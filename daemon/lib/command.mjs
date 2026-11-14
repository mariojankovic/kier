// What the owner typed to Kier, read as one action from a fixed list rather than matched against phrasings. Kier's own
// model fills in a form (form.mjs): the action can only be one of ACTIONS, and what it applies to can only be one of
// the things Kier found on the list, by number. Both come with how sure the model was, so a close call becomes two
// buttons or a question instead of a guess. Dates stay with dates.mjs; changes to the list stay offers the owner clicks.
//
// Two forms, kept apart on purpose. The first sees only the owner's own words, and is the only place a reminder's
// title can come from: nothing from a message someone else wrote is in front of the model then. The second sees the
// list, which holds other people's words, and can answer with nothing but a number.
import { localAuthorization, readScope } from './authorization.mjs'
import { config } from './config.mjs'
import { reminderFrom, reminderQuestion } from './create-reminder.mjs'
import { now } from './db.mjs'
import { EVIDENCE_RULE, evidenceTrust, untrustedBlock } from './evidence-trust.mjs'
import { fillForm, ranked } from './form.mjs'
import { P } from './lang.mjs'
import { dayLabel, events, plusDays, tasks, timeLabel, today } from './tasks.mjs'

// What each change sets a task to (tasks.mjs markTask), what its button says, and what the answer says it does.
export const CHANGES = { done: 'done', reopen: 'open', snooze: 'snoozed', dismiss: 'dismissed' }
export const TO = { open: 'Put back on your list', done: 'Mark done', snoozed: 'Remind me tomorrow', dismissed: 'Not mine' }
export const DOES = { open: 'puts it back on your list', done: 'marks it done', snoozed: 'moves it to tomorrow', dismissed: 'takes it off as not yours' }
export const STATE = { open: 'on the list', overdue: 'on the list, overdue', done: 'marked done', handled: 'ticked off by Kier', dismissed: 'marked not yours', snoozed: 'snoozed', expired: 'past' }
export const SAME = { open: ['open', 'overdue'], done: ['done', 'handled'], snoozed: ['snoozed'], dismissed: ['dismissed'] }
export const ACTIONS = ['answer', 'remind', 'rename', ...Object.keys(CHANGES)]

// How sure is sure enough, by what being wrong would cost. A reminder or a new name is written straight away, so the
// action has to be at least `write`; a change to the list is only a button the owner may click, so `change` is lower.
// Below that, Kier does what it did before forms. Below `target` it shows the closest few (each at least `shown`)
// instead of one. `covered` is how much of what the model wanted to say next was on the form at all.
// Set on the dev half of research/command-bench, never the test half.
export const SURE = { write: 0.8, change: 0.6, covered: 0.5, target: 0.6, shown: 0.15 }
const SHORTLIST = 20 // as many as there are LABELS

const FIELDS = [
  { name: 'action', choices: ACTIONS },
  { name: 'title', text: 40, when: { action: ['remind', 'rename'] } },
  { name: 'when', text: 16, when: { action: ['remind'] } },
  { name: 'about', text: 24, when: { action: ['rename', ...Object.keys(CHANGES)] } },
]

