import { evidenceMeta, ownerAuthored } from './evidence-trust.mjs'
import { speaks } from './lang.mjs'

// What paying, sending and "I did it" look like in the owner's other languages. English is always read, Croatian when
// the owner writes it, and each of these only for someone who writes that language. Everything is spelled without
// accents, the way the text is compared. `claim` is one plain first-person sentence in the past; `hedge` is what takes
// such a sentence back, the small joining words included, since a claim is one simple clause; `behalf` separates who
// was paid from what or whom it was for.
const OTHER = {
  de: { pay: 'zahlen|bezahlen|bezahle|bezahlt|gezahlt|zahlung|uberweisen|uberweise|uberwiesen|uberweisung', send: 'senden|sende|gesendet|schicken|schicke|geschickt|verschickt|abgeschickt',
    partial: 'anzahlung|teilzahlung|rate|raten|teilweise|teil|halfte|nur|vorschuss',
    hedge: 'nicht|nie|niemals|kein|keine|keinen|keiner|wenn|falls|ob|vielleicht|eventuell|glaube|denke|dachte|hoffe|hoffentlich|werde|wirst|wird|werden|wurde|wurdest|konnte|sollte|musste|muss|will|mochte|fast|beinahe|sobald|bevor|morgen|gesagt|sagte|meinte|und|oder|aber',
    claim: /^(?:ich habe|ich hab|habe|hab)\b[^.!]*\b(?:bezahlt|gezahlt|uberwiesen|gesendet|geschickt|verschickt|abgeschickt|erledigt)[.!]?$/,
    nouns: { rechnung: 'invoice', vertrag: 'contract' }, behalf: 'fur|im namen von' },
  // "Pagué" is "I paid" and "pague" is "pay it": only the accent tells them apart, so without "ya" or "he" the accent has to be there.
  es: { pay: 'pagar|pago|pague|pagado|pagada|transferir|transferi|transferido|transferencia', send: 'enviar|envio|envie|enviado|enviada|mandar|mande|mandado',
    partial: 'anticipo|adelanto|senal|plazo|cuota|parte|parcial|parcialmente|mitad|solo|algo',
    hedge: 'no|nunca|si|quiza|quizas|tal vez|creo|pienso|pensaba|espero|ojala|voy|vas|va|vamos|tengo que|hay que|deberia|podria|casi|cuando|antes|manana|dijo|dice|y|o|pero',
    claim: /^(?:ya )?he (?:pagado|enviado|mandado|transferido|terminado)\b[^.!]*[.!]?$|^ya (?:(?:te|se|le|les) )?(?:(?:lo|la|los|las) )?(?:pague|envie|mande|transferi|termine)\b[^.!]*[.!]?$/,
    accented: /^(?:(?:te|se|le|les) )?(?:(?:lo|la|los|las) )?(?:pagué|envié|mandé|transferí|terminé)(?!\p{L})[^.!]*[.!]?$/u,
    nouns: { factura: 'invoice', contrato: 'contract' }, behalf: 'para|por|en nombre de' },
  fr: { pay: 'payer|paye|payee|paiement|regler|regle|reglee|virement|vire|transfere', send: 'envoyer|envoie|envoye|envoyee',
    partial: 'acompte|avance|arrhes|mensualite|partie|partiel|partiellement|moitie|seulement',
    hedge: 'ne|pas|jamais|si|peut-etre|crois|pense|pensais|espere|vais|vas|va|allons|dois|devrais|pourrais|presque|quand|avant|demain|dit|disait|et|ou|mais',
    claim: /^j'ai (?:deja |bien |juste )?(?:paye|regle|envoye|vire|transfere|termine|fini)\b[^.!]*[.!]?$/,
    nouns: { facture: 'invoice', contrat: 'contract' }, behalf: 'pour|au nom de' },
  it: { pay: 'pagare|pago|pagato|pagata|pagamento|bonifico|saldare|saldato|trasferito', send: 'inviare|invio|inviato|inviata|mandare|mando|mandato|spedire|spedito',
    partial: 'acconto|anticipo|caparra|rata|rate|parte|parziale|parzialmente|meta|solo',
    hedge: 'non|mai|se|forse|credo|penso|pensavo|spero|devo|dovrei|potrei|quasi|quando|prima|domani|detto|dice|e|o|ma',
    claim: /^ho (?:gia |appena )?(?:pagato|inviato|mandato|spedito|trasferito|saldato|finito|fatto il bonifico)\b[^.!]*[.!]?$/,
    nouns: { fattura: 'invoice', contratto: 'contract' }, behalf: 'per|a nome di' },
  pt: { pay: 'pagar|pago|paguei|pagamento|transferir|transferi|transferencia', send: 'enviar|envio|enviei|enviado|enviada|mandar|mandei|mandado',
    partial: 'sinal|adiantamento|entrada|parcela|prestacao|parte|parcial|parcialmente|metade|so|apenas',
    hedge: 'nao|nunca|se|talvez|acho|penso|pensei|espero|vou|vais|vai|vamos|tenho que|tenho de|devia|deveria|poderia|quase|quando|antes|amanha|disse|diz|e|ou|mas',
    claim: /^(?:ja )?(?:paguei|enviei|mandei|transferi|terminei|fiz o pagamento|fiz a transferencia)\b[^.!]*[.!]?$/,
    nouns: { fatura: 'invoice', contrato: 'contract' }, behalf: 'para|por|pelo|pela|em nome de' },
  nl: { pay: 'betalen|betaal|betaald|betaling|overmaken|overgemaakt', send: 'sturen|stuur|gestuurd|versturen|verstuurd|verzenden|verzonden|opsturen|opgestuurd',
    partial: 'aanbetaling|voorschot|termijn|deel|gedeeltelijk|helft|alleen|slechts',
    hedge: 'niet|nooit|geen|als|indien|misschien|denk|dacht|hoop|zal|zult|zullen|zou|zouden|moet|moest|wil|bijna|wanneer|voordat|morgen|zei|zegt|en|of|maar',
    claim: /^(?:ik heb|heb)\b[^.!]*\b(?:betaald|overgemaakt|gestuurd|verstuurd|verzonden|opgestuurd|afgerond)[.!]?$/,
    nouns: { factuur: 'invoice', contract: 'contract' }, behalf: 'voor|namens' },
}
const mine = Object.entries(OTHER).filter(([code]) => speaks(code)).map(([, words]) => ({ ...words, hedge: new RegExp(`\\b(?:${words.hedge})\\b`) }))
const more = (kind) => mine.map((l) => `|${l[kind]}`).join('')

