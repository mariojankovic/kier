import { parseModelJSON } from './errors.mjs'
import { modelFetch } from './model-provider.mjs'
import { groundedTitle } from './title-grounding.mjs'
import { actionTitle, ownerVerdict } from './owner-action.mjs'
// A local model reads each new message once and notes whether the owner has something to do.
// Short replies see earlier messages from the same chat so references have a subject.
// The worked examples are invented.
import { discordCopy, discordMessage, reconcileDiscordCopies } from './discord-copies.mjs'
import { config } from './config.mjs'
import { P, calmed, speaks, wordRegex } from './lang.mjs'
import { names, slice } from './profile.mjs'
import { handles } from '../collectors/screenchats.mjs'
import { resolveDue } from './dates.mjs'
import { now } from './db.mjs'
import { cards, decide } from './second.mjs'

const TAGGED_SOURCES = ['whatsapp', 'imessage', 'mail', 'notifications', 'discord', 'chat', 'social']
const BALANCE = wordRegex('balance')
const OWED = wordRegex('owed')
const LATER = wordRegex('later')
const RELAY = wordRegex('relay')
const SAYS = wordRegex('says')
const CONTEXT_MESSAGES = 4
// Only short replies receive preceding context. Applying context to long messages can cause
// requests from that context to be tagged again instead of the current message.
const CONTEXT_BELOW_CHARS = 25
// Short multi-line replies need a longer look back to locate the request they answer.
export const SHORT_CONTEXT = 8
export const needsContext = (text) => Math.max(...String(text).split('\n').map((l) => l.trim().length)) < CONTEXT_BELOW_CHARS
// A chat moves on within hours; an email thread can sit for days.
// A reply on Threads or X can come days after the post it answers.
const CONTEXT_WINDOW = { whatsapp: 12 * 3600, imessage: 12 * 3600, discord: 12 * 3600, mail: 14 * 86400, social: 14 * 86400 }

const N = config.me
const UP = N.toUpperCase()
// Pronouns change the instructions' grammar, so each set is written out in full.

const SYSTEM = `You tag items for ${config.me}'s personal vault. ${config.about ? `${config.about} ` : ''}Items are WhatsApp messages, iMessages or emails, in ${config.languages.join(' or ')}.

Some items show earlier messages from the same chat, and some show the short reactions right after. Both are context only: tag ONLY the message under "Message to tag". The reactions only tell you how it was taken, never what it is about. Use the context to see who is being asked and what "it", "to" or "ovo" refers to, and write a specific summary ("Fix the sample gallery thumbnail refresh bug", not "Fix it"). Only use names of products, apps, pages or features supported by the message and its direct referent; never guess one. A sender name identifies a person, never a product or project. Profile notes explain relationships, not the subject of a task. Do not attach an earlier topic to a request just because it was mentioned nearby. If the message only names a feature, keep that feature name without inventing a product, destination or implementation. A missing website page is a page to add, not a software library to implement. Casual messages may contain typos, missing spaces, abbreviations, partial words and time corrections. Interpret them cautiously in their conversational role. Never expand unfamiliar fragments into product names, acronyms, meeting names or events. A time in a reply can describe the sender's own availability, departure, arrival or workday; that alone creates no action or appointment for the owner. An answer to the owner's question about the sender is information unless this reply explicitly asks the owner to act or confirms the owner's participation in an actual shared arrangement. Preserve real invitations, pickup requests, agreed calls and other explicit owner obligations. If the sender or the others laugh it off right after (haha, xD, 😂) or it is clearly banter, it is not a task.

When a reply gives a bare time or corrects one, interpret what happens then from the immediately answered question and its preceding turn. Distinguish arriving somewhere, starting work and finishing work; never change one into another. If the activity remains unclear, keep the summary neutral about the timing rather than inventing an event.

WHO HAS TO ACT matters most:
- If From says ${UP} ${P.SELF}, ${N} wrote it. A request ${P.he} ${P.makes} of someone else ("pošalji mi", "javi", "approve", "send me") is NOT ${P.his} task. Something ${P.he} ${P.promises} or ${P.commits} to ("riješit ću", "to cu rijesit", "I'll send it") IS ${P.his} task.
- If someone else wrote it, it is ${N}'s task only when it asks ${N} ("you", "ti", "vi", "${N}") to do something, or tells ${P.him} about an appointment, payment or deadline that concerns ${P.him}. In a group chat, a request is ${N}'s only if it is addressed to ${P.him}, by name or as a reply to what ${P.he} just said. A request that @mentions ${P.him} ("@${N}") is ${P.his}, even when the chat around it is joking. If ${P.he} hasn't written in the group lately, a request there is for whoever was talking, unless it names ${P.him}.

is_task true: pay a bill or invoice ${P.self} (not automatic card debits), send something, answer a question that needs ${P.his} decision or information, review something sent for ${P.his} review, keep a promise, attend an appointment, act on a notice that changes ${P.his} own schedule.
is_task false: chit chat, jokes, opinions, news, status updates about other people's work, FYI, receipts, automatic payments, newsletters, sales outreach, mass invitations, requests aimed at someone else.

when: copy the exact words from the message to tag that say when ("sutra", "u pon", "do 31.10.", "u 22:30", "tonight"). "" if it has none. Never guess.
due: the date those words mean, as YYYY-MM-DD, using the sent date. "" if when is "".
amount: money ${N} has to pay or will receive in this item, like "40 EUR" or "925 USD". "" if none.
urgency: 0 none, 1 low, 2 this week, 3 today.
summary: at most 12 words, in English, specific about what and for whom.

Reply with only the JSON object, no other text.`

const ME = `${UP} ${P.SELF} (${P.his} own outgoing message)`
const who = (item) => (item.from_me ? ME : `${item.sender} (incoming, to ${N})`)
const label = { whatsapp: 'WhatsApp', imessage: 'iMessage', mail: 'Email', notifications: 'Notification', discord: 'Discord' }
const clip = (s, n) => (s.length > n ? `${s.slice(0, n)}…` : s)

function fmt(source, where, from, sent, text, context = [], after = [], known = '') {
  const head = `Source: ${source}, ${where}${known ? `\n${known}` : ''}`
  if (!context.length && !after.length) return `${head}\nFrom: ${from}\nSent: ${sent}\n\n${text}`
  const lines = (cs) => cs.map((c) => `[${c.time}] ${c.from}: ${clip(c.text.replace(/\s+/g, ' '), c.long ? 560 : 240)}`).join('\n')
  return `${head}\n${context.length ? `Earlier in this chat (context only):\n${lines(context)}\n\n` : ''}Message to tag:\nFrom: ${from}\nSent: ${sent}\n\n${text}` +
    (after.length ? `\n\nRight after it (context only):\n${lines(after)}` : '')
}
const ans = (is_task, when, due, amount, urgency, summary) => JSON.stringify({ is_task, when, due, amount, urgency, summary })

