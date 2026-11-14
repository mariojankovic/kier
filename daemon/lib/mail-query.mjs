// A search typed into Kier Mail in plain words, read into filters: who, when, what kind of mail, and the words that
// are left. Kier Mail reads the obvious forms itself ("from priya", "last week", "with a pdf") and uses Kier's answer in
// place of its own reading, so the answer starts from that same reading (ownReading, the same rules) and only adds
// to it: a name written without "from" or "with", a sentence rather than keywords, Croatian, a date said another way,
// and the addresses Kier knows for a person. The request is read as a form by Kier's own model (form.mjs); every name
// and date word has to be one the owner typed, and every date is worked out here, never by the model. When Kier has
// nothing to add, or can't be sure, it declines and Kier Mail's own reading stands.
import { execFileSync } from './child-process.mjs'
import { localAuthorization, readScope } from './authorization.mjs'
import { config } from './config.mjs'
import { fillForm, ranked } from './form.mjs'
import { contacts } from '../collectors/contacts.mjs'
import { automated } from '../collectors/mail.mjs'

export const MAIL_QUERY_MAX_BYTES = 16 * 1024
const KINDS = ['people', 'updates', 'promos', 'social', 'finance', 'purchases', 'travel', 'forums', 'low']
const fail = (status, message) => Object.assign(Error(message), { status })
const object = (value) => value !== null && typeof value === 'object' && !Array.isArray(value)
const email = (value) => typeof value === 'string' && value.length <= 320 && /^[^\s<>@]+@[^\s<>@]+$/.test(value)
const DAY = /^\d{4}-\d{2}-\d{2}$/

export function validateMailQuery(input) {
  if (!object(input)) throw fail(400, 'Expected a mail-query request object.')
  if (typeof input.q !== 'string' || !input.q.trim()) throw fail(400, 'A search is required.')
  if (input.q.length > 300) throw fail(413, 'A search may be at most 300 characters.')
  if (typeof input.today !== 'string' || !DAY.test(input.today) || Number.isNaN(Date.parse(`${input.today}T00:00:00Z`))) throw fail(400, 'Today must be a calendar day, YYYY-MM-DD.')
  const accounts = input.accounts === undefined ? [] : input.accounts, bundles = input.bundles === undefined ? KINDS : input.bundles
  if (!Array.isArray(accounts) || accounts.length > 20 || !accounts.every(email)) throw fail(400, 'Accounts must be email addresses.')
  if (!Array.isArray(bundles) || bundles.length > 20 || !bundles.every((b) => typeof b === 'string')) throw fail(400, 'Bundles must be names.')
  return { q: input.q.trim(), today: input.today, accounts, bundles: bundles.filter((b) => KINDS.includes(b)) }
}

// --- Calendar days, as Kier Mail counts them: a day is YYYY-MM-DD, a range ends before its last day.
const at = (day) => new Date(`${day}T00:00:00Z`)
const iso = (date) => date.toISOString().slice(0, 10)
const days = (day, n) => { const d = at(day); d.setUTCDate(d.getUTCDate() + n); return iso(d) }
function months(day, n) {
  const d = at(day), date = d.getUTCDate()
  d.setUTCDate(1); d.setUTCMonth(d.getUTCMonth() + n)
  d.setUTCDate(Math.min(date, new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate()))
  return iso(d)
}
// The week starts where this Mac's region says, as it does for Kier Mail (1 Monday … 7 Sunday).
let weekStart
export function firstWeekday() {
  if (weekStart) return weekStart
  let region = ''
  try { region = execFileSync('defaults', ['read', '-g', 'AppleLocale'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 2000 }).trim().split('@')[0].replace('_', '-') } catch {}
  try { weekStart = new Intl.Locale(region || 'en-US').getWeekInfo?.().firstDay ?? new Intl.Locale(region || 'en-US').weekInfo?.firstDay } catch {}
  return (weekStart ||= 1)
}
const weekOf = (day, first) => { const start = days(day, -((at(day).getUTCDay() || 7) - first + 7) % 7); return [start, days(start, 7)] }
const monthOf = (day) => { const start = `${day.slice(0, 8)}01`; return [start, months(start, 1)] }
const yearOf = (day) => [`${day.slice(0, 4)}-01-01`, `${Number(day.slice(0, 4)) + 1}-01-01`]