// Keep quoted replies, forwarded messages and signatures out of authored evidence.
export function newlyWritten(value) {
  const text = String(value || '').replace(/\r\n?/g, '\n')
  const stop = new RegExp(String.raw`(?:<blockquote\b|<[^>]*(?:gmail_quote|gmail_signature|yahoo_quoted|divRplyFwdMsg|appendonsend)[^>]*>|(?:^|\n)\s*(?:On\s+[^\n]*wrote:|Am\s+[^\n]*schrieb[^\n]*:|Le\s+[^\n]*a écrit\s*:|El\s+[^\n]*escribió\s*:|Il\s+[^\n]*ha scritto\s*:|Em\s+[^\n]*escreveu\s*:|Op\s+[^\n]*schreef[^\n]*:|From:|Od:|Von:|De:|Van:|${speaks('it') ? 'Da:|' : ''}Sent from\b|Gesendet von\b|Von meinem [^\n]* gesendet|Envoyé (?:de|depuis)\b|Enviado (?:desde|do|de)\b|Inviato da\b|Verzonden vanaf\b|Get Outlook\b|--\s*(?:\n|$)|_{5,}|-{2,}\s*(?:Original Message|Forwarded message)|(?:Best(?: regards)?|Kind regards|Regards|Thanks|Thank you|Cheers|Lijep pozdrav|Srdačan pozdrav|Pozdrav|Mit freundlichen Gr(?:ü|ue)(?:ß|ss)en|(?:Viele|Liebe|Beste|Herzliche) Gr(?:ü|ue)(?:ß|ss)e|Danke|Cordialement|Bien cordialement|Merci|Saludos(?: cordiales)?|Un saludo|Atentamente|Gracias|Cordiali saluti|Distinti saluti|Saluti|Grazie|Atenciosamente|Cumprimentos|Obrigad[oa]|Met vriendelijke groet(?:en)?|Vriendelijke groet(?:en)?|Groetjes|Bedankt)[,!]?\s*(?:\n|$)))`, 'i')
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
const PAY = new RegExp(`\\b(?:pay|payment|paid|platiti|plati|platio|platila|uplati|uplatio|uplatila|placanje${more('pay')})\\b`)
const SEND = new RegExp(`\\b(?:send|sent|posalji|poslati|poslao|poslala|slanje${more('send')})\\b`)
const action = text => {
  const pay = text.search(PAY), send = text.search(SEND)
  return pay >= 0 && (send < 0 || pay < send) ? 'pay' : send >= 0 ? 'send' : null
}
const PARTIAL = new RegExp(`\\b(?:deposits?|downpayments?|down payments?|instalments?|installments?|first payment|upfront|advance|predujam|predujma|polog|pologa|akontaciju|akontacija|ratu|rate|rata|dijelom|part|partial|partially|half|some|only|dio|dijela|djelomicno|pola|polovicu|samo${more('partial')})\\b`)
// English words that take a claim back, and the Croatian ones, which only count for someone who writes Croatian:
// to anyone else "ali" is a name and "da" is Italian for "from".
const EN_HEDGE = /\b(?:not|never|no|if|unless|maybe|perhaps|think|thought|hope|wish|told|nothing|nobody|haven't|hasn't|hadn't|didn't|don't|isn't|wasn't|wasnt|havent|didnt|will|won't|would|could|should|might|going to|plan to|need to|tomorrow|said|says|wrote|and|but|or)\b/
const HR_HEDGE = /\b(?:nisam|nismo|nije|nisu|ne|nis|cu|ces|ce|cemo|cete|budem|bude|ako|da|bih|bi|bismo|biste|sutra|ali|ili|kad|kada)\b/
function completionAssertion(text, allowPartial = false) {
  const value = normalized(newlyWritten(text)).trim()
  if (!allowPartial && PARTIAL.test(value)) return false
  if (!value || /[?"“”;\n]/.test(value) || EN_HEDGE.test(value) || (speaks('hr') && HR_HEDGE.test(value))) return false
  const english = /^i (?:have |already |just |have already |have just )?(?:paid|sent|fixed|finished|completed|deployed|shipped|released|pushed|merged|transferred)\b[^.!]*[.!]?$/
  const croatian = /^(?:(?:platio|platila|uplatio|uplatila|poslao|poslala|napravio|napravila|zavrsio|zavrsila) sam|sam (?:platio|platila|uplatio|uplatila|poslao|poslala|napravio|napravila|zavrsio|zavrsila))\b[^.!]*[.!]?$/
  const flat = value.replace(/(\d)[.,](\d)/g, '$1$2')
  if (english.test(flat) || (speaks('hr') && croatian.test(flat))) return true
  // The same sentence with its accents, for the languages where the accent carries the tense.
  const spelled = String(newlyWritten(text)).normalize('NFC').replace(/[’‘]/g, "'").toLowerCase().trim().replace(/(\d)[.,](\d)/g, '$1$2')
  return mine.some((l) => !l.hedge.test(value) && (l.claim.test(flat) || !!l.accented?.test(spelled)))
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
// Card summaries are in English, so the few nouns an obligation is usually about are read as their English word.
const NOUNS = Object.assign({ racun: 'invoice', racuna: 'invoice', racunu: 'invoice', ugovor: 'contract', ugovora: 'contract', ugovoru: 'contract' }, ...mine.map((l) => l.nouns))
const wordKey = word => (NOUNS[word] || word.replace(/[aiu]$/, ''))
const STOP = new Set(['i','have','already','just','the','a','an','please','pay','payment','paid','platiti','plati','platio','platila','uplati','uplatio','uplatila',
  'send','sent','posalji','poslati','poslao','poslala','sam','mi','me','you','your','my','it','this','that','them','something','today','yesterday','to','for','of','od','za','u','iznos'])
const objectWords = text => (normalized(text).replace(CURRENCY, '').match(/[\p{L}\d]+/gu) || [])
  .filter(w => !STOP.has(w)).map(wordKey)
const containsAll = (text, words) => {
  const actual = new Set(objectWords(text))
  return words.length > 0 && words.every(w => actual.has(w))
}
const BEHALF = new RegExp(`\\b(?:for|za|on behalf of${more('behalf')})\\b`)
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
      const destination = said.split(BEHALF)[0]
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
