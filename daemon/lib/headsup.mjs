import { localAuthorization, readScope } from './authorization.mjs'
import { parseModelJSON } from './errors.mjs'
import { modelFetch } from './model-provider.mjs'
// Offer a heads-up the day before an important event or dated task. Cache each decision
// so the list changes only when source items or their state change.
import { config } from './config.mjs'
import { nearest } from './meaning.mjs'
import { planInfo } from './plans.mjs'
import { now } from './db.mjs'
import { announced, brief } from './tasks.mjs'
import { ollamaUp } from './tagger.mjs'
import { P } from './lang.mjs'

const N = config.me
// The owner’s other languages, without their parenthetical descriptions.
const OTHER = (config.languages || []).map((l) => String(l).split(' (')[0].trim()).filter((l) => l && l !== 'English')
// Select events that need preparation; omit routine work blocks and recurring reminders.
const ASK = `${N} has this on ${P.his} calendar or to-do list for an upcoming day. Decide whether ${P.he}'d want a gentle heads-up the day before. Yes when ${P.he} ${P.has} to be somewhere, meet someone, pay, bring or prepare something, or hit a deadline, or it's official or hard to move (a dentist, an exam, a repair booking, a flight). No for routine work blocks and recurring reminders ${P.he} ${P.sets} for ${P.self}, and for holidays unless they change ${P.his} plans. Write the heads-up as a short label of at most 4 words in everyday British English, the way a person would say it, like "Dental checkup" or "Piano lesson". Reply with only JSON: {"important": true or false, "label": "..."}`

// Add one grounded line of context: why, where, with whom or what to bring. Leave it empty
// when no related message supports an explanation.
const CONTEXT = (label, text, about) => `${N} has "${label}" coming up (on ${P.his} calendar as "${text}")${about.length ? `, most likely to do with ${about.join(', ')}` : ''}. Below are recent messages that may or may not be about it. Write one short line of context to ${P.him}, as "you" (never by ${P.his} name: ${P.his} own messages are what you said or asked), at most 14 words, in everyday British English: why, where, with whom, or what to bring or have ready. Leave out dates and times; the card already shows when. Use only what the messages say and only names that appear in them; never guess. Keep who did what exactly as the messages have it: someone who reminds, asks or recommends is not the one selling or doing it. If none of the messages is about this, the line is "". Reply with only JSON: {"context": "..."}`

// A second, narrow question before a line is kept: is it about this at all? Asked on its own the model answers it
// reliably (16 of 16 made-up pairs); as one clause among the writing rules above it let a line through that named a
// stranger and another errand, because a message that shared a word with the label was in the list.
export const OTHER_MATTER = (label, text, line) => `${N} has "${label}" coming up (noted as "${text}"). This line of context was written for it: "${line}". Decide whether the line is clearly about a different matter: another bill, another errand, another project, other people's business. A line that could be useful preparation for "${label}" (what to bring, who it is with, where, why) is not a different matter. Reply with only JSON: {"other": true or false}`

async function ask(system, user) {
  const res = await modelFetch('/api/chat', {
    method: 'POST', signal: AbortSignal.timeout(60000),
    body: JSON.stringify({ model: config.model, stream: false, think: false, keep_alive: config.keepAlive, options: { temperature: 0 },
      messages: [{ role: 'system', content: system }, { role: 'user', content: user }] }),
  }).catch(() => null)
  if (!res?.ok) return null
  const raw = (await res.json()).message.content
  const json = raw.match(/\{[\s\S]*\}/)?.[0]
  // Accept a plain context line as well as the requested JSON wrapper.
  return json ? parseModelJSON(json, 'HEADSUP_JSON_INVALID') : { text: raw.trim() }
}

// What the coming week holds that hasn't been asked about yet, tomorrow first: its events and the tasks due then, by a
// key that changes when the thing moves to another day.
const upcoming = (b) => [
  ...b.soon.events.map((e) => ({ day: e.day, key: `${e.id}@${e.day}`, text: e.text })),
  // A task that looks done already is waiting for a yes or no, not for a heads-up.
  ...b.soon.tasks.filter(announced).map((t) => ({ day: t.due, key: `${t.id}@${t.due}`, text: `${t.summary}${t.when_words ? ` (${t.when_words})` : ''}`, task: t.id })),
].sort((x, y) => x.day.localeCompare(y.day))

export function candidates(db, b = brief(db)) {
  const asked = db.prepare('select 1 from heads_up where key = ?')
  return upcoming(b).filter((c) => !asked.get(c.key))
}