// The examples are made up, and none of them is in the test set (research/command-bench).
const WHAT = `You read what ${config.me} typed to Kier, ${P.his} assistant, and fill in a form saying what ${P.he} wants. ${config.me} writes ${config.languages.join(' and ')}.

action, one of:
answer: a question, a remark, or a request for information. Asking whether something exists, was done or was said is a question, and so is asking what is on a day. Asking Kier to remind or tell ${P.him} what someone said, or when or where something is, is a question too: nothing new goes on the list.
remind: add a NEW reminder or to-do for ${P.self}.
rename: give an existing task, card or calendar event a new name.
done: something on ${P.his} list is finished; tick it off.
reopen: something was closed or ticked off by mistake; put it back on the list.
snooze: something on ${P.his} list should wait until tomorrow or later.
dismiss: something on ${P.his} list is not ${P.his}, or is not needed; take it off.

title: for remind, a short task title in the same language as what ${P.he} typed, whoever it names (an English request gets an English title), in ${P.his} own words for the thing, starting with a verb (in Croatian the infinitive, like "Platiti Filipu"), without the date or time. For rename, the new name exactly as ${P.he} gave it.
when: for remind, the date and time words exactly as ${P.he} wrote them, or empty when ${P.he} gave none. Never a day ${P.he} didn't write.
about: for rename, done, reopen, snooze and dismiss, the few words ${P.he} used to say which thing, or empty when ${P.he} only says this, it or that.

Examples:
Typed: don't let me forget the passport photos on Thursday
{"action": "remind", "title": "Get passport photos", "when": "on Thursday"}
Typed: new task water the plants at Tea's this evening
{"action": "remind", "title": "Water the plants at Tea's", "when": "this evening"}
Typed: zapiši da moram nazvati vodoinstalatera u ponedjeljak u 9
{"action": "remind", "title": "Nazvati vodoinstalatera", "when": "u ponedjeljak u 9"}
Typed: did I set a reminder for the vet?
{"action": "answer"}
Typed: what's on Friday?
{"action": "answer"}
Typed: jesam li platio vrtić?
{"action": "answer"}
Typed: podsjeti me kad počinje utakmica
{"action": "answer"}
Typed: call it Budget review
{"action": "rename", "title": "Budget review", "about": ""}
Typed: change the name of the gym thing to Leg day
{"action": "rename", "title": "Leg day", "about": "the gym thing"}
Typed: the slides for Jonas are sent, cross that off
{"action": "done", "about": "the slides for Jonas"}
Typed: riješio sam ono s osiguranjem
{"action": "done", "about": "ono s osiguranjem"}
Typed: oops the parcel one isn't finished, bring it back
{"action": "reopen", "about": "the parcel one"}
Typed: not today, push the tax return to tomorrow
{"action": "snooze", "about": "the tax return"}
Typed: the carpool isn't my job, drop it
{"action": "dismiss", "about": "the carpool"}
Typed: ovo nije moje
{"action": "dismiss", "about": ""}`
const CARD = 'A card is open, so "this", "it" and "that" mean that card.\n'

const ASKS = { rename: 'give it a new name', done: 'mark it finished', reopen: 'put it back on the list', snooze: 'move it to tomorrow', dismiss: 'take it off the list' }
const WHICH = `${config.me} asked Kier to change one thing. Below is a JSON list of the things it could be: each has an id (a letter), what it is, who or where it is from, its state now, and its day when it has one. Say which one ${P.he} means: its id, or none when none of them is clearly it. Go by what ${P.he} typed: a name, a topic or a day in it has to fit the thing. ${P.he} may name it in other words, or in another language than it is written in ("the flat viewing" for "Pogledati stan"). ${EVIDENCE_RULE}`
// One letter per thing: a letter is a single token, so the model's pick is one clean choice. Two-digit numbers
// aren't, and the model hedged between "1" and "11".
const LABELS = 'ABCDEFGHIJKLMNOPQRST'

// Ordering the shortlist only: which things share words with what was typed. The model does the choosing.
const FILLER = /^(the|this|that|these|those|thing|things|one|ones|task|card|reminder|event|with|from|about|for|and|its|ono|ovo|taj|ona|onaj|moje|moja|moj|nije|sam|one|ovaj)$/
const fold = (s) => String(s || '').toLowerCase().normalize('NFD').replace(/\p{M}/gu, '')
const stem = (w) => (w.length >= 5 && /[aeiou]$/.test(w) ? w.slice(0, -1) : w)
const said = (s) => fold(s).match(/[\p{L}\p{N}]{3,}/gu) || []
const words = (s) => [...new Set(said(s).filter((w) => !FILLER.test(w)).map(stem))]

