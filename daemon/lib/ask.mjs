import { evidenceLine, untrustedBlock, EVIDENCE_RULE, briefEvidence } from './evidence-trust.mjs'
import { ASK_DETAILS, createReminder, modelReminder, reminderIntent, reminderRequest } from './create-reminder.mjs'
import { command, DOES, SAME, STATE, TO } from './command.mjs'
import { CODEX_UNAVAILABLE } from './ask-isolation.mjs'
import { authorization, readScope, localAuthorization } from './authorization.mjs'
import { parseModelJSON } from './errors.mjs'
import { modelFetch } from './model-provider.mjs'
// Talking to Kier: a question goes to Claude or Codex, which read the vault through Kier's MCP tools, or to the
// local model with today's brief. Claude and Codex use the owner's own subscriptions and command line logins.
import { spawn } from './child-process.mjs'
import { existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { config, dataDir, home, tmpDir } from './config.mjs'
import { P } from './lang.mjs'
import { profileText } from './profile.mjs'

const cap = (s) => s[0].toUpperCase() + s.slice(1)
import { aboutItem } from './resolve.mjs'
import { sent } from './settings.mjs'
import { brief, dayLabel, daysText, plusDays, tasks, today } from './tasks.mjs'
import { person as named, search } from './meaning.mjs'

const first = (paths) => paths.find((p) => existsSync(p)) || null
export const CLAUDE = first([resolve(home, '.local/bin/claude'), '/opt/homebrew/bin/claude', '/usr/local/bin/claude'])
export const CODEX = first(['/opt/homebrew/bin/codex', '/usr/local/bin/codex', resolve(home, '.local/bin/codex')])
// External Ask receives only scoped read tools. Codex is unavailable until its
// runner supplies an enforceable global tools-only boundary (ask-isolation.mjs).
export const TOOLS = ['kier_brief', 'kier_tasks', 'kier_search', 'kier_day', 'kier_item'].map((t) => `mcp__kier__${t}`).join(',')
const KIER_MCP = { command: process.execPath, args: ['--disable-warning=ExperimentalWarning', resolve(new URL('../bin/mcp.mjs', import.meta.url).pathname)], env: { KIER_DATA_DIR: dataDir, KIER_CLIENT: 'claude', KIER_MCP_ROLE: 'read-only' } }
export const CLAUDE_LOCK = ['--tools', '', '--restricted', '--setting-sources', '', '--disable-slash-commands', '--no-session-persistence', '--strict-mcp-config', '--mcp-config', JSON.stringify({ mcpServers: { kier: KIER_MCP } })]
export const agents = () => ({ claude: !!CLAUDE, codex: false, kier: true, unavailable: { codex: CODEX_UNAVAILABLE }, default: CLAUDE ? 'claude' : 'kier' })

// Include previous questions for follow-ups, but drop stale refusal answers so they do not
// prevent the model from using newly available evidence.
const REFUSED = /\b(don'?t|do not|cannot|can'?t|unable to|not able to|no access)\b[^.]{0,80}\b(know|have|access|information|tell|provide|share|details)\b/i
const turn = (h) => `${config.me}: ${h.q}${!h.a || REFUSED.test(h.a) ? '' : `\nKier: ${h.a}`}`
// Who the owner is (profile.mjs) goes along with every question, so "tell me about myself" has an answer.
const who = () => { const p = profileText(); return p ? `\n\nWho ${config.me} is, from Kier's profile of ${P.him}:\n${p}\n\n` : '\n\n' }
const intro = (q, history, about) => `You are Kier, ${config.me}'s quiet assistant. Use the kier tools before answering. Answer plainly in at most 4 short sentences. ${EVIDENCE_RULE}

${untrustedBlock({ about, history })}

Owner question: ${q}`

// About one item, the local model answers from what the vault shows about it; otherwise from today's brief.
const ITEM = `You are Kier, ${config.me}'s quiet assistant, and you are talking with ${config.me} ${P.self}: call ${P.him} "you", never by name. You're asked about one item in ${P.his} vault; below is everything the vault shows about it: what happened since, the rest of that chat, and where such things usually go, checked just now. Answer in at most 3 short sentences. If a line answers it, say so and say where and when; something new where it usually goes, after the item, usually means it's done, even under another name (release notes posted as a blog post about the same change). If nothing does, say what you checked and that it doesn't show yet. Never tell ${P.him} to ask ${P.self}.`
// Answer the requested topic using evidence, rather than substituting the daily brief.
const DAY = `You are Kier, ${config.me}'s quiet assistant, talking with ${P.him}: call ${P.him} "you", never by name. Answer the question ${P.he} asked, in at most 3 short sentences. When the messages found below answer it, say what was said, quote a few of the words, and say which chat and which day. A plan agreed in a chat is a plan even when it isn't in the calendar, and one that repeats (every Friday) holds for each such day. When messages disagree (a time changed), the latest holds. If nothing below answers it, say you couldn't find it; don't answer a different question.`
// Spell out upcoming dates and weekdays; do not ask the model to calculate them.
const week = () => `Today is ${dayLabel(today())}. The next seven days: ${[1, 2, 3, 4, 5, 6, 7].map((n) => `${dayLabel(plusDays(today(), n))}${n === 1 ? ' (tomorrow)' : ''}`).join(', ')}.`
// A day summary is structured evidence for the requested day.
const ON_DAY = `You are Kier, ${config.me}'s quiet assistant, talking with ${P.him}: call ${P.him} "you", never by name. Below is each day ${P.he} asked about, with what's on ${P.his} calendar and list that day: answer from it, with the time of each thing. At most 3 short sentences. A day with nothing on it is free.`
// Label group messages explicitly so a group activity is not attributed solely to the sender.
const APP = { whatsapp: 'WhatsApp', imessage: 'iMessage', discord: 'Discord' }
function said(db, found) {
  const many = db.prepare('select count(distinct sender) n from items where source = ? and thread = ? and from_me = 0')
  const group = new Map()
  const where = (m) => {
    if (!APP[m.source] || !m.thread) return `${m.source}${m.thread ? `, ${m.thread}` : ''}`
    const key = `${m.source}\n${m.thread}`
    if (!group.has(key)) group.set(key, many.get(m.source, m.thread).n > 1)
    return group.get(key) ? `${APP[m.source]} group "${m.thread}"` : `${APP[m.source]} chat with ${m.thread}`
  }
  const when = (m) => new Date(m.ts * 1000).toLocaleString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })
  return found.map((m) => evidenceLine(m, `[${where(m)}, ${when(m)}] ${String(m.text).slice(0, 300)}`)).join('\n')
}