// Kept heads-ups still ahead that were worked out an older way get one more look: before context existed, and while a
// task's line could still come from someone else's conversation.
export function stale(db, b = brief(db)) {
  const row = db.prepare('select important, context, asked from heads_up where key = ?')
  return upcoming(b).filter((c) => { const h = row.get(c.key); return h?.important === 1 && (h.context == null || (h.asked ?? 1) < ASKED) })
}

// The last month's messages with any of the words in them, newest first; the model decides which are really about it.
const SOURCES = ['whatsapp', 'imessage', 'mail', 'notifications', 'discord', 'ai']
// Search in two steps: identify the event’s likely subject, then translate those terms into
// stems for each configured language.
const WORDS = (label, text) => `${N} has "${label}" coming up (on ${P.his} calendar as "${text}"). List 2 to 5 English words people would use in chats about it beforehand: the thing itself and what it is most likely for (a pottery class may need clay or tools; a rehearsal may need an instrument or sheet music). Single lowercase words. Reply with only JSON: {"words": ["..."]}`
const STEMS = (lang, words) => `Give these words in ${lang} as people write them in casual chats, each as the short stem that matches all its forms (in Croatian "slik" matches slike, sliku, slikama). One stem per word, lowercase. Words: ${words.join(', ')}. Reply with only JSON: {"words": ["..."]}`

export async function searchWords(label, text) {
  const pick = (r) => (Array.isArray(r?.words) ? r.words : []).filter((w) => typeof w === 'string').map((w) => w.toLowerCase().trim()).filter(Boolean)
  const english = pick(await ask(WORDS(label, text), text)).slice(0, 5)
  const others = []
  for (const lang of OTHER) if (english.length) others.push(...pick(await ask(STEMS(lang, english), english.join(', '))).slice(0, 6))
  // Drop a trailing vowel from longer stems to match inflected words in casual messages.
  const stem = (w) => (w.length >= 4 && /[aeiou]$/.test(w) ? w.slice(0, -1) : w)
  return { words: [...new Set([...others, ...english].map(stem))], about: english }
}

// Rank messages by matched terms and their length, then recency; combine with semantic
// neighbours to recover relevant messages that use different vocabulary.
export async function related(db, words, about = '') {
  db = readScope(db, localAuthorization())
  const byWords = relatedByWords(db, words)
  if (!about) return byWords
  const close = await nearest(db, about, { k: 8, where: `and i.source in (${SOURCES.map(() => '?').join(', ')}) and i.ts > ?`, params: [...SOURCES, now() - 30 * 86400] }).catch(() => [])
  const have = new Set(byWords.map((m) => m.id))
  const extra = close.map((c) => c.id).filter((id) => !have.has(id))
  if (!extra.length) return byWords
  const rows = db.prepare(`select id, ts, sender, from_me, thread, text, source from items where id in (${extra.map(() => '?').join(', ')})`).all(...extra)
  return [...byWords, ...extra.map((id) => rows.find((r) => r.id === id)).filter(Boolean)].slice(0, 14)
}

function relatedByWords(db, words) {
  const ws = [...new Set(words.map((w) => String(w).toLowerCase().trim()).filter((w) => w.length >= 3))].slice(0, 8)
  if (!ws.length) return []
  const rows = db.prepare(`select id, ts, sender, from_me, thread, text, source from items where source in (${SOURCES.map(() => '?').join(', ')}) and ts > ?
    and (${ws.map(() => 'lower(text) like ?').join(' or ')}) order by ts desc limit 400`)
    .all(...SOURCES, now() - 30 * 86400, ...ws.map((w) => `%${w}%`))
  const score = (m) => { const t = String(m.text).toLowerCase(); return ws.reduce((n, w) => n + (t.includes(w) ? w.length : 0), 0) }
  return rows.map((m) => [score(m), m]).sort((a, b) => b[0] - a[0] || b[1].ts - a[1].ts).slice(0, 14).map(([, m]) => m)
}

