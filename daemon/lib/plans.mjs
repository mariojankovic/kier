import { authorization, readScope } from './authorization.mjs'
import { parseModelJSON, failure } from './errors.mjs'
import { modelFetch } from './model-provider.mjs'
// Extract plans agreed in chats even when no calendar entry exists.
// Read messages naming a day or time and identify plans the owner participates in.
// Resolve dates from the message’s words. Merge repeated plans in the same chat by weekday,
// using the latest stated time. Read older chats once, then process new arrivals.
import { config } from './config.mjs'
import { resolveDue } from './dates.mjs'
import { now } from './db.mjs'
import { RELATIVE, WEEKDAYS } from './lang.mjs'
import { offClause } from './settings.mjs'
import { dayLabel, dayRange, isoDay, plusDays } from './tasks.mjs'

export const PLAN_SOURCES = ['whatsapp', 'imessage', 'discord']
const marks = PLAN_SOURCES.map(() => '?').join(', ')
// How far back a plan still counts: a weekly one mentioned last eight weeks ago may well have stopped.
const KEEP_DAYS = 120
const WEEKLY_WEEKS = 8
// A message is read once its burst has settled, like the tagger.
const SETTLE = 3 * 60

const plain = (s) => String(s).toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/đ/g, 'd')
// Names a day ("petak", "tomorrow", "9.10.") or a time ("17:00", "u 9h"): only those can set a plan.
const DAY = new RegExp(`(?<![a-z])(${[...WEEKDAYS.flatMap(([, s]) => s), ...RELATIVE.flatMap(([, w]) => w)].filter((s) => s.length >= 3).map(plain).join('|')})`)
const TIME = /\b([01]?\d|2[0-3])[:.][0-5]\d\b|\b\d{1,2}\s?h\b|\b\d{1,2}\.\s?\d{1,2}\.|\b\d{1,2}\s?(am|pm)\b/i
export const mayBePlan = (text) => TIME.test(text) || DAY.test(plain(text))

const N = config.me
const SYSTEM = `You read ${N}'s chats for plans: something happening on a set day, often at a set time, that ${N} takes part in or is invited to, like a training, a meeting, a dinner or an appointment. The chats are in ${config.languages.join(' or ')}. A few earlier messages come first for context; read only the message under "Message to read".

plan true: the message sets, confirms, moves or cancels such a plan ("ovaj utorak radionica od 16:15", "see you Tuesday at 8", "sutra u 10 kod doktora", "this Friday's off"). In a group, a message to everyone ("dečki", "guys", "@all") counts for ${N}.
plan false: plans that are only someone else's ("I'm at the dentist tomorrow", "u petak sam u gostima"), things that already happened, ideas with no day ("we should meet sometime"), ideas and examples of how something would work (an app or a game: "and then on Tuesdays we compare sketches"), deadlines and payments, jokes.

Read informal spelling and broken words in context; do not invent an event name or acronym from them. A reply about the sender's own work, finish time or arrival is not automatically a plan for ${N}. The latest question and topic determine what a time reply answers. Do not use that time for an older shared plan unless this exchange actually confirms or changes that same activity.

when: copy the exact words that say the day ("ovaj petak", "9.10. petak", "petkom", "tomorrow"). "" if none.
start, end: the times as HH:MM. "" if none.
weekly: true only if it repeats every week ("every Friday", "petkom", "svaki petak", a series of trainings that begins).
cancelled: true if it says this one is off.
what: at most 4 words in English, the plan itself ("Pottery workshop").

Reply with only JSON: {"plan": false, "when": "", "start": "", "end": "", "weekly": false, "cancelled": false, "what": ""}`

