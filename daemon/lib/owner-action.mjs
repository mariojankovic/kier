import { config } from './config.mjs'
import { RELATIVE, WEEKDAYS, speaks } from './lang.mjs'
import { discordMessage } from './discord-copies.mjs'
import { names } from './profile.mjs'
import { handles } from '../collectors/screenchats.mjs'

const clean = s => String(s || '').normalize('NFKC').replace(/[\u200e\u200f\u202a-\u202e\u2066-\u2069]/g, '').trim()
const plain = s => clean(s).normalize('NFD').replace(/\p{M}/gu, '').toLowerCase()
const literal = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
const sources = new Set(['whatsapp', 'imessage', 'mail', 'notifications', 'discord', 'chat', 'social'])
const owner = () => [...names(), config.fullName, ...Object.values(handles()).flat()].filter(Boolean)
const people = me => [...new Set(me.map(clean).filter(Boolean))].sort((a, b) => b.length - a.length).map(literal).join('|')
const message = item => {
  const discord = discordMessage(item)
  const sender = discord?.sender ?? clean(item.sender)
  let text = discord?.text ?? clean(item.text)
  if (sender && text.startsWith(`${sender}:`)) text = text.slice(sender.length + 1).trim()
  return { sender, text }
}

// an addressed question can wait for an answer, or ask for actual work.
const question = /^(?:(?:can|could|may|should|shall|would|do|does|did|is|are|was|were|will|have|has)\b|(?:what|when|where|who|which|how|why|whether)\b|(?:mogu|mozemo|smijem|smijemo|jel|je l|jesi|jeste|dal|da li|kaj|sta|sto|kak|kako|koji|koja|koje|kad|kada|gdje|di|zakaj|zasto|oces|hoces|mozes|mozete)\b)/
const reported = /(?:^|\n)\s*>|["“”„«»`]|\b(?:said|says|wrote|asked|rekao|rekla|kaze|napisao|napisala|pitao|pitala)\b/
const invitation = /^(?:(?:can|could|would|will|shall) (?:you|we)|(?:mozes|hoces|oces)(?: li)?|(?:mozemo|hocemo)(?: li)?)\b.*\b(?:meet|join|come|call|visit|sastanak|sastati|naci|doc[i]?|doci|dodes|nazvati|vidimo)\b/
const indirectWork = /\b(?:do|would) you mind (?!if\b)|\b(?:for you to|are you (?:able|available|free|willing) to|do you have (?:time|a chance) to|(?:can|could) i (?:have|get|borrow|ask you to)|mogu (?:li )?(?:dobiti|dobit|posuditi|posudit))\b/
// The same in the owner's other languages, spelled without accents like the text they are compared with. `asks` opens
// a question that wants an answer; `canYou` opens a request for work, unless it only asks to be told something (`tell`);
// `reported` is someone passing on what another person said; `hello` may come before the owner's name. Each language
// counts only for someone who writes it.
const OTHER = {
  de: { asks: 'was|wann|wo|wer|wen|wem|welche[rsnm]?|wie|wieso|warum|weshalb|ist|sind|war|waren|hast|hat|habt|haben|gibt',
    canYou: '(?:kannst|konntest|wurdest|magst|willst) du|(?:konnen|konnten|wurden) sie', tell: 'sagen|bescheid|bestatigen|antworten|mitteilen',
    reported: 'sagte|sagt|schrieb|meinte|fragte', hello: 'hallo|hi|hey|servus|moin' },
  es: { asks: 'que|cuando|donde|quien|quienes|cual|cuales|como|por que|es|son|esta|estan|hay|tienes|tiene|has|ha',
    canYou: '(?:me |nos )?(?:puedes|podrias|puede|podria)', tell: 'decir|decirme|decirnos|confirmar|confirmarme|avisar|avisarme|responder',
    reported: 'dijo|dice|escribio|pregunto', hello: 'hola|buenas|oye' },
  fr: { asks: "que|quoi|quand|ou|qui|quels?|quelles?|comment|pourquoi|est-ce que|est|sont|as|avez",
    canYou: "(?:peux|pourrais)-tu|tu (?:peux|pourrais)|(?:pouvez|pourriez)-vous|est-ce que (?:tu peux|vous pouvez)", tell: 'dire|confirmer|repondre|prevenir',
    reported: 'a dit|dit que|a ecrit|a demande', hello: 'salut|bonjour|coucou' },
  it: { asks: "che|cosa|quando|dove|chi|quale|quali|come|perche|e|sono|hai|ha|avete",
    canYou: '(?:mi |ci )?(?:puoi|potresti|puo|potrebbe)', tell: 'dire|dirmi|dirci|confermare|confermarmi|rispondere|farmi sapere',
    reported: 'ha detto|dice|ha scritto|ha chiesto', hello: 'ciao|salve|ehi' },
  pt: { asks: 'que|quando|onde|quem|qual|quais|como|porque|por que|e|sao|esta|estao|tens|tem|ha',
    canYou: '(?:me |nos )?(?:podes|pode|poderia|poderias|consegues)|voce pode', tell: 'dizer|dizer-me|confirmar|responder|avisar',
    reported: 'disse|diz|escreveu|perguntou', hello: 'ola|oi|ei' },
  nl: { asks: 'wat|wanneer|waar|wie|welke?|hoe|waarom|is|zijn|was|waren|heb|hebt|heeft|hebben',
    canYou: '(?:kun|kan|zou|wil) je|(?:kunt|zou) u', tell: 'zeggen|vertellen|bevestigen|antwoorden|laten weten',
    reported: 'zei|zegt|schreef|vroeg', hello: 'hoi|hallo|hey|dag' },
}
const spoken = Object.entries(OTHER).filter(([code]) => speaks(code)).map(([, words]) => words)
const any = (kind) => spoken.map((l) => l[kind]).join('|')
const moreQuestion = spoken.length ? new RegExp(`^[¿¡\\s]*(?:${any('asks')}|${any('canYou')})\\b`) : null
const moreReported = spoken.length ? new RegExp(`\\b(?:${any('reported')})\\b`) : null
const moreWork = (text) => spoken.some((l) => new RegExp(`^[¿¡\\s]*(?:${l.canYou})\\b`).test(text) && !new RegExp(`\\b(?:${l.tell})\\b`).test(text))
function work(text) {
  if (indirectWork.test(text) || moreWork(text)) return true
  const en = text.match(/\b(?:can|could|would|will)\s+you\s+(.+)/)?.[1].replace(/^(?:(?:please|just|also|maybe|kindly)\s+)+/, '')
  if (en && !/^(?:tell me|let me know|confirm|say|answer)\b/.test(en)) return true
  const hr = text.match(/\b(?:mozes|mozete|hoces|hocete|oces)\s+(.+)/)?.[1].replace(/^(?:(?:li|mi|nam|ti|vi|samo|molim|opet)\s+)+/, '')
  // "Reci Niki" passes work on; "reci mi gdje" needs an answer.
  if (hr && !/^(?:reci|kazati|javi[t]?i?|potvrdi[t]?i?|odgovori[t]?i?)\s+(?:mi\s+)?(?:gdje|di|kad|kada|koji|koja|koje|sto|sta|kaj|kako|koliko|zasto|zakaj|jel|je|jesi|da li|je li|je l|dal)\b/.test(hr)) return true
  return false
}

export function replyQuestion(item, me = owner()) {
  if (item.from_me || item.amount || ['relay', 'later'].includes(item.model) || !sources.has(item.source)) return null
  if (item.card && !['todo', 'reply', 'appointment'].includes(item.card)) return null
  const { text } = message(item)
  const named = people(me)
  if (!named || !text.includes('?')) return null
  const mine = new RegExp(`^@?(?:${named})$`, 'iu')
  const mentions = [...text.matchAll(/(?<![\p{L}\p{N}_.@])@[\p{L}\p{N}_][\p{L}\p{N}_.-]*/gu)]
  if (mentions.some(m => !mine.test(m[0]))) return null
  // Only a direct address, never a name inside reported speech or a question about them.
  const start = new RegExp(`^(?:(?:hey|hi|hello|ej|hej|bok${spoken.length ? `|${any('hello')}` : ''})\\s*[,!]?(?:\\s+))?@?(?:${named})(?=$|[^\\p{L}\\p{N}_.-])\\s*[,!:]?\\s*`, 'iu')
  const end = new RegExp(`(?:,\\s*@?|\\s+@)(?:${named})\\s*([?!.]*)$`, 'iu')
  let body = text.replace(start, '')
  if (body === text) body = text.replace(end, '$1').trim()
  if (body === text || !body.trim()) return null
  const normalized = plain(body)
  if (reported.test(normalized) || moreReported?.test(normalized) || work(normalized) || invitation.test(normalized)) return null
  if (!(question.test(normalized) || moreQuestion?.test(normalized)) || /[?!.;]\s+\p{L}/u.test(body)) return null
  return body.replace(/\s+/g, ' ').trim()
}

// quote the question so an unfamiliar feature cannot become an invented event.
export function actionTitle(summary, item, me = owner()) {
  if (item.from_me || !sources.has(item.source)) return summary
  const { sender } = message(item)
  const asked = replyQuestion(item, me)
  if (asked && sender) {
    const prefix = `Answer ${sender}: "`
    const room = Math.max(0, 199 - prefix.length)
    return `${prefix}${asked.length > room ? `${asked.slice(0, room - 1).trimEnd()}…` : asked}"`
  }
  const named = people(me)
  if (!named) return summary
  const match = clean(summary).match(new RegExp(`^(.+?)\\s+(?:asks|asked|is asking)\\s+(?:${named})\\s+to\\s+(.+)$`, 'iu'))
  if (!match || me.some(n => plain(n) === plain(match[1]))) return summary
  return match[2][0].toUpperCase() + match[2].slice(1)
}

// Evidence comes from the message, never its generated title, date or chat name.
// These are necessary clues, not proof that an arrangement belongs to the owner.
const arrangement = /\b(?:meet|meeting|appointment|call|visit|join|attend|come|dinner|lunch|coffee|party|wedding|standup|daily|sastan[a-z]*|sastanek|termin[a-z]*|poziv[a-z]*|nazov[a-z]*|nazvat[a-z]*|zovi|zovite|doc[i]?|dodi|dodji|dojdi|dodes|dodjes|navrat[a-z]*|vidimo|nademo|nadjemo|rucak|ruck[a-z]*|vecer[a-z]*|kav[a-z]*|svadb[a-z]*)\b/
const timing = /\b(?:today|tomorrow|tonight|yesterday|now|later|noon|midnight|morning|afternoon|evening|monday|tuesday|wednesday|thursday|friday|saturday|sunday|danas|denes|sutra|zutra|prekosutra|preksutra|naksutra|jutri|veceras|navecer|jutro|vjutro|podne|ponoc|sad|sada|kasnije|ponedjeljak|ponedeljak|utorak|srijed[a-z]*|sred[a-z]*|cetvrtak|petak|petek|subot[a-z]*|nedjelj[a-z]*|nedelj[a-z]*)\b|\b(?:this|next)\s+(?:week|month|weekend)\b|\b(?:u|v|at|ob)\s+(?:\d{1,2}|pon|uto|sri|cet|pet|sub|ned|jedan|dva|tri|cetiri|pet|sest|sedam|osam|devet|deset|jedanaest|dvanaest)\b|\b\d{1,2}(?::\d{2}|\.\d{1,2}\b)|\b\d{1,2}\s*(?:am|pm)\b|\b\d{4}-\d{2}-\d{2}\b/
// What an arrangement and its timing read like in the owner's other languages. An appointment the model named keeps its
// card when the message has one of these; without them a German lunch on Friday would be turned into a to-do.
const MEETING = {
  de: 'treffen|treffe|treffpunkt|termin|besprechung|meeting|anruf|anrufen|telefonat|telefonieren|besuch|besuchen|kommen|komm|kommst|kommt|abendessen|mittagessen|essen|kaffee|party|feier|hochzeit|verabredung|uhr|mittag|mittags|mitternacht|nachmittag|abend|abends|jetzt|spater',
  es: 'quedar|quedamos|reunion|cita|llamada|llamar|llamame|visita|visitar|venir|ven|vienes|cena|cenar|comida|almuerzo|almorzar|cafe|fiesta|boda|mediodia|medianoche|tarde|noche|ahora|luego',
  fr: 'rendez-vous|rdv|reunion|rencontre|retrouver|retrouve|appel|appeler|visite|venir|viens|viendras|diner|dejeuner|cafe|fete|soiree|mariage|midi|minuit|matin|apres-midi|soir|maintenant|plus tard',
  it: 'incontro|incontrarci|incontriamo|vediamo|vederci|riunione|appuntamento|chiamata|chiamare|chiamami|visita|venire|vieni|cena|pranzo|caffe|festa|matrimonio|mezzogiorno|mezzanotte|mattina|pomeriggio|sera|adesso|dopo',
  pt: 'reuniao|encontro|encontrar|consulta|chamada|ligar|ligacao|visita|visitar|vir|vem|vens|jantar|almoco|almocar|cafe|festa|casamento|meio-dia|meia-noite|manha|tarde|noite|agora|depois',
  nl: 'afspraak|afspreken|vergadering|overleg|ontmoeten|bellen|belafspraak|bezoek|langskomen|komen|kom|komt|eten|diner|lunch|lunchen|koffie|feest|bruiloft|uur|middag|middernacht|ochtend|avond|nu|straks|later',
}
const meeting = Object.entries(MEETING).filter(([code]) => speaks(code)).map(([, words]) => words).join('|')
const moreArrangement = meeting ? new RegExp(`(?<![\\p{L}\\p{N}])(?:${meeting})(?![\\p{L}\\p{N}])`, 'u') : null
// Kier's own date words for the owner's languages (lang.mjs): a day named in any of them is timing too.
const dayNamed = (text) => RELATIVE.some(([, words]) => words.some((w) => new RegExp(`(?<![\\p{L}\\p{N}])${literal(w)}(?![\\p{L}\\p{N}])`, 'u').test(text)))
  || text.split(/[^a-z]+/).some((t) => WEEKDAYS.some(([, stems]) => stems.some((s) => t.startsWith(s) && (s.length > 3 || t === s))))
const arrangementEvidence = text => arrangement.test(text.replace(/\bcome\s+(?:first|last)\b/g, '')) || timing.test(text) || (moreArrangement ? moreArrangement.test(text) || dayNamed(text) : false)

export function actionCard(card, item) {
  if (card !== 'appointment' || !sources.has(item.source)) return card
  if (arrangementEvidence(plain(message(item).text))) return card
  return replyQuestion(item) ? 'reply' : 'todo'
}

// A colleague can describe a product order without assigning any of it to the owner.
// Keep questions, addresses, mixed requests and uncertain phrasing for the model.
const request = /\b(?:you|your|yours|ti|te|tebe|tebi|tvoj[a-z]*|vi|vas|vama|vas[a-z]*|please|pls|plz|can|could|would|shall|must|need|let|treba[a-z]*|mor[a-z]*|jel|jesi|jeste|oces|hoces|hocete|mozes|mozete|budes|bute|bus|bu[ms]|ajd[a-z]*|daj|dajte|molim|molimo)\b/
const directive = /\b(?:send|share|check|review|look|tell|ask|ping|remind|help|confirm|approve|fix|repair|build|develop|implement|integrate|test|prepare|write|rewrite|finish|update|add|remove|publish|deploy|merge|push|upload|refactor|sort|handle|release|click|make|do|buy|put|create|design|plan|schedule|move|prioritize|ship|javi|javite|posalji|posaljite|pogledaj|pogledajte|provjeri|provjerite|sredi|sredite|napravi|napravite|dodaj|dodajte|reci|recite|pitaj|pitajte|potvrdi|potvrdite|odobri|odobrite|pripremi|pripremite|prebaci|prebacite|pomogni|pomozite|podsjeti|podsjetite|testiraj|testirajte|fixaj|fixajte|pushaj|pushajte|slozi|slozite|poslozi|poslozite|popravi|popravite|uvedi|uvedite|izradi|izradite|isporuci|isporucite|ukloni|uklonite|kupi|kupite|stavi|stavite|odradi|odradite|zavrsi|zavrsite|napisi|napisite|objavi|objavite|implementiraj|implementirajte|deplo[yj]aj|mergaj)\b/
const order = /^(?:prvo|najprije|najprej|najprvo|first)\s+(?:je|su|bu|bude|ide|idu|is|are)\s+[^,]+$|^[\p{L}\p{N} /&+-]+\s+(?:je|su|bu|bude|ide|idu|is|are|comes?|goes?|should (?:come|be)|will be)\s+(?:(?:nam|nama|za nas|for us|the)\s+)*(?:zadnj[a-z]*|posljednj[a-z]*|prv[a-z]*|last|first|na kraju)(?:\s+(?:za nas|for us))?$|^(?:pa|onda|zatim|then)\s+[\p{L}\p{N} /&+-]+\s+(?:ko|kao|as)\s+(?:slag(?: na (?:to|kraju))?|the cherry on top)$/u
// Bare ordering is only clear for paired nouns. "First open the archive" stays.
const pairedOrder = /^(?:prvo|najprije|najprej|first)\s+[\p{L}\p{N}]+,?\s+(?:pa(?: onda)?|then|and then)\s+[\p{L}\p{N}]+$/u
const orderLead = /^(?:(?:ok|okay|okej|dobro|da|yes|ali|but|and|i)\b[\s,]*)+/
const fragment = /^(?:(?:pa|onda|zatim|then|and)\s+)*[\p{L}\p{N}]+$/u
// Unknown Croatian commands often end in -i or -aj. A possible command after a
// conjunction is enough to keep a mixed message, even if this also keeps a noun.
const possibleCommand = /\b(?:pa|onda|zatim|i)\s+\p{L}*(?:aj|ajte|i|ite)\b(?=\s+(?!(?:ko|kao|je|su|bu|bude)\b)\p{L})/u

export function priorityStatement(item, me = owner()) {
  if (item.from_me || item.amount || ['relay', 'later'].includes(item.model) || !sources.has(item.source)) return false
  const text = plain(message(item).text)
  if (!text || /[?¿]/.test(text) || reported.test(text) || request.test(text) || directive.test(text) || possibleCommand.test(text) || arrangementEvidence(text)) return false
  const named = people(me.map(plain))
  if (named && new RegExp(`(?<![\\p{L}\\p{N}_])@?(?:${named})(?![\\p{L}\\p{N}_])`, 'iu').test(text)) return false
  if (/@[\p{L}\p{N}_]/u.test(text)) return false
  const clauses = text.split(/[\n.!;]+/).flatMap(s => pairedOrder.test(s.trim()) ? [s] : s.split(','))
    .map(s => s.trim().replace(orderLead, '')).filter(Boolean)
  if (!clauses.some(s => order.test(s) || pairedOrder.test(s))) return false
  // Only single nouns with optional sequence words may continue an order statement.
  return clauses.every(s => order.test(s) || pairedOrder.test(s) || fragment.test(s))
}

export function ownerVerdict(tag, item) {
  if (!tag.is_task || !priorityStatement({ ...item, amount: tag.amount })) return tag
  const { sender } = message(item)
  return { ...tag, is_task: 0, urgency: 0, due: '', when_words: '', summary: `${sender || 'The sender'} describes priorities`.slice(0, 200) }
}
