import { test } from 'node:test'
import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import { contactIndex, lookupContact, recordsFromContacts } from '../collectors/contacts.mjs'
import { normalizePerson, identityFor, identitiesMatch, callConnected } from '../lib/contact-identity.mjs'

// Reserved fictional exchange, generated to keep telephone literals out of public source.
const number = n => '+' + ['1', '202', '555', String(n).padStart(4, '0')].join('')
const local = n => number(n).slice(2)
const chatHandle = n => number(n).slice(1) + '@s.whatsapp.net'
const book = () => contactIndex([
  { id: 'person-1', name: 'Jonas Example', handles: [number(101), 'jonas@example.test'] },
  { id: 'person-2', name: 'Sam Example', handles: [number(102)] },
  { id: 'person-3', name: 'Sam Example', handles: [number(103)] },
])
const item = (id, aliases, name = 'Jonas Example') => ({ source: 'calls', thread: name, meta: { contactKnown: true, contactId: id, contactName: name, contactAliases: aliases } })

test('saved telephone, email, and unique display name resolve to one canonical record', () => {
  const b = book()
  for (const [handle, hint] of [[number(101)], [local(101)], [chatHandle(101)], ['JONAS@example.test'], ['8'.repeat(15) + '@lid', 'Jonas Example'], [null, 'Jonas Example']]) {
    const c = lookupContact(b, handle, hint)
    assert.equal(c.known, true)
    assert.equal(c.id, 'person-1')
    assert(c.aliases.includes('Jonas Example'))
  }
  assert.equal(b.legacy.get(number(101).slice(-9)), 'Jonas Example')
})

test('ambiguous saved names and unknown push names never become known contacts', () => {
  const b = book()
  assert.deepEqual(lookupContact(b, null, 'Sam Example'), { known: false, aliases: [] })
  assert.deepEqual(lookupContact(b, '9'.repeat(9) + '@lid', 'New Visitor'), { known: false, aliases: [] })
  assert.deepEqual(lookupContact(b, number(109)), { known: false, aliases: [] })
  assert.equal(lookupContact(b, number(102), 'Sam Example').id, 'person-2')
})

test('shared phone suffixes are ambiguous, while a complete exact handle still resolves', () => {
  const b = contactIndex([{ id: 'a', name: 'Nika', handles: [number(101)] }, { id: 'b', name: 'Tea', handles: ['+44' + local(101)] }])
  assert.equal(lookupContact(b, local(101)).known, false)
  assert.equal(lookupContact(b, number(101)).id, 'a')
})

test('Contacts schemas prefer persistent UID and retain source identity', t => {
  const db = new DatabaseSync(':memory:'); t.after(() => db.close())
  db.exec("create table ZABCDRECORD(Z_PK int,ZUNIQUEID text,ZFIRSTNAME text,ZLASTNAME text,ZORGANIZATION text);create table ZABCDPHONENUMBER(ZOWNER int,ZFULLNUMBER text);create table ZABCDEMAILADDRESS(ZOWNER int,ZADDRESS text);insert into ZABCDRECORD values(2,'stable-uid','Jonas','Example','');insert into ZABCDEMAILADDRESS values(2,'jonas@example.test')")
  db.prepare('insert into ZABCDPHONENUMBER values (?, ?)').run(2, number(101))
  const records = recordsFromContacts(db, 'source-uuid')
  assert.equal(records[0].id, 'addressbook:source-uuid:stable-uid')
  db.exec('update ZABCDRECORD set Z_PK=8;update ZABCDPHONENUMBER set ZOWNER=8;update ZABCDEMAILADDRESS set ZOWNER=8')
  assert.equal(recordsFromContacts(db, 'source-uuid')[0].id, records[0].id)
  assert.equal(lookupContact(contactIndex(records), 'jonas@example.test').name, 'Jonas Example')
})

test('older Contacts schemas can use a source-scoped record ID without email table', t => {
  const db = new DatabaseSync(':memory:'); t.after(() => db.close())
  db.exec("create table ZABCDRECORD(Z_PK int,ZORGANIZATION text);create table ZABCDPHONENUMBER(ZOWNER int,ZFULLNUMBER text);insert into ZABCDRECORD values(7,'Example Shop')")
  db.prepare('insert into ZABCDPHONENUMBER values (?, ?)').run(7, number(101))
  assert.equal(recordsFromContacts(db, 'local')[0].id, 'addressbook:local:7')
})

test('identity matching crosses phone and WhatsApp aliases without merging two saved people by name', () => {
  const a = item('person-1', [number(101), 'Jonas Example'])
  const b = item('person-1', [chatHandle(101), 'Jonas Example'])
  assert(identitiesMatch(a, b))
  assert(!identitiesMatch(a, item('person-other', ['Jonas Example'])))
  assert(!identitiesMatch(a, { thread: 'Jonas Example', meta: {} }))
  assert.equal(identityFor({ ...a, meta: { ...a.meta, contactId: 'contact:person-1' } }).key, 'contact:person-1')
  assert.equal(normalizePerson('⁨Jonas   Example⁩'), 'jonas example')
})

test('only completed conversations settle missed calls', () => {
  assert(callConnected({ meta: { seconds: 12, answered: true } }))
  assert(callConnected({ meta: { seconds: 0, talked: true, outcome: 'elsewhere' } }))
  assert(callConnected({ meta: JSON.stringify({ seconds: 0, outcome: 'answered_elsewhere' }) }))
  assert(!callConnected({ meta: { seconds: 0, answered: true, outcome: 'connected' } }))
  assert(!callConnected({ meta: { seconds: 0, answered: false, outcome: 'missed' } }))
})

test('text sender IDs never share an empty key, so one card cannot claim every alphanumeric sender', () => {
  const { legacy } = contactIndex([{ id: 'svc', name: 'Alerts Service', handles: ['555 0123', 'ALERTS'] }])
  assert.equal(legacy.has(''), false)
  assert.equal(legacy.get('alerts'), 'Alerts Service')
  assert.equal(legacy.get('ministry_x'), undefined)
  assert.equal(legacy.get('5550123'), 'Alerts Service')
})
