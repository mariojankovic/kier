import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { request } from 'node:http'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { sealBody, signedHeaders, responseMAC } from '../lib/http-auth.mjs'

const dir = mkdtempSync(join(tmpdir(), 'kier-mail-query-'))
process.env.KIER_DATA_DIR = dir
writeFileSync(join(dir, 'config.json'), JSON.stringify({ me: 'Sam', fullName: 'Sam', languages: ['English', 'Croatian'], online: false, off: [] }))
const { mailQuery, validateMailQuery, ownReading, dateRange, addressesFor, MAIL_QUERY_MAX_BYTES } = await import('../lib/mail-query.mjs')
const { open, addItems, now } = await import('../lib/db.mjs')
const { serve } = await import('../lib/server.mjs')
const { tokenPath } = await import('../lib/config.mjs')
const secret = 'd'.repeat(64)
writeFileSync(tokenPath, secret, { mode: 0o600 })
const db = open(':memory:')
const server = await serve(db, { port: 0 })
const port = server.address().port
after(async () => { await new Promise(resolve => server.close(resolve)); db.close(); rmSync(dir, { recursive: true, force: true }) })

// Saturday 14 November 2026, weeks starting on Monday.
const TODAY = '2026-11-14'
const ask = (q, extra = {}) => ({ q, today: TODAY, accounts: ['sam@example.test'], ...extra })
const sure = value => ({ options: value === 'yes' ? { yes: 0.97, no: 0.03 } : { yes: 0.02, no: 0.98 }, covered: 0.99 })
// A filled form, as the model process returns it.
// The yes-or-no before each text field follows from whether the test gives that field anything.
function form(values, confidence = {}, calls = []) {
  const all = { people: '', sent_by_them: 'no', when: '', about: '', attachment: 'no', unread: 'no', kind: 'any', ...values }
  const gates = { names_someone: all.people ? 'yes' : 'no', gives_time: all.when ? 'yes' : 'no', has_topic: all.about ? 'yes' : 'no', ...values }
  return async asked => {
    calls.push(asked)
    return { values: { ...all, ...gates }, confidence: { names_someone: sure(gates.names_someone), gives_time: sure(gates.gives_time), has_topic: sure(gates.has_topic),
      sent_by_them: sure(all.sent_by_them), attachment: sure(all.attachment), unread: sure(all.unread), kind: { options: { [all.kind]: 0.95 }, covered: 0.99 }, ...confidence } }
  }
}
const read = (q, values, confidence) => mailQuery(null, ask(q), { fill: form(values, confidence), first: 1 })

test('a search request is checked before anything reads it', () => {
  assert.deepEqual(validateMailQuery({ q: '  from priya  ', today: TODAY, accounts: ['sam@example.test'], bundles: ['finance', 'made-up'] }),
    { q: 'from priya', today: TODAY, accounts: ['sam@example.test'], bundles: ['finance'] })
  for (const bad of [null, [], {}, ask(''), ask(7), { q: 'x y', today: 'yesterday' }, { q: 'x y', today: '2026-13-40' }, ask('x y', { accounts: ['nope'] }), ask('x y', { bundles: 'all' })]) {
    assert.throws(() => validateMailQuery(bad), error => error.status === 400)
  }
  assert.throws(() => validateMailQuery(ask('x'.repeat(301))), error => error.status === 413)
  assert.ok(MAIL_QUERY_MAX_BYTES >= 4096)
})