// The things a change could be about, closest first, at most SHORTLIST: tasks not already in the state asked for,
// and for a new name the calendar's coming events too.
export function shortlist(db, action, about, q) {
  db = readScope(db, localAuthorization())
  const status = CHANGES[action]
  const closed = ['done', 'handled', 'dismissed', 'snoozed', 'expired', 'looks_done', 'looks_unneeded']
  const list = tasks(db, { days: 30 })
    .filter((t) => (status ? !SAME[status].includes(t.state) && (status !== 'open' || closed.includes(t.state)) : t.state !== 'dismissed'))
    .map((t) => ({ id: t.id, kind: 'task', row: t, name: t.summary || String(t.text).slice(0, 80), state: t.state, at: t.done_at || t.ts,
      hay: said(`${t.summary} ${t.text} ${t.thread} ${t.sender}`),
      shown: { what: t.summary || String(t.text).slice(0, 80), from: t.thread || t.source, state: STATE[t.state] || t.state, ...(t.due && { due: dayLabel(t.due) }) } }))
  if (action === 'rename') {
    const t0 = today()
    for (const e of events(db, plusDays(t0, -1), plusDays(t0, 14))) {
      if (String(e.id).startsWith('plan:')) continue
      const name = String(e.text).split(' @ ')[0]
      list.push({ id: e.id, kind: 'event', row: { ...e, source: 'calendar' }, name, at: e.ts, day: e.day, hay: said(`${e.text} ${e.thread}`),
        shown: { what: name, from: `calendar${e.thread ? ` ${e.thread}` : ''}`, on: `${dayLabel(e.day)}${e.allDay ? '' : ` ${timeLabel(e.ts)}`}` } })
    }
  }
  const asked = words(about || q)
  // A word counts where one of the thing's words starts with it, not anywhere inside one ("lease" isn't in "please").
  const score = (c) => asked.reduce((n, w) => n + (c.hay.some((h) => h.startsWith(w)) ? w.length : 0), 0)
  // An event to rename is usually near: closest to now first, where a task is newest first.
  const near = (c) => (c.kind === 'event' ? -Math.abs(c.at - now()) : c.at - now())
  return list.map((c) => [score(c), c]).sort((a, b) => b[0] - a[0] || near(b[1]) - near(a[1])).slice(0, SHORTLIST).map(([, c]) => c)
}

