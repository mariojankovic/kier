import { callIntent } from './callbacks.mjs'
// An optional cloud second opinion reviews unresolved cards with nearby work evidence.
// It receives the selected context with no tools and cannot read additional files.
// This runs once per card, only when enabled and Claude Code is installed.
import { execFile, spawn } from './child-process.mjs'
import { promisify } from 'node:util'
import { CLAUDE } from './ask.mjs'
import { config, tmpDir } from './config.mjs'
import { now } from './db.mjs'
import { recordCompletion, describe, evidence } from './resolve.mjs'
import { sent } from './settings.mjs'
import { burstOf, contextFor } from './tagger.mjs'
import { tasks } from './tasks.mjs'

const N = config.me
const run = promisify(execFile)
const gh = (args) => run('gh', args, { timeout: 15000 }).then((r) => JSON.parse(r.stdout)).catch(() => null)
const WAIT = 3 * 3600
const AFTER = 12 * 3600
// Work, not payments or appointments: a commit can fix a bug, it can't pay a bill.
const FIX = new Set(['promise', 'todo'])
const clock = (ts) => new Intl.DateTimeFormat('en-GB', { timeZone: config.timezone, weekday: 'short', hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date(ts * 1000))
const metaOf = (x) => { try { return JSON.parse(x.meta || '{}') } catch { return {} } }
const flat = (s, n) => String(s || '').replace(/\s+/g, ' ').trim().slice(0, n)

const SYSTEM = `You help Kier, an assistant that keeps track of what ${N} owes people. A task from ${N}'s chats is still open. You see the chat it came from and every commit ${N} made in the hours after it, with their pull requests. Decide whether one of them fixed exactly what the chat asks for. People describe the same thing in different words and languages ("blurry preview" may refer to thumbnail resolution), and a pull request often fixes more than its title says, so read the descriptions. Work in the same area that doesn't fix this exact problem doesn't count. If unsure, fixed is false. Reply with only JSON: {"fixed": true or false, "item": the number of the commit or pull request that fixed it, or 0, "why": "at most 15 words, in English"}`

export function ask(prompt, binary = CLAUDE) {
  return new Promise((done) => {
    const p = spawn(binary, ['-p', '--model', 'sonnet', '--tools', '', '--strict-mcp-config', '--disable-slash-commands', '--no-session-persistence',
      '--output-format', 'json'],
      { cwd: tmpDir, env: {}, stdio: ['pipe', 'pipe', 'ignore'] })
    p.stdin.on('error', () => {})
    p.stdin.end(`${SYSTEM}\n\n${prompt}`)
    let out = ''
    const timer = setTimeout(() => p.kill(), 180000)
    p.stdout.on('data', (d) => { out += d })
    p.on('close', () => {
      clearTimeout(timer)
      try { done(JSON.parse(String(JSON.parse(out).result).match(/\{[\s\S]*\}/)[0])) } catch { done(null) }
    })
    p.on('error', () => { clearTimeout(timer); done(null) })
  })
}

// The commits after a task, grouped by pull request, each with its description and the files it changed.
async function work(db, t) {
  const commits = db.prepare("select thread, text, url, ts, meta from items where source = 'git' and ts > ? and ts <= ? order by ts limit 30").all(t.ts, t.ts + AFTER)
  await describe(db, commits.map((c) => ({ kind: 'git', url: c.url, ts: c.ts, line: c.text }))).catch(() => 0)
  const fresh = db.prepare('select meta from items where url = ?')
  const items = []
  const byPr = new Map()
  for (const c of commits) {
    const pr = metaOf(fresh.get(c.url) || c).pr
    if (!pr) { items.push({ url: c.url, label: `commit in ${c.thread}`, text: `[commit in ${c.thread}, ${clock(c.ts)}] ${c.text}` }); continue }
    if (byPr.has(pr.number)) { byPr.get(pr.number).commits.push(c.text); continue }
    const repo = c.url.match(/github\.com\/([^/]+\/[^/]+)\//)?.[1]
    const full = repo ? await gh(['api', `repos/${repo}/pulls/${pr.number}`]) : null
    const files = repo ? await gh(['api', `repos/${repo}/pulls/${pr.number}/files`, '--jq', '[.[].filename]']) : null
    const entry = { url: full?.html_url || c.url, label: `PR #${pr.number}`, pr, full, files, repo: c.thread, ts: c.ts, commits: [c.text] }
    byPr.set(pr.number, entry)
    items.push(entry)
  }
  return items.map((e) => e.text ? e : {
    ...e,
    text: `[pull request #${e.pr.number} in ${e.repo}, ${clock(e.ts)}${e.full?.merged_at ? ', merged' : ''}] ${e.pr.title}\n` +
      `Description: ${flat(e.full?.body || e.pr.changes, 1500)}\n` +
      (e.files?.length ? `Files: ${e.files.slice(0, 25).join(', ')}\n` : '') + `Commits: ${e.commits.map((x) => flat(x, 120)).join('; ')}`,
  })
}

let busy = false
export async function doubleCheck(db, limit = 1) {
  if (!CLAUDE || config.online !== true || config.claudeCheck !== true || busy) return {}
  busy = true
  try {
    const asked = db.prepare('select 1 from tags where item_id = ? and deep_at is not null')
    const open = tasks(db, { days: 7 }).filter((t) => (t.state === 'open' || t.state === 'overdue') && !t.status && FIX.has(t.card) && !callIntent(t)
      && t.ts < now() - WAIT && !asked.get(t.id))
    const mark = db.prepare('update tags set deep_at = ? where item_id = ?')
    let checked = 0
    let resolved = 0
    for (const t of open) {
      if (checked >= limit) break
      const items = await work(db, t)
      // Nothing after it yet: it may still come, so the card isn't counted as asked.
      if (!items.length) continue
      checked++
      const before = contextFor(db, burstOf(db, t).start, 8).map((c) => `[${c.time}] ${c.from}: ${flat(c.text, 200)}`)
      const after = evidence(db, t).filter((l) => l.kind === 'chat').slice(0, 8).map((l) => l.line)
      const prompt = `The task (an automatic summary, may be wrong): ${t.summary}\n` +
        `From ${t.from_me ? `${N}, a promise` : `${t.sender}, asking ${N}`}, in ${t.thread} (${t.source}), ${clock(t.ts)}: "${flat(t.text, 600)}"\n` +
        (before.length ? `\nThe chat before it:\n${before.join('\n')}\n` : '') + (after.length ? `\nThe chat after it:\n${after.join('\n')}\n` : '') +
        `\nWhat ${N} committed in the ${AFTER / 3600} hours after:\n${items.map((e, i) => `${i + 1}. ${e.text}`).join('\n\n')}`
      sent(db, 'check', 'claude', SYSTEM + prompt)
      const out = await ask(prompt)
      mark.run(now(), t.id)
      const hit = out?.fixed === true ? items[Number(out.item) - 1] : null
      if (!hit) continue
      recordCompletion(db, t, null, `Looks done: Claude found it in ${hit.label}: ${flat(out.why, 140)}`.slice(0, 300), hit.url)
      resolved++
    }
    return { checked, resolved }
  } finally {
    busy = false
  }
}