test('Kier starts from the reading Kier Mail does itself', () => {
  const blank = { words: [], people: [], senders: [], after: null, before: null, attachment: false, unread: false, pinned: false, bundle: null }
  const reads = (q, want) => assert.deepEqual(ownReading(q, TODAY, 1), { ...blank, ...want }, q)
  reads('from priya last week', { senders: ['priya'], after: '2026-11-02', before: '2026-11-09' })
  reads('from priya last week'.toUpperCase(), { senders: ['PRIYA'], after: '2026-11-02', before: '2026-11-09' })
  reads('invoice from acme october', { senders: ['acme'], bundle: 'finance', after: '2026-10-01', before: '2026-11-01' })
  reads('unread pdf with tea', { people: ['tea'], attachment: true, unread: true })
  reads('to:borna from:filip this month', { people: ['borna'], senders: ['filip'], after: '2026-11-01', before: '2026-12-01' })
  reads('what did jonas send yesterday', { words: ['jonas', 'send'], after: '2026-11-13', before: '2026-11-14' })
  reads('last 3 days receipts', { bundle: 'purchases', after: '2026-11-11' })
  reads('past 2 months', { after: '2026-09-14' })
  reads('december flights', { bundle: 'travel', after: '2025-12-01', before: '2026-01-01' })
  reads('dec 2024 "roadmap", new mail', { words: ['roadmap'], unread: true, after: '2024-01-01', before: '2025-01-01' })
  reads('pinned from the team today', { words: ['team'], pinned: true, after: '2026-11-14', before: '2026-11-15' })
  reads('this week', { after: '2026-11-09', before: '2026-11-16' })
  assert.deepEqual([ownReading('this week', TODAY, 7).after, ownReading('last week', TODAY, 7).after], ['2026-11-08', '2026-11-01'])
  reads('last year this year', { after: '2026-01-01', before: '2027-01-01' })
})

test('the owner\'s date words are worked out here, and anything else is left unread', () => {
  const range = (words, after, before = null) => assert.deepEqual(dateRange(words, TODAY, 1), { after, before }, words)
  range('two weeks ago', '2026-10-26', '2026-11-02')
  range('since March', '2026-03-01')
  range('after march', '2026-04-01')
  range('since monday', '2026-11-09')
  range('before october', null, '2026-10-01')
  range('last friday', '2026-11-13', '2026-11-14')
  range('in 2025', '2025-01-01', '2026-01-01')
  range('march 2025', '2025-03-01', '2025-04-01')
  range('past two weeks', '2026-10-31')
  range('a month ago', '2026-10-01', '2026-11-01')
  range('2026-11-03', '2026-11-03', '2026-11-04')
  range('jučer', '2026-11-13', '2026-11-14')
  range('prekjučer', '2026-11-12', '2026-11-13')
  range('prošli tjedan', '2026-11-02', '2026-11-09')
  range('ovaj tjedan', '2026-11-09', '2026-11-16')
  range('prošli mjesec', '2026-10-01', '2026-11-01')
  range('iz listopada', '2026-10-01', '2026-11-01')
  range('iz kolovoza', '2026-08-01', '2026-09-01')
  range('od ponedjeljka', '2026-11-09')
  range('do petka', null, '2026-11-13')
  range('prije dva tjedna', '2026-10-26', '2026-11-02')
  range('zadnja tri dana', '2026-11-11')
  range('prije listopada', null, '2026-10-01')
  for (const words of ['sometime', 'next week', 'tomorrow', 'pet', 'soon', 'last couple of weeks', '', 'since', 'the other day']) assert.equal(dateRange(words, TODAY, 1), null, words)
  // The 31st has no twin in a shorter month.
  assert.deepEqual(dateRange('a month ago', '2026-03-31', 1), { after: '2026-02-01', before: '2026-03-01' })
  assert.deepEqual(dateRange('last 1 month', '2026-03-31', 1), { after: '2026-02-28', before: null })
})