// Asked to change something on the list ("that chat was marked done, put it back", "that's not mine"): which task, and
// to what, become buttons under the answer. Kier only offers; the owner's click changes it (/api/mark).
const ACTING = /\b(put (it |that |them )?back|revert|undo|reopen|re-?open|un-?done|not done|mark(ed)?\b.*\b(done|open)|tick(ed)? (it )?off|snooze|remind me|(move|push|shift)\b.*\btomorrow|not mine|isn'?t mine|dismiss|vrati|odzna[cč]i|ozna[cč]i|nije moj|gotovo)\b/i
// What's on your plate for a day ("what do I have tomorrow", "am I free Friday"): the brief has the calendar and the
// list, so that's the answer. Old messages only muddle it, their "tomorrow" was a different day.
const PLANS = /\b(what'?s|what is|what do i have|have i got|anything|am i (free|busy)|do i (have|need)|my (day|plans?|schedule|calendar|week))\b.*\b(today|tonight|tomorrow|this week|next week|weekend|monday|tuesday|wednesday|thursday|friday|saturday|sunday|danas|sutra|vikend)\b/i
// Expand a topic into words people use in each configured language. Combine these terms
// with the query and semantic retrieval.
const WORDS = `${config.me} writes ${config.languages.join(' and ')}. Give 4 to 6 single words that messages about this question's topic would contain, in each of those languages, as stems where a language bends words (keramik, radionic). Only nouns and verbs of the topic: no names, no question words. Reply with only the words, comma separated.`
async function chatWords(q) {
  const res = await modelFetch('/api/chat', {
    method: 'POST', signal: AbortSignal.timeout(20000),
    body: JSON.stringify({ model: config.model, asked: true, stream: false, think: false, keep_alive: config.chatKeepAlive, options: { temperature: 0, num_predict: 40 }, messages: [
      { role: 'system', content: WORDS }, { role: 'user', content: q },
    ] }),
  })
  if (!res.ok) return []
  return String((await res.json()).message?.content || '').toLowerCase().split(/[,\n]+/).map((w) => w.trim()).filter((w) => /^\p{L}{4,}$/u.test(w)).slice(0, 6)
}

// What a question is about beyond the day and the asking ("puzzles" in "do I have puzzles on Friday").
const SCAFFOLD = /^(what|whats|have|anything|free|busy|need|plan|plans|planned|schedule|calendar|today|tonight|tomorrow|this|next|week|weekend|monday|tuesday|wednesday|thursday|friday|saturday|sunday|danas|sutra|vikend|else|there|then|again|like|really|still|left|going|happening|doing)$/
const topic = (q) => (q.toLowerCase().match(/\p{L}{4,}/gu) || []).some((w) => !SCAFFOLD.test(w))
const WEEKDAYS = [/\b(sunday|nedjelj)/i, /\b(monday|ponedjelj)/i, /\b(tuesday|utor)/i, /\b(wednesday|srijed)/i, /\b(thursday|[cč]etvrt)/i, /\b(friday|pet(ak|ku))\b/i, /\b(saturday|subot)/i]

// Which days such a question means, first and last, worked out here rather than by the model.
function daysAsked(q) {
  const t0 = today()
  const wd = new Date(`${t0}T12:00:00Z`).getUTCDay()
  const at = (n) => plusDays(t0, n)
  if (/\b(day after tomorrow|prekosutra)\b/i.test(q)) return [at(2), at(2)]
  if (/\b(tomorrow|sutra)\b/i.test(q)) return [at(1), at(1)]
  if (/\b(today|tonight|danas|ve[cč]eras)\b/i.test(q)) return [t0, t0]
  // On a weekend, "next weekend" is the one after; on a weekday it's the coming one, same as "this weekend".
  if (/\bnext weekend\b/i.test(q) && (wd === 0 || wd === 6)) return wd === 0 ? [at(6), at(7)] : [at(7), at(8)]
  if (/\b(weekend|vikend)\b/i.test(q)) return wd === 0 ? [t0, t0] : wd === 6 ? [t0, at(1)] : [at(6 - wd), at(7 - wd)]
  if (/\bnext week\b/i.test(q)) { const monday = (8 - wd) % 7 || 7; return [at(monday), at(monday + 6)] }
  // On a Sunday, "this week" is the one starting tomorrow.
  if (/\bthis week\b/i.test(q)) return [t0, at((7 - wd) % 7 || 7)]
  const weekday = WEEKDAYS.findIndex((re) => re.test(q))
  if (weekday >= 0) return [at((weekday - wd + 7) % 7), at((weekday - wd + 7) % 7)]
  return null
}
const ACT =`${config.me} asked Kier to change something on ${P.his} list. Below are the tasks that may be meant, numbered, each with where it's from and its state now. Which does ${P.he} want changed, and to what: "open" (back on the list, not done), "done", "snoozed" (tomorrow) or "dismissed" (not ${P.his})? Only tasks the request clearly means, usually one; none if it's unclear. Reply with only JSON: {"actions": [{"n": 1, "to": "open"}]}`

async function actionsFor(db, q, found, item) {
  const ids = new Set(found.map((m) => m.id))
  const threads = new Set(found.map((m) => m.thread).filter(Boolean))
  const all = tasks(db, { days: 30 })
  const at = (t) => t.done_at || t.ts
  // Tasks around what search found, what was finished or set aside lately (a "put it back" is usually about one of those),
  // and tasks whose own summary has the question's words.
  const ws = (q.toLowerCase().match(/[\p{L}\p{N}]{4,}/gu) || []).filter((w) => !/^(mark|marked|done|back|thing|that|this|please|revert|undo|again|mistake|chat|task|list|from|with|about|what|when|have|just)$/.test(w))
  const candidates = item ? all.filter((t) => t.id === item) : [...new Map([
    ...all.filter((t) => ids.has(t.id) || threads.has(t.thread)).slice(0, 8),
    ...all.filter((t) => ['done', 'handled', 'dismissed', 'snoozed'].includes(t.state) && at(t) > Date.now() / 1000 - 3 * 86400).sort((x, y) => at(y) - at(x)).slice(0, 8),
    ...all.filter((t) => ws.some((w) => `${t.summary} ${t.text}`.toLowerCase().includes(w))).slice(0, 6),
  ].map((t) => [t.id, t])).values()].slice(0, 15)
  if (!candidates.length) return []
  const list = candidates.map((t, i) => evidenceLine(t, `${i + 1}. ${t.summary || String(t.text).slice(0, 80)} (${t.thread || t.source}, ${STATE[t.state] || t.state})`)).join('\n')
  const res = await modelFetch('/api/chat', {
    method: 'POST', signal: AbortSignal.timeout(60000),
    body: JSON.stringify({ model: config.model, asked: true, stream: false, think: false, keep_alive: config.chatKeepAlive, options: { temperature: 0 },
      messages: [{ role: 'system', content: `${ACT} ${EVIDENCE_RULE}` }, { role: 'user', content: `${untrustedBlock(list)}\n\nOwner question: ${q}` }] }),
  })
  if (!res.ok) return []
  const out = parseModelJSON((await res.json()).message.content.match(/\{[\s\S]*\}/)?.[0] ?? '{}')
  return (out.actions || []).map((a) => ({ t: candidates[Number(a.n) - 1], to: a.to }))
    .filter((a) => a.t && TO[a.to] && !SAME[a.to].includes(a.t.state))
    .slice(0, 3).map((a) => ({ id: a.t.id, status: a.to, label: TO[a.to], summary: a.t.summary || '', state: a.t.state }))
}

// Supply earlier turns as background rather than authoritative model answers.
async function local(q, history = [], about = '', on = QUIET, item = null, acting = true) {
  const earlier = history.length
    ? `\n\nEarlier in this chat (background only):\n${history.map(turn).join('\n')}`
    : ''
  // For a topic question, retrieve relevant conversations as well as day summaries.
  // A bare date question can use the structured calendar and task list.
  const plans = PLANS.test(q) && !topic(q) && !named(globalThis.kierDb, q)
  // A follow-up ("I mean on Friday") is searched with the questions before it.
  const context = history.slice(-3).map((h) => h.q).join('\n')
  if (!about && !plans) on.status('Working out what to look for')
  const extra = about || plans ? [] : await chatWords(context ? `${context}\n${q}` : q).catch(() => [])
  const found = about || plans ? [] : await search(globalThis.kierDb, q, { step: on.status, context, extra }).catch(() => [])
  // "Anything else?" after "what do I have on Friday?" is still about Friday.
  const days = daysAsked(q) || (history.length ? daysAsked(history.at(-1).q) : null)
  if (!about && !found.length) on.status(plans ? 'Looking at your calendar and list' : 'Reading your brief')
  let offered = []
  if (acting && ACTING.test(q)) {
    on.status('Finding what to change')
    offered = await actionsFor(globalThis.kierDb, q, found, item).catch(() => [])
  }
  // Describe the evidence and available action consistently with the button shown.
  if (offered.length) {
    const out = offered.length === 1
      ? `Found it: “${offered[0].summary.replace(/[.!]$/, '')}”, ${STATE[offered[0].state] || offered[0].state}. The button below ${DOES[offered[0].status]}.`
      : `Found ${offered.length}: ${offered.map((o) => `“${o.summary}”`).join(' and ')}. The buttons below do it.`
    on.text(out)
    return { out, actions: offered }
  }
  const buttons = ''
  on.status('Thinking')
  const vault = found.length ? `Messages found for this question, oldest first (a "tomorrow" or "this Friday" in one counts from the day it was sent):\n${said(globalThis.kierDb, found)}\n\n` : ''
  // The days the question names, when it names any, otherwise the brief.
  const calendar = `${days ? `${cap(P.his)} calendar and list:\n${daysText(globalThis.kierDb, ...days, { evidenceLabels: true })}` : briefEvidence(brief(globalThis.kierDb))}`
  const res = await modelFetch('/api/chat', {
    method: 'POST', signal: AbortSignal.timeout(120000),
    body: JSON.stringify({ model: config.model, asked: true, stream: true, think: false, keep_alive: config.chatKeepAlive, options: { temperature: 0.3, num_ctx: 8192 }, messages: [
      { role: 'system', content: `${about ? ITEM : plans ? ON_DAY : `${DAY} ${week()}`}${buttons} ${EVIDENCE_RULE}` },
      { role: 'user', content: `${untrustedBlock({ evidence: about || (plans ? daysText(globalThis.kierDb, ...(days || [today(), today()]), { evidenceLabels: true }) : vault + calendar), history: earlier, profile: who() })}\n\nOwner question: ${q}` },
    ] }),
  })
  if (!res.ok) return { error: `local model ${res.status}` }
  let text = ''
  for await (const line of lines(res.body)) {
    try { text += JSON.parse(line).message?.content || '' } catch { continue }
    on.text(text)
  }
  return { out: text.trim(), ...(offered.length && { actions: offered }) }
}

// The lines of a streamed body, as they arrive.
async function* lines(body) {
  const decoder = new TextDecoder()
  let buf = ''
  for await (const chunk of body) {
    buf += decoder.decode(chunk, { stream: true })
    let i
    while ((i = buf.indexOf('\n')) >= 0) { yield buf.slice(0, i); buf = buf.slice(i + 1) }
  }
  if (buf.trim()) yield buf
}

// A command whose output is one JSON event per line, each handed over as it comes.
export function events(cmd, args, onEvent, input = '', timeout = 240000) {
  return new Promise((done) => {
    const p = spawn(cmd, args, { cwd: tmpDir, env: {}, stdio: ['pipe', 'pipe', 'ignore'] })
    p.stdin.on('error', () => {})
    p.stdin.end(input)
    const timer = setTimeout(() => p.kill(), timeout)
    let buf = ''
    p.stdout.on('data', (d) => {
      buf += d
      let i
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i)
        buf = buf.slice(i + 1)
        try { onEvent(JSON.parse(line)) } catch {}
      }
    })
    p.on('close', () => { clearTimeout(timer); done() })
    p.on('error', () => { clearTimeout(timer); done() })
  })
}

