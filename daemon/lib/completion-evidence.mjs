import { evidenceMeta, ownerAuthored } from './evidence-trust.mjs'

// Keep quoted replies, forwarded messages and signatures out of authored evidence.
export function newlyWritten(value) {
  const text = String(value || '').replace(/\r\n?/g, '\n')
  const stop = /(?:<blockquote\b|<[^>]*(?:gmail_quote|gmail_signature|yahoo_quoted|divRplyFwdMsg|appendonsend)[^>]*>|(?:^|\n)\s*(?:On\s+[^\n]*wrote:|From:|Od:|Sent from\b|Get Outlook\b|--\s*(?:\n|$)|_{5,}|-{2,}\s*(?:Original Message|Forwarded message)|(?:Best(?: regards)?|Kind regards|Regards|Thanks|Thank you|Cheers|Lijep pozdrav|Srdačan pozdrav|Pozdrav)[,!]?\s*(?:\n|$)))/i
  return text.split(stop)[0].split('\n').filter(line => !/^\s*>/.test(line)).join('\n').trim()
}
export function authoredText(row) {
  if (row.source !== 'mail') return newlyWritten(row.text)
  const meta = evidenceMeta(row)
  // Subjects and flattened previews have no reliable author/quote boundaries.
  // Old mail without body provenance fails closed too.
  return meta.bodyKind === 'plain' && typeof meta.body === 'string' ? newlyWritten(meta.body) : ''
}