// Entirely invented cast, groups and everyday situations; no examples come from personal chats.
const HR_SHOTS = [
  [fmt('WhatsApp', 'chat with Nika', `Nika (incoming, to ${N})`, 'Mon 2026-06-08 17:12', 'Hej, stigneš mi sutra do ručka prebaciti skice za policu?'),
    ans(true, 'sutra', '2026-06-09', '', 2, 'Send Nika the shelf sketches by lunch tomorrow')],
  [fmt('WhatsApp', 'Sample group', ME, 'Tue 2026-06-09 09:22', 'Filip daj mi pošalji popis namirnica do četvrtka'),
    ans(false, '', '', '', 0, `${N} asks Filip to send the grocery list by Thursday`)],
  [fmt('WhatsApp', 'chat with Borna', ME, 'Wed 2026-06-10 15:10', 'okej budem ja to poslao večeras',
    [{ time: '15:02', from: 'Borna', text: 'skica vrtne klupe još nije otišla Filipu' }, { time: '15:09', from: 'Borna', text: 'stigneš preuzeti?' }]),
    ans(true, 'večeras', '2026-06-10', '', 3, 'Send the garden bench sketch to Filip tonight')],
  [fmt('WhatsApp', 'Sample group', ME, 'Wed 2026-06-10 08:35', 'da, sredim to',
    [{ time: '08:31', from: 'Tea', text: 'gumb za preuzimanje slagalice ne reagira na tabletu' }]),
    ans(true, '', '', '', 2, 'Fix the unresponsive puzzle download button on tablets')],
  [fmt('WhatsApp', 'Sample group', `Tea (incoming, to ${N})`, 'Wed 2026-06-10 12:20', 'daj mi link za taj nacrt?',
    [{ time: '12:12', from: 'Filip', text: 'složio sam nacrt za novu galeriju crteža' }, { time: '12:18', from: 'Tea', text: 'odlično, hvala Filip' }]),
    ans(false, '', '', '', 0, 'Tea asks Filip for the drawing gallery draft link')],
  [fmt('Email', 'to me', `Priya (incoming, to ${N})`, 'Thu 2026-06-11 09:10', 'Subject: Boje za klupu\nMolimo uplatu 28 EUR za boje do 19.6.'),
    ans(true, 'do 19.6.', '2026-06-19', '28 EUR', 2, 'Pay Priya 28 EUR for bench paint')],
  [fmt('Email', 'to me', `Sam (incoming, to ${N})`, 'Fri 2026-06-12 08:00', 'Subject: Puzzle order receipt #SAMPLE-001\nYour card was charged €12.00 for a puzzle. Nothing remains to pay.'),
    ans(false, '', '', '12 EUR', 0, 'Puzzle order receipt from Sam, 12 EUR paid')],
  [fmt('Email', `to ${config.exampleEmail}`, `Lucija (incoming, to ${N})`, 'Fri 2026-06-12 15:40', `Subject: Garden sketch approval\nHello ${N}, please return the signed approval form for the garden sketch whenever you have a moment.`),
    ans(true, '', '', '', 1, 'Return the signed garden sketch approval form to Lucija')],
  [fmt('Email', `to ${config.exampleEmail}`, `Jonas (incoming, to ${N})`, 'Mon 2026-06-15 10:20', `Subject: Handmade bookmarks for sale\nHello ${N}, thanks for browsing my handmade bookmarks. Interested in a short introductory demo of the new designs?`),
    ans(false, '', '', '', 0, 'Sales outreach from Jonas about handmade bookmarks')],
  [fmt('WhatsApp', 'Sample group', `Borna (incoming, to ${N})`, 'Sat 2026-06-13 20:24', 'ahaha kakav kaos uz društvenu igru danas'),
    ans(false, '', '', '', 0, 'Borna jokes about the board game')],
  [fmt('WhatsApp', 'Sample group', `Filip (incoming, to ${N})`, 'Mon 2026-06-15 14:12', `${N} složi cijelu računalnu igru\ndo večere\nu jednoj poruci`, [],
    [{ time: '14:12', from: 'Filip', text: 'ahahaha' }, { time: '14:13', from: 'Tea', text: '😂😂' }]),
    ans(false, '', '', '', 0, `Filip jokes that ${N} should build a computer game`) ],
]
const EN_SHOTS = [
  [fmt('WhatsApp', 'chat with Nika', `Nika (incoming, to ${N})`, 'Mon 2026-06-08 17:12', 'Hi, can you forward the shelf sketches by lunch tomorrow?'),
    ans(true, 'by lunch tomorrow', '2026-06-09', '', 2, 'Send Nika the shelf sketches by lunch tomorrow')],
  [fmt('WhatsApp', 'Sample group', ME, 'Tue 2026-06-09 09:22', 'Filip please forward the grocery list by Thursday'),
    ans(false, '', '', '', 0, `${N} asks Filip to send the grocery list by Thursday`)],
  [fmt('WhatsApp', 'chat with Borna', ME, 'Wed 2026-06-10 15:10', "okay I'll send that tonight",
    [{ time: '15:02', from: 'Borna', text: "the garden bench sketch hasn't reached Filip" }, { time: '15:09', from: 'Borna', text: 'could you take over?' }]),
    ans(true, 'tonight', '2026-06-10', '', 3, 'Send the garden bench sketch to Filip tonight')],
  [fmt('WhatsApp', 'Sample group', ME, 'Wed 2026-06-10 08:35', "yes, I'll sort that",
    [{ time: '08:31', from: 'Tea', text: 'the puzzle download button is unresponsive on tablets' }]),
    ans(true, '', '', '', 2, 'Fix the unresponsive puzzle download button on tablets')],
  [fmt('WhatsApp', 'Sample group', `Tea (incoming, to ${N})`, 'Wed 2026-06-10 12:20', 'could I have the draft link?',
    [{ time: '12:12', from: 'Filip', text: 'the new drawing gallery draft is ready' }, { time: '12:18', from: 'Tea', text: 'excellent, thank you Filip' }]),
    ans(false, '', '', '', 0, 'Tea asks Filip for the drawing gallery draft link')],
  [fmt('Email', 'to me', `Priya (incoming, to ${N})`, 'Thu 2026-06-11 09:10', 'Subject: Bench paint\nPlease pay 28 EUR for paint by 19.6.'),
    ans(true, 'by 19.6.', '2026-06-19', '28 EUR', 2, 'Pay Priya 28 EUR for bench paint')],
  ...HR_SHOTS.slice(6, 9),
  [fmt('WhatsApp', 'Sample group', `Borna (incoming, to ${N})`, 'Sat 2026-06-13 20:24', 'haha what a chaotic board game today'),
    ans(false, '', '', '', 0, 'Borna jokes about the board game')],
  [fmt('WhatsApp', 'Sample group', `Filip (incoming, to ${N})`, 'Mon 2026-06-15 14:12', `${N} build an entire computer game\nbefore dinner\nin one message`, [],
    [{ time: '14:12', from: 'Filip', text: 'ahahaha' }, { time: '14:13', from: 'Tea', text: '😂😂' }]),
    ans(false, '', '', '', 0, `Filip jokes that ${N} should build a computer game`)],
]
const SHOTS = speaks('hr') ? HR_SHOTS : EN_SHOTS
// Indirect requests, explicit mentions and local resource alerts still need the owner's attention.
// These are invented edge cases, separate from general status updates about another person's work.
const ATTENTION_SHOTS = [
  [fmt('Discord', `Sample group (talking lately: Tea, ${N} too)`, `Tea (incoming, to ${N})`, 'Tue 2026-06-16 10:15', speaks('hr')
    ? 'Ak je katalog knjiga arhiviran, mogla bi nestat ova archived oznaka?'
    : 'If the book catalogue is archived, could this archived label disappear?'),
    ans(true, '', '', '', 1, 'Remove the redundant archived label from the book catalogue')],
  [fmt('Notification', `shown by the Discord app on ${N}'s Mac`, `Tea (incoming, to ${N})`, 'Tue 2026-06-16 11:45', `@${N}`),
    ans(true, '', '', '', 1, 'Check the direct mention from Tea in Discord')],
  [fmt('Notification', `shown by a resource monitor on ${N}'s Mac`, `Memory warning (incoming, to ${N})`, 'Tue 2026-06-16 14:20', 'Memory warning: sample-worker has stayed over 9 GB for 6 minutes while exporting the recipe catalogue. Review the active render job.'),
    ans(true, '', '', '', 3, 'Investigate sample-worker memory use during the recipe catalogue export')],
]
const PREFIX = [{ role: 'system', content: SYSTEM }, ...[...SHOTS, ...ATTENTION_SHOTS].flatMap(([u, a]) => [{ role: 'user', content: u }, { role: 'assistant', content: a }])]

