// Runs before anything is saved: secrets never reach the vault, so no client can ever read them back.

const luhn = (digits) => {
  let sum = 0
  for (let i = 0; i < digits.length; i++) {
    let d = Number(digits[digits.length - 1 - i])
    if (i % 2) d = d * 2 > 9 ? d * 2 - 9 : d * 2
    sum += d
  }
  return sum % 10 === 0
}

// A national or tax number is hidden when its label says what it is; on its own it reads like any other number.
// The value is letters and digits in short groups with at least five digits: groups joined by dashes, dots or
// spaces, a letter or two in front, a letter at the end (the tests carry one of each shape).
const ID_VALUE = String.raw`(?=(?:[^\d\n]{0,7}\d){5})[A-Z]{0,6} ?\d[A-Z0-9]*(?:[ .\-/]\d[A-Z0-9]*){0,6}(?: [A-Z](?![A-Za-z]))?`
const ID_SEP = String.raw`(\s*(?:[:#]|\b(?:is|ist|je|es|est)\b)?\s*)`
const ID_NAMES = ['OIB', 'JMBG', 'SSN', String.raw`social security(?: number| no\.?)?`, 'ITIN', String.raw`national insurance(?: number| no\.?)?`, 'NINO',
  'Steuer-?ID', 'Steueridentifikationsnummer', 'Steuernummer', 'Sozialversicherungsnummer', 'codice fiscale', 'CPF', 'PESEL', 'BSN', 'burgerservicenummer',
  'num[ée]ro de s[ée]curit[ée] sociale', 'n[úu]mero de (?:la )?seguridad social', 'n[úu]mero de contribuinte']
// Short labels that are also everyday words somewhere ("nie" is German for never), so only in capitals.
const ID_CAPITALS = ['DNI', 'NIE', 'NIF', 'NIR', 'NISS']
const idRule = (m, label, sep) => `${label}${sep}[ID]`

const RULES = [
  ['secret', /\b(?:sk-[A-Za-z0-9_-]{20,}|sk_live_[A-Za-z0-9]{16,}|ghp_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{30,}|AKIA[0-9A-Z]{16}|xox[abprs]-[A-Za-z0-9-]{10,}|AIza[0-9A-Za-z_-]{35})\b/g],
  ['iban', /\b[A-Z]{2}\d{2}(?:[ ]?[A-Z0-9]{4}){3,7}(?:[ ]?[A-Z0-9]{1,3})?\b/g],
  ['id', new RegExp(String.raw`\b(${ID_NAMES.join('|')})${ID_SEP}${ID_VALUE}`, 'gi'), idRule],
  ['id', new RegExp(String.raw`\b(${ID_CAPITALS.join('|')})${ID_SEP}${ID_VALUE}`, 'g'), idRule],
  ['password', /\b(password|passwd|lozinka|šifra|sifra|passwort|contraseña|contrasena|mot de passe|wachtwoord|senha|pass|pwd)(\s*[:=]\s*)\S+/gi, (m, label, sep) => `${label}${sep}[PASSWORD]`],
  // "kod" alone also means "at" in Croatian, so it only counts as "kod:", "kod je" or "kod za"; money is never a code.
  ['code', /\b(code|PIN|OTP|TAN|verification|verifikacijski|jednokratni|sigurnosni|bestätigungscode|código|codigo|codice|kod(?=\s*(?::|je\b|za\b)))([^\d\n]{0,30})(\d{4,8})\b(?!\s?(?:€|eur|kn|\$|usd|%))/gi, (m, label, mid) => `${label}${mid}[CODE]`],
  // Not after @, / or =: WhatsApp mentions and tweet or video ids are long numbers too.
  ['card', /(?<![@/=#\w])(?:\d[ -]?){12,18}\d(?![\w/])/g, (m) => (luhn(m.replace(/\D/g, '')) ? '[CARD]' : m)],
]

export function redact(text) {
  if (!text) return { text, found: [] }
  const found = []
  let out = text
  for (const [kind, re, fn] of RULES) {
    out = out.replace(re, (...args) => {
      const replaced = fn ? fn(...args) : `[${kind.toUpperCase()}]`
      if (replaced !== args[0]) found.push(kind)
      return replaced
    })
  }
  return { text: out, found }
}