// Only simple, completed first-person assertions can settle a Kier card. This
// parser grants no native reminder authority, regardless of the model verdict.
const normalized = text => String(text || '').normalize('NFD').replace(/\p{M}/gu, '').replace(/[’‘]/g, "'").toLowerCase()
const PAY = /\b(?:pay|payment|paid|platiti|plati|platio|platila|uplati|uplatio|uplatila|placanje)\b/
const SEND = /\b(?:send|sent|posalji|poslati|poslao|poslala|slanje)\b/
const action = text => {
  const pay = text.search(PAY), send = text.search(SEND)
  return pay >= 0 && (send < 0 || pay < send) ? 'pay' : send >= 0 ? 'send' : null
}
const PARTIAL = /\b(?:deposits?|downpayments?|down payments?|instalments?|installments?|first payment|upfront|advance|predujam|predujma|polog|pologa|akontaciju|akontacija|ratu|rate|rata|dijelom|part|partial|partially|half|some|only|dio|dijela|djelomicno|pola|polovicu|samo)\b/
function completionAssertion(text, allowPartial = false) {
  const value = normalized(newlyWritten(text)).trim()
  if (!allowPartial && PARTIAL.test(value)) return false
  if (!value || /[?"“”;\n]/.test(value) || /\b(?:not|never|no|if|unless|maybe|perhaps|think|thought|hope|wish|told|nothing|nobody|haven't|hasn't|hadn't|didn't|don't|isn't|wasn't|wasnt|havent|didnt|will|won't|would|could|should|might|going to|plan to|need to|nisam|nismo|nije|nisu|ne|nis|cu|ces|ce|cemo|cete|budem|bude|ako|da|bih|bi|bismo|biste|sutra|tomorrow|said|says|wrote|and|but|or|ali|ili|kad|kada)\b/.test(value)) return false
  const english = /^i (?:have |already |just |have already |have just )?(?:paid|sent|fixed|finished|completed|deployed|shipped|released|pushed|merged|transferred)\b[^.!]*[.!]?$/
  const croatian = /^(?:(?:platio|platila|uplatio|uplatila|poslao|poslala|napravio|napravila|zavrsio|zavrsila) sam|sam (?:platio|platila|uplatio|uplatila|poslao|poslala|napravio|napravila|zavrsio|zavrsila))\b[^.!]*[.!]?$/
  return english.test(value.replace(/(\d)[.,](\d)/g, '$1$2')) || croatian.test(value.replace(/(\d)[.,](\d)/g, '$1$2'))
}
export const completedAction = text => completionAssertion(text)
export const ownerCompletionClaim = (row, task) => {
  const text = authoredText(row), kind = action(normalized(task.summary || task.text))
  return ownerAuthored(row) && kind && action(normalized(text)) === kind && completionAssertion(text, true)
}
// Reject ambiguous numeric formats instead of guessing what was fully paid.
const amounts = text => normalized(text).match(/\d+(?:[.,]\d+)*/g)?.map(n => {
  if (!/^\d+(?:[.,]\d{1,2})?$/.test(n)) return null
  return Number(n.replace(',', '.'))
}) || []
const CURRENCY = /\p{Sc}|\b(?:aed|afn|all|amd|ang|aoa|ars|awg|azn|bam|bbd|bdt|bgn|bhd|bif|bmd|bnd|bob|brl|bsd|btn|bwp|byn|bzd|cdf|clp|cop|crc|cup|cve|czk|djf|dkk|dop|dzd|egp|ern|etb|fjd|fkp|gel|ghs|gip|gmd|gnf|gtq|gyd|hkd|hnl|htg|huf|idr|ils|iqd|irr|isk|jmd|jod|kes|kgs|khr|kmf|kpw|krw|kwd|kyd|kzt|lak|lbp|lkr|lrd|lsl|lyd|mad|mdl|mga|mkd|mmk|mnt|mop|mru|mur|mvr|mwk|mxn|myr|mzn|nad|ngn|nio|nok|npr|nzd|omr|pab|pen|pgk|php|pkr|pln|pyg|qar|ron|rsd|rub|rwf|sar|sbd|scr|sdg|sek|sgd|shp|sle|sll|sos|srd|ssp|stn|svc|syp|szl|thb|tjs|tmt|tnd|top|try|ttd|twd|tzs|uah|ugx|uyu|uzs|ves|vnd|vuv|wst|xaf|xcd|xof|xpf|yer|zar|zmw|zwl|eur|euros?|eura|euro|usd|dollars?|dolara|gbp|pounds?|chf|francs?|hrk|kuna|kn|cad|aud|jpy|cny|inr)\b/gu
const currencies = text => [...new Set((normalized(text).match(CURRENCY) || []).map(c => {
  if (/^(?:€|eur|euros?|eura)$/.test(c)) return 'eur'
  if (/^(?:usd|dollars?|dolara)$/.test(c)) return 'usd'
  if (/^(?:£|gbp|pounds?)$/.test(c)) return 'gbp'
  if (/^(?:hrk|kuna|kn)$/.test(c)) return 'hrk'
  // An ambiguous symbol alone cannot establish a particular dollar or yen currency.
  return c
}))]
const wordKey = word => ({ racun: 'invoice', racuna: 'invoice', racunu: 'invoice', ugovor: 'contract', ugovora: 'contract', ugovoru: 'contract' }[word] || word.replace(/[aiu]$/, ''))
const STOP = new Set(['i','have','already','just','the','a','an','please','pay','payment','paid','platiti','plati','platio','platila','uplati','uplatio','uplatila',
  'send','sent','posalji','poslati','poslao','poslala','sam','mi','me','you','your','my','it','this','that','them','something','today','yesterday','to','for','of','od','za','u','iznos'])
const objectWords = text => (normalized(text).replace(CURRENCY, '').match(/[\p{L}\d]+/gu) || [])
  .filter(w => !STOP.has(w)).map(wordKey)
const containsAll = (text, words) => {
  const actual = new Set(objectWords(text))
  return words.length > 0 && words.every(w => actual.has(w))
}
export function matchesCompletedTask(task, text, recipients = []) {
  if (!completedAction(text)) return false
  const wanted = normalized(task.summary || task.text), said = normalized(text)
  const kind = action(wanted)
  if (!kind || action(said) !== kind) return false
  if (kind === 'pay') {
    const expectedCurrency = currencies(`${wanted} ${task.amount || ''}`), actualCurrency = currencies(said)
    if (expectedCurrency.length || actualCurrency.length) {
      if (expectedCurrency.length !== 1 || actualCurrency.length !== 1 || expectedCurrency[0] !== actualCurrency[0]) return false
    }
    const expected = [...new Set([...amounts(wanted), ...amounts(task.amount)])], actual = amounts(said)
    if (expected.length && (expected.length !== 1 || expected[0] === null || actual.length !== 1 || expected[0] !== actual[0])) return false
    const payee = (task.summary || task.text || '').match(/\b(?:Pay|pay|Plati|plati|Platiti|platiti|Uplati|uplati)\s+([\p{Lu}][\p{L}]+)/u)?.[1]
    if (payee) {
      const destination = said.split(/\b(?:for|za|on behalf of)\b/)[0]
      if (!containsAll(destination, objectWords(payee))) return false
    }
    // Amount alone never identifies the obligation. Preserve every named payee/object.
    return containsAll(said, objectWords(wanted.replace(/\d+(?:[.,]\d+)*/g, '')))
  }
  // Explicit destinations must match the assertion itself. Headers can establish a
  // recipient only when the assertion leaves its destination implicit.
  const recipient = wanted.match(/\bto\s+(.+)$/)?.[1]
  if (recipient) {
    const stated = said.match(/\bto\s+(.+)$/)?.[1]
    const destinations = stated ? [stated] : [said, ...recipients.map(r => typeof r === 'string' ? r : `${r.name || ''} ${r.email || ''}`)]
    if (!destinations.some(value => containsAll(value, objectWords(recipient)))) return false
  }
  const objects = objectWords(recipient ? wanted.replace(/\bto\s+.*$/, '') : wanted)
  return containsAll(said, objects)
}
export const ownerCompletion = (row, task) => ownerAuthored(row) && matchesCompletedTask(task, authoredText(row), evidenceMeta(row).to || [])
export const canCompleteReminder = task => ['owner', 'reminders'].includes(task.completion_origin)