const parts = (ts, opts) => new Intl.DateTimeFormat('en-GB', { timeZone: config.timezone, hour12: false, ...opts })
  .formatToParts(new Date(ts * 1000)).reduce((o, p) => ({ ...o, [p.type]: p.value }), {})
const sentLabel = (ts) => {
  const p = parts(ts, { weekday: 'short', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })
  return `${p.weekday} ${p.year}-${p.month}-${p.day} ${p.hour}:${p.minute}`
}
// "14:22" for the same day as the message being tagged, "Mon 12 Oct 14:22" otherwise.
export function contextLine(c, itemTs) {
  const p = parts(c.ts, { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })
  const same = sentLabel(c.ts).slice(0, 14) === sentLabel(itemTs).slice(0, 14)
  return { time: same ? `${p.hour}:${p.minute}` : `${p.weekday} ${p.day} ${p.month} ${p.hour}:${p.minute}`, from: c.from_me ? config.me : c.sender, text: c.text || '' }
}

// Tag a thought typed across several short messages once, after the burst and immediate
// reactions settle. Reactions help distinguish a request from banter.
const CHATS = new Set(['whatsapp', 'imessage', 'discord', 'chat', 'social'])
const BURST_GAP = 90
export const SETTLE = 3 * 60
const AFTER_WINDOW = 10 * 60
const AFTER_MESSAGES = 3
const REACTION = 40
// People can type over each other. A line sent before the next message could reasonably have
// been typed does not split a burst; a later deliberate reply does.
const OVERLAP = 30
const typing = (text) => Math.max(2, (text || '').length / 4)

// The burst this message belongs to, whether it is the burst's last message, and the replies that followed.
export function burstOf(db, item) {
  if (!CHATS.has(item.source)) return { last: true, text: item.text, read: item.text, start: item, after: [] }
  const rows = db.prepare('select id, sender, from_me, ts, text from items where source = ? and thread = ? and ts between ? and ? order by ts, rowid')
    .all(item.source, item.thread, item.ts - 30 * 60, item.ts + 30 * 60)
  const i = rows.findIndex((r) => r.id === item.id)
  if (i < 0) return { last: true, text: item.text, read: item.text, start: item, after: [] }
  const same = (r) => !!r.from_me === !!item.from_me && r.sender === item.sender
  // The sender's next or previous message: right next to it within the burst gap, or just past one line someone
  // else sent while it was being typed.
  const at = (j) => (j >= 0 && j < rows.length ? rows[j] : null)
  const step = (k, dir) => {
    const j = k + dir
    if (!at(j)) return -1
    if (same(at(j))) return Math.abs(at(j).ts - rows[k].ts) <= BURST_GAP ? j : -1
    const n = j + dir
    if (!at(n) || !same(at(n))) return -1
    const [early, late] = dir > 0 ? [rows[k], at(n)] : [at(n), rows[k]]
    return late.ts - early.ts <= OVERLAP && late.ts - at(j).ts < typing(late.text) ? n : -1
  }
  let a = i
  let b = i
  for (let j = step(a, -1); j >= 0; j = step(a, -1)) a = j
  for (let j = step(b, 1); j >= 0; j = step(b, 1)) b = j
  // Only short reactions directly after the burst count. A longer message begins a new topic,
  // which must not supply the task’s subject.
  const after = []
  for (const r of rows.slice(b + 1)) {
    if (after.length === AFTER_MESSAGES || r.ts - rows[b].ts > AFTER_WINDOW || (r.text || '').length > REACTION) break
    after.push(r)
  }
  const lines = rows.slice(a, b + 1).filter(same).map((r) => r.text || '')
  return { last: b === i, text: lines.join('\n'), read: corrected(lines).join('\n'), start: { ...item, ...rows[a] }, after: after.map((c) => contextLine(c, item.ts)) }
}

// A single-word follow-up can correct a typo in the preceding line. Give the model the corrected
// reading while preserving the original wording on the card.
export function corrected(lines) {
  const out = []
  for (const line of lines) {
    const word = line.trim().replace(/^\*+|\*+$/g, '')
    const prev = out.length ? out[out.length - 1] : null
    if (prev && /^\p{L}{3,}$/u.test(word)) {
      const parts = prev.split(/(\P{L}+)/u)
      let best = -1
      let bestD = Infinity
      parts.forEach((w, k) => {
        if (w.length < 3 || w.toLowerCase() === word.toLowerCase()) return
        const d = distance(w.toLowerCase(), word.toLowerCase())
        if (d <= (Math.max(w.length, word.length) >= 6 ? 2 : 1) && d <= bestD) { best = k; bestD = d }
      })
      if (best >= 0) { parts[best] = word; out[out.length - 1] = parts.join(''); continue }
    }
    out.push(line)
  }
  return out
}

function distance(a, b) {
  let row = Array.from({ length: b.length + 1 }, (_, j) => j)
  for (let i = 1; i <= a.length; i++) {
    const next = [i]
    for (let j = 1; j <= b.length; j++) next[j] = Math.min(row[j] + 1, next[j - 1] + 1, row[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1))
    row = next
  }
  return row[b.length]
}

// Recent group participants help determine who a request addresses. A conversation between
// other people should not silently become an obligation for the owner.
export function talkers(db, item) {
  const rows = db.prepare('select sender, from_me from items where source = ? and thread = ? and ts < ? and ts > ? order by ts desc limit 10')
    .all(item.source, item.thread, item.ts, item.ts - 3 * 3600)
  if (!rows.length) return `${N} hasn't written here lately`
  const names = [...new Set(rows.filter((r) => !r.from_me && r.sender !== item.sender).map((r) => r.sender))].slice(0, 3)
  const mine = rows.some((r) => r.from_me)
  return `${names.length ? `talking lately: ${names.join(', ')}` : 'quiet lately'}${mine ? `, ${N} too` : `; ${N} hasn't written here lately`}`
}

// A short reply may refer to a longer paste outside the immediate context window.
// Retain the paste’s beginning and end when there is no intervening topic boundary.
const ANCHOR = 200
const ANCHOR_WINDOW = 30 * 60
const ends = (s) => (s.length > 520 ? `${s.slice(0, 200)} … ${s.slice(-300)}` : s)

