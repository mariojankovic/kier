import { closeSync, existsSync, openSync, readdirSync, readSync, statSync } from 'node:fs'
import { basename, resolve } from 'node:path'
import { dataDir, home } from '../lib/config.mjs'
import { addItems, now } from '../lib/db.mjs'
import { redact } from '../lib/redact.mjs'

// Questions an AI assistant asked and never got an answer to: Claude Code (terminal and desktop app) and Codex
// sessions on this Mac. A session whose last word is a question to you, then nothing for two hours, is a
// follow-up you probably forgot. Only the end of the exchange is kept, redacted: your last request, the assistant's
// last message and the repository, so the question still makes sense a day later. Never the whole conversation.
export const source = 'ai'
const CLAUDE = resolve(home, '.claude/projects')
const CODEX = resolve(home, '.codex/sessions')
const DAYS = 7
const IDLE = 2 * 3600
// Transcripts can run to hundreds of MB; the end of the file holds the last question.
const TAIL = 4 * 1024 * 1024

function tail(path) {
  const size = statSync(path).size
  const fd = openSync(path, 'r')
  try {
    const length = Math.min(size, TAIL)
    const buf = Buffer.alloc(length)
    readSync(fd, buf, 0, length, size - length)
    const lines = buf.toString('utf8').split('\n')
    if (size > length) lines.shift()
    return lines.flatMap((l) => { try { return [JSON.parse(l)] } catch { return [] } })
  } finally {
    closeSync(fd)
  }
}

// The first line, which says how a Codex session started; on a long run it sits far before the tail.
function firstLine(path) {
  const fd = openSync(path, 'r')
  try {
    const chunks = []
    for (let pos = 0; pos < TAIL;) {
      const buf = Buffer.alloc(65536)
      const n = readSync(fd, buf, 0, buf.length, pos)
      if (!n) break
      const nl = buf.subarray(0, n).indexOf(10)
      chunks.push(buf.subarray(0, nl >= 0 ? nl : n))
      if (nl >= 0) break
      pos += n
    }
    return JSON.parse(Buffer.concat(chunks).toString('utf8'))
  } catch {
    return null
  } finally {
    closeSync(fd)
  }
}

function recent(dir, depth) {
  if (!existsSync(dir)) return []
  const out = []
  const walk = (d, level) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = resolve(d, e.name)
      if (e.isDirectory() && level < depth) walk(p, level + 1)
      else if (e.isFile() && e.name.endsWith('.jsonl')) {
        const age = now() - statSync(p).mtimeMs / 1000
        if (age < DAYS * 86400) out.push(p)
      }
    }
  }
  walk(dir, 0)
  return out
}

