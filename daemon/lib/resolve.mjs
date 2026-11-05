import { parseModelJSON } from './errors.mjs'
import { localAuthorization, readScope } from './authorization.mjs'
import { callIntent } from './callbacks.mjs'
import { modelFetch } from './model-provider.mjs'
// Did it get done? Open tasks are checked against what happened after them: later messages in the same chat,
// your commits, pull requests you opened and the AI sessions you ran. Qwen reads that evidence and says whether
// one line clearly shows the task was done; if so the card moves to "Probably done", with the proof, where one
// click puts it back.
import { execFile, execFileSync } from './child-process.mjs'
import { basename } from 'node:path'
import { promisify } from 'node:util'
import { config } from './config.mjs'
import { now } from './db.mjs'
import { burstOf, contextFor, ollamaUp, sameConversation } from './tagger.mjs'
import { newSince, whereItGoes } from './places.mjs'
import { P, wordRegex } from './lang.mjs'
import { slice } from './profile.mjs'
import { tasks, waiting } from './tasks.mjs'

const N = config.me
const WINDOW = 3 * 86400
const RECHECK = 6 * 3600
const SOON = 3 * 3600
// The tagger reads 4 messages before a task; checking whether it was done needs more of the conversation.
const BEFORE = 8
const KINDS = new Set(['promise', 'todo', 'reply', 'ask', 'payment'])
// Common words say nothing about which commit matches which task.
const STOP = new Set(['update', 'that', 'this', 'with', 'from', 'have', 'will', 'into', 'about', 'what', 'when', 'your', 'their', 'there', 'them',
  config.me.toLowerCase(), 'asks', 'issue', 'issues', 'something', 'things', 'today', 'tomorrow', 'feat', 'chore', 'merge', 'pull', 'request', 'branch',
  'worked', 'claude', 'codex', 'astra', 'send', 'make', 'check', 'help', 'need', 'needs'])