// Which conversation an item is part of. For a chat that's the chat; a notification's "thread" is only the app that
// showed it (Spark Mail, Discord), so its conversation is the sender, or the channel for a Discord message
// (a sender and channel label). Without this, every email of the morning read as one chat.
const convo = (r) => {
  const who = String(r.sender || '').replace(/[\u200e\u200f\u2066-\u2069]/g, '').trim()
  return who.match(/\(#([^,)]+)/)?.[1] || who
}
export const sameConversation = (item) => (r) => item.source !== 'notifications' || convo(r) === convo(item)

// The messages just before this one in the same chat, oldest first.
export function contextFor(db, item, limit = CONTEXT_MESSAGES) {
  const rows = db.prepare(`select sender, from_me, ts, text from items where source = ? and thread = ?
    and (ts < ? or (ts = ? and rowid < coalesce((select rowid from items where id = ?), 0))) and ts > ? and id != ?
    order by ts desc, rowid desc limit ${Number(limit) * (item.source === 'notifications' ? 20 : 1)}`).all(item.source, item.thread, item.ts, item.ts, item.id, item.ts - (CONTEXT_WINDOW[item.source] || 12 * 3600), item.id)
    .filter(sameConversation(item)).slice(0, Number(limit)).reverse()
  // A "BTW" starts a new subject. Keep its replies, but never fetch an older paste from before it.
  const topic = CHATS.has(item.source) ? rows.findLastIndex((r) => /^\s*(?:btw|by\s+the\s+way)\b/i.test(r.text || '')) : -1
  if (topic >= 0) rows.splice(0, topic)
  if (topic < 0 && rows.length && CHATS.has(item.source) && !rows.some((r) => (r.text || '').length > ANCHOR)) {
    const paste = db.prepare(`select sender, from_me, ts, text from items where source = ? and thread = ? and ts < ? and ts > ? and length(text) > ?
      order by ts desc limit 1`).get(item.source, item.thread, rows[0].ts, item.ts - ANCHOR_WINDOW, ANCHOR)
    if (paste) rows.unshift({ ...paste, text: ends(paste.text.replace(/\s+/g, ' ')), long: true })
  }
  return rows.map((c) => ({ ...contextLine(c, item.ts), ...(c.long && { long: true }) }))
}

// A short direct-chat answer can exceed the old per-line threshold through run-on
// typing. Give it the adjacent owner turn, without fetching an older paste/topic.
export function contextForTag(db, item, text = item.text) {
  let meta = {}
  try { meta = typeof item.meta === 'object' ? item.meta || {} : JSON.parse(item.meta || '{}') } catch {}
  const direct = ['whatsapp', 'imessage'].includes(item.source)
    || ['discord', 'chat'].includes(item.source) && meta.group === false
  if (!item.from_me && direct && !meta.group && String(text || '').trim().length <= 320) {
    const previous = db.prepare(`select sender, from_me, ts, text from items where source = ? and thread = ?
      and (ts < ? or (ts = ? and rowid < coalesce((select rowid from items where id = ?), 0)))
      and ts >= ? order by ts desc, rowid desc limit 1`).get(item.source, item.thread, item.ts, item.ts, item.id, item.ts - 180)
    if (previous?.from_me && String(previous.text || '').length <= 320) {
      return [{ ...contextLine(previous, item.ts), replyToOwner: true }]
    }
  }
  return needsContext(text) ? contextFor(db, item, SHORT_CONTEXT) : []
}

export function prompt(item, context = [], after = []) {
  const discord = discordMessage(item)
  if (discord) item = { ...item, sender: discord.sender, text: discord.text }
  const meta = item.meta ? JSON.parse(item.meta) : {}
  const where = item.source === 'mail' ? `to ${meta.to || 'me'}` : item.source === 'notifications' ? `shown by the ${item.thread} app on ${N}'s Mac`
    : item.source === 'social' ? (meta.site === 'LinkedIn' ? `a LinkedIn conversation with ${item.from_me ? meta.replyTo || 'someone' : item.sender}` : 'public replies under a post')
    // Treat a group title as a label, not as the subject of every message. Use the profile’s
    // group description when available.
    : meta.group ? `a group chat${item.talk ? ` (${item.talk})` : ''}` : `chat with ${item.thread}`
  // Who the people here are to the owner, and what the group is for, from the profile.
  const known = CHATS.has(item.source) ? slice({ people: [item.sender, ...context.map((c) => c.from), ...after.map((c) => c.from)], group: meta.group ? item.thread : null }) : ''
  // Normalize exclamations for the model so they cannot be mistaken for product or person names.
  const calm = (cs) => cs.map((c) => ({ ...c, text: calmed(c.text) }))
  return fmt(item.source === 'social' ? meta.site : label[item.source], where, who(item), sentLabel(item.ts), calmed(item.text), calm(context), calm(after), known)
}

export async function ollamaUp() {
  try {
    return (await modelFetch('/api/version', { signal: AbortSignal.timeout(2000) })).ok
  } catch {
    return false
  }
}

// The full conversation the model sees: instructions, the invented examples, then this item.
export const messages = (item, context = [], after = []) => [...PREFIX, { role: 'user', content: prompt(item, context, after) }]

export async function tag(item, context = [], after = []) {
  const res = await modelFetch('/api/chat', {
    method: 'POST',
    signal: AbortSignal.timeout(120000),
    body: JSON.stringify({
      model: config.model, stream: false, think: false, keep_alive: config.keepAlive,
      options: { temperature: 0, num_ctx: 4096 }, messages: messages(item, context, after),
    }),
  })
  if (!res.ok) throw Error(`model HTTP ${res.status}`)
  const result = parse((await res.json()).message.content, item)
  const summary = groundedTitle(result.summary, item, context)
  return { ...result, summary: result.is_task ? actionTitle(summary, { ...item, amount: result.amount }) : summary }
}

// Turns the model's JSON answer into a tag; the date always comes from the message's own words.
export function parse(raw, item) {
  let out
  try { out = JSON.parse(raw.match(/\{[\s\S]*\}/)?.[0] ?? 'null') } catch { throw Error('unreadable model answer') }
  if (!out || typeof out !== 'object') throw Error('unreadable model answer')
  return ownerVerdict({
    is_task: out.is_task === true ? 1 : 0,
    when_words: String(out.when || ''),
    due: resolveDue(String(out.when || ''), String(out.due || ''), item.ts, item.text),
    amount: String(out.amount || ''),
    urgency: Number.isInteger(out.urgency) ? out.urgency : 0,
    summary: String(out.summary || '').slice(0, 200),
  }, item)
}

export function pending(db, limit) {
  const marks = TAGGED_SOURCES.map(() => '?').join(', ')
  return db.prepare(`select i.* from items i left join tags t on t.item_id = i.id
    where t.item_id is null and i.source in (${marks}) and i.ts > ? and json_extract(i.meta, '$.quiet') is null
    and (i.source != 'notifications' or lower(coalesce(json_extract(i.meta, '$.app'), '')) != 'com.apple.reminders')
    and (i.source not in ('whatsapp', 'imessage', 'discord', 'chat', 'social') or i.ts < ?) order by i.ts desc limit ?`)
    .all(...TAGGED_SOURCES, now() - config.tagBackfillDays * 86400, now() - SETTLE, limit)
}

// Reminders are read directly. Its alerts can echo Kier's own export and must
// never turn back into a second task; retain messages and explicit owner choices.
export function excludeReminderNotices(db) {
  return Number(db.prepare(`update tags set is_task = 0, model = 'reminder-notice'
    where is_task = 1 and confirmed is null
    and item_id in (select id from items where source = 'notifications'
      and lower(coalesce(json_extract(meta, '$.app'), '')) = 'com.apple.reminders')
    and not exists (select 1 from task_state s where s.item_id = tags.item_id
      and s.status in ('open', 'snoozed', 'done', 'dismissed'))`).run().changes)
}

export async function tagPending(db, { limit = 25 } = {}) {
  reconcileDiscordCopies(db)
  const items = pending(db, limit)
  // Quiet moments go to double checking tasks found earlier.
  if (!items.length) return { tagged: 0, ...(await doubleCheck(db)) }
  if (!(await ollamaUp())) return { tagged: 0, waiting: items.length, error: 'Ollama is not running' }
  const save = db.prepare(`insert or replace into tags (item_id, is_task, due, when_words, amount, urgency, summary, model, tagged_at, said)
    values (:item_id, :is_task, :due, :when_words, :amount, :urgency, :summary, :model, :tagged_at, :said)`)
  const none = { is_task: 0, when_words: '', due: '', amount: '', urgency: 0 }
  let tagged = 0
  let failed = 0
  // The same message saved twice by one source (read off the screen again with its sender written differently) is
  // tagged once: a copy of one already tagged isn't, so a task marked done can't come back as new.
  const copy = db.prepare(`select 1 from items i join tags t on t.item_id = i.id where i.source = ? and coalesce(i.thread, '') = ?
    and i.ts between ? and ? and i.text = ? and i.id != ? limit 1`)
  for (const item of items) {
    if (discordCopy(db, item)) {
      save.run({ item_id: item.id, ...none, summary: '', model: 'twin', tagged_at: now(), said: null })
      tagged++
      continue
    }
    if (copy.get(item.source, item.thread ?? '', item.ts - 60, item.ts + 60, item.text ?? '', item.id)) {
      save.run({ item_id: item.id, ...none, summary: '', model: 'twin', tagged_at: now(), said: null })
      tagged++
      continue
    }
    const burst = burstOf(db, item)
    // The burst is tagged once, on its last message, with all of it.
    if (!burst.last) {
      save.run({ item_id: item.id, ...none, summary: '', model: 'burst', tagged_at: now(), said: null })
      tagged++
      continue
    }
    const group = (() => { try { return JSON.parse(item.meta || '{}').group } catch { return false } })()
    const whole = { ...item, text: burst.read ?? burst.text ?? '', talk: group ? talkers(db, burst.start) : '' }
    // Two letter replies ("ok", "da") are never tasks; no need to wake the model.
    const short = whole.text.trim().length < 3
    const context = contextForTag(db, burst.start, burst.text)
    let t = short ? { ...none, summary: whole.text } : await tag(whole, context, burst.after).catch(() => null)
    if (!t) { failed++; continue }
    let model = short ? 'skip' : config.model
    // A balance notice isn't a bill: "saldo pretplate je 7 EUR" is what's left, not what's owed.
    // Checked after the model, since telling the model so made it shy of every notice.
    if (t.is_task && BALANCE.test(burst.text) && !OWED.test(burst.text)) { t = { ...t, is_task: 0 }; model = 'balance' }
    // An explicit mention can still be a request in a joking group. Recheck ownership with a
    // narrower prompt when the first reading dismisses it as banter.
    if (!short && !t.is_task && !item.from_me && mentioned(burst.text)) {
      const asked = await mentionAsk(whole, context.length ? context : contextFor(db, burst.start, SHORT_CONTEXT)).catch(() => null)
      if (asked?.asks === true && String(asked.task || '').trim()) { t = { ...t, is_task: 1, urgency: Math.max(1, t.urgency || 0), summary: String(asked.task).trim() }; model = 'mention' }
    }
    // A request handed back for later ("pitaj me nakon što složim nacrt", "ping me when it's merged") is a follow-up
    // for the owner, though it has no date. Worked examples made the model read the owner's own "javi mi kad" as
    // theirs too, so a fixed rule catches it after the model, and only from someone else.
    let later = false
    if (!short && !t.is_task && !item.from_me && LATER.test(burst.text)) {
      const back = await followUp(whole, context.length ? context : contextFor(db, burst.start, SHORT_CONTEXT)).catch(() => null)
      if (String(back?.task || '').trim().length > 8) { t = { ...t, is_task: 1, urgency: Math.max(1, t.urgency || 0), summary: String(back.task).trim() }; model = 'later'; later = true }
    }
    // Reported speech can describe information instead of a request. Recheck the conversational
    // role without turning unaccented words into names.
    if (!short && t.is_task && !item.from_me && model === config.model && SAYS.test(whole.text)) {
      const r = await reported(whole, context.length ? context : contextFor(db, burst.start, SHORT_CONTEXT)).catch(() => null)
      if (r?.asks === false && String(r.means || '').trim()) { t = { ...t, is_task: 0, urgency: 0, summary: String(r.means).trim() }; model = 'reported' }
      else if (r?.asks === true && String(r.task || '').trim().length > 8) t = { ...t, summary: String(r.task).trim() }
    }
    // Asked to pass something on ("reci mu da pogleda taj pr"): the task is telling that person, never the sender.
    // A narrower question rewrites the summary, after the model and only for these, like the follow-up rule above.
    let relay = false
    if (!short && t.is_task && !item.from_me && model !== 'later' && RELAY.test(whole.text)) {
      const passed = await passOn(whole, context.length ? context : contextFor(db, burst.start, SHORT_CONTEXT)).catch(() => null)
      // Use a pronoun when the summary names the owner or sender as the recipient.
      const people = [...names(), item.sender, String(item.sender || '').split(/\s+/)[0]].filter((n) => n && n.length > 1)
      const task = String(passed?.task || '').trim().replace(new RegExp(`^(tell|ask|remind|let)\\s+(${people.map((n) => n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')})\\b`, 'i'), '$1 them')
      if (task.length > 8) { t = { ...t, summary: task }; model = 'relay'; relay = true }
    }
    // A promise in a public reply ("happy to look into that", "it's on my list") reads to the model as small talk, since
    // it judges it like a chat message without the context of the post. Those are
    // what Threads and X are read for, so a narrower question reads each of the owner's replies there again.
    let promise = false
    if (!short && !t.is_task && item.from_me && item.source === 'social') {
      const p = await promised(whole, context.length ? context : contextFor(db, burst.start, SHORT_CONTEXT)).catch(() => null)
      if (p?.promises === true && String(p.task || '').trim().length > 8) {
        t = { ...t, is_task: 1, urgency: Math.max(1, t.urgency || 0), summary: String(p.task).trim() }
        model = 'promise'
        promise = true
      }
    }
    // Recheck outgoing tasks: the owner’s commitments remain tasks, while requests made
    // of other people belong in Waiting on others.
    if (!short && t.is_task && item.from_me && !promise) {
      const r = await ownWord(whole, context.length ? context : contextFor(db, burst.start, SHORT_CONTEXT)).catch(() => null)
      const who = String(r?.who || '').trim(), what = String(r?.what || '').trim().replace(/^to\s+/i, '')
      // A failed or incomplete ownership check must be retried, never accepted as a promise.
      const verdict = ownVerdict(r, whole.text)
      if (verdict === null) { failed++; continue }
      if (!verdict) {
        t = { ...t, is_task: 0, urgency: 0, summary: who && what ? `${N} asks ${who} to ${what}` : t.summary }
        model = 'own'
      }
    }
    if (t.is_task && unaddressedGroup(db, whole, burst.start)) { t = { ...t, is_task: 0, urgency: 0 }; model = 'unaddressed-group' }
    if (t.is_task && senderPromise(whole)) { t = { ...t, is_task: 0, urgency: 0 }; model = 'sender-promise' }
    t = ownerVerdict(t, { ...whole, model })
    t.summary = groundedTitle(t.summary, whole, context)
    if (t.is_task) t.summary = actionTitle(t.summary, { ...whole, amount: t.amount })
    save.run({ item_id: item.id, ...t, model, tagged_at: now(), said: burst.text !== item.text ? burst.text : null })
    // Requests in a group where the owner has not participated wait under Maybe yours unless
    // they explicitly name the owner.
    const named = names().concat(N).some((n) => n && whole.text.toLowerCase().includes(n.toLowerCase()))
    if (t.is_task && group && !item.from_me && /hasn't written here lately/.test(whole.talk || '') && !named) {
      db.prepare('update tags set quiet = 1 where item_id = ?').run(item.id)
    }
    // Explicit requests addressed to someone else also wait under Maybe yours. Prefer this narrow
    // rule over a model-only ownership vote, which can reject genuine owner tasks.
    if (t.is_task && !item.from_me && !named && (elsewhere(whole.text, item.sender, owner()) || calledOther(db, item, whole.text))) {
      db.prepare('update tags set quiet = 1 where item_id = ?').run(item.id)
    }
    // The rule is sure of itself: no second opinion, straight into the brief as a to-do.
    if (later) db.prepare("update tags set second = 1, card = 'todo' where item_id = ?").run(item.id)
    // The owner's own word in a reply is a promise card ("You promised on Threads"), like their promises in chats.
    if (promise) db.prepare("update tags set second = 1, card = 'promise' where item_id = ?").run(item.id)
    // Passing it on is something to do, not a reply to the sender; d1 still judges whether it's the owner's at all.
    if (relay) db.prepare("update tags set card = 'todo' where item_id = ?").run(item.id)
    tagged++
  }
  return { tagged, failed, ...(await doubleCheck(db)) }
}

const RELAY_TASK = `Someone asked ${N} to pass something on to another person: "reci mu da pogleda taj crtež", "tell her the puzzle afternoon moved", "pitaj ga za papir". "Him", "her" or "them" is never the sender and never ${N}: it's whoever the chat was just talking about, and can be an app or an AI ${N} works with. First say who that is, from the chat (or "him" or "her" if the chat doesn't say). Then write the task for ${N}, which is passing it on: at most 16 words, specific, in English, using only names that appear, like "Tell Filip to check whether the new drawing filter works". Reply with only JSON: {"who": "...", "task": "..."}`

// One narrow question to the model about one message, with the chat before it.
async function askAbout(system, item, context) {
  const lines = context.map((c) => `[${c.time}] ${c.from}: ${clip(String(c.text).replace(/\s+/g, ' '), c.long ? 560 : 240)}`).join('\n')
  const res = await modelFetch('/api/chat', {
    method: 'POST', signal: AbortSignal.timeout(120000),
    body: JSON.stringify({ model: config.model, stream: false, think: false, keep_alive: config.keepAlive, options: { temperature: 0, num_ctx: 4096 },
      messages: [{ role: 'system', content: system }, { role: 'user', content: `${lines ? `The chat before it:\n${lines}\n\n` : ''}${item.sender}: ${item.text}` }] }),
  })
  if (!res.ok) return null
  return parseModelJSON((await res.json()).message.content.match(/\{[\s\S]*\}/)?.[0] ?? 'null')
}

const passOn = (item, context) => askAbout(RELAY_TASK, item, context)

const PROMISE = `${N} replied on Threads, X or LinkedIn to the message before it. Decide whether ${P.his} reply promises something ${P.he} will do later: look into it, add or build it, fix it, send it, come back with an answer, or put it on ${P.his} list ("happy to look into that", "it's on my list", "I'll add it", "will DM you"). Thanks, answers, opinions, jokes and pointing someone to a link promise nothing. If it promises, write the task for ${N}: what to do, and for whom when the post says, at most 14 words, in English, using only names that appear, like "Look into drawing shortcuts for Priya". Reply with only JSON: {"promises": true or false, "task": "..."}`

const promised = (item, context) => askAbout(PROMISE, item, context)

const LATER_TASK = `Someone handed something back to ${N} for later: "ask me when I finish", "ping me when it's merged", "javi mi kad stigne". First say in a few words what was asked or talked about right before it, from the chat. Then write the follow-up: what ${N} has to do, about that, and when, at most 16 words, specific, in English, using only names that appear, like "Send Nika the birdhouse plan once she finishes the draft". If the message hands nothing back to ${N} for later, task is "". Reply with only JSON: {"about": "...", "task": "..."}`

const followUp = (item, context) => askAbout(LATER_TASK, item, context)

const REPORTED = `This message passes on what someone or something said or wrote (English "says", Croatian "kaže", German "laut"). People often type without accents, so read every word as the writer meant it, in their language ("kaze" is "kaže", says), never as a name. First write in English what the message means, at most 14 words, naming whoever said it as the message does (a person, an app, an AI) and using only names that appear. Then decide: does it ask ${N} to do something, or tell ${P.him} that something of ${P.his} own is due, moved or needs ${P.him} (an appointment, a payment, a deadline)? Then it is a task. Only sharing what someone said, thinks or recommends is not. If it is, write the task for ${N}, at most 12 words, in English. Reply with only JSON: {"means": "...", "asks": true or false, "task": "..."}`

export const reported = (item, context = []) => askAbout(REPORTED, item, context)

const OWN = `${N} wrote this message ${P.self}. Decide whether it commits ${P.him} to doing something ${P.self}: a promise or a plan ("riješit ću", "bum to sad sredil", "pogledam", "I'll send it"), agreeing to do what someone asked of ${P.him} ("moze", "ok", "dodam"), agreeing to a plan that includes ${P.him} (a meeting, a call), or saying ${P.he} is on it now ("evo otvaram crtež", "dolazim"). Asking someone else to do, check, review or answer something ("jel ovo ima smisla?" with a link, "pogledaj ovo", "can you approve it?"), reminding them, giving them permission, or only sharing news or an opinion does not commit ${N}. Neither does telling them ${P.his} own plans when they asked for nothing and wait for nothing from ${P.him} ("sutra ću slagati slagalicu", "u lipnju slažem papirnatog zmaja"). If it doesn't commit ${P.him} and this message itself asks someone to do something, say who (a name from the chat other than ${N}, or "them") and what they should do, starting with the verb, at most 12 words, in English, like "review the birdhouse draft for Jonas". The chat before it is context only: what an earlier message asked is never this message's. If this message asks nothing, who and what are "". Reply with only JSON: {"commits": true or false, "who": "...", "what": "..."}`

const OWN_ACTOR = `${OWN.replace(/Reply with only JSON:.*$/, '')}
Before deciding, identify who would actually perform the action in THIS message. Imperatives and permission ("ship it", "put it behind a switch", "stavi to tamo", "slobodno pusti") assign action to the recipient, even though the owner wrote them. They are not first-person commitments. A future prediction ("eventually it will work") is not a commitment either. Context may identify the recipient but must never supply the owner's promise.
Return JSON with: actor ("owner", "recipient", "other", or "none"), evidence (an exact quote from THIS message demonstrating who acts), commits (boolean), who and what. commits is true only for actor owner and an explicit promise, acceptance or shared arrangement. If the message both delegates and promises, quote the owner's own commitment as evidence.`

export function ownVerdict(result, text) {
  if (!result || typeof result.commits !== 'boolean' || !['owner', 'recipient', 'other', 'none'].includes(result.actor)) return null
  if (!result.commits) return false
  if (result.actor !== 'owner') return false
  const evidence = String(result.evidence || '').trim()
  if (!evidence || !String(text).includes(evidence)) return null
  return true
}
export const ownWord = (item, context = []) => askAbout(OWN_ACTOR, item, context)

// Recognize every owner alias supplied by the profile when checking explicit mentions.
const mentioned = (text) => names().some((n) => new RegExp(`@${n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i').test(text))
const ASKED = `${N} was @mentioned in a group chat. From the message and the chat before it, decide what the sender wants ${N} to do. A request ("ajd im otkazi", "pogledaj ovo", "can you send") counts even if the chat around it is joking; a greeting, a joke with nothing to do, or news is not a request. "Them" ("im", "njima") means whoever the chat is talking about, never the sender. Reply with only JSON: {"asks": true or false, "task": "what ${N} should do, at most 12 words, specific, in English, using only names that appear"}`

async function mentionAsk(item, context) {
  const lines = context.map((c) => `[${c.time}] ${c.from}: ${clip(String(c.text).replace(/\s+/g, ' '), c.long ? 560 : 240)}`).join('\n')
  const res = await modelFetch('/api/chat', {
    method: 'POST', signal: AbortSignal.timeout(120000),
    body: JSON.stringify({ model: config.model, stream: false, think: false, keep_alive: config.keepAlive, options: { temperature: 0, num_ctx: 4096 },
      messages: [{ role: 'system', content: ASKED }, { role: 'user', content: `Chat before it:\n${lines}\n\n${item.sender} wrote:\n${item.text}` }] }),
  })
  if (!res.ok) return null
  return parseModelJSON((await res.json()).message.content.match(/\{[\s\S]*\}/)?.[0] ?? 'null')
}

// Find explicit mentions while excluding email addresses and quoted reply headers.
export const mentions = (text) => [...String(text).replace(/[\u2066-\u2069]/g, '').matchAll(/(?<![\p{L}\p{N}_.@])@([\p{L}\p{N}_][\p{L}\p{N}_.-]{1,31})(?![\p{L}\p{N}_.-])(?!\s*Server Tag)/gu)]
  .map((m) => m[1].replace(/[._-]+$/, '')).filter((m) => !/\.[a-z]{2,}$/i.test(m))

// The owner as chats call them: their names, and the handle each chat app knows them by (screenchats.mjs).
export const owner = () => [...names(), N, ...Object.values(handles()).flat()].filter(Boolean)

// Asked of someone else: it @-mentions people, none of them the owner, and one of them isn't who sent it (GitHub's
// "@filip_notes has invited you" is the sender inviting you).
export function elsewhere(text, sender, me) {
  const at = mentions(text).map((m) => m.toLowerCase())
  if (!at.length) return false
  const mine = me.map((n) => String(n).toLowerCase())
  if (at.some((a) => mine.some((n) => a === n || a.startsWith(n) || n.startsWith(a)))) return false
  const from = String(sender || '').replace(/[\u2066-\u2069]/g, '').toLowerCase()
  return at.some((a) => !from.includes(a))
}

// A short name-only call or a direct vocative addresses another participant. A statement
// mentioning someone, or an instruction to relay something, does not have that meaning.
const NOT_NAMES = new Set(['dok', 'sad', 'sam', 'san', 'tak', 'van', 'dan', 'ono', 'ona', 'ali', 'the', 'and', 'can', 'pls', 'hey', 'aaa', 'joj', 'daj'])
export function calledOther(db, item, text, me = owner()) {
  if (item.from_me) return false
  const first = (n) => plain(n).replace(/\(.*$/, '').match(/[\p{L}]+/u)?.[0] || ''
  const sender = first(item.sender)
  const mine = me.map((n) => plain(n))
  const people = [...new Set(db.prepare(`select distinct sender from items where source = ? and thread = ? and from_me = 0 and ts between ? and ?`)
    .all(item.source, item.thread, item.ts - 14 * 86400, item.ts).map((r) => first(r.sender)))]
    .filter((p) => p.length >= 3 && p !== sender && !mine.some((m) => m === p || m.startsWith(p)))
  if (!people.length) return false
  const calls = (w) => w.length >= 3 && !NOT_NAMES.has(w) && people.some((p) => p === w || p.startsWith(w) || (w.startsWith(p) && w.length - p.length <= 2))
  for (const line of String(text).split('\n').slice(0, 2)) {
    const words = plain(line).match(/[\p{L}]+/gu) || []
    if (words.some((w) => mine.some((m) => m && (w === m || w.startsWith(m))))) return false
    if (words.length && words.length <= 3 && words.some(calls)) return true
    const lead = plain(line).match(/^\s*@?([\p{L}]+)\s*[,!:]/u)
    if (lead && calls(lead[1])) return true
  }
  return false
}

// Reapply mention and vocative ownership rules once to older open cards.
export function quietElsewhere(db) {
  const me = owner()
  let n = 0
  for (const r of db.prepare(`select i.id, i.source, i.thread, i.ts, i.from_me, i.sender, coalesce(t.said, i.text) text from tags t join items i on i.id = t.item_id
      left join task_state s on s.item_id = i.id where t.is_task = 1 and i.from_me = 0 and s.item_id is null and t.quiet is null
      and t.confirmed is null and i.source != 'reminders' and i.ts > ?`).all(now() - 30 * 86400)) {
    const named = me.some((x) => x && String(r.text).toLowerCase().includes(String(x).toLowerCase()))
    if (!named && (elsewhere(r.text, r.sender, me) || calledOther(db, r, r.text, me))) { db.prepare('update tags set quiet = 1 where item_id = ?').run(r.id); n++ }
  }
  return n
}

// require a first-person work action, not just "moram". Questions, requests, shared plans and quotes stay.
const plain = (text) => String(text || '').normalize('NFD').replace(/\p{M}/gu, '').replace(/[\u200e\u200f\u2066-\u2069]/g, '').replace(/’/g, "'").toLowerCase()
const HR_WORK = '(?:(?:kaza|napravi|popravi|razvi|razvija|sredi|rijesi|rjesi|resi|posla|doda|doradi|maknu|ukloni|prebaci|prepravi|provjeri|proveri|pogleda|pregleda|pripremi|napisa|objavi|slozi|poslozi|spoji|poveza|odradi|zavrsi|dovrsi|implementira|integrira|testira|fixa|pusha|deploya|merga|builda)(?:ti?|o|la?|lo)|fix|push|deploy|merge|build)'
const HR_FILL = '(?:\\s+(?:ja|ga|ju|ih|im|to|si|se|sad|sada|onda|sutra|danas|veceras|jos|samo|prvo|opet)){0,4}'
const HR_COMMIT = new RegExp(`\\b(?:(?:moram|cu|bum|budem)${HR_FILL}\\s+${HR_WORK}|${HR_WORK}\\s+cu)\\b`)
// Short first-person replies still belong to their author, even without an infinitive.
const HR_PRESENT = /\b(?:rijesim|rjesim|resim|sredim|popravim|napravim|dodajem|odradim|zavrsim|poslozim|fixam)\b/
const HR_SHORT = /^(?:(?:ok|okej|da|onda|dobro)[,.!]?\s+)*(?:ja\s+)?(?:cu|bum|budem)\s+(?:to|ovo|ono|ih|ga)(?:\s+(?:ja|sutra|danas|kasnije|sad|sada))?[.!\s]*$/
const EN_COMMIT = /\b(?:i'll|i will|i have to|i need to|let me)\s+(?:(?:just|first|also|still|now)\s+){0,2}(?:fix|repair|build|develop|implement|integrate|test|prepare|write|rewrite|send|share|finish|update|add|remove|check|review|publish|deploy|merge|push|upload|refactor|sort|handle|release|look into|take care of)\b/
const REQUEST = /\b(?:you|your|yours|we|our|us|ti|te|tebe|tebi|tvoj[a-z]*|vi|vas|vama|vas[a-z]*|nas[a-z]*|nam|cemo|please|pls|plz|can|could|would|should|shall|let's|let us|let me know|tell me|ping me|remind me|send me|help me|need help|need a hand|jel|je l|jesi|jeste|oces|hoces|hocete|mozes|mozete|trebas|trebate|trebamo|kaj|sta|sto|kak|kako|koji|koja|koje|kad|kada|ajd[a-z]*|daj|dajte|molim|molimo|javi|javite|posalji|posaljite|pogledaj|pogledajte|provjeri|provjerite|sredi|sredite|napravi|napravite|dodaj|dodajte|reci|recite|pitaj|pitajte|potvrdi|potvrdite|potvrdu|odobri|odobrite|pripremi|pripremite|prebaci|prebacite|pomogni|pomozite|podsjeti|podsjetite|testiraj|testirajte|fixaj|pushaj)\b/
const IMPERATIVE = /(?:^|[\n.!;:,]|\b(?:and|but|then))\s*(?:(?:please|also|just|then)\s+)*(?:send|share|check|review|look|tell|ask|ping|remind|help|confirm|approve|let|fix|repair|build|develop|implement|integrate|test|prepare|write|rewrite|finish|update|add|remove|publish|deploy|merge|push|upload|refactor|sort|handle|release|click)\b/
const REPORTED_PROMISE = /["“”„«»`]|(?:^|\n)\s*>|(?:^|[\s:])'(?=\S)|\b(?:said|says|say|saying|wrote|writes|told|asked|quote|quoted|rekao|rekla|rekli|reko|kaze|kazem|kazes|veli|velim|velis|pise|pisalo|napisao|napisala)\b/
const ARRANGEMENT = /\b(?:meet|meeting|appointment|call|come|visit|sastan[a-z]*|termin[a-z]*|dogovor[a-z]*|poziv[a-z]*|nazvat[a-z]*|doc[i]?|dodem|dodjem|navrat[a-z]*)\b/

export function senderPromise(item, me = owner()) {
  if (item.from_me || !TAGGED_SOURCES.includes(item.source)) return false
  let text = plain(item.text)
  const from = plain(item.sender)
  // Notification headers can quote the channel name; only the message itself decides.
  if (from && text.startsWith(`${from}:`)) text = text.slice(from.length + 1).trim()
  // Croatian future word order: 'reci cu' is a promise, unlike the imperative 'reci'.
  text = text.replace(/\breci\s+cu\b/g, 'cu kazati').replace(/\bcu\s+reci\b/g, 'cu kazati')
  if (me.some((n) => n && text.includes(plain(n)))) return false
  if (/[?¿]/.test(text) || /\bne moram\b/.test(text) || REQUEST.test(text) || REPORTED_PROMISE.test(text) || ARRANGEMENT.test(text)) return false
  if (/\b(?:what|when|where|who|which|how|why|whether|gdje|di|zakaj|zasto|treba|trebam|trebalo|any thoughts|any feedback|need approval|need a review)\b/.test(text)) return false
  // "Let me fix it" is the sender's offer; "let me know" was kept above.
  if (IMPERATIVE.test(text.replace(/\blet me\s+/g, 'i will '))) return false
  if (/\b(?:ne|nemrem|necu)\s+(?:(?:ja|to|ga|ih)\s+)*(?:rijesim|rjesim|resim|sredim|popravim|napravim|dodajem|odradim|zavrsim|poslozim|fixam)\b/.test(text)) return false
  return HR_COMMIT.test(text) || EN_COMMIT.test(text) || HR_PRESENT.test(text) || HR_SHORT.test(text)
}

// Open cards read before the sender-promise rule get it once, without changing the owner's choices.
export function quietSenderPromises(db) {
  const me = owner()
  const save = db.prepare('update tags set quiet = 1 where item_id = ?')
  let n = 0
  for (const r of db.prepare(`select i.id, i.source, i.sender, i.from_me, coalesce(t.said, i.text) text from tags t join items i on i.id = t.item_id
      left join task_state s on s.item_id = i.id where t.is_task = 1 and i.from_me = 0 and s.item_id is null and t.quiet is null
      and t.confirmed is null and i.ts > ?`).all(now() - 30 * 86400)) {
    if (senderPromise(r, me)) { save.run(r.id); n++ }
  }
  return n
}

export async function doubleCheck(db, limit = 16) {
  const items = db.prepare(`select i.id, i.source, i.thread, i.sender, i.from_me, i.ts, i.meta, coalesce(t.said, i.text) text, t.amount, t.when_words
    from tags t join items i on i.id = t.item_id where t.is_task = 1 and (t.second is null or t.card is null) and i.ts > ?
      and i.source != 'reminders' order by i.ts desc limit ?`).all(now() - 30 * 86400, limit)
  if (!items.length) return {}
  const checks = items.map(item => ({ ...item, context: contextForTag(db, burstOf(db, item).start, item.text) }))
  const p = await decide(checks).catch(() => null)
  const kinds = await cards(checks).catch(() => null)
  if (!p || !kinds) return {}
  // A card type a rule already set (passing something on is a to-do) stays; d1 fills in the rest.
  const save = db.prepare('update tags set second = ?, card = coalesce(card, ?) where item_id = ?')
  items.forEach((item, i) => save.run(p[i], kinds[i], item.id))
  return { checked: items.length }
}

// Correct old unclaimed cards while retaining messages and explicit owner choices.
export function excludeSenderPromises(db) {
  const save = db.prepare("update tags set is_task = 0, model = 'sender-promise' where item_id = ?")
  let n = 0
  for (const r of db.prepare(`select i.id, i.source, i.sender, i.from_me, coalesce(t.said, i.text) text
    from tags t join items i on i.id = t.item_id left join task_state s on s.item_id = i.id
    where t.is_task = 1 and i.from_me = 0 and t.confirmed is null and s.item_id is null and i.ts > ?`).all(now() - 30 * 86400)) {
    if (senderPromise(r)) { save.run(r.id); n++ }
  }
  return n
}

// Group membership alone does not assign work. Require an address or recent participation.
export function unaddressedGroup(db, item, start = item, me = owner()) {
  if (item.from_me) return false
  let meta = {}
  try { meta = JSON.parse(item.meta || '{}') } catch {}
  const group = meta.group || (item.source === 'notifications' && item.thread === 'Discord' && /\(\s*#/.test(plain(item.sender)))
  if (!group) return false
  const text = plain(item.text)
  const words = text.match(/[\p{L}\p{N}_]+/gu) || []
  if (me.some(n => n && words.includes(plain(n)))) return false
  const rows = db.prepare(`select sender, from_me, ts, text from items where source = ? and thread = ?
    and (ts < ? or (ts = ? and rowid < (select rowid from items where id = ?))) and ts > ?
    order by ts desc, rowid desc limit 200`).all(item.source, item.thread, start.ts, start.ts, start.id, start.ts - 3 * 3600)
  return !rows.filter(sameConversation(item)).slice(0, 10).some(r => r.from_me)
}

export function excludeUnaddressedGroups(db) {
  const save = db.prepare("update tags set is_task = 0, model = 'unaddressed-group' where item_id = ?")
  let n = 0
  const rows = db.prepare(`select i.*, coalesce(t.said, i.text) whole_text from tags t join items i on i.id = t.item_id
    left join task_state s on s.item_id = i.id where t.is_task = 1 and i.from_me = 0
    and t.confirmed is null and s.item_id is null and i.ts > ?`).all(now() - 30 * 86400)
  for (const item of rows) {
    if (unaddressedGroup(db, { ...item, text: item.whole_text }, burstOf(db, item).start)) { save.run(item.id); n++ }
  }
  return n
}