// A task's line comes from its own conversation and nowhere else: the chat or mail thread it was said in, nearest
// messages first. Searching everything by the label's words finds other people's messages that only share a word
// with it ("invoice", "payment"), and the line then names someone who has nothing to do with the task.
const AROUND = 2 * 86400
export function conversationAround(db, id) {
  db = readScope(db, localAuthorization())
  const cols = 'id, ts, sender, from_me, thread, text, source'
  const self = db.prepare(`select ${cols} from items where id = ?`).get(id)
  // A reminder or a card you added yourself has no conversation; a banner's thread is every banner of that app.
  if (!self || ['kier', 'reminders'].includes(self.source)) return []
  if (self.source === 'notifications') return [self]
  return db.prepare(`select ${cols} from items where source = ? and thread = ? and ts between ? and ? order by abs(ts - ?), ts limit 14`)
    .all(self.source, self.thread, self.ts - AROUND, now(), self.ts).sort((a, b) => a.ts - b.ts)
}

async function explain(db, key, label, text, words, about = [], task = null) {
  const found = task ? conversationAround(db, task) : await related(db, words, [label, ...about].join(' '))
  if (!found.length) return ''
  // Label the owner’s messages as You so the model preserves who asked or did what.
  const lines = found.map((m) => `[${new Date(m.ts * 1000).toISOString().slice(0, 10)}] ${m.from_me ? 'You' : m.sender} in ${m.thread}: ${String(m.text).replace(/\s+/g, ' ').slice(0, 220)}`).join('\n')
  const r = await ask(CONTEXT(label, text, about), lines)
  const line = String(r?.context ?? (r?.text && !r.text.includes('\n') ? r.text : '')).trim().replace(/^"|"$/g, '').replace(/\.$/, '')
  if (!line) return ''
  // Kept only on a plain "not another matter": no line is better than one about someone else's business.
  return (await ask(OTHER_MATTER(label, text, line), line))?.other === false ? line : ''
}

// Strategy version. 2: likely subjects and inflected word stems. 3: a task's line comes from its own conversation.
const ASKED = 3

export async function checkHeadsUps(db, limit = 6) {
  const b = brief(db)
  const todo = candidates(db, b).slice(0, limit)
  const again = stale(db, b)
  if ((!todo.length && !again.length) || !(await ollamaUp())) return {}
  const save = db.prepare('insert or replace into heads_up (key, important, label, words, context, at, asked) values (?, ?, ?, ?, ?, ?, ?)')
  let important = 0
  for (const c of [...todo, ...again]) {
    const event = c.text
    const r = await ask(ASK, event)
    if (typeof r?.important !== 'boolean') continue
    const label = String(r.label || '').trim().slice(0, 40) || null
    // Only a calendar event is searched for across the chats; a task already has its conversation.
    const { words, about } = r.important && !c.task ? await searchWords(label || event, event) : { words: [], about: [] }
    const context = r.important ? await explain(db, c.key, label || event, event, words, about, c.task).catch(() => '') : ''
    save.run(c.key, r.important ? 1 : 0, label, JSON.stringify(words), context, now(), ASKED)
    important += r.important ? 1 : 0
  }
  return { checked: todo.length + again.length, important }
}

// An event detail page includes its time, place, heads-up and related messages.
// Search with saved terms, falling back to longer words in the title.
export async function eventInfo(db, id) {
  db = readScope(db, localAuthorization())
  if (id.startsWith('plan:')) return planInfo(db, id)
  const item = db.prepare("select id, thread, ts, text, meta from items where id = ? and source = 'calendar'").get(id)
  if (!item) return null
  const key = db.prepare('select key from heads_up where key like ? order by at desc limit 1').get(`${id}@%`)?.key
  const h = key ? db.prepare('select important, label, words, context from heads_up where key = ?').get(key) : null
  const [title, place] = String(item.text).split(' @ ')
  const own = title.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter((w) => w.length >= 5).slice(0, 3)
  const words = (() => { try { return JSON.parse(h?.words || '[]') } catch { return [] } })()
  // Guessing from the title, only conversations count: notifications and sessions share too many words by chance.
  const seen = new Set()
  const said = (await related(db, words.length ? words : own, title))
    .filter((m) => words.length || ['whatsapp', 'imessage', 'mail', 'discord'].includes(m.source))
    .filter((m) => !seen.has(m.text) && seen.add(m.text)).slice(0, 6)
  const allDay = (() => { try { return !!JSON.parse(item.meta || '{}').allDay } catch { return false } })()
  return {
    id, title, place: place || null, calendar: item.thread || 'Calendar', ts: item.ts, allDay,
    label: h?.important ? h.label : null, context: h?.context || null,
    related: said.map((m) => ({ who: m.from_me ? N : m.sender, ts: m.ts, source: m.source, thread: m.thread, text: String(m.text).replace(/\s+/g, ' ').slice(0, 300) })),
  }
}