test('a name typed without "from" or "with" becomes a person, and the words are what is left', async () => {
  const calls = []
  const out = await mailQuery(null, ask('priya contract'), { fill: form({ people: 'priya', about: 'contract' }, {}, calls), first: 1 })
  assert.deepEqual(out, { words: ['contract'], people: ['priya'] })
  assert.equal(calls.length, 1)
  assert.equal(calls[0].user, 'Typed: priya contract')
  assert.deepEqual(calls[0].fields.map(field => field.name), ['names_someone', 'people', 'sent_by_them', 'gives_time', 'when', 'has_topic', 'about', 'attachment', 'unread', 'kind'])
  assert.deepEqual(calls[0].fields.filter(field => field.when).map(field => [field.name, field.when]), [['people', { names_someone: ['yes'] }], ['sent_by_them', { names_someone: ['yes'] }], ['when', { gives_time: ['yes'] }], ['about', { has_topic: ['yes'] }]])
  assert.match(calls[0].system, /never add a name, a date or a word that was not typed/)
  assert.deepEqual(await read('what did Jonas send me about the lease last month', { people: 'Jonas', sent_by_them: 'yes', when: 'last month', about: 'lease' }),
    { words: ['lease'], senders: ['Jonas'], after: '2026-10-01', before: '2026-11-01' })
  assert.deepEqual(await read("tea's email about the keys", { people: 'Tea', about: 'keys' }), { words: ['keys'], people: ['Tea'] })
  assert.deepEqual(await read('jonas and priya about the roadmap', { people: 'jonas, priya', about: 'roadmap' }), { words: ['roadmap'], people: ['jonas', 'priya'] })
  assert.deepEqual(await read('anything from the landlord about the deposit', { people: 'the landlord', sent_by_them: 'yes', about: 'deposit' }), { words: ['deposit'], senders: ['landlord'] })
  // Croatian, where the rules read nothing.
  assert.deepEqual(await read('poruke od Lucije o ugovoru', { people: 'Lucije', sent_by_them: 'yes', about: 'ugovoru' }), { words: ['ugovoru'], senders: ['Lucije'] })
  assert.deepEqual(await read('računi iz rujna', { when: 'iz rujna', kind: 'finance' }), { after: '2026-09-01', before: '2026-10-01', bundle: 'finance' })
  // Not sure they are the senders: with, not from.
  assert.deepEqual(await read('borna budget', { people: 'borna', sent_by_them: 'yes', about: 'budget' }, { sent_by_them: { options: { yes: 0.55, no: 0.45 }, covered: 0.99 } }), { words: ['budget'], people: ['borna'] })
})

test('the whole date phrase says more than the one word the rules know', async () => {
  assert.deepEqual(ownReading('mails with borna since march', TODAY, 1).before, '2026-04-01')
  assert.deepEqual(await read('mails with borna since march', { people: 'borna', when: 'since march' }), { people: ['borna'], after: '2026-03-01' })
  assert.deepEqual(await read('emails borna sent me before october', { people: 'borna', sent_by_them: 'yes', when: 'before october' }), { senders: ['borna'], before: '2026-10-01' })
  assert.deepEqual(await read('lucija sent a pdf two weeks ago', { people: 'lucija', sent_by_them: 'yes', when: 'two weeks ago', attachment: 'yes' }),
    { senders: ['lucija'], after: '2026-10-26', before: '2026-11-02', has_attachment: true })
})