const at = (ts) => new Date(ts * 1000).toLocaleString('en-GB', { timeZone: config.timezone, weekday: 'short', day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' })
const line = (m) => `[${at(m.ts)}] ${m.from_me ? N : m.sender}: ${String(m.text).replace(/\s+/g, ' ').slice(0, 300)}`

function prompt(db, item) {
  const before = db.prepare(`select ts, sender, from_me, text from items where source = ? and thread = ?
    and (ts < ? or (ts = ? and rowid < coalesce((select rowid from items where id = ?), 0)))
    and ts > ? order by ts desc, rowid desc limit 4`)
    .all(item.source, item.thread, item.ts, item.ts, item.id, item.ts - 12 * 3600).reverse()
  return `Chat: ${item.thread}\n${before.length ? `Earlier messages:\n${before.map(line).join('\n')}\n\n` : ''}Message to read:\n${line(item)}`
}

const clock = (s) => (/^([01]?\d|2[0-3]):[0-5]\d$/.test(String(s || '').trim()) ? String(s).trim().padStart(5, '0') : '')

// The model's JSON as a plan row; the day from the message's words, or a bare time means the day it was sent.
export function parse(raw, item) {
  const out = parseModelJSON(String(raw).match(/\{[\s\S]*\}/)?.[0] ?? 'null', 'PLANS_JSON_INVALID')
  if (!out || typeof out !== 'object') throw failure('PLANS_JSON_INVALID')
  const starts = clock(out.start)
  const day = resolveDue(String(out.when || ''), '', item.ts, item.text) || (starts && TIME.test(item.text) ? isoDay(item.ts) : '')
  const what = String(out.what || '').replace(/[."]/g, '').trim().slice(0, 60)
  const yes = out.plan === true && !!day && !!what
  return { item_id: item.id, is_plan: yes ? 1 : 0, what: yes ? what : '', day: yes ? day : '', starts: yes ? starts : '', ends: yes ? clock(out.end) : '',
    weekly: yes && out.weekly === true ? 1 : 0, cancelled: yes && out.cancelled === true ? 1 : 0 }
}

export async function read(db, item) {
  const res = await modelFetch('/api/chat', {
    method: 'POST', signal: AbortSignal.timeout(120000),
    body: JSON.stringify({ model: config.model, stream: false, think: false, keep_alive: config.keepAlive, options: { temperature: 0, num_ctx: 4096, num_predict: 100 },
      messages: [{ role: 'system', content: SYSTEM }, { role: 'user', content: prompt(db, item) }] }),
  })
  if (!res.ok) throw Error(`model ${res.status}`)
  const raw = (await res.json()).message?.content || ''
  // An answer that isn't JSON counts as no plan: retried, the same message gets the same answer, and the reading
  // stopped there for good.
  const none = { item_id: item.id, is_plan: 0, what: '', day: '', starts: '', ends: '', weekly: 0, cancelled: 0 }
  try { return parse(raw, item) } catch { return none }
}

// The next chat messages not yet read for plans, newest first. Most name no day or time and are marked read at once;
// the rest go to the model, `limit` at a time. Returns how many the model read, or 0 when there's nothing left.
export async function readPending(db, limit = 4) {
  const rows = db.prepare(`select i.id, i.source, i.thread, i.sender, i.from_me, i.ts, i.text from items i left join plans p on p.item_id = i.id
    where p.item_id is null and i.source in (${marks}) and i.ts > ? and i.ts < ? and i.thread is not null ${offClause()} order by i.ts desc limit 400`)
    .all(...PLAN_SOURCES, now() - KEEP_DAYS * 86400, now() - SETTLE)
  if (!rows.length) return 0
  const save = db.prepare(`insert or replace into plans (item_id, is_plan, what, day, starts, ends, weekly, cancelled, read_at)
    values (:item_id, :is_plan, :what, :day, :starts, :ends, :weekly, :cancelled, :read_at)`)
  const none = { is_plan: 0, what: '', day: '', starts: '', ends: '', weekly: 0, cancelled: 0 }
  let read_ = 0
  for (const item of rows) {
    const t = String(item.text || '')
    if (t.length < 8 || t.length > 1200 || !mayBePlan(t)) { save.run({ item_id: item.id, ...none, read_at: now() }); continue }
    if (read_ >= limit) break
    save.run({ ...(await read(db, item)), read_at: now() })
    read_++
  }
  return read_ || (rows.length ? 1 : 0)
}

const STOPWORDS = new Set(['the', 'and', 'with', 'for', 'at', 'of', 'a', 'an', 'to', 'on', 'in'])
const words = (s) => plain(s).split(/[^a-z0-9]+/).filter((w) => w.length >= 3 && !STOPWORDS.has(w))
const weekday = (iso) => new Date(`${iso}T12:00:00Z`).getUTCDay()
const weekOf = (iso) => plusDays(iso, -((weekday(iso) + 6) % 7))
const NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']

// Plan rows (with their message's thread and ts) as plans: same chat, same weekday, a word of what in common.
export function group(rows) {
  const plans = []
  for (const r of [...rows].sort((a, b) => a.ts - b.ts)) {
    const ws = words(r.what)
    const p = plans.find((g) => g.source === r.source && g.thread === r.thread && g.weekday === weekday(r.day) && g.words.some((w) => ws.includes(w)))
    if (p) { p.rows.push(r); for (const w of ws) if (!p.words.includes(w)) p.words.push(w) } else plans.push({ source: r.source, thread: r.thread, weekday: weekday(r.day), words: ws, rows: [r] })
  }
  return plans.map((p) => {
    const on = p.rows.filter((r) => !r.cancelled)
    const timed = on.filter((r) => r.starts).at(-1)
    const latest = on.at(-1) || p.rows.at(-1)
    return {
      id: `plan:${p.rows[0].item_id}`, source: p.source, thread: p.thread, weekday: p.weekday,
      what: latest.what, starts: timed?.starts || '', ends: timed?.ends || '',
      weekly: on.some((r) => r.weekly) || new Set(on.map((r) => weekOf(r.day))).size > 1,
      first: on.length ? on.map((r) => r.day).sort()[0] : p.rows[0].day, days: [...new Set(on.map((r) => r.day))],
      off: new Set(p.rows.filter((r) => r.cancelled).map((r) => r.day)),
      said: Math.max(...p.rows.map((r) => r.ts)), items: p.rows.map((r) => r.item_id),
    }
  })
}

// The days a plan happens between two dates (inclusive): each of its days, or every week on its weekday from the
// first, for eight weeks after it was last mentioned.
export function datesOf(plan, from, to) {
  if (!plan.weekly) return plan.days.filter((d) => d >= from && d <= to && !plan.off.has(d))
  const until = plusDays(isoDay(plan.said), WEEKLY_WEEKS * 7)
  const out = []
  for (let d = from; d <= to && d <= until; d = plusDays(d, 1)) if (d >= plan.first && weekday(d) === plan.weekday && !plan.off.has(d)) out.push(d)
  return out
}

export function plans(db, { sources, auth = authorization(sources ?? null) } = {}) {
  db = readScope(db, auth)
  const rows = db.prepare(`select p.*, i.source, i.thread, i.ts from plans p join items i on i.id = p.item_id
    where p.is_plan = 1 and i.ts > ? ${offClause()}`).all(now() - KEEP_DAYS * 86400)
  return group(sources ? rows.filter((r) => sources.includes(r.source)) : rows)
}

const label = (p) => `${p.what}${p.ends ? `, until ${p.ends}` : ''} (${p.thread}${p.weekly ? `, every ${NAMES[p.weekday]}` : ''})`
const tsOf = (day, hhmm) => dayRange(day)[0] + (hhmm ? Number(hhmm.slice(0, 2)) * 3600 + Number(hhmm.slice(3)) * 60 : 0)

// Expose timed plans as calendar-shaped events for the brief, day view and heads-ups.
// An untimed plan stays hidden until a later message supplies a time.
export const shows = (p) => !!p.starts

// Deduplicate one timed plan posted to multiple chats. Prefer the version with most supporting messages.
export function planEvents(db, fromIso, toIso, opts = {}) {
  const seen = new Set()
  return plans(db, opts).filter(shows).sort((a, b) => b.items.length - a.items.length).flatMap((p) => datesOf(p, fromIso, toIso).map((day) => ({
    id: p.id, thread: p.thread, ts: tsOf(day, p.starts), text: label(p), allDay: !p.starts, day, plan: true,
    what: p.what, ends: p.ends ? tsOf(day, p.ends) : null, weekly: p.weekly,
    meta: JSON.stringify({ allDay: !p.starts, plan: true }),
  }))).filter((e) => e.allDay || (!seen.has(`${e.day} ${e.ts}`) && seen.add(`${e.day} ${e.ts}`)))
}

// One plan for its page (/api/event): what it is, its next day, and the messages it came from.
export function planInfo(db, id, auth = authorization(null)) {
  db = readScope(db, auth)
  const p = plans(db, { auth }).find((x) => x.id === id)
  if (!p) return null
  const day = datesOf(p, isoDay(now()), plusDays(isoDay(now()), 7 * WEEKLY_WEEKS))[0] || p.days.at(-1)
  const said = db.prepare(`select ts, sender, from_me, source, thread, text from items where id in (${p.items.map(() => '?').join(', ')}) order by ts desc limit 6`).all(...p.items)
  return {
    id, title: p.what, place: null, calendar: `${p.thread} chat${p.weekly ? `, every ${NAMES[p.weekday]}` : ''}`, ts: tsOf(day, p.starts), allDay: !p.starts,
    label: null, context: `From the ${p.thread} chat, last said ${dayLabel(isoDay(p.said))}.`,
    related: said.map((m) => ({ who: m.from_me ? N : m.sender, ts: m.ts, source: m.source, thread: m.thread, text: String(m.text).replace(/\s+/g, ' ').slice(0, 300) })),
  }
}
