// The few words Kier matches directly rather than through a model: "done", "right now", "call me", and the words that
// carry a date. English always counts; the other languages come in with the owner's (config.languages, from System
// Settings), so "sad" means "now" only to someone who writes Croatian. Teaching Kier a language means adding its words
// here. Pronouns live here too, so every prompt speaks of the owner the way they asked ("they" until they say).
import { config } from './config.mjs'

const CODES = { english: 'en', croatian: 'hr', serbian: 'hr', bosnian: 'hr', montenegrin: 'hr', german: 'de', spanish: 'es', french: 'fr',
  italian: 'it', portuguese: 'pt', dutch: 'nl' }
export const langs = [...new Set(['en', ...config.languages.map((l) => CODES[String(l).toLowerCase().split(/[\s(]/)[0]]).filter(Boolean)])]
export const speaks = (code) => langs.includes(code)

const WORDS = {
  en: { balance: ['remaining balance', 'your balance is', 'balance is low', 'low balance', 'prepaid balance', 'credit left', 'remaining credit'],
    owed: ['due', 'overdue', 'please pay', 'pay by', 'amount owed', 'outstanding', 'payment reminder'], done: ['done', 'fixed', 'sent', 'pushed', 'merged', 'released', 'deployed', 'shipped', 'finished', 'paid'], paid: ['paid', 'payment sent', 'transferred'], now: ['now', 'right away', 'asap'],
    call: ['call me', 'give me a call', 'ring me'], month: ['end of the month', 'end of month'],
    later: ['let me know when', 'ask me when', 'ask me again when', 'ask me after', 'ask me later', 'ping me when', 'ping me after', 'ping me later', 'remind me when', 'remind me after', 'check with me when', 'check back with me'] },
  hr: { balance: ['preostali iznos', 'stanje računa', 'stanje racuna', 'avansnih uplata', 'raspoloživa sredstva', 'raspoloziva sredstva', 'preostalo stanje'],
    owed: ['dospijeće', 'dospijece', 'dospjelo', 'rok plaćanja', 'rok placanja', 'opomena', 'dugovanje', 'zaduženje', 'zaduzenje'], done: ['gotovo', 'riješeno', 'rijeseno', 'fixano', 'fixao', 'napravio', 'napravljeno', 'poslao', 'poslano', 'pushao', 'pusho', 'deployano', 'evo', 'plaćeno', 'placeno',
    'platio', 'platila', 'uplatio', 'uplatila', 'uplaćeno', 'uplaceno', 'poslala', 'napravila'],
    paid: ['platio', 'platila', 'plaćeno', 'placeno', 'uplatio', 'uplatila', 'uplaćeno', 'uplaceno', 'platili'],
    now: ['sad', 'sada', 'odmah', 'odma', 'evo', 'upravo'], call: ['nazovi', 'nazov', 'nazvat', 'nazvati', 'zovi'], month: ['kraj mjeseca', 'kraj ovog mjeseca'],
    later: ['javi mi kad', 'javi mi kada', 'pitaj me kad', 'pitaj me kada', 'pitaj me poslije', 'pitaj me kasnije', 'pingaj me kad', 'pingaj me kada', 'podsjeti me kad', 'podsjeti me kada', 'javi mi se kad', 'javi se kad'] },
  de: { balance: ['restguthaben', 'guthaben', 'kontostand', 'verbleibender betrag'], owed: ['fällig', 'faellig', 'überfällig', 'zahlungserinnerung', 'mahnung', 'offener betrag'], done: ['erledigt', 'fertig', 'gemacht', 'geschickt', 'gesendet', 'behoben', 'bezahlt'], paid: ['bezahlt', 'überwiesen'], now: ['jetzt', 'sofort', 'gleich'],
    call: ['ruf mich an', 'ruf an', 'anrufen'], month: ['monatsende', 'ende des monats'], later: ['frag mich wenn', 'frag mich später', 'frag mich nochmal', 'erinner mich wenn'] },
  es: { balance: ['saldo disponible', 'saldo restante', 'saldo actual'], owed: ['vencimiento', 'vencido', 'pendiente de pago', 'recordatorio de pago'], done: ['hecho', 'listo', 'arreglado', 'enviado', 'terminado', 'pagado'], paid: ['pagado', 'pagué', 'transferido'], now: ['ahora', 'enseguida'], call: ['llámame', 'llamame'], month: ['fin de mes'], later: ['pregúntame cuando', 'preguntame cuando', 'pregúntame luego', 'recuérdame cuando'] },
  fr: { balance: ['solde restant', 'solde disponible', 'votre solde'], owed: ['échéance', 'echeance', 'impayé', 'relance', 'à payer'], done: ['fait', 'terminé', 'réglé', 'corrigé', 'envoyé', 'payé'], paid: ['payé', 'réglé', 'viré'], now: ['maintenant', 'tout de suite'], call: ['appelle-moi', 'appelle moi', 'rappelle-moi'],
    month: ['fin du mois'], later: ['demande-moi quand', 'redemande-moi', 'relance-moi quand', 'rappelle-moi quand'] },
  it: { balance: ['saldo residuo', 'credito residuo', 'saldo disponibile'], owed: ['scadenza', 'scaduto', 'sollecito', 'da pagare'], done: ['fatto', 'finito', 'sistemato', 'inviato', 'mandato', 'pagato'], paid: ['pagato', 'bonifico fatto'], now: ['adesso', 'subito'], call: ['chiamami'], month: ['fine mese', 'fine del mese'], later: ['chiedimi quando', 'richiedimi', 'ricordamelo quando'] },
  pt: { balance: ['saldo restante', 'saldo disponível', 'saldo disponivel'], owed: ['vencimento', 'vencido', 'em atraso', 'a pagar'], done: ['feito', 'pronto', 'resolvido', 'enviado', 'pago'], paid: ['pago', 'paguei', 'transferi'], now: ['agora'], call: ['me liga', 'liga-me'], month: ['fim do mês', 'fim do mes'], later: ['pergunta-me quando', 'me pergunta quando', 'me lembra quando'] },
  nl: { balance: ['resterend saldo', 'uw saldo', 'beschikbaar saldo'], owed: ['vervaldatum', 'achterstallig', 'betalingsherinnering', 'te betalen'], done: ['klaar', 'gedaan', 'opgelost', 'verstuurd', 'betaald'], paid: ['betaald', 'overgemaakt'], now: ['nu', 'meteen'], call: ['bel me'], month: ['eind van de maand'], later: ['vraag me als', 'vraag me wanneer', 'vraag het me later'] },
}

// A request to relay information makes the relay the task, not the recipient’s underlying work.
const RELAY = {
  en: ['tell him', 'tell her', 'tell them', 'ask him', 'ask her', 'ask them', 'let him know', 'let her know', 'let them know', 'remind him', 'remind her'],
  hr: ['reci mu', 'reci joj', 'reci im', 'recite mu', 'kazi mu', 'kaži mu', 'kazi joj', 'kaži joj', 'javi mu', 'javi joj', 'javi im', 'pitaj ga', 'pitaj ju',
    'pitaj je', 'pitaj ih', 'podsjeti ga', 'podsjeti ju', 'podsjeti ih'],
  de: ['sag ihm', 'sag ihr', 'sag ihnen', 'frag ihn', 'frag sie', 'erinner ihn', 'erinner sie'],
  es: ['dile', 'díle', 'pregúntale', 'preguntale', 'avísale', 'avisale', 'recuérdale', 'recuerdale'],
  fr: ['dis-lui', 'dis lui', 'demande-lui', 'demande lui', 'rappelle-lui', 'préviens-le', 'previens-le'],
  it: ['digli', 'dille', 'chiedigli', 'chiedile', 'ricordagli', 'ricordale', 'avvisalo', 'avvisala'],
  pt: ['diz-lhe', 'diz pra ele', 'diz pra ela', 'pergunta-lhe', 'avisa ele', 'avisa ela', 'lembra ele', 'lembra ela'],
  nl: ['zeg hem', 'zeg haar', 'vraag hem', 'vraag haar', 'laat hem weten', 'laat haar weten'],
}
for (const [l, list] of Object.entries(RELAY)) if (WORDS[l]) WORDS[l].relay = list

// Reported speech is often information rather than a request. Support accented and plain forms.
const SAYS = {
  en: ['says', 'apparently', 'according to'],
  hr: ['kaže', 'kaze', 'kažu', 'kazu', 'veli', 'vele', 'navodno', 'piše da', 'pise da'],
  de: ['sagt', 'sagen', 'laut', 'angeblich'],
  es: ['dice', 'dicen', 'según', 'segun', 'al parecer'],
  fr: ['dit', 'disent', 'selon', 'apparemment', 'paraît-il', 'parait-il'],
  it: ['dice', 'dicono', 'secondo', 'a quanto pare'],
  pt: ['diz', 'dizem', 'segundo', 'pelos vistos', 'parece que'],
  nl: ['zegt', 'zeggen', 'volgens', 'blijkbaar'],
}
for (const [l, list] of Object.entries(SAYS)) if (WORDS[l]) WORDS[l].says = list

// Normalize exclamations for inference so they are not interpreted as names.
// Preserve the original message in the vault.
const EXCLAIM = {
  // Only the ones that look like a name: noting "joj" too made summaries vaguer on the bench and changed no verdict.
  hr: ['bokte', 'bote', 'jebote', 'jebate', 'bemti', 'majkemi', 'ajme'],
}
for (const [l, list] of Object.entries(EXCLAIM)) if (WORDS[l]) WORDS[l].exclaim = list

const esc = (w) => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
const words = (kind) => langs.flatMap((l) => WORDS[l]?.[kind] || [])
// Whole words only, in any script: "nu" is Dutch for now, not part of "menu".
// `but` leaves out words that mean something else too: "evo" is "here you go" as often as "done".
// A text with its exclamations as "omg".
export const calmed = (text) => (words('exclaim').length ? String(text).replace(new RegExp(`(?<!\\p{L})(${words('exclaim').map(esc).join('|')})(?!\\p{L})`, 'giu'), 'omg') : text)
export const wordRegex = (kind, but = []) => new RegExp(`(?<!\\p{L})(${words(kind).filter((w) => !but.includes(w)).map(esc).join('|')})(?!\\p{L})`, 'iu')

// Dates. Weekdays are matched by how a word starts (short stems only as whole words); relative words anywhere, in this
// order, so "prekosutra" and "übermorgen" aren't read as "sutra" and "morgen". Words are compared without accents.
const DATES = {
  en: { weekdays: [[1, ['monday', 'mon']], [2, ['tuesday', 'tue']], [3, ['wednesday', 'wed']], [4, ['thursday', 'thu']], [5, ['friday', 'fri']], [6, ['saturday']], [0, ['sunday']]],
    relative: [[2, ['day after tomorrow']], [1, ['tomorrow']], [0, ['today', 'tonight', 'this morning', 'this evening']]],
    months: { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 } },
  // No bare "sat" or "sun" stems at all: in Croatian "sat" is an hour.
  hr: { weekdays: [[1, ['ponedjelj', 'pon']], [2, ['utor', 'uto']], [3, ['srijed', 'sri']], [4, ['cetvrt', 'cet']], [5, ['petak', 'petk', 'pet']], [6, ['subot', 'sub']], [0, ['nedjelj', 'ned']]],
    relative: [[2, ['prekosutra']], [1, ['sutra']], [0, ['danas', 'veceras', 'jutros', 'popodne', 'nocas']]],
    months: { sij: 1, velj: 2, ozu: 3, tra: 4, svi: 5, lip: 6, srp: 7, kol: 8, ruj: 9, lis: 10, stu: 11, pro: 12 } },
  de: { weekdays: [[1, ['montag']], [2, ['dienstag']], [3, ['mittwoch']], [4, ['donnerstag']], [5, ['freitag']], [6, ['samstag', 'sonnabend']], [0, ['sonntag']]],
    relative: [[2, ['ubermorgen']], [1, ['morgen']], [0, ['heute', 'heute abend']]],
    months: { jan: 1, feb: 2, mar: 3, apr: 4, mai: 5, jun: 6, jul: 7, aug: 8, sep: 9, okt: 10, nov: 11, dez: 12 } },
  es: { weekdays: [[1, ['lunes']], [2, ['martes']], [3, ['miercoles']], [4, ['jueves']], [5, ['viernes']], [6, ['sabado']], [0, ['domingo']]],
    relative: [[2, ['pasado manana']], [1, ['manana']], [0, ['hoy', 'esta noche']]],
    months: { ene: 1, feb: 2, mar: 3, abr: 4, may: 5, jun: 6, jul: 7, ago: 8, sep: 9, oct: 10, nov: 11, dic: 12 } },
  fr: { weekdays: [[1, ['lundi']], [2, ['mardi']], [3, ['mercredi']], [4, ['jeudi']], [5, ['vendredi']], [6, ['samedi']], [0, ['dimanche']]],
    relative: [[2, ['apres-demain', 'apres demain']], [1, ['demain']], [0, ["aujourd'hui", 'ce soir']]],
    months: { jan: 1, fev: 2, mar: 3, avr: 4, mai: 5, aou: 8, sep: 9, oct: 10, nov: 11, dec: 12 } },
  it: { weekdays: [[1, ['lunedi']], [2, ['martedi']], [3, ['mercoledi']], [4, ['giovedi']], [5, ['venerdi']], [6, ['sabato']], [0, ['domenica']]],
    relative: [[2, ['dopodomani']], [1, ['domani']], [0, ['oggi', 'stasera']]],
    months: { gen: 1, feb: 2, mar: 3, apr: 4, mag: 5, giu: 6, lug: 7, ago: 8, set: 9, ott: 10, nov: 11, dic: 12 } },
  pt: { weekdays: [[1, ['segunda']], [2, ['terca']], [3, ['quarta']], [4, ['quinta']], [5, ['sexta']], [6, ['sabado']], [0, ['domingo']]],
    relative: [[2, ['depois de amanha']], [1, ['amanha']], [0, ['hoje', 'hoje a noite']]],
    months: { jan: 1, fev: 2, mar: 3, abr: 4, mai: 5, jun: 6, jul: 7, ago: 8, set: 9, out: 10, nov: 11, dez: 12 } },
  nl: { weekdays: [[1, ['maandag']], [2, ['dinsdag']], [3, ['woensdag']], [4, ['donderdag']], [5, ['vrijdag']], [6, ['zaterdag']], [0, ['zondag']]],
    relative: [[2, ['overmorgen']], [1, ['morgen']], [0, ['vandaag', 'vanavond']]],
    months: { jan: 1, feb: 2, mrt: 3, apr: 4, mei: 5, jun: 6, jul: 7, aug: 8, sep: 9, okt: 10, nov: 11, dec: 12 } },
}
export function dateWords(languages = langs) {
  const mine = languages.map(l => DATES[l]).filter(Boolean)
  return {
    weekdays: [1, 2, 3, 4, 5, 6, 0].map(d => [d, mine.flatMap(x => x.weekdays.find(([n]) => n === d)?.[1] || [])]),
    relative: [2, 1, 0].map(o => [o, mine.flatMap(x => x.relative.find(([n]) => n === o)?.[1] || [])]),
    months: Object.assign({}, ...mine.map(x => x.months)),
    monthEnd: new RegExp(languages.flatMap(l => WORDS[l]?.month || []).map(esc).join('|') || '(?!)'),
  }
}
export const { weekdays: WEEKDAYS, relative: RELATIVE, months: MONTHS, monthEnd: MONTH_END } = dateWords()

// How prompts speak of the owner. Set `pronoun` in config.json; "they" until then.
const PRONOUNS = {
  he: { self: 'himself', SELF: 'HIMSELF', his: 'his', him: 'him', he: 'he', makes: 'makes', promises: 'promises', commits: 'commits' },
  she: { self: 'herself', SELF: 'HERSELF', his: 'her', him: 'her', he: 'she', makes: 'makes', promises: 'promises', commits: 'commits' },
  they: { self: 'themselves', SELF: 'THEMSELVES', his: 'their', him: 'them', he: 'they', makes: 'make', promises: 'promise', commits: 'commit' },
}
export const P = PRONOUNS[config.pronoun] || PRONOUNS.they
