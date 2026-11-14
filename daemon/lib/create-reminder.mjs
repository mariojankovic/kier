// Only a direct request to Kier can create an owner-authored task. Retrieved text
// and model output never enter this path.
import { randomUUID } from 'node:crypto'
import { addItems, now } from './db.mjs'
import { resolveDue } from './dates.mjs'
import { dateWords } from './lang.mjs'
import { config } from './config.mjs'

const DATES = dateWords(['en', 'hr'])
const REQUEST = /^(?:(?:please|molim te)\s+|(?:can|could|would|will) you\s+|mo[žz]e[šs](?: li)?(?: me)?\s+)*(?:remind me\b|(?:add|create|set)(?: me)? (?:a |an )?(?:new )?(?:task|reminder)\b|podsjeti(?:ti)? me\b|podseti me\b|dodaj(?: mi)? (?:zadatak|podsjetnik)\b)\s*:?\s*/i
const REFERENCE = /^(?:(?:about|on|to|na|za)\s+)?(?:it|this|that|them|the (?:task|card|reminder)|this (?:task|card|reminder)|that (?:task|card|reminder)|ovo|taj zadatak|ovaj zadatak)(?:\s|$)/i
const DATE = /\b(?:(?:on|by|u|do|za)\s+)?(?:day after tomorrow|this evening|this morning|tomorrow|today|tonight|prekosutra|sutra|danas|ve[čc]eras|monday|tuesday|wednesday|thursday|friday|saturday|sunday|ponedjeljak|ponedjeljka|utorak|utorka|srijedu|srijeda|[čc]etvrtak|petak|petka|subotu|subota|nedjelju|nedjelja|\d{1,2}\.\s?\d{1,2}\.(?:\s?\d{4})?)(?:\s+(?:at|u)\s+\d{1,2}:\d{2})?|\b(?:at|u)\s+\d{1,2}:\d{2}\b/gi

