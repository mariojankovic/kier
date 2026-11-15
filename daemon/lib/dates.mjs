// The tagger only names the words that carry a date; turning them into a calendar date happens here,
// because small models are unreliable at weekday arithmetic ("u pon" from a Saturday).
import { config, region } from './config.mjs'
import { MONTH_END, MONTHS, RELATIVE, WEEKDAYS } from './lang.mjs'

const plain = (s) => s.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/đ/g, 'd')

// Weekdays, relative words and months for the owner's languages (lang.mjs).
// Calendar date of a unix timestamp in the owner's timezone, as [year, month, day].
const formats = new Map()
export function localDate(ts, timeZone = config.timezone) {
  let format = formats.get(timeZone)
  if (!format) { format = new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }); formats.set(timeZone, format) }
  const parts = format.format(new Date(ts * 1000))
  return parts.split('-').map(Number)
}

const iso = (y, m, d) => {
  const t = new Date(Date.UTC(y, m - 1, d))
  return t.toISOString().slice(0, 10)
}
const addDays = (y, m, d, n) => iso(y, m, d + n)

// Whether the Mac's region writes the month before the day ("6/19" in the US). Everywhere else the day comes first.
export const MONTH_FIRST = (() => {
  try {
    const parts = new Intl.DateTimeFormat(new Intl.Locale(`und-${region}`).maximize().toString(), { month: 'numeric', day: 'numeric' }).formatToParts(new Date(Date.UTC(2026, 0, 2)))
    return parts.findIndex((p) => p.type === 'month') < parts.findIndex((p) => p.type === 'day')
  } catch { return false }
})()

function explicitDate(w, [y, m], months, monthFirst) {
  let hit = w.match(/\b(\d{1,2})\.\s?(\d{1,2})\.(?:\s?(\d{4}))?/)
  if (hit) return pick(Number(hit[3]) || null, Number(hit[2]), Number(hit[1]), y, m)
  // A date with slashes. The order is the region's unless only one order can be a date ("19/6" is never month 19).
  // "24/7" is a way of saying always, not a day.
  hit = w.match(/(?<![\d/.])(\d{1,2})\/(\d{1,2})(?:\/(\d{4}|\d{2}))?(?![\d/])/)
  if (hit && !(hit[1] === '24' && hit[2] === '7' && !hit[3])) {
    let [first, second] = [Number(hit[1]), Number(hit[2])]
    let [month, day] = monthFirst ? [first, second] : [second, first]
    if (month > 12 && day <= 12) [month, day] = [day, month]
    const year = hit[3] ? (hit[3].length === 2 ? 2000 + Number(hit[3]) : Number(hit[3])) : null
    return pick(year, month, day, y, m)
  }
  hit = w.match(/\b(\d{1,2})\.?\s*([a-z]{3})[a-z]*\b/)
  if (hit && months[hit[2]]) return pick(null, months[hit[2]], Number(hit[1]), y, m)
  hit = w.match(/\b([a-z]{3})[a-z]*\s+(\d{1,2})\b/)
  if (hit && months[hit[1]]) return pick(null, months[hit[1]], Number(hit[2]), y, m)
  return null
}

function pick(year, month, day, y, m) {
  if (month < 1 || month > 12 || day < 1 || day > 31) return null
  // "15.1." written in December means next January.
  if (!year) year = month < m - 6 ? y + 1 : y
  return iso(year, month, day)
}

export function resolveDue(whenWords, modelDue, sentTs, text = '', { weekdays = WEEKDAYS, relative = RELATIVE, months = MONTHS, monthEnd = MONTH_END, monthFirst = MONTH_FIRST } = {}) {
  if (!whenWords) return ''
  const w = plain(whenWords).trim()
  // Grounding: the words must really be in the message, otherwise the date was invented.
  if (!w || !plain(text).includes(w)) return ''
  const [y, m, d] = localDate(sentTs)
  const explicit = explicitDate(w, [y, m], months, monthFirst)
  if (explicit) return explicit
  // A word that only appears inside a longer one that was also said is not its own word: "sutra" in "prekosutra",
  // "morgen" in "vanmorgen", "mañana" in "esta mañana".
  const said = relative.flatMap(([offset, words]) => words.filter((x) => w.includes(x)).map((x) => ({ offset, x })))
  const own = said.filter((a) => !said.some((b) => b.x.length > a.x.length && b.x.includes(a.x) && !w.replaceAll(b.x, '').includes(a.x)))
  for (const [offset] of relative) if (own.some((a) => a.offset === offset)) return addDays(y, m, d, offset)
  if (monthEnd.test(w)) return iso(y, m + 1, 0)
  const tokens = w.split(/[^a-z]+/)
  for (const [day, stems] of weekdays) {
    if (tokens.some((t) => stems.some((s) => t.startsWith(s) && (s.length > 3 || t === s)))) {
      const today = new Date(Date.UTC(y, m - 1, d)).getUTCDay()
      // The same weekday named on that weekday means next week.
      return addDays(y, m, d, ((day - today + 7) % 7) || 7)
    }
  }
  // A bare clock time ("u 22:30", "u 9h") means the same day.
  if (/\b\d{1,2}([:.]\d{2}|h)\b/.test(w)) return addDays(y, m, d, 0)
  return /^\d{4}-\d{2}-\d{2}$/.test(modelDue || '') ? modelDue : ''
}
