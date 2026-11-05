// The tagger only names the words that carry a date; turning them into a calendar date happens here,
// because small models are unreliable at weekday arithmetic ("u pon" from a Saturday).
import { config } from './config.mjs'
import { MONTH_END, MONTHS, RELATIVE, WEEKDAYS } from './lang.mjs'

const plain = (s) => s.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/đ/g, 'd')

// Weekdays, relative words and months for the owner's languages (lang.mjs).
// Calendar date of a unix timestamp in the owner's timezone, as [year, month, day].
export function localDate(ts, timeZone = config.timezone) {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(ts * 1000))
  return parts.split('-').map(Number)
}

const iso = (y, m, d) => {
  const t = new Date(Date.UTC(y, m - 1, d))
  return t.toISOString().slice(0, 10)
}
const addDays = (y, m, d, n) => iso(y, m, d + n)

function explicitDate(w, [y, m]) {
  let hit = w.match(/\b(\d{1,2})\.\s?(\d{1,2})\.(?:\s?(\d{4}))?/)
  if (hit) return pick(Number(hit[3]) || null, Number(hit[2]), Number(hit[1]), y, m)
  hit = w.match(/\b(\d{1,2})\.?\s*([a-z]{3})[a-z]*\b/)
  if (hit && MONTHS[hit[2]]) return pick(null, MONTHS[hit[2]], Number(hit[1]), y, m)
  hit = w.match(/\b([a-z]{3})[a-z]*\s+(\d{1,2})\b/)
  if (hit && MONTHS[hit[1]]) return pick(null, MONTHS[hit[1]], Number(hit[2]), y, m)
  return null
}

function pick(year, month, day, y, m) {
  if (month < 1 || month > 12 || day < 1 || day > 31) return null
  // "15.1." written in December means next January.
  if (!year) year = month < m - 6 ? y + 1 : y
  return iso(year, month, day)
}

export function resolveDue(whenWords, modelDue, sentTs, text = '') {
  if (!whenWords) return ''
  const w = plain(whenWords).trim()
  // Grounding: the words must really be in the message, otherwise the date was invented.
  if (!w || !plain(text).includes(w)) return ''
  const [y, m, d] = localDate(sentTs)
  const explicit = explicitDate(w, [y, m])
  if (explicit) return explicit
  for (const [offset, words] of RELATIVE) if (words.some((x) => w.includes(x))) return addDays(y, m, d, offset)
  if (MONTH_END.test(w)) return iso(y, m + 1, 0)
  const tokens = w.split(/[^a-z]+/)
  for (const [day, stems] of WEEKDAYS) {
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