const LOOKING = 'Looking through your vault'
// What Claude or Codex is doing with Kier's tools, for the chat's waiting line: which tool, and with what.
function cue(name = '', input = {}) {
  const tool = String(name).replace(/^mcp__kier__/, '')
  try { if (typeof input === 'string') input = JSON.parse(input) } catch { input = {} }
  if (tool === 'kier_search') return input?.query ? `Searching your vault for "${String(input.query).slice(0, 40)}"` : 'Searching your vault'
  if (tool === 'kier_day') return input?.date ? `Looking at your day, ${new Date(`${input.date}T12:00:00`).toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short' })}` : 'Looking at your day'
  if (tool === 'kier_tasks') return 'Going through your tasks'
  if (tool === 'kier_brief') return "Reading today's brief"
  if (tool === 'kier_item') return 'Reading a message'
  return LOOKING
}

// Claude streams word by word. Text it writes before using a tool ("let me check") is replaced by the answer after.
export async function claude(prompt, on, runEvents = events) {
  let text = ''
  let final = null
  await runEvents(CLAUDE, ['-p', ...CLAUDE_LOCK, '--allowedTools', TOOLS, '--output-format', 'stream-json', '--verbose', '--include-partial-messages'], (e) => {
    const ev = e.type === 'stream_event' ? e.event : null
    if (ev?.type === 'content_block_start' && ev.content_block?.type === 'tool_use') { text = ''; on.text(''); on.status(cue(ev.content_block.name)) }
    if (ev?.type === 'content_block_start' && ev.content_block?.type === 'thinking') on.status('Thinking')
    // The whole call comes with the finished message: now the waiting line can say what it's looking for.
    if (e.type === 'assistant') for (const c of e.message?.content || []) if (c.type === 'tool_use') on.status(cue(c.name, c.input))
    if (ev?.type === 'content_block_delta' && ev.delta?.type === 'text_delta') { text += ev.delta.text; on.text(text) }
    if (e.type === 'result' && typeof e.result === 'string') final = e.result
  }, prompt)
  const out = (final ?? text).trim()
  return out ? { out } : { error: 'Claude gave no answer' }
}