// A time of day in the request ("at 7", "at 7pm", "18:30", "u 7", "u 19h", "7 ujutro", "navečer"), taken out of
// the title and kept as HH:MM in the date words, which is where cards and Reminders read a time from. A bare hour is
// read like Apple does: the next time the clock shows it, so "tomorrow at 7" is 07:00; "pm" or "evening" moves it.
const EVENING = /\b(?:pm|p\.m\.|evening|tonight|in the evening|afternoon|nave[cč]er|ve[cč]eras|popodne|poslijepodne|uve[cč]e)\b/i
const MORNING = /\b(?:am|a\.m\.|morning|in the morning|ujutro|jutros)\b/i
const CLOCK = /(?:\b(?:at|@|around|by|u|oko|do)\s*)?\b([01]?\d|2[0-3])(?:[:.h]([0-5]\d))?\s*(?:h\b|sati\b|o'?clock\b)?\s*(am|pm|a\.m\.|p\.m\.)?(?=\s|$|[,.!?])/i
export function takeTime(text, at = now(), due = '') {
  const t = String(text)
  const m = t.match(new RegExp(`(?:\\b(?:at|@|around|by|u|oko|do)\\s*)\\b([01]?\\d|2[0-3])(?:[:.h]([0-5]\\d))?\\s*(?:h\\b|sati\\b|o'?clock\\b)?\\s*(am|pm|a\\.m\\.|p\\.m\\.)?(?=\\s|$|[,.!?])|\\b([01]?\\d|2[0-3])[:.]([0-5]\\d)\\b|\\b(1[0-2]|0?[1-9])\\s*(am|pm|a\\.m\\.|p\\.m\\.)(?=\\s|$|[,.!?])`, 'i'))
  const part = t.match(EVENING) || t.match(MORNING)
  if (!m && !part) return { text: t, clock: '' }
  let hour, minute = 0, meridiem = ''
  if (m) {
    hour = Number(m[1] ?? m[4] ?? m[6]); minute = Number(m[2] ?? m[5] ?? 0); meridiem = (m[3] || m[7] || '').toLowerCase()
  } else {
    hour = EVENING.test(t) ? 19 : 9
  }
  const evening = /^p/.test(meridiem) || (!meridiem && EVENING.test(t))
  const morning = /^a/.test(meridiem) || (!meridiem && MORNING.test(t))
  if (evening && hour < 12) hour += 12
  if (morning && hour === 12) hour = 0
  if (!evening && !morning && hour < 12 && due === localDay(at)) {
    // Today, and that morning hour has passed: the next time it shows is this evening.
    const nowHour = Number(new Intl.DateTimeFormat('en-GB', { timeZone: config.timezone, hour: '2-digit', hourCycle: 'h23' }).format(new Date(at * 1000)))
    if (hour <= nowHour) hour += 12
  }
  let rest = m ? t.slice(0, m.index) + t.slice(m.index + m[0].length) : t
  rest = rest.replace(EVENING, '').replace(MORNING, '').replace(/\s+/g, ' ').trim()
  return { text: rest, clock: `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}` }
}
const localDay = (at) => new Intl.DateTimeFormat('en-CA', { timeZone: config.timezone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(at * 1000))

// With a time but no day, a time already past today means tomorrow, like Apple Reminders.
function dayFor(clock, at) {
  const [h, m] = clock.split(':').map(Number)
  const parts = new Intl.DateTimeFormat('en-GB', { timeZone: config.timezone, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(new Date(at * 1000)).split(':').map(Number)
  const today = localDay(at)
  return h * 60 + m > parts[0] * 60 + parts[1] ? today : localDay(at + 86400)
}
const CROATIAN = /[čćšžđ]|\b(?:sutra|danas|prekosutra|ponedjelj|utor|srijed|petak|petku|subot|nedjelj|ujutro|nave[cč]er)/i
const at_ = (words, clock) => (CROATIAN.test(words) ? ` u ${clock}` : ` at ${clock}`)

// "Remind me what Nika said": the words after "remind me" ask for something to be told, not kept.
const ASKING = /^(what|who|why|how|where|whether|if|when|after|kad|kada|što|sta|kaj|tko|gdje)\b/i
export function reminderQuestion(question) {
  const q = String(question).trim().replace(/^mo[žz]e[šs](?: li)? me podsjetiti\s+/i, 'podsjeti me ')
  const prefix = q.match(REQUEST)
  return !!prefix && ASKING.test(q.slice(prefix[0].length).trim())
}

export function reminderRequest(question, at = now()) {
  const q = String(question).trim().replace(/^mo[žz]e[šs](?: li)? me podsjetiti\s+/i, 'podsjeti me ')
  const prefix = q.match(REQUEST)
  if (!prefix) return null
  let title = q.slice(prefix[0].length).replace(/[?!,]+$/, '').trim()
  if (!title || REFERENCE.test(title) || /\b(?:mark|snooze|reopen|dismiss)\b.*\b(?:card|task|reminder)\b/i.test(title) || ASKING.test(title)) return null
  const dates = [...title.matchAll(DATE)]
  // A bare time ("at 18:30") is not a day: the time logic below picks today or tomorrow.
  const date = dates.find(m => !/^\s*(?:(?:at|@|by|around|u|oko|do)\s*)?\d/i.test(m[0]) && resolveDue(m[0], '', at, title, DATES))
  const when = date?.[0] || ''
  const due = resolveDue(when, '', at, title, DATES)
  if (date) title = title.slice(0, date.index) + title.slice(date.index + when.length)
  const timed = takeTime(title, at, due || localDay(at))
  title = timed.text
  title = title.trim().replace(/^[,.:;\-\s]+/, '').replace(/^(?:to|about|for|that I|da|na|za)\s+/i, '').replace(/^[,.:;\-\s]+/, '').replace(/\s+/g, ' ').trim().replace(/[,.:;]+$/, '').trim()
  // A date followed by a reference still refers to an existing card.
  if (!title || REFERENCE.test(title)) return null
  const day = timed.clock && !due ? dayFor(timed.clock, at) : due
  const words = `${when}${timed.clock ? at_(`${when} ${q}`, timed.clock) : ''}`.trim()
  return { title: title[0].toUpperCase() + title.slice(1), due: day, when: words }
}

export function createReminder(db, request, at = now()) {
  const id = `kier:${randomUUID()}`
  const added = addItems(db, [{ id, source: 'kier', thread: 'Reminders', sender: config.me,
    fromMe: true, ts: at, text: request.title, meta: { ownerCreated: true } }])
  if (!added) return null
  // Use the stored, redacted title for every derived field and confirmation.
  const title = db.prepare('select text from items where id = ?').get(id).text
  db.prepare(`insert into tags (item_id, is_task, due, when_words, summary, card, confirmed, model, tagged_at)
    values (?, 1, ?, ?, ?, 'todo', 1, 'owner', ?)`).run(id, request.due, request.when, title, at)
  return { id, title, due: request.due, when: request.when }
}

// Asking Kier to remember something without the instant phrasings above ("can you create a reminder", "new task:
// dentist Monday", "don't let me forget the rent", "napravi podsjetnik"). Only the owner's own message reaches this.
export const ASK_DETAILS = 'Sure. What should I remind you about, and when?'
const INTENT = /\b(remind|reminder|reminders|to-?do|task|forget|forgot|podsjet\p{L}*|zadat\p{L}*|zaborav\p{L}*|zapamti)\b/iu
const PAST = /^\s*(?:did|have|has|had|was|were|what did|when did|who|jesam|jesi|je li|da li|sto je|što je|kaj je)\b/i
export const reminderIntent = (q) => INTENT.test(q) && !PAST.test(q)

const PROMPT = `Decide whether the user is asking their assistant to create a NEW reminder or task for them. Questions about past reminders, or asking what someone said, are not.
Reply with JSON only: {"create": true or false, "title": "", "when": ""}.
title: a short task title in the user's language, starting with a verb (Croatian: the infinitive, e.g. "Platiti Filipu"), without the date; empty if the user gave no task.
when: the date or time words exactly as the user wrote them (e.g. "tomorrow", "on Friday", "u petak"), or empty.`

// The model only extracts; Kier still decides the date itself and builds the card.
export async function modelReminder(q, fetchModel, model, at = now()) {
  const res = await fetchModel('/api/chat', {
    method: 'POST', signal: AbortSignal.timeout(20000),
    body: JSON.stringify({ model, asked: true, stream: false, think: false, options: { temperature: 0, num_predict: 80 }, messages: [
      { role: 'system', content: PROMPT }, { role: 'user', content: String(q).slice(0, 500) },
    ] }),
  })
  if (!res.ok) return null
  const text = String((await res.json()).message?.content || '')
  let out
  try { out = JSON.parse(text.slice(text.indexOf('{'), text.lastIndexOf('}') + 1)) } catch { return null }
  if (out?.create !== true) return null
  return reminderFrom(out.title, out.when, q, at)
}

// A title and date words the model took from the owner's request, made into a reminder: the day and time are worked
// out here, never by the model.
export function reminderFrom(rawTitle, rawWhen, q, at = now()) {
  const title = String(rawTitle || '').replace(/\s+/g, ' ').trim().replace(/[,.:;!?]+$/, '').slice(0, 140)
  if (!title) return { needsDetails: true }
  const when = String(rawWhen || '').trim()
  const timedTitle = takeTime(title, at)
  const due = when ? resolveDue(when, '', at, `${title} ${when}`, DATES) : ''
  const timed = takeTime(when, at, due || localDay(at))
  const clock = timed.clock || timedTitle.clock
  const day = clock && !due ? dayFor(clock, at) : due
  const words = `${due ? timed.text || when : ''}${clock ? at_(`${when} ${q}`, clock) : ''}`.trim()
  const clean = timedTitle.text || title
  return { title: clean[0].toUpperCase() + clean.slice(1), due: day, when: words }
}