// --- Kier Mail's own reading (its SmartSearch.swift), rule for rule, so Kier's answer never knows less than it.
const FILLER = new Set(['a', 'an', 'the', 'that', 'this', 'those', 'these', 'about', 'regarding', 're', 'email', 'emails', 'mail', 'mails', 'message', 'messages', 'thread',
  'find', 'show', 'me', 'my', 'i', 'of', 'on', 'in', 'for', 'was', 'were', 'what', 'where', 'when', 'which', 'did', 'do', 'get', 'got', 'someone', 'somebody', 'and', 'or', 'any',
  'all', 'some', 'is', 'it', 'to', 'from', 'with', 'by'])
const KIND_WORDS = { receipt: 'purchases', receipts: 'purchases', order: 'purchases', orders: 'purchases', newsletter: 'updates', newsletters: 'updates', promo: 'promos',
  promos: 'promos', promotions: 'promos', invoice: 'finance', invoices: 'finance', bank: 'finance', flight: 'travel', flights: 'travel', booking: 'travel' }
const MONTHS = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december']
const timeWord = (w) => ['today', 'yesterday', 'this', 'last', 'past'].includes(w) || MONTHS.includes(w)
const attachmentWord = (w) => ['attachment', 'attachments', 'attached', 'pdf', 'pdfs', 'file', 'files'].includes(w)
const monthOfWord = (w) => MONTHS.findIndex((m) => m === w || (m.slice(0, 3) === w && w.length === 3 && w !== 'may'))
// The most recent such month that has started.
function monthRange(month, today) {
  let start = `${today.slice(0, 4)}-${String(month + 1).padStart(2, '0')}-01`
  if (start > today) start = `${Number(today.slice(0, 4)) - 1}${start.slice(4)}`
  return [start, months(start, 1)]
}