// The start of a request, where its gist is, and the end of a reply, where the question is; and the text of a
// message, whichever shape it was stored in.
const end = (s, n) => { const t = String(s || '').trim(); return t.length > n ? `…${t.slice(-n)}` : t }
const start = (s, n) => { const t = String(s || '').trim(); return t.length > n ? `${t.slice(0, n)}…` : t }
// Pull requests a session opened or worked on: links in its messages and its tools' output ("gh pr create" prints one).
const PR = /https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/pull\/\d+/g
const prsIn = (seen, value) => { for (const m of JSON.stringify(value ?? '').match(PR) || []) { seen.delete(m); seen.add(m) } }
// The files a session wrote itself, so changes it left uncommitted are told apart from changes already lying around:
// Claude's edit tools name the file, Codex's patches carry "*** Update File: <path>".
const EDITS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit'])
const PATCHED = /\*\*\* (?:Add|Update) File: ([^\\"\n]+)/g
const wrote = (seen, path) => { if (path) { seen.delete(path); seen.add(path) } }
const said = (content) => clean(typeof content === 'string' ? content : (content || []).filter((b) => b.type === 'text').map((b) => b.text).join('\n'))
// A scheduled run's own instructions, past the standard paragraph every run opens with ("This is an automated run…").
const task = (body) => body.trim().split(/\n\s*\n/).filter((p) => !/^This is an automated run of a scheduled task/i.test(p.trim())).join('\n\n').trim()
// A scheduled run's prompt is the request; reminders, citations and other blocks the apps add around the text are not.
const clean = (text) => String(text || '')
  .replace(/<scheduled-task name="([^"]+)"[^>]*>([\s\S]*?)<\/scheduled-task>/g, (_, name, body) => `Scheduled task "${name}": ${task(body)}`)
  .replace(/<([a-z][\w-]*)[^>]*>[\s\S]*?<\/\1>/gi, '').trim()

// The question itself: the last paragraph that asks something, cut to one or two sentences.
function question(text) {
  const paragraphs = String(text || '').split(/\n\s*\n/).map((p) => p.trim()).filter(Boolean)
  const asking = paragraphs.reverse().find((p) => /\?\s*$/.test(p) || /\?\s*\*{0,2}$/.test(p))
  if (!asking) return null
  // Sentences end at punctuation followed by a capital, so "1.237,27 €" stays whole.
  const sentences = asking.replace(/\s+/g, ' ').split(/(?<=[.!?])\s+(?=[A-ZČĆŠŽĐ"“(])/)
  return sentences.filter((s) => s.includes('?')).slice(-2).join(' ').replace(/[*_`#]/g, '').trim().slice(0, 300) || null
}

export function claude(path) {
  const lines = tail(path)
  let title = null
  let cwd = null
  let human = 0
  let last = 0
  // The desktop app asks its closing question in the wrap-up box; the text after it doesn't repeat it.
  let boxed = null
  let asked = null
  let request = ''
  // Where the session is now: its latest words, or the wrap-up box's recap.
  let latest = ''
  // Where it runs: the Claude app, or a terminal.
  let entry = ''
  const prs = new Set()
  const edits = new Set()
  for (const d of lines) {
    if (d.entrypoint) entry = d.entrypoint
    if (d.type === 'user' || d.type === 'assistant') prsIn(prs, d.message?.content)
    if (d.type === 'assistant') for (const b of d.message?.content || []) if (b.type === 'tool_use' && EDITS.has(b.name)) wrote(edits, b.input?.file_path || b.input?.notebook_path)
    if (d.isSidechain) continue
    if (d.type === 'custom-title' && d.customTitle) title = d.customTitle
    if (d.cwd) cwd = d.cwd
    const ts = d.timestamp ? Date.parse(d.timestamp) / 1000 : 0
    if (d.type === 'user' || d.type === 'assistant') last = Math.max(last, ts)
    if (d.type === 'user' && d.origin?.kind === 'human') { human = ts; boxed = null; asked = null; request = said(d.message?.content) || request }
    // A scheduled run starts a new turn too, but nobody answered anything.
    if (d.type === 'user' && d.origin?.kind === 'task-notification') { boxed = null; asked = null; request = said(d.message?.content) || request }
    if (d.type !== 'assistant') continue
    for (const b of d.message?.content || []) {
      // The wrap-up box's recap is what the question is about.
      if (b.type === 'tool_use' && /wrap_up$/.test(b.name || '') && b.input?.recap) latest = b.input.recap
      if (b.type === 'text' && b.text?.trim()) latest = b.text
      if (b.type === 'tool_use' && /wrap_up$/.test(b.name || '') && b.input?.ask) boxed = { ts, text: b.input.ask, id: d.uuid, said: `${b.input.recap || ''}\n\n${b.input.ask}` }
      // A question in passing, followed by more text that asks nothing, was answered by the assistant itself.
      else if (b.type === 'text' && b.text?.trim()) asked = question(b.text) ? { ts, text: question(b.text), id: d.uuid, said: b.text } : null
    }
  }
  const session = basename(path, '.jsonl')
  return { agent: 'Claude', provider: 'claude', session, title: title || (cwd ? basename(cwd) : 'Claude Code'), cwd, human, last, request, latest, app: entry === 'claude-desktop' ? 'desktop' : 'terminal', prs: [...prs].slice(-6), edits: [...edits].slice(-150), ask: asked || boxed }
}

// Desktop and editor sessions both report source "vscode". The client originator is what
// distinguishes the Codex app; an editor session must still resume in its own terminal.
export function codexApp(meta = {}) {
  const client = typeof meta.client === 'string' ? meta.client : meta.client?.name
  const desktop = [meta.originator, client].some(value => /\bcodex[ _-]*(?:work[ _-]*)?desktop\b/i.test(value || ''))
  return desktop || meta.source === 'desktop' ? 'desktop' : 'terminal'
}

export function codex(path) {
  const lines = tail(path)
  let cwd = null
  let model = ''
  let metadata = {}
  let session = basename(path, '.jsonl')
  let human = 0
  let last = 0
  let ask = null
  let first = ''
  let request = ''
  let latest = ''
  const prs = new Set()
  const edits = new Set()
  const head = firstLine(path)
  if (head?.type === 'session_meta') { metadata = head.payload || {}; cwd = metadata.cwd; session = metadata.id || session; model = metadata.model || '' }
  for (const d of lines) {
    const p = d.payload || {}
    const ts = d.timestamp ? Date.parse(d.timestamp) / 1000 : 0
    if (d.type === 'session_meta') { metadata = { ...metadata, ...p }; cwd = p.cwd || cwd; session = p.id || session; model = p.model || model }
    if (d.type === 'turn_context' && p.model) model = p.model
    if (d.type === 'response_item') prsIn(prs, p)
    if (d.type === 'response_item' && /call$/.test(p.type || '')) for (const m of JSON.stringify(p).matchAll(PATCHED)) wrote(edits, resolve(cwd || home, m[1].trim()))
    if (d.type !== 'response_item' || p.type !== 'message') continue
    const text = (p.content || []).map((c) => c.text || '').join('\n')
    // Instructions and environment notes arrive as user messages too; they start with a tag.
    if (p.role === 'user' && text.trim() && !text.trim().startsWith('<')) { human = ts; ask = null; request = text.trim(); first ||= text.trim().replace(/\s+/g, ' ').slice(0, 80) }
    last = Math.max(last, ts)
    if (p.role === 'assistant') { ask = question(text) ? { ts, text: question(text), id: p.id || String(ts), said: clean(text) } : null; if (text.trim()) latest = clean(text) }
  }
  // Exec and spawned agents are another session's work, not conversations with the owner.
  if (metadata.source === 'exec' || metadata.source?.subagent || metadata.thread_source === 'subagent') return { own: true, session }
  const agent = /astra/i.test(model) ? 'Astra' : /sol/i.test(model) ? 'Sol' : 'Codex'
  return { agent, provider: 'codex', model, originator: metadata.originator, session, title: first || (cwd ? basename(cwd) : 'Codex'), cwd, human, last, request, latest, app: codexApp(metadata), prs: [...prs].slice(-6), edits: [...edits].slice(-150), ask }
}

export function collect(db, { claudeDir = CLAUDE, codexDir = CODEX } = {}) {
  // Kier's own questions to Claude run in its data folder: the companion's chats, not yours.
  const all = [...recent(claudeDir, 1).map(claude), ...recent(codexDir, 3).map(codex)].filter(Boolean)
    .map((s) => (s.cwd?.startsWith(dataDir) ? { own: true, session: s.session } : s))
  const sessions = all.filter((s) => !s.own)
  const notYours = db.prepare(`insert into task_state (item_id, status, changed_at, reason) select id, 'dismissed', ?, 'an agent run, not your conversation'
    from items where source = ? and json_extract(meta, '$.session') = ? and id not in (select item_id from task_state)`)
  for (const s of all.filter((s) => s.own)) notYours.run(now(), source, s.session)
  const items = []
  // Going back to a session doesn't merge its pull request: work it left unfinished closes on its own evidence.
  const answered = db.prepare(`insert into task_state (item_id, status, changed_at, reason) select id, 'done', ?, 'you answered in the session'
    from items where source = ? and json_extract(meta, '$.session') = ? and ts < ? and json_extract(meta, '$.kind') is not 'stalled'
    and id not in (select item_id from task_state)`)
  for (const s of sessions) {
    if (s.human) answered.run(now(), source, s.session, s.human)
    // What each session was about, once a day it was active: evidence that a promised fix was worked on.
    if (s.last) {
      items.push({
        id: `${source}:${s.session}:day${Math.floor(s.last / 86400)}`, source, thread: s.title, sender: s.agent, fromMe: true, ts: Math.floor(s.last),
        text: `Worked with ${s.agent} on: ${s.title}`,
        // What you last asked it and where it is now, so "I gave Claude this, how's it doing?" has an answer.
        meta: { agent: s.agent, provider: s.provider, model: s.model, originator: s.originator, session: s.session, kind: 'session', cwd: s.cwd, at: Math.floor(s.last), human: Math.floor(s.human), app: s.app, prs: s.prs, edits: s.edits,
          request: start(redact(s.request).text, 400), latest: end(redact(s.latest).text, 600) },
      })
    }
    if (!s.ask?.text || s.ask.ts < s.human || s.ask.ts > now() - IDLE) continue
    const { text } = redact(s.ask.text)
    items.push({
      id: `${source}:${s.session}:${s.ask.id}`, source, thread: s.title, sender: s.agent, fromMe: false, ts: Math.floor(s.ask.ts), text,
      meta: { agent: s.agent, provider: s.provider, model: s.model, originator: s.originator, app: s.app, session: s.session, cwd: s.cwd, request: start(redact(s.request).text, 500), said: end(redact(s.ask.said || '').text, 1500) },
    })
  }
  const added = addItems(db, items)
  // Items seen before keep their row; their context is filled in as it is read, and a session's time follows its
  // latest activity, so work done after a promise counts as after it.
  const update = db.prepare("update items set meta = ?, ts = ? where id = ? and source = 'ai'")
  for (const i of items) update.run(JSON.stringify(i.meta), i.ts, i.id)
  // These are tasks by definition, so they skip the tagger: the summary is the question itself.
  const tag = db.prepare(`insert or ignore into tags (item_id, is_task, due, when_words, amount, urgency, summary, model, tagged_at, second, card)
    values (?, 1, '', '', '', 1, ?, 'rule', ?, 1, 'ask')`)
  for (const i of items.filter((i) => i.meta.kind !== 'session')) tag.run(i.id, `${i.sender} asked: ${i.text}`.slice(0, 200), now())
  return added
}