test('nothing the owner did not type gets in', async () => {
  // An invented name, a date that was not typed, a topic word from nowhere: each is dropped, and with nothing left to add Kier declines.
  assert.equal(await read('quarterly budget spreadsheet', { people: 'Priya', about: 'quarterly budget spreadsheet' }), null)
  assert.equal(await read('quarterly budget spreadsheet', { when: 'last week', about: 'quarterly budget spreadsheet' }), null)
  assert.equal(await read('quarterly budget spreadsheet', { about: 'quarterly budget report' }), null)
  assert.equal(await read('quarterly budget spreadsheet', { people: 'the team', about: 'quarterly budget spreadsheet' }), null)
  // A topic offered as a person too is a topic; so is a word the rules already read as a filter; so is a person the model is not sure of.
  assert.equal(await read('quarterly budget spreadsheet', { people: 'quarterly budget spreadsheet', about: 'budget spreadsheet' }), null)
  assert.equal(await read('show me unread mail', { people: 'unread', unread: 'yes' }), null)
  assert.equal(await read('flight confirmation lisbon', { people: 'lisbon', about: 'confirmation lisbon', kind: 'travel' }, { names_someone: { options: { yes: 0.55, no: 0.45 }, covered: 0.99 } }), null)
  // Words go only when the model is sure there is no topic.
  assert.deepEqual(await read('priya contract', { people: 'priya' }, { has_topic: { options: { yes: 0.4, no: 0.6 }, covered: 0.99 } }), { words: ['contract'], people: ['priya'] })
  assert.deepEqual(await read('priya contract', { people: 'priya' }), { people: ['priya'] })
  // A name written the dictionary way stands beside the case the owner typed; one that matches nothing typed is dropped.
  assert.deepEqual(await read('poruke od Lucije o ugovoru', { people: 'Lucija', sent_by_them: 'yes', about: 'ugovoru' }), { words: ['ugovoru'], senders: ['Lucije', 'Lucija'] })
  assert.deepEqual(await read("sam's notes from the offsite", { people: 'sam', about: 'notes offsite' }), { words: ['notes', 'offsite'], people: ['sam'] })
  assert.equal(await read('kickoff meeting notes', { people: 'Lucija', about: 'kickoff meeting notes' }), null)
  // The one word that named the kind of mail is not looked for as well, unless the model is very sure it is a topic.
  const fairly = { has_topic: { options: { yes: 0.88, no: 0.12 }, covered: 0.99 } }
  assert.deepEqual(await read('računi iz rujna', { when: 'iz rujna', about: 'računi', kind: 'finance' }, fairly), { after: '2026-09-01', before: '2026-10-01', bundle: 'finance' })
  assert.deepEqual(await read('struja iz rujna', { when: 'iz rujna', about: 'struja', kind: 'finance' }), { words: ['struja'], after: '2026-09-01', before: '2026-10-01', bundle: 'finance' })
  // The little words of a Croatian sentence are never looked for.
  assert.deepEqual(await read('što mi je Borna poslao prošli mjesec', { people: 'Borna', sent_by_them: 'yes', when: 'prošli mjesec', about: 'šta' }), { words: ['poslao'], senders: ['Borna'], after: '2026-10-01', before: '2026-11-01' })
  // A date Kier can't work out stays as words, as in Kier Mail's own reading.
  assert.deepEqual(await read('priya the other day', { people: 'priya', when: 'the other day' }), { people: ['priya'] })
  // A filter the model is not sure of hides mail, so it is left off.
  const unsure = { options: { yes: 0.7, no: 0.3 }, covered: 0.99 }
  assert.deepEqual(await read('priya report', { people: 'priya', about: 'report', attachment: 'yes', unread: 'yes', kind: 'finance' }, { attachment: unsure, unread: unsure, kind: { options: { finance: 0.6, any: 0.4 }, covered: 0.99 } }),
    { words: ['report'], people: ['priya'] })
  assert.deepEqual(await read("promos I haven't opened", { unread: 'yes', kind: 'promos' }), { unread: true, bundle: 'promos' })
})

test('Kier declines when it has nothing to add, when asked for pinned mail, and when the form fails', async () => {
  assert.equal(await read('from filip last week', { people: 'filip', sent_by_them: 'yes', when: 'last week' }), null)
  assert.equal(await read('kickoff meeting notes', { about: 'kickoff meeting notes' }), null)
  assert.equal(await read('show me unread mail', { unread: 'yes' }), null)
  assert.equal(await mailQuery(null, ask('pinned from filip'), { fill: () => assert.fail('asked the model'), first: 1 }), null)
  for (const fill of [async () => null, async () => { throw Error('no') }]) assert.equal(await mailQuery(null, ask('priya contract'), { fill, first: 1 }), null)
  await assert.rejects(mailQuery(null, { q: 'priya contract' }, { fill: () => assert.fail('asked the model') }), error => error.status === 400)
})

