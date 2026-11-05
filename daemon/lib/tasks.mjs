import { evidenceLine, ownerCreated } from './evidence-trust.mjs'
import { authorization, readScope } from './authorization.mjs'
import { callIntent, callbackCompletion } from './callbacks.mjs'
import { config } from './config.mjs'
import { localDate } from './dates.mjs'
import { authoredText, ownerCompletion, ownerCompletionClaim } from './completion-evidence.mjs'
import { now } from './db.mjs'
import { planEvents } from './plans.mjs'
import { SECOND } from './second.mjs'
import { actionCard, actionTitle, priorityStatement, replyQuestion } from './owner-action.mjs'
import { isOff, offClause } from './settings.mjs'

const pad = (n) => String(n).padStart(2, '0')
export const isoDay = (ts) => { const [y, m, d] = localDate(ts); return `${y}-${pad(m)}-${pad(d)}` }
export const today = () => isoDay(now())
export const plusDays = (iso, n) => new Date(Date.parse(iso) + n * 86400000).toISOString().slice(0, 10)
const fmt = (opts) => new Intl.DateTimeFormat('en-GB', { timeZone: config.timezone, ...opts })
export const dayLabel = (iso) => fmt({ weekday: 'short', day: 'numeric', month: 'short' }).format(new Date(`${iso}T12:00:00Z`))
export const timeLabel = (ts) => fmt({ hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date(ts * 1000))
const weekday = (iso) => fmt({ weekday: 'short' }).format(new Date(`${iso}T12:00:00Z`))
const SOURCE = { whatsapp: 'WhatsApp', imessage: 'iMessage', mail: 'email', calls: 'call', calendar: 'calendar', chat: 'chat' }

// Unix range of a local calendar day, found by stepping hours so DST days work.
export function dayRange(iso) {
  let start = Math.floor(Date.parse(`${iso}T00:00:00Z`) / 1000) - 14 * 3600
  while (isoDay(start) < iso) start += 3600
  while (isoDay(start - 60) === iso) start -= 60
  let end = start + 22 * 3600
  while (isoDay(end) === iso) end += 3600
  while (isoDay(end - 60) !== iso) end -= 60
  return [start, end]
}

const OVERDUE_DAYS = 3
const MOMENTS = new Set(['appointment', 'reply'])
// A reply alone does not complete substantive work. Let the done-check inspect the later chat
// for evidence; conversational questions can close when answered. A model’s reply label
// must not override a clear work request.
const WORK = /^(write|draft|prepare|plan|set|create|build|make|design|review|investigate|fix|update|implement|research|analy[sz]e|organi[sz]e|finish|deliver|record|edit|test|pay|move|add|remove|publish|release|deploy|ship|migrate|rewrite|refactor)\b/i
// Being somewhere is a moment whatever the card says: "Attend the daily meeting at 13" can't be done a day late.
const moment = (t) => MOMENTS.has(t.card) || /^(attend|join|go to|be at)\b/i.test(t.summary || '')
// Sources switched off in Setup leave the brief along with everything else they brought.
// Someone you owe something wrote again: the moment to remember it ("Nika just wrote. You still owe this"). Same chat
// only: a one to one chat is the person, and in a group only what that sender asked of you, never your promises to the
// whole group. The island shows each once per message (Orb.swift remindOwed).
const OWED_MINUTES = 20
const OWED_SOURCES = ['whatsapp', 'imessage', 'discord', 'chat', 'notifications']
export function owed(db, live, at = now(), minutes = OWED_MINUTES) {
  const fresh = db.prepare(`select source, thread, sender, max(ts) ts, max(json_extract(meta, '$.group')) grp from items
    where from_me = 0 and ts > ? and source in (${OWED_SOURCES.map(() => '?').join(', ')}) ${offClause('source')}
    group by source, thread, sender order by ts desc`).all(at - minutes * 60, ...OWED_SOURCES)
  const out = []
  for (const m of fresh) {
    const t = live.find((t) => t.source === m.source && t.thread === m.thread && t.ts < m.ts - 60 && !['ask', 'stalled'].includes(t.card) &&
      (t.from_me ? !m.grp && m.source !== 'notifications' : t.sender === m.sender))
    if (t && !out.some((o) => o.card.id === t.id)) out.push({ who: firstName(m.grp || m.source === 'notifications' ? m.sender : m.thread || m.sender), at: m.ts, card: t })
  }
  return out.slice(0, 3)
}

const sourceFilter = (sources) => `${sources ? `and i.source in (${sources.map((s) => `'${s.replace(/'/g, '')}'`).join(', ')})` : ''} ${offClause()}`
// Where Reply takes you when a card has no link of its own: the app the conversation lives in.
const APPS = { whatsapp: 'net.whatsapp.WhatsApp', imessage: 'com.apple.MobileSMS', discord: 'com.hnc.Discord', reminders: 'com.apple.reminders' }
const openApp = (r) => {
  if (r.url) return null
  try { return r.source === 'notifications' ? JSON.parse(r.meta || '{}').app || null : APPS[r.source] || null } catch { return null }
}

// Used by the native Confirm action and other explicit owner marks.
export function markTask(db, id, status) {
  if (!['done', 'dismissed', 'open', 'snoozed'].includes(status)) throw Error('bad status')
  const reason = status === 'snoozed' ? `until ${plusDays(today(), 1)}` : 'marked in the timeline'
  db.prepare(`insert into task_state (item_id, status, changed_at, reason, completion_origin) values (?, ?, ?, ?, ?)
    on conflict(item_id) do update set status = excluded.status, changed_at = excluded.changed_at,
      reason = excluded.reason, completion_origin = excluded.completion_origin, url = null`)
    .run(id, status, now(), reason, ['done', 'dismissed'].includes(status) ? 'owner' : null)
}

// Every task Kier knows about, with a state the brief can act on: open, overdue, handled, done or dismissed.
export function tasks(db, { days = 14, sources, auth = authorization(sources ?? null) } = {}) {
  db = readScope(db, auth)
  const t0 = today()
  const rows = db.prepare(`
    select i.id, i.rowid rid, i.source, i.thread, i.sender, i.from_me, i.ts, coalesce(t.said, i.text) text, i.text raw_text, i.url, i.meta, t.due, t.when_words, t.amount, t.urgency, t.summary, t.second, t.quiet, t.confirmed, t.card, t.hint, t.hint_url, t.model, s.status, s.reason, s.url evidence_url, s.changed_at done_at, s.completion_origin
    from tags t join items i on i.id = t.item_id left join task_state s on s.item_id = i.id
    where t.is_task = 1 and (i.ts > ? or t.due >= ? or s.changed_at > ?
      or (i.source = 'kier' and (s.status is null or s.status in ('open', 'snoozed', 'looks_done', 'looks_unneeded')))
      or (t.card = 'callback' and (s.status is null or s.status in ('open', 'snoozed', 'looks_done', 'looks_unneeded')))) ${sourceFilter(sources)}
    order by i.ts desc`).all(now() - days * 86400, plusDays(t0, -days), now() - days * 86400)
  // Include later rows from the same minute: some sources provide minute-resolution timestamps.
  const replied = db.prepare('select ts from items where source = ? and thread = ? and from_me = 1 and (ts > ? or (ts = ? and rowid > ?)) and ts < ? order by ts, rowid limit 1')
  const replies = db.prepare('select * from items where source = ? and thread = ? and from_me = 1 and (ts > ? or (ts = ? and rowid > ?)) and ts < ? order by ts, rowid limit 30')
  return rows.filter(r => r.confirmed === 1 || r.status || !priorityStatement(r)).map((r) => {
    // old tags get the same wording and card rule without rewriting the vault.
    r.summary = actionTitle(r.summary, r)
    if (replyQuestion(r)) r.card = 'reply'
    r.card = actionCard(r.card, r)
    if (r.card === 'reply' && WORK.test(r.summary || '')) r.card = 'todo'
    let state = r.status || 'open'
    let reason = r.reason || null
    // Older model verdicts also need confirmation before original reminders can close.
    if (ownerCreated(r) && ['done', 'handled'].includes(state)
        && !['owner', 'reminders'].includes(r.completion_origin)) state = 'looks_done'
    if (ownerCreated(r) && state === 'dismissed' && !['owner', 'reminders'].includes(r.completion_origin) && r.reason !== 'marked in the timeline') state = 'looks_unneeded'
    let callback = {}
    try { callback = JSON.parse(r.meta || '{}') } catch {}
    const phoneTask = r.card === 'callback' || callIntent(r)
    // Switching a chat source off also hides the wording/timing it contributed to a call card.
    if (r.card === 'callback' && callback.promiseId) {
      const promise = db.prepare('select source from items where id = ?').get(callback.promiseId)
      if (!promise || isOff(promise.source)) {
        r.text = r.raw_text; r.due = ''; r.when_words = ''; r.quiet = 1
        delete callback.promiseId; delete callback.promiseTs
        r.meta = JSON.stringify(callback)
      } else r.from_me = 1
    }

    // "Tomorrow" hides a task until its date comes round.
    if (state === 'snoozed') state = (reason?.match(/\d{4}-\d{2}-\d{2}/)?.[0] || '') > t0 ? 'snoozed' : 'open'
    // AI questions close when you answer in that session, which the AI collector checks itself.
    // A card you reopened (Undo on a "done" toast) stays open: no automatic rule closes it again.
    // A follow-up handed back for later ("pitaj me kad završim…") isn't settled by your "ok, pingam te": that's you
    // agreeing to it. It closes when you follow up, which the done-check reads.
    if (!ownerCreated(r) && phoneTask && (!r.status || r.status === 'snoozed')) {
      const call = callbackCompletion(db, r)
      if (call) { state = 'handled'; reason = call.seconds > 0 ? `you spoke, ${Math.max(1, Math.round(call.seconds / 60))} min` : 'you spoke'; r.done_at = call.ts }
    }
    if (!ownerCreated(r) && !phoneTask && state === 'open' && !r.status && !r.from_me && r.source !== 'ai' && r.model !== 'later') {
      // A reply closes a request a reply can settle, dated or not: replying was the task. Payments, dated items and
      // real work stay open: "ok" doesn't pay the bill or write the plan.
      if ((r.card === 'reply' || (!r.amount && !r.due && !WORK.test(r.summary || ''))) && (r.reply = replied.get(r.source, r.thread, r.ts, r.ts, r.rid, r.ts + 7 * 86400))) { state = 'looks_done'; reason = 'Looks done: you replied in this chat'; r.done_at = r.reply.ts }
      else {
        // Work closes only when a first-person completed action matches this task.
        // Other replies go to the done-check and can only suggest confirmation.
        const after = replies.all(r.source, r.thread, r.ts, r.ts, r.rid, r.ts + 86400).filter((x) => x.text)
        const said = after.find(x => ownerCompletion(x, r))
        // Text matching alone never hides a card: it suggests, and one tap confirms. Rule matching keeps finding
        // new edge cases (other payee, other currency, a word that is also a currency code), so it only proposes.
        if (said) { state = 'looks_done'; reason = `Looks done: you said "${authoredText(said).slice(0, 80)}"` }
        else if (after.some(x => ownerCompletionClaim(x, r))) { state = 'looks_done'; reason = 'Looks done: confirm this obligation was fully completed' }
        else if (after.length) r.answered = after.at(-1).ts
      }
    }
    // Anything tied to a moment (being somewhere, a quick "reply now") has simply passed once its day is over.
    // Only promises, to-dos and payments can be forgotten, for a few days.
    if (state === 'open' && r.due && r.due < t0) state = r.source === 'kier' ? 'overdue' : r.card === 'callback' || (!moment(r) && r.due >= plusDays(t0, -OVERDUE_DAYS)) ? 'overdue' : 'expired'
    // Summaries were written on the day the message came, so "tomorrow" goes stale; the card shows the date instead.
    if (r.summary) r.summary = r.summary.replace(/\s+(?:(?:by|until|before|on|for)\s+)?(today|tomorrow|tonight|this evening|this morning)\.?$/i, '')
    // Without a second opinion, keep the first model’s judgment. Owner promises, personal
    // reminders and explicitly claimed tasks never wait under Maybe yours.
    const maybe = r.source !== 'reminders' && !r.from_me && r.confirmed !== 1 && ((r.second != null && r.second < SECOND.threshold) || r.quiet === 1)
    delete r.reply
    delete r.raw_text
    return { ...r, from_me: !!r.from_me, state, reason, maybe, open_app: openApp(r) }
  })
}

// The calendar's events, and the plans agreed in chats (plans.mjs) on those days, unless the calendar has the same
// thing at the same time already.
export function events(db, fromIso, toIso, { sources, auth = authorization(sources ?? null) } = {}) {
  db = readScope(db, auth)
  const [from] = dayRange(fromIso)
  const [, to] = dayRange(toIso)
  const calendar = (sources && !sources.includes('calendar')) || isOff('calendar') ? []
    : db.prepare("select id, thread, ts, text, meta from items where source = 'calendar' and ts >= ? and ts < ? order by ts").all(from, to)
      .map((e) => ({ ...e, allDay: JSON.parse(e.meta || '{}').allDay, day: isoDay(e.ts) }))
  const chats = planEvents(db, fromIso, toIso, { sources })
    .filter((p) => !calendar.some((e) => e.day === p.day && !e.allDay && !p.allDay && Math.abs(e.ts - p.ts) <= 15 * 60))
  return [...calendar, ...chats].sort((a, b) => a.ts - b.ts)
}

const SECTION_MAX = 6
const OWN_UNDATED_HOURS = 24

// Most urgent first, then newest; the rest is counted, not listed.
function top(list, when = (t) => t.ts) {
  const sorted = [...list].sort((a, b) => (b.urgency || 0) - (a.urgency || 0) || when(b) - when(a))
  return { list: sorted.slice(0, SECTION_MAX), more: Math.max(0, sorted.length - SECTION_MAX) }
}

// Deduplicate nearby cards in one conversation by shared subject, retaining the newest.
// A request followed by the owner’s promise can describe one task. Stalled work uses its
// repository or pull request identity instead of wording.
const content = (s) => new Set(String(s || '').toLowerCase().match(/[\p{L}\d]{4,}/gu) || [])
function dedupe(list) {
  const kept = []
  for (const t of list) {
    const mine = content(t.summary)
    const twin = t.card !== 'stalled' && kept.some((k) => k.source === t.source && k.thread === t.thread && (k.summary.toLowerCase() === t.summary.toLowerCase()
      || (Math.abs(k.ts - t.ts) <= 1800 && [...mine].filter((w) => content(k.summary).has(w)).length >= Math.min(3, Math.max(2, mine.size - 1)))))
    if (!twin) kept.push(t)
  }
  return kept
}

// Completed cards share one ordering and duplicate rule in both the brief and the full list.
export function completed(db, { days = 365, sources, auth = authorization(sources ?? null) } = {}) {
  db = readScope(db, auth)
  const cutoff = now() - days * 86400
  return dedupe(tasks(db, { days, sources })
    .filter(t => ['handled', 'done'].includes(t.state) && (t.done_at || t.ts) > cutoff)
    .sort((a, b) => (b.done_at || b.ts) - (a.done_at || a.ts)))
}

export function donePage(db, { offset = 0, limit = 100, days = 365 } = {}) {
  offset = Math.max(0, Math.trunc(Number(offset)) || 0)
  limit = Math.min(200, Math.max(1, Math.trunc(Number(limit)) || 100))
  days = Math.min(365, Math.max(1, Math.trunc(Number(days)) || 365))
  const all = completed(db, { days })
  const cards = all.slice(offset, offset + limit)
  return { cards, total: all.length, days, next: offset + cards.length < all.length ? offset + cards.length : null }
}

// Track the owner’s explicit requests to others, excluding conversational questions and
// obligations between other people. Unanswered requests lapse after a week.
const ASKS = new RegExp(`^${config.me.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} (?:asks|tells|reminds|wants) (.+?) to (.+)$`, 'i')
// A new owner task in the same conversation can indicate that responsibility has returned
// to the owner rather than remaining with the other person.
const HANDED_BACK = 3600
export function waiting(db, { days = 7, sources, auth = authorization(sources ?? null) } = {}) {
  db = readScope(db, auth)
  const back = db.prepare(`select 1 from tags t join items i on i.id = t.item_id left join task_state s on s.item_id = i.id
    where i.source = ? and i.thread = ? and i.ts > ? and i.ts <= ? and t.is_task = 1 and (s.status is null or s.status = 'open') limit 1`)
  return db.prepare(`select i.id, i.source, i.thread, i.ts, i.url, coalesce(t.said, i.text) text, t.summary, s.status
    from tags t join items i on i.id = t.item_id left join task_state s on s.item_id = i.id
    where i.from_me = 1 and t.is_task = 0 and i.ts > ? ${sourceFilter(sources)} order by i.ts desc`).all(now() - days * 86400)
    .flatMap((r) => {
      const m = (r.summary || '').match(ASKS)
      // A name followed by a question or reassurance is not necessarily a request for action.
      if (!m || /\b(how|what|why|where|when|whether|if|which|who|he|she|they|it|we|you)\b/i.test(m[1]) || (r.status && r.status !== 'open')) return []
      if (back.get(r.source, r.thread, r.ts, r.ts + HANDED_BACK)) return []
      const who = /^(someone|them|him|her|the group|everyone)$/i.test(m[1]) ? r.thread : m[1]
      return [{ id: r.id, source: r.source, thread: r.thread, ts: r.ts, url: r.url, text: r.text, who, what: m[2].replace(/\.$/, '') }]
    })
}

export function brief(db, { sources, auth = authorization(sources ?? null) } = {}) {
  db = readScope(db, auth)
  const t0 = today()
  const week = plusDays(t0, 7)
  const all = dedupe(tasks(db, { sources }).filter((t) => ['open', 'overdue', 'looks_done', 'looks_unneeded'].includes(t.state)))
  const ev = events(db, t0, week, { sources })
  // Tasks both models agree on make the brief; the ones the second opinion doubts wait under "Maybe yours".
  const live = all.filter((t) => !t.maybe)
  // Keep an outstanding promise visible when the recipient writes again, so a reminder
  // always leads to an accessible card.
  const back = new Map(owed(db, live, now(), 24 * 60).map((o) => [o.card.id, o.at]))
  // Your own "I'll fix it" without a date is usually handled in the same conversation, so it only
  // stays in the brief for a day; requests from other people stay until answered or 3 days pass.
  const recent = (t) => t.source === 'kier' || t.card === 'callback' || t.due || t.ts > now() - (t.from_me ? OWN_UNDATED_HOURS * 3600 : OVERDUE_DAYS * 86400) || back.has(t.id)
  const maybe = top(all.filter((t) => t.maybe && recent(t)))
  const forgotten = top(live.filter((t) => t.state === 'overdue' || (['looks_done', 'looks_unneeded'].includes(t.state) && t.due && t.due < t0)))
  const open = top(live.filter((t) => !t.due && recent(t)), (t) => back.get(t.id) || t.ts)
  const b = {
    date: t0,
    today: { events: ev.filter((e) => e.day === t0), tasks: live.filter((t) => t.due === t0) },
    forgotten: forgotten.list,
    open: open.list,
    maybe: maybe.list,
    more: { forgotten: forgotten.more, open: open.more, maybe: maybe.more },
    soon: { events: ev.filter((e) => e.day > t0), tasks: live.filter((t) => t.due > t0 && t.due <= week) },
    waiting: waiting(db, { sources }).slice(0, 8),
    // Done lately, the last one done first: what Kier saw done (a reply, a call, a commit), shown so a wrong guess can
    // be undone, and what you ticked off yourself, so the one you just marked is at the top.
    done: completed(db, { days: OVERDUE_DAYS, sources }).slice(0, SECTION_MAX),
  }
  b.owed = owed(db, live)
  b.ahead = ahead(db, b)
  b.day = dayList(b)
  // The 08:00 and 20:00 brief, for the island to show as its own nudge, for two hours after it was due.
  if (sources === undefined && moments.brief && moments.brief.at > now() - 2 * 3600) b.moment = moments.brief
  const g = glanceOf(b)
  return { ...b, glance: g?.text ?? null, glanceAbout: g ? { line: g.line, text: g.about } : null }
}

// The daemon schedules briefs; the app shows them in its island. Avoid osascript notifications
// that macOS attributes to Script Editor.
export const moments = { brief: null }
export function briefMoment(b, at = now()) {
  const n = b.forgotten.length + b.today.tasks.length + b.open.length
  const first = [...b.forgotten, ...b.today.tasks, ...b.open][0]
  const part = new Date(at * 1000).getHours() < 12 ? 'Morning' : 'Evening'
  return { at, line: n ? `${part} brief: ${n} ${n === 1 ? 'thing' : 'things'} waiting` : `${part} brief`, text: first ? first.summary : 'Nothing waiting on you.' }
}

// The coming week's events and dated tasks the model said are worth a heads-up (headsup.mjs), soonest first.
function ahead(db, b) {
  const asked = db.prepare('select important, label, context from heads_up where key = ?')
  const when = (x) => `${x.day} ${x.ts ? timeLabel(x.ts) : '99:99'}`
  return [
    ...b.soon.events.map((e) => ({ id: e.id, day: e.day, ts: e.allDay ? null : e.ts, text: e.text, h: asked.get(`${e.id}@${e.day}`) })),
    ...b.soon.tasks.map((t) => ({ id: t.id, card: t.id, day: t.due, ts: null, text: t.summary, from: from(t), h: asked.get(`${t.id}@${t.due}`) })),
  ].filter((x) => x.h?.important === 1).map((x) => ({ ...x, label: x.h.label || x.text, context: x.h.context || null }))
    .sort((x, y) => when(x).localeCompare(when(y)))
}

// Who a task is with and where it was said, under its line: "Nika, WhatsApp", or "You said, WhatsApp".
const from = (t) => `${t.from_me ? 'You said' : who(t.sender)}, ${SOURCE[t.source] || t.source}`

// The Today card that slides out when you hover the island: at most four lines, most pressing first. Today's timed
// events still ahead, then what you owe that's overdue or due today, and one or two of tomorrow's heads-ups, which
// always get a line. It's worked out from what's open, so it holds still through the day: things drop off as they're
// done, and only something new and important adds a line.
const DAY_LINES = 4
// Read time words as HH:MM, distinguishing dotted dates from clock times.
export function clockOf(t) {
  const m = String(t.when_words || '').match(/\b([01]?\d|2[0-3])(?::([0-5]\d)(?!\d)|\.([0-5]\d)(?!\d)(?!\.\d|\.(?:\s|$)))/)
  return m ? `${m[1].padStart(2, '0')}:${m[2] ?? m[3]}` : null
}

function dayList(b) {
  const at = now()
  const clock = clockOf
  const lines = [
    ...b.today.events.filter((e) => !e.allDay && e.ts > at).slice(0, 2).map((e) => ({ id: e.id, card: null, when: timeLabel(e.ts), text: e.text })),
    ...b.forgotten.map((t) => ({ id: t.id, card: t.id, when: 'Overdue', text: t.summary, detail: from(t) })),
    ...b.today.tasks.map((t) => ({ id: t.id, card: t.id, when: clock(t) || 'Today', text: t.summary, detail: from(t) })),
  ]
  const day = plusDays(b.date, 1)
  const tomorrow = b.ahead.filter((x) => x.day === day).slice(0, 2).map((x) => ({ id: x.id, card: x.card || null, when: x.ts ? `Tomorrow ${timeLabel(x.ts)}` : 'Tomorrow', text: x.label, detail: x.context || x.from || null }))
  // Show the next upcoming item when space permits, including on quiet days.
  const later = b.ahead.filter((x) => x.day > day).slice(0, 1).map((x) => ({ id: x.id, card: x.card || null, when: `${weekday(x.day)}${x.ts ? ` ${timeLabel(x.ts)}` : ''}`, text: x.label, detail: x.context || x.from || null }))
  const out = [...lines.slice(0, DAY_LINES - Math.min(1, tomorrow.length)), ...tomorrow].slice(0, DAY_LINES)
  return out.length < DAY_LINES ? [...out, ...later] : out
}

// The one short line under the orb on the island, or nothing, and the island shrinks to just the orb. Only what is
// worth a glance right now, most pressing first: a meeting about to start, something overdue, something due today, an
// AI waiting on your answer, a fresh message to reply to. Older waiting things stay in the panel.
const GLANCE_MAX = 11
// A sender as a person reads it: no direction marks, and a Discord notification's "(#general, Text)" left off.
const who = (s) => String(s || '').replace(/[\u200e\u200f\u2066-\u2069]/g, '').replace(/\s*\((#[^)]*)\)\s*$/, '').trim()
const firstName = (s) => (s || '').replace(/[\u200e\u200f\u2066-\u2069]/g, '').trim().split(/[\s(]/)[0]
export const glance = (b, at = now()) => glanceOf(b, at)?.text ?? null

// Return both the compact glance and full event or task details for its hover card.
export function glanceOf(b, at = now()) {
  const next = b.today.events.filter((e) => !e.allDay && e.ts > at && e.ts - at <= 3600).sort((x, y) => x.ts - y.ts)[0]
  if (next) {
    const mins = Math.round((next.ts - at) / 60)
    const line = `Today at ${timeLabel(next.ts)}${mins <= 60 ? `, in ${Math.max(1, mins)} min` : ''}`
    if (mins <= 15) return { text: `in ${Math.max(1, mins)} min`, line, about: next.text || '' }
    // Strip punctuation from the first word before fitting the compact glance.
    const named = `${timeLabel(next.ts)} ${(next.text || '').split(/\s+/)[0].replace(/[^\p{L}\p{N}]+$/u, '')}`
    return { text: named.length <= GLANCE_MAX ? named : `at ${timeLabel(next.ts)}`, line, about: next.text || '' }
  }
  const overdue = b.forgotten.length + (b.more?.forgotten || 0)
  if (overdue) return { text: `${overdue} overdue`, line: overdue === 1 ? 'Overdue' : `Overdue, ${overdue - 1} more after this`, about: b.forgotten[0]?.summary || '' }
  if (b.today.tasks.length) {
    const n = b.today.tasks.length
    return { text: `${n} due today`, line: n === 1 ? 'Due today' : `Due today, ${n - 1} more after this`, about: b.today.tasks[0].summary || '' }
  }
  const fresh = (t, hours) => at - t.ts <= hours * 3600
  const ai = b.open.filter((t) => t.source === 'ai' && fresh(t, 3)).sort((x, y) => y.ts - x.ts)[0]
  if (ai) return { text: `${firstName(ai.sender)} asks`, line: `${who(ai.sender)} asks`, about: ai.summary || '' }
  const reply = b.open.find((t) => !t.from_me && t.card === 'reply' && fresh(t, 4))
  if (reply) {
    const text = `Reply ${firstName(reply.sender)}`
    return { text: text.length <= GLANCE_MAX ? text : '1 to reply', line: `Reply to ${who(reply.sender)}`, about: reply.summary || '' }
  }
  // Name the weekday in the compact look-ahead; the hover card supplies the full date and time.
  const day = b.ahead?.length ? plusDays(b.date, 1) : null
  const soon = day && b.ahead.find((x) => x.day === day)
  if (soon) {
    const name = (style) => new Date(`${day}T12:00:00`).toLocaleDateString('en-US', { weekday: style })
    const text = `${soon.label.split(/\s+/)[0].replace(/[^\p{L}\p{N}]+$/u, '')} ${name('short')}`
    return { text: text.length <= GLANCE_MAX ? text : name('long'), line: soon.ts ? `Tomorrow at ${timeLabel(soon.ts)}` : 'Tomorrow', about: soon.label }
  }
  return null
}

const line = (t) => {
  const bits = [t.from_me ? `you, ${SOURCE[t.source] || t.source}` : `${t.sender}, ${SOURCE[t.source] || t.source}`]
  if (t.amount) bits.push(t.amount)
  return `${t.summary} (${bits.join(', ')})`
}
const eventLine = (e) => `${e.allDay ? 'all day' : timeLabel(e.ts)} ${e.text}`

// Provide explicitly dated day summaries so the model does not infer weekdays from old messages.
export function daysText(db, from, to, { evidenceLabels = false } = {}) {
  const taskText = t => evidenceLabels ? evidenceLine(t, line(t)) : line(t)
  const eventText = e => evidenceLabels ? evidenceLine({ ...e, source: 'calendar' }, eventLine(e)) : eventLine(e)
  const t0 = today()
  const live = dedupe(tasks(db).filter((t) => (t.state === 'open' || t.state === 'overdue') && !t.maybe))
  const ev = events(db, from, to)
  const name = (iso) => (iso === t0 ? `Today, ${dayLabel(iso)}` : iso === plusDays(t0, 1) ? `Tomorrow, ${dayLabel(iso)}` : dayLabel(iso))
  const out = []
  for (let d = from; d <= to; d = plusDays(d, 1)) {
    const lines = [...ev.filter((e) => e.day === d).map(eventText), ...live.filter((t) => t.due === d).map(taskText)]
    out.push(lines.length ? `${name(d)}:` : `${name(d)}: nothing on the calendar or the list`, ...lines.map((l) => `- ${l}`))
  }
  // Asked about today, what's still waiting from before is on today's plate too.
  if (from === t0) {
    const b = brief(db)
    const still = [...b.forgotten.map((t) => `${taskText(t)}, was due ${dayLabel(t.due)}`), ...b.open.map(taskText)]
    if (still.length) out.push('', 'Still open from before:', ...still.map((l) => `- ${l}`))
  }
  return out.join('\n')
}

// A calendar file for an appointment card: Calendar.app opens it and asks where to add it, so no permission is needed.
export function icsFor(t) {
  const day = (t.due || today()).replace(/-/g, '')
  const time = (t.when_words || '').match(/\b(\d{1,2})[:.](\d{2})\b|\b(\d{1,2})\s?h\b/)
  const stamp = new Date().toISOString().replace(/[-:]/g, '').slice(0, 15) + 'Z'
  const text = (s) => s.replace(/\r\n?/g, '\n').replace(/[\\;,]/g, (c) => `\\${c}`).replace(/\n/g, '\\n')
  const when = time
    ? (() => { const h = String(time[1] || time[3]).padStart(2, '0'); const m = time[2] || '00'; const end = String((Number(h) + 1) % 24).padStart(2, '0')
      return [`DTSTART;TZID=${config.timezone}:${day}T${h}${m}00`, `DTEND;TZID=${config.timezone}:${day}T${end}${m}00`] })()
    : [`DTSTART;VALUE=DATE:${day}`, `DTEND;VALUE=DATE:${plusDays(t.due || today(), 1).replace(/-/g, '')}`]
  return ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Kier//EN', 'BEGIN:VEVENT', `UID:${t.id.replace(/\W/g, '')}@getkier.com`, `DTSTAMP:${stamp}`,
    ...when, `SUMMARY:${text(t.summary || t.text)}`, `DESCRIPTION:${text(`${t.sender}: ${t.text}`)}`, 'END:VEVENT', 'END:VCALENDAR'].join('\r\n')
}

export function briefText(b) {
  const out = [`Kier, ${dayLabel(b.date)}`]
  const section = (title, lines) => { if (lines.length) out.push('', title, ...lines.map((l) => `- ${l}`)) }
  section(`Today, ${dayLabel(b.date)}`, [...b.today.events.map(eventLine), ...b.today.tasks.map(line)])
  const more = (n) => (n ? [`and ${n} more in the timeline`] : [])
  section('Maybe forgotten', [...b.forgotten.map((t) => `${line(t)}, was due ${dayLabel(t.due)}`), ...more(b.more?.forgotten)])
  section('Still open', [...b.open.map((t) => `${line(t)}, ${dayLabel(isoDay(t.ts))}`), ...more(b.more?.open)])
  // Label tomorrow explicitly to prevent confusion with today’s events.
  const day = (iso) => (iso === plusDays(b.date, 1) ? `Tomorrow, ${dayLabel(iso)}` : dayLabel(iso))
  section('Coming up', [
    ...b.soon.events.map((e) => `${day(e.day)}: ${eventLine(e)}`),
    ...b.soon.tasks.map((t) => `${day(t.due)}: ${line(t)}`),
  ])
  section('Maybe yours', [...(b.maybe || []).map(line), ...more(b.more?.maybe)])
  if (out.length === 1) out.push('', 'Nothing waiting on you.')
  return out.join('\n')
}