const QUIET = { text() {}, status() {} }

// `on` hears the answer as it forms: text(the answer so far) and status(what it's doing), for a reply that streams.
// Kier on this Mac unless the owner picks Claude or Codex for this question: nothing leaves the Mac by default.
// The new name in a card's own chat: "rename this to "X"", "call it X", "change the title to X", "preimenuj ovo u X".
const RENAME = /^\s*(?:please\s+|can you\s+|could you\s+)?(?:rename|retitle|preimenuj)(?:\s+(?:this|it|that|the card|the task|ovo|ga|to))?\s+(?:to|as|into|u)\s+(.+?)\s*$|^\s*(?:call|name)\s+(?:it|this)\s+(.+?)\s*$|^\s*change\s+(?:the|its)\s+(?:title|name)\s+to\s+(.+?)\s*$/i
export function renameTo(q) {
  const m = String(q).match(RENAME)
  const title = (m?.[1] || m?.[2] || m?.[3] || '').trim().replace(/^["“'‘]+|["”'’]+$/g, '').replace(/\.$/, '').trim()
  return title.length >= 3 ? title : null
}

export async function ask(db, q, agent = 'kier', history = [], item = null, on = QUIET) {
  // Fail before reading the vault, building a prompt, renaming a card or starting a process.
  if (agent === 'codex') return { agent, seconds: 0, unavailable: true, out: CODEX_UNAVAILABLE }
  // A reply to "what should I remind you about?" is the reminder itself.
  const answering = !item && history.at(-1)?.a === ASK_DETAILS
  let request = !item && (reminderRequest(q) || (answering && reminderRequest(`remind me to ${q}`)))
  // What was typed, read as one action by Kier's own model (command.mjs), when the exact phrasings above didn't
  // match. Sure of itself, it settles the question here; unsure, or with the owner's own model server, it is null
  // and everything below runs as it always did. A question for Claude only pays for this when it looks like a command.
  const began = Date.now()
  let typed = null
  if (!request && !answering && !(item && renameTo(q)) && config.typedCommands !== false && (agent === 'kier' || reminderIntent(q) || ACTING.test(q) || RENAME.test(q))) {
    on.status?.('Reading what you asked')
    typed = await command(db, q, { item }).catch(() => null)
    // In a card's own chat a reminder is about that card, which the paths below handle.
    if (item && ['remind', 'details'].includes(typed?.kind)) typed = null
  }
  if (typed?.kind === 'remind') request = typed.request
  if (typed?.kind === 'details') { on.text?.(ASK_DETAILS); return { agent, seconds: 0, out: ASK_DETAILS } }
  if (typed?.kind === 'offer' || typed?.kind === 'say') {
    on.text?.(typed.out)
    return { agent, seconds: Math.round((Date.now() - began) / 1000), out: typed.out, ...(typed.actions && { actions: typed.actions }) }
  }
  if (!request && !typed && !item && (answering || reminderIntent(q))) {
    const found = await modelReminder(answering ? `remind me to ${q}` : q, modelFetch, config.model).catch(() => null)
    if (found?.needsDetails) { on.text?.(ASK_DETAILS); return { agent, seconds: 0, out: ASK_DETAILS } }
    if (found) request = found
  }
  if (request) {
    const reminder = createReminder(db, request)
    if (!reminder) return { agent, seconds: 0, out: 'Could not add that reminder.' }
    const out = `Added: ${reminder.title}${reminder.when ? `, ${reminder.when}` : ''}.`
    on.text?.(out)
    return { agent, seconds: 0, out, created: reminder.id,
      actions: [{ id: reminder.id, status: 'dismissed', label: 'Undo', summary: reminder.title }] }
  }
  globalThis.kierDb = readScope(db, localAuthorization())
  const t0 = Date.now()
  // Handle an explicit rename in a card’s chat directly, regardless of the selected assistant.
  const renamed = typed?.kind === 'rename' ? typed : item && renameTo(q) ? { id: item, title: renameTo(q) } : null
  const title = renamed?.title
  if (title && db.prepare('update tags set summary = ? where item_id = ?').run(title, renamed.id).changes) {
    const out = `Renamed it to “${title}”.`
    on.text?.(out)
    return { agent, seconds: Math.round((Date.now() - t0) / 1000), out }
  }
  if (item) on.status('Reading what your vault knows about this')
  const about = item ? await aboutItem(db, item, agent === 'claude' ? authorization(config.scopes.claude || []) : authorization(null)) : ''
  let r
  // What goes to Claude or Codex is counted for "On this Mac"; the local model's isn't, it never leaves.
  const prompt = (agent === 'claude' && CLAUDE) || (agent === 'codex' && CODEX) ? intro(q, history, about) : null
  if (prompt) sent(db, 'chat', agent, prompt)
  if (agent === 'claude' && CLAUDE) r = await claude(prompt, on)
  // Read as a plain question above: the older guess at "is this asking for a change" doesn't get a second go.
  else r = await local(q, history, about, on, item, typed?.kind !== 'answer')
  return { agent, seconds: Math.round((Date.now() - t0) / 1000), ...r }
}