test('the addresses Kier knows for a name widen the search and never narrow it', async t => {
  const vault = open(':memory:')
  t.after(() => vault.close())
  const mail = (id, sender, address, fromMe = false) => ({ id, source: 'mail', sender, fromMe, thread: 'Notes', ts: now() - 100, text: 'Hello.', meta: { from: [{ name: sender, email: address }], to: [{ email: 'sam@example.test' }] } })
  addItems(vault, [mail('a', 'Nika Example', 'nika@example.test'), mail('b', 'Nika Example', 'nika@example.test'), mail('c', 'Nika Example', 'nika.work@example.test'),
    mail('d', 'Nikola Other', 'nikola@example.test'), mail('e', 'Shop News', 'newsletter@shop.example.test'), mail('f', 'Sam', 'sam@example.test', true), mail('g', 'Filip Example', 'filip@example.test')])
  assert.deepEqual(addressesFor(vault, 'Nika', ['sam@example.test']).map(found => found.address), ['nika@example.test', 'nika.work@example.test'])
  // Another case of the same name still finds her; a longer name that only starts alike does not.
  assert.deepEqual(addressesFor(vault, 'Nike').map(found => found.address), ['nika@example.test', 'nika.work@example.test'])
  assert.deepEqual(addressesFor(vault, 'Filipa').map(found => found.address), ['filip@example.test'])
  assert.deepEqual(addressesFor(vault, 'Shop'), [])
  assert.deepEqual(addressesFor(vault, 'Sam', ['sam@example.test']), [])
  const withHer = await mailQuery(vault, ask('nika contract'), { fill: form({ people: 'nika', about: 'contract' }), first: 1 })
  assert.deepEqual(withHer, { words: ['contract'], people: ['nika'], emails: ['nika@example.test', 'nika.work@example.test'] })
  // "From" keeps name and addresses in one list: any of them, not all of them.
  const fromHer = await mailQuery(vault, ask('od Nike prošli tjedan'), { fill: form({ people: 'Nike', sent_by_them: 'yes', when: 'prošli tjedan' }), first: 1 })
  assert.deepEqual(fromHer, { senders: ['Nike', 'nika@example.test', 'Nika', 'nika.work@example.test'], after: '2026-11-02', before: '2026-11-09' })
  // Already read by the rules: Kier only adds what it knows.
  assert.deepEqual(await mailQuery(vault, ask('from nika'), { fill: form({ people: 'nika', sent_by_them: 'yes' }), first: 1 }), { senders: ['nika', 'nika@example.test', 'nika.work@example.test'] })
  assert.deepEqual(await mailQuery(vault, ask('with nika'), { fill: form({ people: 'nika' }), first: 1 }), { people: ['nika'], emails: ['nika@example.test', 'nika.work@example.test'] })
})

function send(path, { method = 'POST', input, signed = true, encrypted = true } = {}) {
  const plain = input === undefined ? Buffer.alloc(0) : Buffer.from(JSON.stringify(input))
  const wire = signed && encrypted && plain.length ? sealBody(secret, plain) : plain
  const proof = signed ? signedHeaders(secret, method, path, wire) : {}
  return new Promise((resolve, reject) => {
    const req = request({ hostname: '127.0.0.1', port, path, method, headers: { 'content-type': 'application/json', ...proof } }, res => {
      const chunks = []
      res.on('data', chunk => chunks.push(chunk))
      res.on('end', () => {
        const body = Buffer.concat(chunks)
        if (signed && res.statusCode !== 401) assert.equal(res.headers['x-kier-response'], responseMAC(secret, proof['x-kier-nonce'], res.statusCode, body))
        resolve({ status: res.statusCode, body: body.length ? JSON.parse(body.toString('utf8')) : null })
      })
    })
    req.on('error', reject)
    req.end(wire)
  })
}

test('the route needs the native proof and a sealed body, and declines with an empty signed 204', async () => {
  assert.equal((await send('/api/mail-query', { input: ask('priya contract'), signed: false })).status, 401)
  assert.equal((await send('/api/mail-query', { input: ask('priya contract'), encrypted: false })).status, 400)
  assert.equal((await send('/api/mail-query', { method: 'GET' })).status, 400)
  assert.equal((await send('/api/mail-query', { input: { q: 'priya contract' } })).status, 400)
  assert.equal((await send('/api/mail-query', { input: ask('x'.repeat(301)) })).status, 413)
  // No model here, so there is no form to read: Kier declines and Kier Mail keeps its own reading.
  assert.deepEqual(await send('/api/mail-query', { input: ask('priya contract') }), { status: 204, body: null })
})