const words = (s) => new Set((String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').match(/[a-z0-9]{4,}/g) || [])
  .map((w) => w.replace(/(ing|ed|es|s)$/, '')).filter((w) => w.length > 3 && !STOP.has(w)))

const clock = (ts) => new Intl.DateTimeFormat('en-GB', { timeZone: config.timezone, weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', hour12: false })
  .format(new Date(ts * 1000))

// GitHub links in the chat say more than any message: whether the PR merged, the check passed, the commit shipped.
// Asked through the owner's own `gh` login, read only, at most every six hours per link; without gh this is skipped.
const LINK = /https:\/\/github\.com\/([\w.-]+)\/([\w.-]+)\/(pull|issues|commit|actions\/runs)\/(\w+)/g
const asked = new Map()
// GitHub is one of the online helpers: off by default, so nothing here reaches the internet unless the owner allows it.
const gh = (args) => {
  if (!config.online) return null
  try { return JSON.parse(execFileSync('gh', args, { encoding: 'utf8', timeout: 15000, stdio: ['ignore', 'pipe', 'ignore'] })) } catch { return null }
}
const pr = (p) => `PR #${p.number} "${p.title}" ${p.merged_at || p.mergedAt ? `merged ${clock(Date.parse(p.merged_at || p.mergedAt) / 1000)}` : `is ${String(p.state).toLowerCase()}`}`

export function github(text) {
  const out = []
  for (const [url, owner, repo, kind, id] of String(text || '').matchAll(LINK)) {
    const hit = asked.get(url)
    if (hit && hit.at > now() - RECHECK) { out.push(...hit.lines); continue }
    const R = `${owner}/${repo}`
    let said = null
    if (kind === 'pull') {
      const p = gh(['pr', 'view', id, '-R', R, '--json', 'number,title,state,mergedAt'])
      said = p && pr(p)
    } else if (kind === 'issues') {
      const i = gh(['issue', 'view', id, '-R', R, '--json', 'title,state'])
      said = i && `issue #${id} "${i.title}" is ${i.state.toLowerCase()}`
    } else {
      // A run or a commit: what matters is the pull request it belongs to.
      const run = kind === 'actions/runs' ? gh(['api', `repos/${R}/actions/runs/${id}`]) : null
      const sha = run ? run.head_sha : id
      const prs = gh(['api', `repos/${R}/commits/${sha}/pulls`]) || []
      said = (run ? `check "${run.name}" ${run.conclusion || run.status}; ` : '') + (prs.length ? prs.map(pr).join('; ') : 'not in any pull request')
    }
    const lines = said ? [{ kind: 'github', ts: now(), url, line: `[GitHub now, the link in the chat] ${said}` }] : []
    asked.set(url, { at: now(), lines })
    out.push(...lines)
  }
  return out
}

// What Kier read on screen in a chat app (Discord today), turned back into who said what. Your own messages in
// those apps never arrive as notifications, so this is the only place the owner’s reply shows up.
const HEADER = /^(.{1,40}?)(?: Server Tag: \S+)? (\d{1,2}):(\d{2})\s?([AP]M)$/
const NOISE = /^(\d{1,2}:\d{2}\s?[AP]M|\w+day, \w+ \d{1,2}, \d{4} at .+|Send GIF|.+ is typing\.\.\.|Copy Message ID|Copy Link|Mark Unread|Bookmark Message|Pin Message|Create Thread|Click to react|:[\w+-]+:)$/
export function screenChat(text, day) {
  const out = []
  let cur = null
  for (const raw of String(text || '').split('\n')) {
    const line = raw.trim()
    if (!line || NOISE.test(line)) continue
    const h = line.match(HEADER)
    if (h) {
      const hour = (Number(h[2]) % 12) + (h[4] === 'PM' ? 12 : 0)
      const at = new Date(day * 1000)
      at.setHours(hour, Number(h[3]), 0, 0)
      cur = { name: h[1].trim(), ts: Math.floor(at.getTime() / 1000), text: [] }
      out.push(cur)
    } else if (cur) cur.text.push(line)
  }
  return out.filter((m) => m.text.length).map((m) => ({ ...m, text: m.text.join(' / ').slice(0, 240) }))
}

function onScreen(db, task, until) {
  const app = String(task.thread || '').split(':')[0]
  if (task.source !== 'notifications' || !app) return []
  const seen = new Map()
  for (const s of db.prepare("select ts, text from items where source = 'screen' and thread like ? and ts > ? and ts <= ? order by ts")
    .all(`${app}:%`, task.ts - 60, until)) {
    for (const m of screenChat(s.text, s.ts)) if (m.ts >= task.ts - 60 && !seen.has(`${m.name}|${m.text}`)) seen.set(`${m.name}|${m.text}`, m)
  }
  return [...seen.values()].sort((a, b) => a.ts - b.ts).slice(0, 14)
    .map((m) => ({ kind: 'chat', ts: m.ts, line: `[${app} on screen, ${clock(m.ts)}] ${m.name}: ${m.text}` }))
}

// What happened after the task, as numbered lines the model can point at.
const AI_APPS = ['com.anthropic.claudefordesktop', 'com.openai.codex']
// Retain both the beginning and end of long messages: the closing sentence may establish
// who takes responsibility.
const ends = (s) => (s.length > 520 ? `${s.slice(0, 200)} … ${s.slice(-300)}` : s)
const SAID_SOON = 10 * 60
const PAYING = /^pay\b/i
const PAID = wordRegex('paid')
const aboutThis = (t, proof) => proof.ts - t.ts <= SAID_SOON
  || [...words(proof.line.replace(/^\[[^\]]*\]\s*/, ''))].some((w) => words(`${t.summary} ${t.text}`).has(w))
const metaOf = (x) => { try { return JSON.parse(x.meta || '{}') } catch { return {} } }

// An AI's question belongs to one repository and one topic: only work there that shares words with it counts, and
// only other sessions (its own continuing would have answered it). Most sessions start in the same folder, so the
// folder alone proves nothing, and commits in other repos the same morning are noise.
const related = (task) => {
  if (task.source !== 'ai') return () => true
  // Work a session left unfinished belongs to the repository it's in (the vault, the PR's repo), not where the session ran.
  const { cwd, session, repo: folder, pr, kind } = metaOf(task)
  const repo = pr ? String(pr).split('/')[4] : folder ? basename(folder) : cwd ? basename(cwd) : null
  // What settles it is a commit there, whatever its words; other sessions' chatter isn't.
  if (kind === 'stalled') return (w) => w.source === 'git' && !!repo && w.thread === repo
  return (w) => {
    if (w.score < 1) return false
    if (w.source === 'git') return !!repo && w.thread === repo
    if (w.source === 'ai') return metaOf(w).session !== session
    return !!repo && String(w.url || '').includes(`/${repo}/`)
  }
}

// Look up each commit’s pull request once and retain its description as completion evidence.
const run = promisify(execFile)
const ghAsync = (args) => (config.online ? run('gh', args, { timeout: 15000 }).then((r) => JSON.parse(r.stdout)).catch(() => null) : Promise.resolve(null))
const points = (body) => String(body || '').split('\n').map((l) => l.trim()).filter((l) => /^[-*] /.test(l))
  .map((l) => l.replace(/^[-*]\s+/, '').replace(/\*\*|`/g, '').replace(/\s+/g, ' ').slice(0, 160)).join('; ').slice(0, 700)
const prOf = (w) => {
  const p = metaOf(w).pr
  return p ? ` (PR #${p.number}${p.title && p.title !== w.text ? ` "${p.title}"` : ''}${p.changes ? `: ${p.changes}` : ''})` : ''
}

export async function describe(db, lines) {
  const get = db.prepare("select id, meta from items where source = 'git' and url = ?")
  const save = db.prepare('update items set meta = ? where id = ?')
  let found = 0
  for (const l of lines.filter((x) => x.kind === 'git' && x.url)) {
    const row = get.get(l.url)
    const m = row ? metaOf(row) : null
    // A commit pushed before its pull request was opened gets another look each hour, for a day.
    if (!m || m.pr || (m.pr_at && (now() - m.pr_at < 3600 || now() - l.ts > 86400))) continue
    const u = l.url.match(/github\.com\/([^/]+)\/([^/]+)\/commit\/(\w+)/)
    if (!u) continue
    const n = l.line.match(/Merge pull request #(\d+)/)?.[1]
    const pr = n ? await ghAsync(['api', `repos/${u[1]}/${u[2]}/pulls/${n}`]) : (await ghAsync(['api', `repos/${u[1]}/${u[2]}/commits/${u[3]}/pulls`]))?.[0]
    save.run(JSON.stringify({ ...m, pr_at: now(), ...(pr?.number ? { pr: { number: pr.number, title: pr.title, changes: points(pr.body) } } : {}) }), row.id)
    if (pr?.number) found++
  }
  return found
}

// Cards with no conversation of their own: an AI session's question, and one of your reminders, whose neighbours in its
// list are other reminders, not a chat.
const NO_CHAT = new Set(['ai', 'reminders'])

export function evidence(db, task, auth = localAuthorization()) {
  db = readScope(db, auth)
  const until = Math.min(now(), task.ts + WINDOW)
  // Later, or the same minute but stored after it (Discord gives only the minute; tasks.mjs `replied`).
  const rid = db.prepare('select rowid from items where id = ?').get(task.id)?.rowid ?? Number.MAX_SAFE_INTEGER
  const chat = NO_CHAT.has(task.source) ? [] : db.prepare(`select sender, from_me, ts, text, url from items where source = ? and thread = ?
    and (ts > ? or (ts = ? and rowid > ?)) and ts <= ? order by ts, rowid limit 120`).all(task.source, task.thread, task.ts, task.ts, rid, until).filter(sameConversation(task)).slice(0, 12)
    .map((c) => ({ kind: 'chat', owner: c.from_me === 1, ts: c.ts, line: `[chat, ${clock(c.ts)}] ${c.from_me ? N : c.sender}: ${String(c.text || '').replace(/\s+/g, ' ').slice(0, 200)}` }))
  // The words of the task and of the chat that led to it: a summary can be wrong, the conversation isn't.
  const before = NO_CHAT.has(task.source) ? [] : contextFor(db, burstOf(db, task).start, BEFORE).map((c) => c.text)
  const want = words(`${task.summary} ${task.text} ${before.join(' ')}`)
  // Desktop assistant notifications can supply completion evidence for work outside code.
  const all = db.prepare(`select source, thread, ts, text, url, meta from items where ts > ? and ts <= ? and (source = 'git'
    or (source = 'ai' and json_extract(meta, '$.kind') = 'session') or (source = 'browser' and url like 'https://github.com/%/pull/%')
    or (source = 'notifications' and json_extract(meta, '$.app') in (${AI_APPS.map((a) => `'${a}'`).join(', ')})))`).all(task.ts, until)
    // A session matches by what you asked it and what it says now, not only by its title.
    .map((w) => ({ ...w, about: w.source === 'ai' ? `${metaOf(w).request || ''} ${metaOf(w).latest || ''}` : w.source === 'git' ? prOf(w) : '' }))
    .map((w) => ({ ...w, score: [...words(`${w.thread} ${w.text} ${w.about}`)].filter((x) => want.has(x)).length }))
    .filter(related(task))
  // Nearby work can support an owner promise even with different wording. Frequent assistant
  // notifications require shared subject words to avoid unrelated matches.
  const soon = all.filter((w) => w.ts - task.ts < SOON && w.source !== 'notifications').sort((a, b) => a.ts - b.ts).slice(0, 6)
  const matched = all.filter((w) => w.score > 0).sort((a, b) => b.score - a.score || a.ts - b.ts).slice(0, 8)
  const work = [...new Set([...soon, ...matched])].sort((a, b) => a.ts - b.ts)
    .map((w) => ({
      kind: w.source, owner: false, ts: w.ts, url: w.url, shared: w.score,
      line: w.source === 'git' ? `[commit in ${w.thread}, ${clock(w.ts)}] ${w.text}${prOf(w)}`
        : w.source === 'browser' ? `[pull request page ${N} opened, ${clock(w.ts)}] ${w.text}`
        : w.source === 'notifications' ? `[${w.thread} said, ${clock(w.ts)}] ${w.text}` : session(w),
    }))
  // Payment confirmation may arrive through a different conversation. Include candidate
  // confirmations and let the done-check determine whether they concern this payment.
  const paid = PAYING.test(task.summary || '') || task.card === 'payment' || task.amount
    ? db.prepare(`select source, thread, sender, from_me, ts, text from items where source in ('whatsapp', 'imessage', 'discord', 'chat', 'mail', 'notifications')
        and ts > ? and ts <= ? and not (source = ? and thread = ?) order by ts desc limit 400`).all(task.ts, until, task.source, task.thread)
        .filter((m) => PAID.test(m.text || '')).slice(0, 6).reverse()
        .map((m) => ({ kind: 'chat', owner: m.from_me === 1, ts: m.ts, line: `[${m.source === 'mail' ? 'email' : m.source}, ${m.thread}, ${clock(m.ts)}] ${m.from_me ? N : m.sender}: ${String(m.text || '').replace(/\s+/g, ' ').slice(0, 200)}` }))
    : []
  // What you told Kier about it in its chat ("I gave Claude this", "done"): your words, so the same rules apply.
  const told = db.prepare('select ts, q from chats where key = ? order by ts').all(task.id)
    .map((c) => ({ kind: 'kier', owner: true, ts: c.ts, line: `[${N} told Kier about it, ${clock(c.ts)}] ${N}: ${String(c.q).replace(/\s+/g, ' ').slice(0, 300)}` }))
  const screen = onScreen(db, task, until)
  const links = github([task.text, ...before, ...chat.map((c) => c.line)].join(' '))
  return [...links, ...chat, ...paid, ...told, ...screen, ...work]
}

// An AI session as a line: what it's about, what you last asked it, and where it is now.
function session(w) {
  const m = metaOf(w)
  const clip = (s, n) => String(s || '').replace(/\s+/g, ' ').slice(0, n)
  return `[AI session, ${clock(m.at || w.ts)}] ${w.text}${m.request ? `; you last asked: "${clip(m.request, 160)}"` : ''}${m.latest ? `; it last said: "${clip(m.latest, 240)}"` : ''}`
}

const SYSTEM = `You check whether a task in ${N}'s vault has been done. You see the task, the message it came from, and numbered lines of what happened after it: later messages in the same chat, ${N}'s code commits, pull requests ${N} opened, AI coding sessions, and what GitHub says now about links in the chat.

The summary of the task can be wrong; trust the chat before it for what the task really is. done is true only when one line clearly shows this exact task was done, answered or is no longer needed: a commit or pull request that fixes exactly that thing, something new on the feed where such things are published, after the promise and about the same change (release notes can be posted as a blog post about that change), ${N} saying it's done ("fixano", "riješeno", "gotovo", "evo", "poslao sam", "done", "sent"), or the other person confirming or cancelling it. When the task is to pass something on ("tell him to check the PR", "reci mu da pogleda"), passing it on is doing it: ${N} telling that person, or, when it was meant for an AI ${N} works with, an AI session whose "you last asked" carries that same request. Work on a similar topic is not enough. If unsure, done is false.

If ${N} says it isn't ${P.his} ("not mine", "that belongs to Nika", "Filip is handling that", in whatever language the chat is in), or the others say whose it is, or the person who raised it takes it on ${P.he === 'they' ? 'themselves' : 'themselves'} ("I'll offer it", "leave it to me", "pa ću ja"), even if ${N} agreed, set not_mine true and point at that line.

If it was never a real task at all, set not_a_task true: an example someone gave while explaining something ("npr", "na primjer", "recimo", "for example", "like when"), a hypothetical ("if I had to…"), a joke, a description of how something works, or an automatic notice from a service that asks nothing of ${N} (a balance or usage notice, a receipt). When a message explains how something should work or what it would notice and then lists cases, every case in that list is an example, even the lines after the "npr". A real request or promise said casually is still a task.

First say in your own words what the task really is, from the chat. Then judge. Reply with only JSON:
{"task": "the real task in at most 12 words", "done": true or false, "not_mine": true or false, "not_a_task": true or false, "line": number of the line that shows it or 0, "why": "at most 12 words"}`

export async function judge(db, task, lines) {
  const who = task.from_me ? `${N} promised` : `${task.sender} asked ${N}`
  const before = NO_CHAT.has(task.source) ? [] : contextFor(db, burstOf(db, task).start, BEFORE)
  // Without the summary the model drifts to whatever else the chat mentions, so it stays, marked as a guess.
  const known = slice({ people: [task.sender, ...before.map((c) => c.from)], group: metaOf(task).group ? task.thread : null })
  const user = `Task (an automatic summary, may be wrong): ${task.summary}\n` + (known ? `${known}\n` : '') +
    (before.length ? `Before it, in the same chat:\n${before.map((c) => `[${c.time}] ${c.from}: ${String(c.text).replace(/\s+/g, ' ').slice(0, 200)}`).join('\n')}\n` : '') +
    `From: ${who}, in ${metaOf(task).group ? 'a group chat' : task.thread} (${task.source}), ${clock(task.ts)}: "${ends(String(task.text || '').replace(/\s+/g, ' '))}"\n\nAfter it:\n${lines.map((l, i) => `${i + 1}. ${l.line}`).join('\n')}`
  // Room for pull request descriptions on the commit lines.
  const res = await modelFetch('/api/chat', {
    method: 'POST', signal: AbortSignal.timeout(120000),
    body: JSON.stringify({ model: config.model, stream: false, think: false, keep_alive: config.keepAlive, options: { temperature: 0, num_ctx: 8192 },
      messages: [{ role: 'system', content: SYSTEM }, { role: 'user', content: user }] }),
  })
  if (!res.ok) throw Error(`ollama ${res.status}`)
  const out = parseModelJSON((await res.json()).message.content.match(/\{[\s\S]*\}/)?.[0] ?? 'null')
  return out && typeof out === 'object' ? out : null
}

// When the judge isn't sure, a narrower question: which of the commits made in the hour after a promise is the fix?
// Right often enough to suggest, wrong too often to close a task, so the answer only becomes a hint on the card.
const PICK = `You match a promise from a chat to the commit that kept it. You see the chat around the promise and the commits ${N} made in the hour after it. Pick the commit that fixes exactly what the chat talks about. Repository names tell you which product. If none clearly is, answer 0. Reply with only JSON: {"commit": number or 0, "why": "at most 12 words"}`
const FIXABLE = new Set(['promise', 'todo'])
const CONFIRM = `You check one commit against a chat. Answer fixes true only if this commit clearly fixes exactly the problem the chat is about, not just the same area of the product. Reply with only JSON: {"fixes": true or false, "why": "at most 12 words"}`
// Check nearby work and merged pull requests for completion evidence. Timing alone cannot
// show that a promise has been kept.
const QUICK = 30 * 60
// Promises to do it right now, in Croatian and English, kept within a quarter of an hour.
const NOW = wordRegex('now')
const NOW_WINDOW = 15 * 60
// Words that report something finished, in Croatian and English.
const DONE_WORDS = wordRegex('done')

export async function ask(system, user) {
  const res = await modelFetch('/api/chat', {
    method: 'POST', signal: AbortSignal.timeout(120000),
    body: JSON.stringify({ model: config.model, stream: false, think: false, keep_alive: config.keepAlive, options: { temperature: 0, num_ctx: 4096 },
      messages: [{ role: 'system', content: system }, { role: 'user', content: user }] }),
  })
  if (!res.ok) return null
  return parseModelJSON((await res.json()).message.content.match(/\{[\s\S]*\}/)?.[0] ?? 'null')
}

// The pull request a commit belongs to, if it was merged.
function mergedPr(url) {
  const m = String(url || '').match(/github\.com\/([^/]+)\/([^/]+)\/commit\/(\w+)/)
  const prs = m ? gh(['api', `repos/${m[1]}/${m[2]}/commits/${m[3]}/pulls`]) || [] : []
  return prs.find((p) => p.merged_at) || null
}

export async function hint(db, task) {
  // A code commit cannot prove payment.
  if (!FIXABLE.has(task.card) || task.amount || /^(attend|join|meet|go|call|pay)\b/i.test(task.summary || '')) return null
  const commits = db.prepare("select thread, text, url, ts, meta from items where source = 'git' and ts > ? and ts < ? order by ts limit 12").all(task.ts, task.ts + 3600)
  if (!commits.length) return null
  const before = contextFor(db, burstOf(db, task).start, BEFORE).map((c) => `[${c.time}] ${c.from}: ${String(c.text).replace(/\s+/g, ' ').slice(0, 160)}`)
  const chat = `Chat:\n${before.join('\n')}\nPromise: ${String(task.text || '').replace(/\s+/g, ' ')}`
  const out = await ask(PICK, `${chat}\n\nCommits in the hour after:\n${commits.map((c, i) => `${i + 1}. [${c.thread}] ${c.text}${prOf(c)}`).join('\n')}`)
  const c = out?.commit ? commits[Number(out.commit) - 1] : null
  if (!c) return null
  const found = { text: `${c.text} (${c.thread})`, url: c.url }
  if (task.card !== 'promise' || c.ts - task.ts > QUICK) return found
  // An explicit work promise followed by a matching merged change can supply strong evidence.
  // Compare the described behavior rather than requiring identical wording.
  const now = NOW.test(task.text || '') && c.ts - task.ts <= NOW_WINDOW
  const confirmed = now || (await ask(CONFIRM, `${chat}\n\nCommit [${c.thread}]: ${c.text}${prOf(c)}`))?.fixes === true
  const pr = confirmed ? mergedPr(c.url) : null
  return pr ? { ...found, done: `PR #${pr.number} "${pr.title}" merged ${Math.max(1, Math.round((c.ts - task.ts) / 60))} min after you promised`, url: pr.html_url || c.url } : found
}

// Evidence ownership comes from collected provenance, never from names in message text
// or a model's claim. Unknown and model-only evidence needs the owner's confirmation.
export function recordCompletion(db, task, proof, reason, url = null) {
  // Git author text is forgeable. Only existing trusted message paths can authorize completion.
  const origin = proof?.owner === true && ['chat', 'kier'].includes(proof.kind) ? 'owner-message' : null
  const status = task.source === 'reminders' && !origin ? 'looks_done' : 'handled'
  return db.prepare(`insert into task_state (item_id, status, changed_at, reason, url, completion_origin)
    values (?, ?, ?, ?, ?, ?) on conflict(item_id) do nothing`)
    .run(task.id, status, now(), reason, url, origin)
}

// A few open tasks at a time, each at most every six hours, so it runs in Kier's quiet moments.
// `answered` only: cards you've replied to since they were last checked, which go first and don't wait an hour, so
// "evo jesam" closes "plati ovo" on the next pass even while the tagger is busy.
export async function resolvePending(db, limit = 4, { answered = false, now: asked = false } = {}) {
  const checked = new Map(db.prepare('select item_id, checked_at from tags where checked_at is not null').all().map((r) => [r.item_id, r.checked_at]))
  const fresh = (t) => t.answered && t.answered > (checked.get(t.id) || 0)
  // Revisit open tasks after an early inconclusive check so later completion evidence is found.
  const lastCommit = db.prepare("select max(ts) ts from items where source = 'git'").get().ts || 0
  const newWork = (t) => FIXABLE.has(t.card) && lastCommit > Math.max(t.ts, checked.get(t.id) || 0) && (checked.get(t.id) || 0) < now() - 3600
  // Prioritize unchecked open cards without treating recent activity alone as completion.
  const later = db.prepare('select sender, ts from items where source = ? and thread = ? and ts > ? order by ts desc limit 200')
  const movedOn = (t) => t.source !== 'ai' && t.ts < now() - 10 * 60
    && later.all(t.source, t.thread, Math.max(t.ts + 60, checked.get(t.id) || 0)).filter(sameConversation(t)).length > 0
  const open = tasks(db, { days: 14 }).filter((t) => (t.state === 'open' || t.state === 'overdue') && !t.status && KINDS.has(t.card) && !callIntent(t)
    // `now`: you asked for a look (Check now), so every open card gets one, however recently it had the last.
    && (asked || fresh(t) || (!answered && t.ts < now() - 3600 && ((checked.get(t.id) || 0) < now() - RECHECK || newWork(t))) || (!answered && movedOn(t))))
    .sort((a, b) => Number(fresh(b)) - Number(fresh(a))).slice(0, limit)
  if (!open.length || !(await ollamaUp())) return {}
  const mark = db.prepare('update tags set checked_at = ? where item_id = ?')
  const setHint = db.prepare('update tags set hint = ?, hint_url = ? where item_id = ?')
  const dismiss = db.prepare(`insert into task_state (item_id, status, changed_at, reason) values (?, 'dismissed', ?, ?)
    on conflict(item_id) do nothing`)
  let resolved = 0
  for (const t of open) {
    // Your own promise to publish something can be checked where you publish it.
    // Commits first get their pull requests' descriptions, then the evidence is read again with them.
    const first = evidence(db, t)
    const lines = [...((await describe(db, first).catch(() => 0)) ? evidence(db, t) : first), ...(t.from_me ? await newSince(db, t).catch(() => []) : [])]
    const verdict = lines.length ? await judge(db, t, lines).catch(() => null) : null
    let proof = verdict?.done === true ? lines[Number(verdict.line) - 1] : null
    // An acknowledgment or promise to start work is not evidence that the work is complete.
    if (proof && proof.owner === true && ['chat', 'kier'].includes(proof.kind) && !DONE_WORDS.test(proof.line)) proof = null
    // Only consider nearby replies or replies that share the task’s subject.
    if (proof && proof.owner === true && ['chat', 'kier'].includes(proof.kind) && !aboutThis(t, proof)) proof = null
    // A reply is answered in its conversation; an unrelated commit is never an answer.
    if (proof && t.card === 'reply' && proof.kind === 'git') proof = null
    const elsewhere = verdict?.not_mine === true ? lines[Number(verdict.line) - 1] : null
    // An example or a hypothetical the tagger took at its word (such as an imagined course payment).
    if (verdict?.not_a_task === true && !proof && !elsewhere) {
      dismiss.run(t.id, now(), `Not a task: ${String(verdict.why || 'an example, not something to do').slice(0, 200)}`)
      resolved++
    } else if (elsewhere) {
      dismiss.run(t.id, now(), `Not yours: ${elsewhere.line.replace(/^\[([^\]]+)\]\s*/, '$1: ')}`.slice(0, 300))
      resolved++
    } else if (proof) {
      recordCompletion(db, t, proof, `Looks done: ${proof.line.replace(/^\[([^\]]+)\]\s*/, '$1: ')}`.slice(0, 300), proof.url || null)
      resolved++
    } else if (t.source === 'reminders' && verdict?.done === true) {
      recordCompletion(db, t, null, `Looks done: ${String(verdict.why || 'Model verdict without verified evidence').slice(0, 200)}`)
      resolved++
    } else {
      const h = await hint(db, t).catch(() => null)
      if (h?.done) {
        recordCompletion(db, t, null, `Looks done: ${h.done}`.slice(0, 300), h.url || null)
        resolved++
      } else if (h) setHint.run(h.text.slice(0, 300), h.url || null, t.id)
    }
    mark.run(now(), t.id)
  }
  return { resolved, checked: open.length }
}

// Things you asked others for: done when a later message in that chat shows they delivered.
const WAIT = `${N} asked someone to do something. You see the request and the messages after it in the same chat, and what GitHub says about links in them. done is true only if a later message shows the person did it, sent it, answered it, or that it's no longer needed. "ok", "will do" or "sutra" is not done. Reply with only JSON: {"done": true or false, "line": number of the line that shows it or 0, "why": "at most 12 words"}`

export async function resolveWaiting(db, limit = 3) {
  const checked = new Map(db.prepare('select item_id, checked_at from tags where checked_at is not null').all().map((r) => [r.item_id, r.checked_at]))
  const open = waiting(db).filter((w) => w.ts < now() - 1800 && (checked.get(w.id) || 0) < now() - RECHECK).slice(0, limit)
  if (!open.length || !(await ollamaUp())) return {}
  const mark = db.prepare('update tags set checked_at = ? where item_id = ?')
  const done = db.prepare(`insert into task_state (item_id, status, changed_at, reason, url) values (?, 'handled', ?, ?, ?)
    on conflict(item_id) do nothing`)
  let resolved = 0
  for (const w of open) {
    const after = db.prepare('select sender, from_me, ts, text from items where source = ? and thread = ? and ts > ? and ts <= ? order by ts limit 14')
      .all(w.source, w.thread, w.ts, w.ts + WINDOW)
    const lines = [...github(after.map((a) => a.text).join(' ')),
      ...after.map((a) => ({ line: `[chat, ${clock(a.ts)}] ${a.from_me ? N : a.sender}: ${String(a.text || '').replace(/\s+/g, ' ').slice(0, 200)}` }))]
    if (lines.length) {
      const user = `${N} asked ${w.who} to ${w.what}, in ${w.thread}, ${clock(w.ts)}: "${String(w.text || '').replace(/\s+/g, ' ').slice(0, 300)}"\n\nAfter it:\n${lines.map((l, i) => `${i + 1}. ${l.line}`).join('\n')}`
      const v = await ask(WAIT, user).catch(() => null)
      const proof = v?.done === true ? lines[Number(v.line) - 1] : null
      if (proof) {
        done.run(w.id, now(), `Looks done: ${proof.line.replace(/^\[([^\]]+)\]\s*/, '$1: ')}`.slice(0, 300), proof.url || null)
        resolved++
      }
    }
    mark.run(now(), w.id)
  }
  return { resolved, checked: open.length }
}

// An AI's closing question read cold ("How should the missing caption get added?") says nothing a day later, so the
// local model rewrites it once, from the end of that session, into a line that stands on its own.
const EXPLAIN = `${N} works with AI coding assistants. One ended its last message with a question ${N} never answered. Make the question make sense on its own a day later: keep its meaning and as much of its wording as you can, and only add what it is about where it doesn't say (the post, page, reel, repo or bug, by the name the text uses). Never change what is asked, and never add options it didn't offer. At most 18 words, in English. Reply with only JSON: {"question": "..."}`

export async function explainAsks(db, limit = 4) {
  const rows = db.prepare(`select i.id, i.sender, i.thread, i.text, i.meta from tags t join items i on i.id = t.item_id
    where i.source = 'ai' and t.card = 'ask' and t.model = 'rule' and json_extract(i.meta, '$.said') is not null order by i.ts desc limit ?`).all(limit)
  if (!rows.length || !(await ollamaUp())) return {}
  const save = db.prepare("update tags set summary = ?, model = 'explained' where item_id = ?")
  let explained = 0
  for (const r of rows) {
    const m = metaOf(r)
    const user = `Session: ${r.thread}${m.cwd ? `\nRepository: ${basename(m.cwd)}` : ''}\n${m.request ? `${N}'s last request: ${m.request}\n` : ''}\n${r.sender}'s last message:\n${m.said}\n\nThe question: ${r.text}`
    const out = await ask(EXPLAIN, user).catch(() => null)
    const q = String(out?.question || '').trim()
    if (q.length < 8) continue
    save.run(`${r.sender} asked: ${q}`.slice(0, 240), r.id)
    explained++
  }
  return { explained }
}

// Provide the full item and its evidence so the assistant can answer status questions.
const LABEL = { whatsapp: 'WhatsApp', imessage: 'iMessage', mail: 'Email', notifications: 'Notification', browser: 'Web', git: 'Commit',
  ai: 'AI', calendar: 'Calendar', calls: 'Call', downloads: 'Download', screen: 'On screen', apps: 'App' }

export async function aboutItem(db, id, auth = localAuthorization()) {
  db = readScope(db, auth)
  const t = db.prepare(`select i.*, t.summary, t.card, coalesce(t.said, i.text) said, s.status, s.reason from items i
    left join tags t on t.item_id = i.id left join task_state s on s.item_id = i.id where i.id = ?`).get(id)
  if (!t) return ''
  const meta = metaOf(t)
  const where = t.source === 'ai' ? `${t.sender} session "${t.thread}"` : meta.group ? 'a group chat' : t.thread
  const before = t.source === 'ai' ? [meta.request && `${N}: ${meta.request}`, meta.said && `${t.sender}: ${meta.said}`].filter(Boolean)
    : contextFor(db, burstOf(db, t).start, BEFORE).map((c) => `[${c.time}] ${c.from}: ${String(c.text).replace(/\s+/g, ' ').slice(0, 240)}`)
  const since = evidence(db, { ...t, text: t.said }, auth).map((e) => e.line)
  const later = laterInChat(db, t, since, auth)
  const also = alsoMentions(db, t, [...since, ...later], auth)
  const place = t.source === 'ai' ? '' : await whereItGoes(db, t, auth).catch(() => '')
  return [
    `The item: ${t.summary || t.text}${t.status ? ` (marked ${t.status}${t.reason ? `: ${t.reason}` : ''})` : ''}`,
    `From ${t.from_me ? N : t.sender}, in ${where} (${LABEL[t.source] || t.source}), ${clock(t.ts)}: "${String(t.said || '').replace(/\s+/g, ' ').slice(0, 400)}"`,
    before.length ? `Before it:\n${before.join('\n')}` : '',
    `What ${N}'s vault shows since then:\n${since.length ? since.map((l) => `- ${l}`).join('\n') : '- nothing yet'}`,
    later.length ? `Later in the same chat, up to now (${N}'s own messages, and any with the same words):\n${later.map((l) => `- ${l}`).join('\n')}` : '',
    also.length ? `Other things in the vault since then with the same words:\n${also.map((l) => `- ${l}`).join('\n')}` : '',
    place,
  ].filter(Boolean).join('\n\n')
}

// Read later conversation beyond the initial evidence window when it shares the task’s topic.
function laterInChat(db, t, seen, auth) {
  db = readScope(db, auth)
  if (t.source === 'ai') return []
  const keys = [...new Set(String(t.summary || '').toLowerCase().match(/[a-zčćšžđ]{4,}/g) || [])].filter((w) => !STOP.has(w) && w !== N.toLowerCase())
  return db.prepare('select sender, from_me, ts, text from items where source = ? and thread = ? and ts > ? order by ts desc limit 400')
    .all(t.source, t.thread, t.ts).filter(sameConversation(t))
    // Match conversational answers by context when their words differ from the question.
    .filter((r) => r.from_me || (!t.from_me && r.sender === t.sender) || keys.some((k) => String(r.text || '').toLowerCase().includes(k)))
    .slice(0, 15).reverse()
    .map((r) => `[chat, ${clock(r.ts)}] ${r.from_me ? N : r.sender}: ${String(r.text || '').replace(/\s+/g, ' ').slice(0, 200)}`)
    .filter((l) => !seen.includes(l))
}

// Pages opened, other chats, notifications and commits since the item that share its key words ("release notes").
function alsoMentions(db, t, seen, auth) {
  db = readScope(db, auth)
  const keys = [...new Set(String(t.summary || '').toLowerCase().match(/[a-zčćšžđ]{4,}/g) || [])].filter((w) => !STOP.has(w) && w !== N.toLowerCase()).slice(0, 6)
  if (!keys.length) return []
  const need = Math.min(2, keys.length)
  return db.prepare("select source, thread, sender, ts, text, url from items where ts > ? and id != ? and source != 'clipboard' order by ts limit 5000").all(t.ts, t.id)
    .map((r) => ({ r, n: keys.filter((k) => `${r.text} ${r.thread} ${r.url || ''}`.toLowerCase().includes(k)).length }))
    .filter((x) => x.n >= need).sort((a, b) => b.n - a.n || b.r.ts - a.r.ts).slice(0, 8)
    .map(({ r }) => `[${LABEL[r.source] || r.source}${r.thread && r.source !== 'browser' ? ` ${r.thread}` : ''}, ${clock(r.ts)}] ${r.sender && !['browser', 'git'].includes(r.source) ? `${r.sender}: ` : ''}${String(r.text || '').replace(/\s+/g, ' ').slice(0, 200)}${r.url && r.source === 'browser' ? ` (${r.url})` : ''}`)
    .filter((l) => !seen.some((s) => s.includes(l.slice(-60))))
}