export function ownReading(text, today, first = firstWeekday()) {
  const out = { words: [], people: [], senders: [], after: null, before: null, attachment: false, unread: false, pinned: false, bundle: null }
  const tokens = String(text).split(/\s+/).map((t) => t.replace(/^[,.?!"']+|[,.?!"']+$/g, '')).filter(Boolean)
  const lower = tokens.map((t) => t.toLowerCase())
  const range = (a, b) => { out.after = a; out.before = b }
  for (let i = 0; i < lower.length;) {
    const word = lower[i], next = lower[i + 1] || ''
    const colon = word.indexOf(':')
    if (colon > 0 && ['from', 'to', 'with'].includes(word.slice(0, colon))) {
      const value = tokens[i].slice(colon + 1)
      if (value) (word.startsWith('from') ? out.senders : out.people).push(value)
      i += 1; continue
    }
    if (['from', 'with', 'to'].includes(word) && next && !FILLER.has(next) && !timeWord(next) && !attachmentWord(next)) {
      (word === 'from' ? out.senders : out.people).push(tokens[i + 1]); i += 2; continue
    }
    if (attachmentWord(word)) { out.attachment = true; i += 1; continue }
    if (word === 'unread' || (word === 'new' && next === 'mail')) { out.unread = true; i += 1; continue }
    if (word === 'pinned' || word === 'starred') { out.pinned = true; i += 1; continue }
    if (KIND_WORDS[word]) { out.bundle = KIND_WORDS[word]; i += 1; continue }
    if (word === 'today') { range(today, days(today, 1)); i += 1; continue }
    if (word === 'yesterday') { range(days(today, -1), today); i += 1; continue }
    if ((word === 'this' || word === 'last') && ['week', 'month', 'year'].includes(next)) {
      const [start, end] = next === 'week' ? weekOf(today, first) : next === 'month' ? monthOf(today) : yearOf(today)
      if (word === 'this') range(start, end)
      else range(...(next === 'week' ? weekOf(days(start, -7), first) : next === 'month' ? monthOf(months(start, -1)) : yearOf(`${Number(start.slice(0, 4)) - 1}-01-01`)))
      i += 2; continue
    }
    if ((word === 'last' || word === 'past') && /^\d+$/.test(next) && i + 2 < lower.length && ['day', 'days', 'week', 'weeks', 'month', 'months'].includes(lower[i + 2])) {
      const n = Number(next), unit = lower[i + 2]
      range(unit.startsWith('day') ? days(today, -n) : unit.startsWith('week') ? days(today, -7 * n) : months(today, -n), null)
      i += 3; continue
    }
    const month = monthOfWord(word)
    if (month >= 0) { range(...monthRange(month, today)); i += 1; continue }
    if (/^\d{4}$/.test(word) && Number(word) >= 1990 && Number(word) <= 2100) { range(`${word}-01-01`, `${Number(word) + 1}-01-01`); i += 1; continue }
    if (!FILLER.has(word)) out.words.push(tokens[i])
    i += 1
  }
  return out
}

// --- Dates said another way, from the owner's own date words. Anything not listed here stays unread.
const fold = (s) => String(s || '').toLowerCase().normalize('NFD').replace(/\p{M}/gu, '').replace(/đ/g, 'd')
const NUMBERS = { a: 1, an: 1, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, couple: 2, few: 3, jedan: 1, jedna: 1, dva: 2, dvije: 2, tri: 3, cetiri: 4, pet: 5, sest: 6, sedam: 7, osam: 8, devet: 9, deset: 10 }
const count = (w) => (/^\d{1,3}$/.test(w) ? Number(w) : NUMBERS[w])
const WEEKDAYS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday']
// Croatian weekdays by their stem, since the ending changes with the case (ponedjeljak, ponedjeljka, u ponedjeljak).
const HR_WEEKDAYS = [/^nedjelj[aeiu]$/, /^ponedjelj(ak|ka|ku)$/, /^utor(ak|ka|ku)$/, /^srijed[aeiu]$/, /^cetvrt(ak|ka|ku)$/, /^pet(ak|ka|ku)$/, /^subot[aeiu]$/]
const weekdayOf = (w) => { const en = WEEKDAYS.indexOf(w); return en >= 0 ? en : HR_WEEKDAYS.findIndex((form) => form.test(w)) }
const HR_MONTHS = ['sijecanj|sijecnj', 'veljac', 'ozuj', 'travanj|travnj', 'svibanj|svibnj', 'lipanj|lipnj', 'srpanj|srpnj', 'kolovoz', 'rujan|rujn', 'listopad', 'studen', 'prosinac|prosinc']
const anyMonth = (w) => { const en = monthOfWord(w); return en >= 0 ? en : HR_MONTHS.findIndex((m) => m.split('|').some((stem) => w.startsWith(stem))) }
const unitOf = (w) => (/^(day|days|dan|dana)$/.test(w) ? 'day' : /^(week|weeks|tjedan|tjedna|tjedana|tjedn[aeiu])$/.test(w) ? 'week' : /^(month|months|mjesec|mjeseca|mjeseci)$/.test(w) ? 'month' : /^(year|years|godina|godine|godinu|godini)$/.test(w) ? 'year' : null)
const back = (today, n, unit) => (unit === 'day' ? days(today, -n) : unit === 'week' ? days(today, -7 * n) : unit === 'month' ? months(today, -n) : months(today, -12 * n))
// The latest such weekday before today.
const lastWeekday = (today, weekday) => days(today, -(((at(today).getUTCDay() - weekday + 7) % 7) || 7))

// One named moment as [start, end), or null.
function moment(words, today, first) {
  const [a, b, c] = words
  if (words.length === 1) {
    if (a === 'today' || a === 'danas') return [today, days(today, 1)]
    if (a === 'yesterday' || a === 'jucer') return [days(today, -1), today]
    if (a === 'prekjucer') return [days(today, -2), days(today, -1)]
    const weekday = weekdayOf(a)
    if (weekday >= 0) { const day = lastWeekday(today, weekday); return [day, days(day, 1)] }
    const month = anyMonth(a)
    if (month >= 0) return monthRange(month, today)
    if (/^\d{4}$/.test(a) && Number(a) >= 1990 && Number(a) <= 2100) return [`${a}-01-01`, `${Number(a) + 1}-01-01`]
    if (/^\d{4}-\d{2}-\d{2}$/.test(a) && !Number.isNaN(Date.parse(`${a}T00:00:00Z`))) return [a, days(a, 1)]
  }
  if (words.length === 2) {
    const which = /^(this|ovaj|ova|ove|ovog|ovoga|ovom)$/.test(a) ? 0 : /^(last|prosli|prosla|prosle|proslog|prosloga|proslu|proslom)$/.test(a) ? -1 : null
    const unit = unitOf(b)
    if (which !== null && unit && unit !== 'day') {
      const [start] = unit === 'week' ? weekOf(today, first) : unit === 'month' ? monthOf(today) : yearOf(today)
      const from = which === 0 ? start : unit === 'week' ? days(start, -7) : unit === 'month' ? months(start, -1) : `${Number(start.slice(0, 4)) - 1}-01-01`
      return unit === 'week' ? [from, days(from, 7)] : unit === 'month' ? monthOf(from) : yearOf(from)
    }
    if (which === -1) { const weekday = moment([b], today, first); if (weekday && days(weekday[0], 1) === weekday[1] && !['today', 'danas', 'yesterday', 'jucer'].includes(b)) return weekday }
    // "march 2025", "ozujak 2025"
    const month = anyMonth(a)
    if (month >= 0 && /^\d{4}$/.test(b)) { const start = `${b}-${String(month + 1).padStart(2, '0')}-01`; return [start, months(start, 1)] }
  }
  // "two weeks ago", "prije dva tjedna": that day, week or month.
  const ago = words.length === 3 && c === 'ago' ? [count(a), unitOf(b)] : words.length === 3 && a === 'prije' ? [count(b), unitOf(c)] : null
  if (ago && ago[0] && ago[1]) {
    const day = back(today, ago[0], ago[1])
    return ago[1] === 'day' ? [day, days(day, 1)] : ago[1] === 'week' ? weekOf(day, first) : ago[1] === 'month' ? monthOf(day) : yearOf(day)
  }
  return null
}

// The owner's date words as { after, before } (either may be null), or null when they aren't a date Kier knows.
export function dateRange(text, today, first = firstWeekday()) {
  let words = fold(text).split(/[^\p{L}\p{N}-]+/u).filter(Boolean)
  const drop = (set) => { while (words.length > 1 && set.includes(words[0])) words = words.slice(1) }
  drop(['from', 'on', 'in', 'during', 'u', 'na', 'iz', 'tijekom', 'za'])
  const [a] = words
  // "last 3 days", "past two weeks", "zadnja tri dana", "u zadnjih mjesec dana": from then until now.
  if (/^(last|past|zadnj[aeiu]h?|zadnji|proteklih?|protekl[aeiu]|posljednj[aeiu]h?|posljednji)$/.test(a) && words.length >= 3 && count(words[1]) && unitOf(words[2])) return { after: back(today, count(words[1]), unitOf(words[2])), before: null }
  if (/^(since|after|od|nakon|poslije)$/.test(a) && words.length > 1) { const m = moment(words.slice(1), today, first); return m && { after: a === 'since' || a === 'od' ? m[0] : m[1], before: null } }
  if (/^(before|until|till|prije|do)$/.test(a) && words.length > 1 && !(a === 'prije' && words.length === 3 && count(words[1]) && unitOf(words[2]))) { const m = moment(words.slice(1), today, first); return m && { after: null, before: m[0] } }
  const m = moment(words, today, first)
  return m && { after: m[0], before: m[1] }
}

// --- The form. Each text field follows a yes-or-no about whether there is anything to write: a field the model
// must fill gets filled with something, and a topic then turns up as a person.
const WHAT = (kinds) => `You read a search that ${config.me} typed into a mail app, and fill in a form saying what mail is wanted. ${config.me} writes ${config.languages.join(' and ')}. Copy words exactly as typed; never add a name, a date or a word that was not typed.

names_someone: yes when the search names a person or a company the mail is from or with. A topic, a place, a thing or a kind of mail is not a person: no.
people: those people or companies, exactly as typed, separated by commas.
sent_by_them: yes when the mail wanted is mail they SENT (from them, they wrote, they sent, od); no when it is mail with or to them.
gives_time: yes when the search says when the mail is from (last week, since March, yesterday, prošli tjedan, jučer, iz listopada); otherwise no.
when: the words that say when, exactly as typed.
has_topic: yes when words say what the mail is about; no when the search is only people, a time or a kind of mail.
about: the words that say what the mail is about, exactly as typed, without the people, the time, the kind of mail, and filler like "emails", "everything", "find", "sent", "poruke".
attachment: yes when the mail must have an attachment or file (pdf, attachment, attached, file, prilog); otherwise no.
unread: yes only when unread mail is asked for (unread, haven't read, nepročitano); otherwise no.
kind: the kind of mail, only when the search asks for that kind by name: ${kinds.join(', ')}. purchases is orders, receipts and deliveries; finance is invoices and bills; travel is flights and bookings; updates is newsletters and notifications; promos is offers and marketing. Mail from a company is not a kind. Otherwise any.

Examples:
Typed: priya contract
{"names_someone": "yes", "people": "priya", "sent_by_them": "no", "gives_time": "no", "has_topic": "yes", "about": "contract", "attachment": "no", "unread": "no", "kind": "any"}
Typed: what did Jonas send me about the lease last month
{"names_someone": "yes", "people": "Jonas", "sent_by_them": "yes", "gives_time": "yes", "when": "last month", "has_topic": "yes", "about": "lease", "attachment": "no", "unread": "no", "kind": "any"}
Typed: emails where Lucija and Borna talk about the offsite
{"names_someone": "yes", "people": "Lucija, Borna", "sent_by_them": "no", "gives_time": "no", "has_topic": "yes", "about": "offsite", "attachment": "no", "unread": "no", "kind": "any"}
Typed: od Filipa prošli tjedan
{"names_someone": "yes", "people": "Filipa", "sent_by_them": "yes", "gives_time": "yes", "when": "prošli tjedan", "has_topic": "no", "attachment": "no", "unread": "no", "kind": "any"}
Typed: poruke s Teom o najmu stana
{"names_someone": "yes", "people": "Teom", "sent_by_them": "no", "gives_time": "no", "has_topic": "yes", "about": "najmu stana", "attachment": "no", "unread": "no", "kind": "any"}
Typed: pdf that the accountant sent two weeks ago
{"names_someone": "yes", "people": "the accountant", "sent_by_them": "yes", "gives_time": "yes", "when": "two weeks ago", "has_topic": "no", "attachment": "yes", "unread": "no", "kind": "any"}
Typed: unread newsletters since monday
{"names_someone": "no", "gives_time": "yes", "when": "since monday", "has_topic": "no", "attachment": "no", "unread": "yes", "kind": "updates"}
Typed: računi za struju iz listopada
{"names_someone": "no", "gives_time": "yes", "when": "iz listopada", "has_topic": "yes", "about": "struju", "attachment": "no", "unread": "no", "kind": "finance"}
Typed: quarterly roadmap slides
{"names_someone": "no", "gives_time": "no", "has_topic": "yes", "about": "quarterly roadmap slides", "attachment": "no", "unread": "no", "kind": "any"}
Typed: hotel booking barcelona
{"names_someone": "no", "gives_time": "no", "has_topic": "yes", "about": "hotel barcelona", "attachment": "no", "unread": "no", "kind": "travel"}
Typed: all the mail from the insurance company
{"names_someone": "yes", "people": "the insurance company", "sent_by_them": "yes", "gives_time": "no", "has_topic": "no", "attachment": "no", "unread": "no", "kind": "any"}
Typed: fakture ovaj mjesec
{"names_someone": "no", "gives_time": "yes", "when": "ovaj mjesec", "has_topic": "no", "attachment": "no", "unread": "no", "kind": "finance"}
Typed: sve od Tee ove godine
{"names_someone": "yes", "people": "Tee", "sent_by_them": "yes", "gives_time": "yes", "when": "ove godine", "has_topic": "no", "attachment": "no", "unread": "no", "kind": "any"}`
const YES_NO = ['yes', 'no']
const fields = (kinds) => [{ name: 'names_someone', choices: YES_NO }, { name: 'people', text: 28, when: { names_someone: ['yes'] } }, { name: 'sent_by_them', choices: YES_NO, when: { names_someone: ['yes'] } },
  { name: 'gives_time', choices: YES_NO }, { name: 'when', text: 16, when: { gives_time: ['yes'] } }, { name: 'has_topic', choices: YES_NO }, { name: 'about', text: 28, when: { has_topic: ['yes'] } },
  { name: 'attachment', choices: YES_NO }, { name: 'unread', choices: YES_NO }, { name: 'kind', choices: [...kinds, 'any'] }]
// A filter the owner didn't ask for hides mail, so a yes has to be this sure, and so does "no topic" before words are
// dropped. Who sent it only moves a name between "from" and "with".
const SURE = { filter: 0.9, person: 0.7, sender: 0.7, topic: 0.7, lone: 0.95 }

const tokensOf = (s) => String(s || '').split(/\s+/).map((t) => t.replace(/^[,.?!"':;()]+|[,.?!"':;()]+$/g, '')).filter(Boolean)
// A word as typed, and without the 's of "Priya's".
const bare = (t) => fold(t).replace(/['’]s$/, '')
// Everything a name or topic is made of has to be a word the owner typed.
const typed = (value, q) => { const said = new Set(tokensOf(q).flatMap((t) => [fold(t), bare(t)])); return tokensOf(value).every((t) => said.has(fold(t)) || said.has(bare(t))) }
const same = (a, b) => fold(a) === fold(b) || bare(a) === bare(b)
const add = (list, value) => { if (value && !list.some((v) => same(v, value))) list.push(value) }
// Words that are never a person, and words that are never worth looking for: Kier Mail's own filler, and the
// little words of a Croatian sentence, which its rules don't know.
const NOT_A_NAME = /^(the|a|an|my|our|me|i|you|someone|somebody|anyone|everyone|everything|anything|something|team|unread|mail|mails|email|emails|moj|moja|moje|moji|netko|nekog|svi|sve|svima)$/
const MORE_FILLER = new Set(['everything', 'anything', 'something', 'stuff', 'od', 's', 'sa', 'o', 'iz', 'za', 'u', 'na', 'ili', 'mi', 'je', 'si', 'su', 'se', 'sto', 'sta',
  'koji', 'koja', 'koje', 'gdje', 'kad', 'kada', 'sve', 'svi', 'poruke', 'poruka', 'poruku', 'mailovi', 'mailove', 'mejl', 'mejlovi', 'mejlove'])
const keyword = (t) => FILLER.has(fold(t)) || MORE_FILLER.has(fold(t)) || !!KIND_WORDS[fold(t)] || attachmentWord(fold(t)) || timeWord(fold(t))

// --- The addresses Kier knows for a name: people who have written to the owner, and the owner's contacts. A short
// Croatian name changes its last letter with its case (Nika, Nike, Niki), so a name matches on all but that letter.
const stemOf = (w) => (w.length >= 4 && /[aeiou]$/.test(w) ? w.slice(0, -1) : w.length >= 6 && /(om|em)$/.test(w) ? w.slice(0, -2) : w)
const named = (display, name) => {
  const want = fold(name).match(/[\p{L}\p{N}]{3,}/gu) || [], have = fold(display).match(/[\p{L}\p{N}]{2,}/gu) || []
  return want.length > 0 && want.every((w) => have.some((h) => h === w || (stemOf(h) === stemOf(w) && Math.abs(h.length - w.length) <= 2 && stemOf(w).length >= 3)))
}
export function addressesFor(db, name, own = []) {
  const mine = new Set([...own, config.exampleEmail].filter(Boolean).map((a) => a.toLowerCase()))
  const found = new Map()
  const note = (address, display, weight) => {
    const key = String(address || '').toLowerCase()
    if (!email(key) || mine.has(key) || automated(key, '', '', false) || !named(display, name)) return
    const seen = found.get(key) || { display, weight: 0 }
    seen.weight += weight; found.set(key, seen)
  }
  const first = (fold(name).match(/[\p{L}\p{N}]{3,}/u) || [''])[0]
  if (!first) return []
  try {
    const rows = readScope(db, localAuthorization()).prepare(`select i.sender display, lower(json_extract(a.value, '$.email')) address, count(*) n from items i,
      json_each(case when json_valid(i.meta) then i.meta else '{}' end, '$.from') a where i.source = 'mail' and i.from_me = 0 and i.sender is not null group by 1, 2 order by n desc limit 4000`).all()
    for (const row of rows) note(row.address, row.display, row.n)
  } catch {}
  try { for (const [handle, display] of contacts()) if (String(handle).includes('@')) note(handle, display, 2) } catch {}
  return [...found].sort((a, b) => b[1].weight - a[1].weight).slice(0, 3).map(([address, seen]) => ({ address, display: seen.display }))
}
// The form of the name the mail itself uses, when the owner typed another case of it ("Nike" for Nika).
const asWritten = (display, name) => (display.match(/[\p{L}\p{N}]{2,}/gu) || []).find((part) => fold(part) !== fold(name) && stemOf(fold(part)) === stemOf(fold(name)))

// Kier's reading of a search, in the shape Kier Mail takes, or null to decline.
export async function mailQuery(db, request, { fill = fillForm, first = firstWeekday() } = {}) {
  const input = validateMailQuery(request)
  const own = ownReading(input.q, input.today, first)
  // Kier Mail's answer shape has no place for "pinned": its own reading keeps that filter, Kier's would lose it.
  if (own.pinned) return null
  const kinds = input.bundles.length ? input.bundles : KINDS
  // Kier Mail waits 12 s. A cold model has to load first, and a late answer is no use to a search being typed.
  const form = await fill({ system: WHAT(kinds), user: `Typed: ${input.q}`, fields: fields(kinds), timeout: 11000 }).catch(() => null)
  if (!form) return null
  const v = form.values, sure = (field, value) => ranked(form.confidence[field]).find(([option]) => option === value)?.[1] ?? 0
  const about = v.has_topic === 'yes' ? tokensOf(v.about) : []
  const out = { words: [...own.words], people: [...own.people], senders: [...own.senders], emails: [], after: own.after, before: own.before,
    has_attachment: own.attachment, unread: own.unread, bundle: own.bundle }
  let added = false
  const used = new Set() // typed words that became a name or a date, and so are no longer words to look for
  const spent = (text) => { for (const t of tokensOf(text)) { used.add(fold(t)); used.add(bare(t)) } }

  // People: only names the owner typed, as "from" when the model is sure they are the senders.
  const bySender = v.sent_by_them === 'yes' && sure('sent_by_them', 'yes') >= SURE.sender
  const someone = v.names_someone === 'yes' && sure('names_someone', 'yes') >= SURE.person
  for (const raw of someone ? String(v.people || '').split(/\s*(?:,|;|\band\b|\bi\b|&)\s*/i) : []) {
    let name = raw.trim().replace(/^(?:the|my|moj|moja)\s+/i, ''), plain = null
    if (name.length < 2 || name.length > 60 || NOT_A_NAME.test(fold(name))) continue
    if (!typed(name, input.q)) {
      // The model may write a name the way a dictionary would (Lucija) when the owner typed another case of it
      // (Lucije). The typed word is the one that counts; the other is looked for beside it, since mail says Lucija.
      const as = tokensOf(name).length === 1 && tokensOf(input.q).find((t) => t.length >= 3 && Math.abs(t.length - name.length) <= 2 && stemOf(fold(t)) === stemOf(fold(name)) && stemOf(fold(t)).length >= 3)
      if (!as) continue
      plain = name; name = as
    }
    // A person is not also the topic, and not one of the words the rules read as a filter.
    if (tokensOf(name).every(keyword) || tokensOf(name).some((t) => about.some((word) => same(word, t)))) continue
    const known = [...out.people, ...out.senders].some((p) => same(p, name) || tokensOf(name).some((t) => same(p, t)))
    const list = out.senders.some((p) => same(p, name)) || (bySender && !out.people.some((p) => same(p, name))) ? out.senders : out.people
    if (!known) { add(list, name); added = true }
    if (plain && list.length < 4) add(list, plain)
    spent(name)
    // The addresses go in the same list as the name, so they widen what it finds and never narrow it.
    const addresses = addressesFor(db, name, input.accounts)
    for (const { address, display } of addresses) {
      const other = asWritten(display, name)
      if (list === out.senders) { if (out.senders.length < 4) { add(out.senders, address); added = true } }
      else if (out.emails.length < 8) { add(out.emails, address); added = true }
      if (other && list.length < 4) add(list, other)
    }
  }
  // When: only the owner's own date words, worked out here. The rules read "march" in "since march" as that month
  // alone; the whole phrase, when Kier knows it, says more.
  const when = v.gives_time === 'yes' ? String(v.when || '').trim() : ''
  if (when && fold(input.q).includes(fold(when))) {
    const range = dateRange(when, input.today, first)
    if (range) {
      if (range.after !== out.after || range.before !== out.before) added = true
      out.after = range.after; out.before = range.before; spent(when)
    }
  }
  // Filters the rules missed (another word for it, another language), only when the model is sure.
  if (!out.has_attachment && v.attachment === 'yes' && sure('attachment', 'yes') >= SURE.filter) { out.has_attachment = true; added = true }
  if (!out.unread && v.unread === 'yes' && sure('unread', 'yes') >= SURE.filter) { out.unread = true; added = true }
  let kindRead = false
  if (!out.bundle && kinds.includes(v.kind) && sure('kind', v.kind) >= SURE.filter) { out.bundle = v.kind; added = true; kindRead = true }
  // Words: what the owner typed about the topic. The model may drop filler, never add a word.
  // Every word is one more thing a mail must contain, so a stray "sent" or "everything" hides the mail wanted. Once
  // the search is pinned to a person, a time or a kind, what the model leaves out of the topic goes; a search that
  // is only words keeps every one of them, and a topic with a word the owner never typed is not trusted at all.
  const left = out.words.filter((w) => !used.has(fold(w)) && !used.has(bare(w)) && !MORE_FILLER.has(fold(w)))
  const pinned = out.people.length || out.senders.length || out.after || out.before || out.bundle || out.has_attachment || out.unread
  // One word left beside a kind Kier has just read is most often the word that named the kind ("računi" for
  // finance): unless the model is very sure it is a topic, it is not looked for as well.
  const naming = kindRead && about.length === 1 && sure('has_topic', 'yes') < SURE.lone
  const none = naming || (v.has_topic === 'no' && sure('has_topic', 'no') >= SURE.topic)
  const words = !pinned ? left : none ? [] : about.length && typed(about.join(' '), input.q) ? left.filter((w) => about.some((t) => same(t, w))) : left
  if (words.length !== out.words.length) added = true
  out.words = words
  if (!added) return null
  return { ...(out.words.length && { words: out.words.slice(0, 8) }), ...(out.people.length && { people: out.people.slice(0, 4) }), ...(out.senders.length && { senders: out.senders.slice(0, 4) }),
    ...(out.emails.length && { emails: out.emails.slice(0, 8) }), ...(out.after && { after: out.after }), ...(out.before && { before: out.before }),
    ...(out.has_attachment && { has_attachment: true }), ...(out.unread && { unread: true }), ...(out.bundle && { bundle: out.bundle }) }
}