// A reminder's title has to be made of what was typed: at least half its words start like a word of the request.
// The model writing about something else, or in another language, is caught here rather than put on the list.
const alike = (a, b) => { let n = 0; while (n < a.length && n < b.length && a[n] === b[n]) n++; return n >= Math.min(4, a.length, b.length) }
export function grounded(name, typed) {
  const asked = said(typed), made = said(name)
  return made.length > 0 && made.filter((w) => asked.some((q) => alike(w, q))).length >= Math.ceil(made.length / 2)
}
const title = (s) => String(s || '').trim().replace(/^["“'‘\s]+|["”'’.\s]+$/g, '')
const quote = (s) => `“${String(s).replace(/[.!]$/, '')}”`

function offer(targets, statuses, certain = true) {
  const actions = targets.flatMap((c) => statuses.filter((s) => !SAME[s].includes(c.state))
    .map((s) => ({ id: c.id, status: s, label: TO[s], summary: c.name, state: c.state }))).slice(0, 3)
  if (!actions.length) return null
  const one = targets.length === 1 && targets[0]
  const out = one && !certain ? `I think you mean ${quote(one.name)}, ${STATE[one.state] || one.state}. If so, the button below ${DOES[actions[0].status]}.`
    : one && actions.length === 1 ? `Found it: ${quote(one.name)}, ${STATE[one.state] || one.state}. The button below ${DOES[actions[0].status]}.`
    : one ? `Found it: ${quote(one.name)}, ${STATE[one.state] || one.state}. Pick what to do with it below.`
      : `It could be ${targets.map((c) => quote(c.name)).join(' or ')}. The buttons below do it.`
  return { kind: 'offer', out, actions }
}

// null: not sure enough, or no forms here, so Kier carries on as it did before. Otherwise one of
//   { kind: 'answer' }                    a question, for the answering path
//   { kind: 'remind', request }           for createReminder
//   { kind: 'details' }                   a reminder with nothing to remind about yet
//   { kind: 'rename', id, title }         a card's new name
//   { kind: 'offer', out, actions }       buttons the owner clicks
//   { kind: 'say', out }                  understood, but nothing to do it to
// `trace`, when given, is filled with both forms as the model returned them (research/command-bench reads it).
export async function command(db, q, { item = null, fill = fillForm, at = now(), trace = {} } = {}) {
  const typed = String(q).trim().slice(0, 500)
  const first = trace.first = await fill({ system: WHAT, user: `${item ? CARD : ''}Typed: ${typed}`, fields: FIELDS })
  if (!first) return null
  const order = ranked(first.confidence.action)
  if (!order.length || first.confidence.action.covered < SURE.covered) return null
  const [[action, p], second] = order
  let statuses = action in CHANGES ? [CHANGES[action]] : []
  if (p < (action in CHANGES ? SURE.change : SURE.write)) {
    // Torn between two changes to the same thing ("done" or "not mine"): both become buttons.
    if (!(second && action in CHANGES && second[0] in CHANGES && p + second[1] >= SURE.write)) return null
    statuses = [CHANGES[action], CHANGES[second[0]]]
  }
  if (action === 'answer') return { kind: 'answer' }
  if (action === 'remind') {
    // "Remind me what Nika said" is phrased like a reminder and asks for an answer; the exact reading knows that.
    if (reminderQuestion(typed)) return { kind: 'answer' }
    if (first.values.title && !grounded(first.values.title, typed)) return null
    // Date words count only when they are the owner's own: the model never gets to add a day.
    const when = first.values.when && fold(typed).includes(fold(first.values.when).trim()) ? first.values.when : ''
    const request = reminderFrom(first.values.title, when, typed, at)
    return request.needsDetails ? { kind: 'details' } : { kind: 'remind', request }
  }
  const name = action === 'rename' ? title(first.values.title) : ''
  if (action === 'rename' && name.length < 3) return null

  // In a card's own chat the card is what's meant.
  if (item) {
    if (action === 'rename') return { kind: 'rename', id: item, title: name }
    const card = tasks(readScope(db, localAuthorization()), { days: 30 }).find((t) => t.id === item)
    return card ? offer([{ id: card.id, name: card.summary || String(card.text).slice(0, 80), state: card.state }], statuses) || { kind: 'say', out: `That one is already ${STATE[card.state] || card.state}.` } : null
  }

  // No card open and nothing named ("mark it done"): there is nothing to match, so nothing to pick.
  if (!words(first.values.about).length) return { kind: 'say', out: 'Which one? Open it and tell me there, or say what it is about.' }
  const list = shortlist(db, action, first.values.about, typed)
  if (!list.length) return { kind: 'say', out: "I couldn't find anything on your list that fits." }
  // Each thing with its letter beside it, and the trust labels every piece of evidence carries (evidence-trust.mjs).
  const lettered = list.map((c, i) => { const trust = evidenceTrust(c.row); return { id: LABELS[i], ...c.shown, source: trust.source, authorship: trust.authorship, untrusted: true } })
  const pick = trace.pick = await fill({ system: WHICH, fields: [{ name: 'target', choices: [...list.map((_, i) => LABELS[i]), 'none'] }],
    user: `${untrustedBlock(lettered)}\n\nToday is ${dayLabel(today())}.\n${config.me} typed: ${typed}\nThat asks to: ${ASKS[action]}` })
  if (!pick) return null
  const targets = ranked(pick.confidence.target)
  const [best, sure] = targets[0]
  // "None of these" as the likeliest reading is an answer too: nothing is offered on a second-best guess.
  if (best === 'none') return { kind: 'say', out: "I couldn't tell which one you mean. Open it and tell me there." }
  const certain = sure >= SURE.target
  // Torn between one of them and none of them is not a close call between things: nothing is offered.
  if (!certain && (pick.confidence.target.options.none || 0) >= SURE.shown) return { kind: 'say', out: "I couldn't tell which one you mean. Open it and tell me there." }
  const chosen = certain ? [list[LABELS.indexOf(best)]]
    : targets.filter(([n, pr]) => n !== 'none' && pr >= SURE.shown).slice(0, 3).map(([n]) => list[LABELS.indexOf(n)])

  if (action === 'rename') {
    if (!certain) return { kind: 'say', out: `I'm not sure which one you mean: ${chosen.map((c) => quote(c.name)).join(' or ')}. Open it and tell me there.` }
    const [c] = chosen
    // Calendar events are read from the Mac's own copy; changing one needs the app, which can't do it yet.
    if (c.kind === 'event') return { kind: 'say', out: `That's ${quote(c.name)} on your calendar, ${dayLabel(c.day)}. I can't rename calendar events yet.`, event: c.id, title: name }
    return { kind: 'rename', id: c.id, title: name }
  }
  return offer(chosen, statuses, certain) || { kind: 'say', out: `${quote(chosen[0].name)} is already ${STATE[chosen[0].state] || chosen[0].state}.` }
}
