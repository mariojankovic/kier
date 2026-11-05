import { readdirSync, existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { home } from '../lib/config.mjs'
import { normalizePerson } from '../lib/contact-identity.mjs'
import { snapshot } from './util.mjs'

// Keep the old key->display-name map for existing collectors; identity lookups require an unambiguous saved record.
const ROOT = resolve(home, 'Library/Application Support/AddressBook')
// Phone numbers match on their last 9 digits; text sender IDs (MUP_RH, PGRDTY) and emails only match exactly, so a
// sender with no number never collapses to an empty key shared by every other one.
const key = s => {
  const text = String(s).trim()
  const digits = text.replace(/\D/g, '')
  return !text.includes('@') && /^[\d ()+.-]+$/.test(text) && digits.length >= 6 ? digits.slice(-9) : text.toLowerCase()
}

export function contactIndex(records) {
  const people = new Map(), handles = new Map(), suffixes = new Map(), localSuffixes = new Map(), names = new Map(), legacy = new Map()
  const add = (map, alias, id) => {
    if (!alias) return
    if (!map.has(alias)) map.set(alias, new Set())
    map.get(alias).add(id)
  }
  for (const record of records) {
    if (!record.id || !record.name) continue
    const person = people.get(record.id) || { id: record.id, name: record.name, aliases: new Set() }
    for (const alias of [record.name, ...(record.aliases || [])]) if (alias) person.aliases.add(String(alias))
    people.set(record.id, person)
    add(names, normalizePerson(record.name), record.id)
    for (const handle of record.handles || []) if (handle) {
      person.aliases.add(String(handle))
      const normalized = normalizePerson(handle)
      add(handles, normalized, record.id)
      // Local and international phone formats are accepted only when that suffix is unique in Contacts.
      if (/^\d{9,}$/.test(normalized)) {
        add(suffixes, normalized.slice(-9), record.id)
        if (normalized.length <= 10) add(localSuffixes, normalized.slice(-9), record.id)
      }
      if (key(handle)) legacy.set(key(handle), record.name)
    }
  }
  return { people, handles, suffixes, localSuffixes, names, legacy }
}

export function lookupContact(book, handle, nameHint) {
  const normalized = normalizePerson(handle)
  let ids = book.handles.get(normalized)
  if (!ids && /^\d{9,}$/.test(normalized)) ids = (normalized.length <= 10 ? book.suffixes : book.localSuffixes).get(normalized.slice(-9))
  // A caller ID may already be a saved display name. Never choose between same-name contacts.
  if (!ids && nameHint) ids = book.names.get(normalizePerson(nameHint))
  if (!ids && normalized && !/[\d@]/.test(normalized)) ids = book.names.get(normalized)
  if (ids?.size !== 1) return { known: false, aliases: [] }
  const person = book.people.get([...ids][0])
  return { known: true, id: person.id, name: person.name, aliases: [...person.aliases] }
}

// SQLite schemas vary between Contacts versions; a persistent record UID is preferred to its database row number.
export function recordsFromContacts(db, sourceId) {
  const columns = new Set(db.prepare('pragma table_info(ZABCDRECORD)').all().map(c => c.name))
  if (!columns.has('Z_PK')) return []
  const uid = ['ZUNIQUEID', 'ZUUID', 'ZUID'].find(c => columns.has(c))
  const field = name => columns.has(name) ? `coalesce(${name}, '')` : "''"
  const rows = db.prepare(`select Z_PK pk, ${uid || 'Z_PK'} uid, trim(${field('ZFIRSTNAME')} || ' ' || ${field('ZLASTNAME')}) name,
    ${field('ZORGANIZATION')} organization from ZABCDRECORD`).all()
  const records = new Map(rows.map(r => [r.pk, { id: `addressbook:${sourceId}:${r.uid || r.pk}`, name: r.name || r.organization, aliases: [], handles: [] }]))
  for (const [table, value] of [['ZABCDPHONENUMBER', 'ZFULLNUMBER'], ['ZABCDEMAILADDRESS', 'ZADDRESS']]) {
    try {
      for (const row of db.prepare(`select ZOWNER owner, ${value} value from ${table}`).all()) {
        if (row.value && records.has(row.owner)) records.get(row.owner).handles.push(row.value)
      }
    } catch {}
  }
  return [...records.values()].filter(r => r.name)
}

let cache
function book() {
  if (cache) return cache
  const files = [{ path: resolve(ROOT, 'AddressBook-v22.abcddb'), source: 'local' }]
  // Contacts may be unavailable to this process even when Calls can be read. Treat
  // missing access as unknown identity rather than stopping the source collector.
  try {
    for (const source of readdirSync(resolve(ROOT, 'Sources'))) files.push({ path: resolve(ROOT, 'Sources', source, 'AddressBook-v22.abcddb'), source })
  } catch {}
  const records = []
  files.forEach((file, i) => {
    if (!existsSync(file.path)) return
    let ab
    try {
      ab = snapshot(file.path, `contacts${i}`)
      records.push(...recordsFromContacts(ab.db, file.source))
    } catch {} finally { ab?.close() }
  })
  cache = contactIndex(records)
  return cache
}

export const contacts = () => book().legacy
export const contactFor = (handle, nameHint) => lookupContact(book(), handle, nameHint)
export const nameFor = handle => (handle && contacts().get(key(handle))) || handle || 'unknown'
