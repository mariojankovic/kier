import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { DatabaseSync } from 'node:sqlite'
const dir = mkdtempSync(join(tmpdir(), 'kier-mail-fixtures-'))
process.env.KIER_DATA_DIR = join(dir, 'vault')
mkdirSync(process.env.KIER_DATA_DIR)
writeFileSync(join(process.env.KIER_DATA_DIR, 'config.json'), JSON.stringify({ me: 'Sam', fullName: 'Sam', languages: ['English', 'Croatian'], online: false, workRoots: [], backfillDays: 30 }))
after(() => rmSync(dir, { recursive: true, force: true }))
const { collect, mailStores, mailSetup, plainMail, addresses, mailDate } = await import('../collectors/mail.mjs')
const { APPLE_EPOCH } = await import('../collectors/util.mjs')
const { open, now, addItems } = await import('../lib/db.mjs')
const { setSource } = await import('../lib/settings.mjs')
const { authorization, readScope } = await import('../lib/authorization.mjs')
const { forget, forgetKey } = await import('../lib/privacy.mjs')
const { createReminder } = await import('../lib/create-reminder.mjs')
const { tasks, today } = await import('../lib/tasks.mjs')
const { evidence, resolvePending } = await import('../lib/resolve.mjs')
const { tagPending } = await import('../lib/tagger.mjs')
const { modelFixture } = await import('./model-fixture.mjs')
await modelFixture({ decision: false })
const at = now()

function fixture(t) {
  const home = mkdtempSync(join(dir, 'home-'))
  const root = join(home, 'Library/Mail/V12')
  const applePath = join(root, 'MailData/Envelope Index')
  const sparkPath = join(home, 'Library/Application Support/Spark Mail/core-data/messages.sqlite')
  mkdirSync(join(root, 'MailData'), { recursive: true }); mkdirSync(join(sparkPath, '..'), { recursive: true })
  const apple = new DatabaseSync(applePath)
  apple.exec(`create table subjects (subject text); create table addresses (address text, comment text);
    create table mailboxes (url text, role text); create table recipients (message_id integer, address_id integer, type integer);
    create index recipient_message on recipients(message_id);
    create table messages (subject integer, sender integer, mailbox integer, date_sent integer, date_received integer, message_id text);
    insert into addresses values ('nika@example.test', 'Nika'), ('sam@example.test', 'Sam'), ('priya@example.test', 'Priya');`)
  const inbox = join(root, 'account/INBOX.mbox'), sent = join(root, 'account/Sent.mbox')
  for (const path of [inbox, sent]) mkdirSync(join(path, 'Data/0/Messages'), { recursive: true })
  for (const [path, role] of [[inbox, 'inbox'], [sent, 'sent']]) apple.prepare('insert into mailboxes values (?, ?)').run(pathToFileURL(path).href, role)
  const spark = new DatabaseSync(sparkPath)
  spark.exec(`create table messages (subject text, shortBody text, messageFrom text, messageTo text, messageCc text, inSent integer,
    receivedDate real, creationDate real, conversationPk integer, messageId text, mailbox text, listUnsubscribe text)`)
  const db = open(':memory:')
  t.after(() => { db.close(); apple.close(); spark.close() })
  let appleSeq = 0, sparkSeq = 0
  function appleMessage({ subject = 'Contract', text = 'Please send the contract.', sent: outgoing = false, date = at - 60, id, headers = '', mime, body = true } = {}) {
    const pk = ++appleSeq
    const mid = id || `apple-${pk}@example.test`
    apple.prepare('insert into subjects(rowid,subject) values (?,?)').run(pk, subject)
    apple.prepare('insert into messages(rowid,subject,sender,mailbox,date_sent,date_received,message_id) values (?,?,?,?,?,?,?)')
      .run(pk, pk, outgoing ? 2 : 1, outgoing ? 2 : 1, date, date, mid)
    apple.prepare('insert into recipients values (?,?,0)').run(pk, outgoing ? 1 : 2)
    apple.prepare('insert into recipients values (?,3,1)').run(pk)
    if (body) {
      const raw = `Message-ID: <${mid}>\r\n${headers}${mime || `Content-Type: text/plain; charset=utf-8\r\n\r\n${text}`}`
      writeFileSync(join(outgoing ? sent : inbox, `Data/0/Messages/${pk}.emlx`), `${Buffer.byteLength(raw)}\n${raw}\n<plist>private metadata</plist>`)
    }
    return pk
  }
  function sparkMessage({ subject = 'Sketch', text = 'Please send the sketch.', sent = false, date = at - 30, id, from, to, list = '' } = {}) {
    const pk = ++sparkSeq
    spark.prepare('insert into messages(rowid,subject,shortBody,messageFrom,messageTo,messageCc,inSent,receivedDate,creationDate,conversationPk,messageId,mailbox,listUnsubscribe) values (?,?,?,?,?,?,?,?,?,?,?,?,?)')
      .run(pk, subject, text, from || JSON.stringify({ name: sent ? 'Sam' : 'Priya', email: sent ? 'sam@example.test' : 'priya@example.test' }),
        to || JSON.stringify([{ name: sent ? 'Priya' : 'Sam', email: sent ? 'priya@example.test' : 'sam@example.test' }]), '[]', Number(sent), date, date, 20, id || `spark-${pk}@example.test`, sent ? 'Sent' : 'Inbox', list)
    return pk
  }
  return { home, root, apple, spark, applePath, sparkPath, db, appleMessage, sparkMessage, stores: mailStores(home), inbox }
}

test('detects both local clients and replaces the mail setup placeholder', t => {
  const f = fixture(t)
  assert.deepEqual(f.stores.map(s => s.client), ['apple-mail', 'spark'])
  assert.match(mailSetup(f.stores, false).detail, /Apple Mail and Spark/)
  assert.match(mailSetup([], false).detail, /No local/)
  assert.match(mailSetup(f.stores, true).detail, /off/)
})

test('Apple Mail collects sender, recipients, subject, Sent role and capped plain body without changing source', t => {
  const f = fixture(t)
  f.appleMessage({ subject: 'Re: Fwd: Contract', text: 'Please send the contract.\n' + 'x'.repeat(3000) })
  f.appleMessage({ sent: true, text: 'I sent Nika the contract.' })
  const original = readFileSync(f.applePath)
  assert.equal(collect(f.db, { stores: f.stores }), 2)
  const rows = f.db.prepare('select * from items order by rowid').all()
  assert.equal(rows[0].from_me, 1)
  assert.equal(rows[1].thread, 'Contract')
  assert.equal(rows[1].sender, 'Nika')
  assert.ok(rows[1].text.length <= 2020)
  assert.doesNotMatch(rows[1].text, /plist|private metadata/)
  const meta = JSON.parse(rows[1].meta)
  assert.equal(meta.client, 'apple-mail')
  assert.equal(meta.to[0].email, 'sam@example.test')
  assert.equal(meta.cc[0].name, 'Priya')
  assert.equal(meta.messageId, 'apple-1@example.test')
  assert.deepEqual(readFileSync(f.applePath), original)
  assert.deepEqual(readdirSync(join(process.env.KIER_DATA_DIR, 'tmp')), [])
})

test('Spark collects JSON or RFC address lists and learns owner addresses only from Sent', t => {
  const f = fixture(t)
  f.sparkMessage({ subject: 'Re: Sketch', from: 'Priya <priya@example.test>' })
  f.sparkMessage({ sent: true })
  f.sparkMessage({ subject: 'Archive', from: 'Sam <sam@example.test>', to: 'Nika <nika@example.test>' })
  assert.equal(collect(f.db, { stores: f.stores }), 3)
  const rows = f.db.prepare('select * from items order by rowid').all()
  assert.equal(rows[0].from_me, 0)
  assert.equal(rows[1].from_me, 1)
  assert.equal(rows[2].from_me, 0)
  assert.equal(rows[2].thread, 'Sketch')
  assert.equal(JSON.parse(rows[2].meta).conversationPk, 20)
  f.sparkMessage({ from: 'Sam <jonas@example.test>', subject: 'Claim' })
  collect(f.db, { stores: f.stores })
  assert.equal(f.db.prepare("select from_me from items where thread = 'Claim'").get().from_me, 0)
})

test('Message-ID preserves independent client copies and remains stable after replay', t => {
  const f = fixture(t)
  f.appleMessage({ id: 'shared@example.test' }); f.sparkMessage({ id: '<shared@example.test>' })
  assert.equal(collect(f.db, { stores: f.stores }), 2)
  f.db.exec('delete from cursors')
  assert.equal(collect(f.db, { stores: f.stores }), 0)
  assert.equal(f.db.prepare('select count(*) n from items').get().n, 2)
})

test('bounded newest-first backfill and incoming pages never skip an interval', t => {
  const f = fixture(t)
  for (let i = 1; i <= 7; i++) f.sparkMessage({ subject: `Sketch ${i}` })
  f.sparkMessage({ subject: 'Too old', date: at - 60 * 86400 })
  assert.equal(collect(f.db, { stores: f.stores, limit: 2 }), 2)
  assert.deepEqual(f.db.prepare('select thread from items order by rowid').all().map(r => r.thread), ['Sketch 7', 'Sketch 6'])
  for (let i = 8; i <= 12; i++) f.sparkMessage({ subject: `Sketch ${i}` })
  collect(f.db, { stores: f.stores, limit: 2 })
  f.sparkMessage({ subject: 'Sketch 13' })
  for (let i = 0; i < 8; i++) collect(f.db, { stores: f.stores, limit: 2 })
  assert.equal(f.db.prepare('select count(*) n from items').get().n, 13)
  assert.equal(collect(f.db, { stores: f.stores, limit: 2 }), 0)
})

test('list mail, noreply and receipts stay out, while owner replies are retained', t => {
  const f = fixture(t)
  f.appleMessage({ headers: 'List-Unsubscribe: <mailto:list@example.test>\r\n' })
  f.sparkMessage({ from: 'No Reply <noreply@example.test>' })
  f.sparkMessage({ subject: 'Your receipt' })
  f.sparkMessage({ list: 'mailto:list@example.test' })
  f.sparkMessage({ sent: true, subject: 'Re: Your receipt', text: 'Please correct the receipt.' })
  assert.equal(collect(f.db, { stores: f.stores }), 1)
  assert.equal(f.db.prepare('select from_me from items').get().from_me, 1)
})

test('MIME extraction ignores HTML, attachments, quoted history and trailing metadata', () => {
  const raw = 'Content-Type: multipart/mixed; boundary="fixture"\r\n\r\n--fixture\r\nContent-Type: text/plain\r\nContent-Disposition: attachment; filename="notes.txt"\r\n\r\nATTACHMENT\r\n--fixture\r\nContent-Type: text/html\r\n\r\n<p>HTML</p>\r\n--fixture\r\nContent-Type: text/plain; charset=utf-8\r\nContent-Transfer-Encoding: quoted-printable\r\n\r\nBok Tea, ugovor je poslan.\r\nOn Friday Nika wrote:\r\nPlease send it.\r\n--fixture--'
  assert.equal(plainMail(raw).snippet, 'Bok Tea, ugovor je poslan.')
  assert.equal(plainMail('Content-Type: text/html\n\n<b>HTML</b>').snippet, '')
  assert.equal(plainMail('Content-Type: text/plain\nContent-Transfer-Encoding: base64\n\nSGVsbG8gVGVh').snippet, 'Hello Tea')
})

test('mail dates support Unix, Apple epoch, milliseconds and ISO', () => {
  assert.equal(mailDate(at), at)
  assert.equal(mailDate(at - APPLE_EPOCH), at)
  assert.equal(mailDate(at * 1000), at)
  assert.equal(mailDate(new Date(at * 1000).toISOString()), at)
  assert.equal(addresses('[{"name":"Tea","address":"tea@example.test"}]')[0].name, 'Tea')
})

test('redaction and Forget apply before content enters cards and evidence', t => {
  const f = fixture(t)
  const token = ['sk', 'synthetic_fixture_only_1234567890'].join('-')
  f.sparkMessage({ subject: `Sketch ${token}`, text: token })
  collect(f.db, { stores: f.stores })
  const row = f.db.prepare('select * from items').get()
  assert.ok(!JSON.stringify(row).includes(token))
  assert.match(row.text, /\[SECRET\]/)
  forget(f.db, { id: row.id }); f.db.exec('delete from cursors')
  assert.equal(collect(f.db, { stores: f.stores }), 0)
  f.sparkMessage({ subject: 'Archive' }); collect(f.db, { stores: f.stores })
  forget(f.db, { source: 'mail', thread: 'Archive' })
  f.sparkMessage({ subject: 'Re: Archive' })
  assert.equal(collect(f.db, { stores: f.stores }), 0)
})

test('mail switch blocks collectors and every capture origin, with scoped reads hiding old rows', t => {
  const f = fixture(t)
  f.sparkMessage(); collect(f.db, { stores: f.stores })
  const copies = ['com.apple.mail', 'com.readdle.smartemail-MacOS', 'com.readdle.SparkDesktop'].map((app, i) => ({ id: `copy-${i}`, source: 'notifications', thread: 'Mail', ts: at, text: 'Sketch', meta: { app } }))
  addItems(f.db, copies)
  setSource('mail', false); t.after(() => setSource('mail', true))
  assert.equal(collect(f.db, { stores: [{ path: '/does-not-exist', client: 'spark' }] }), 0)
  assert.equal(addItems(f.db, copies.map(i => ({ ...i, id: `${i.id}-new` }))), 0)
  const scoped = readScope(f.db, authorization(null, ['mail']))
  assert.equal(scoped.prepare('select count(*) n from items').get().n, 0)
  assert.equal(readScope(f.db, authorization(['whatsapp'], [])).prepare('select count(*) n from items').get().n, 0)
})

test('sent mail suggests completion of a cross-source owner reminder', async t => {
  const f = fixture(t)
  const reminder = createReminder(f.db, { title: 'Send Nika the contract', due: today(), when: '' }, at - 3600)
  f.appleMessage({ sent: true, subject: 'Contract', text: 'Nika, I sent the contract you requested.' })
  collect(f.db, { stores: f.stores })
  const card = tasks(f.db).find(r => r.id === reminder.id)
  const lines = evidence(f.db, card)
  assert.equal(lines.length, 1)
  assert.equal(lines[0].owner, true)
  assert.match(lines[0].line, /email to Nika/)
  assert.equal(evidence(f.db, card, authorization(['kier'], [])).length, 0)
  const original = globalThis.fetch
  globalThis.fetch = async url => new Response(String(url).endsWith('/api/version') ? '{}' : JSON.stringify({ message: { content: JSON.stringify({ done: true, line: 1 }) } }))
  t.after(() => { globalThis.fetch = original })
  await resolvePending(f.db, 4, { now: true })
  assert.equal(tasks(f.db).find(r => r.id === reminder.id).state, 'looks_done')
  assert.equal(tasks(f.db).find(r => r.id === reminder.id).completion_origin, null)
})

test('incoming personal mail goes through the existing task tagger', async t => {
  const f = fixture(t)
  f.sparkMessage({ subject: 'Contract', text: 'Sam, please send the contract tomorrow.' })
  collect(f.db, { stores: f.stores })
  const original = globalThis.fetch
  globalThis.fetch = async url => new Response(String(url).endsWith('/api/version') ? '{}' : JSON.stringify({ message: { content: JSON.stringify({ is_task: true, summary: 'Send Priya the contract', card: 'todo', when: 'tomorrow', due: '', urgency: 1 }) } }))
  t.after(() => { globalThis.fetch = original })
  await tagPending(f.db, 2)
  assert.equal(tasks(f.db)[0]?.source, 'mail')
})

test('a WAL snapshot sees committed mail without modifying the live database', t => {
  const f = fixture(t)
  f.spark.exec('pragma journal_mode=wal')
  f.sparkMessage({ subject: 'WAL sketch' })
  const before = readFileSync(f.sparkPath)
  assert.equal(collect(f.db, { stores: f.stores }), 1)
  assert.deepEqual(readFileSync(f.sparkPath), before)
})

test('IMAP mailbox URLs find only bounded local mailbox files', t => {
  const f = fixture(t)
  f.appleMessage({ text: 'Local snippet' })
  f.apple.prepare('update mailboxes set url = ? where rowid = 1').run('imap://sam@example.test/INBOX')
  collect(f.db, { stores: f.stores })
  assert.match(f.db.prepare('select text from items').get().text, /Local snippet/)
})


test('Apple Message-ID lookup separates a received subject-only copy from Sent evidence', t => {
  const f = fixture(t)
  f.appleMessage({ id: '42', body: false })
  f.apple.exec("create table message_ids (message_id text); insert into message_ids(rowid,message_id) values (42,'linked@example.test')")
  f.sparkMessage({ id: 'linked@example.test', subject: 'Contract', text: 'I sent Nika the contract.', sent: true })
  assert.equal(collect(f.db, { stores: f.stores }), 2)
  const rows = f.db.prepare('select * from items').all()
  assert.equal(rows.length, 2)
  const sent = rows.find(r => r.from_me === 1), received = rows.find(r => r.from_me === 0)
  assert.equal(sent.sender, 'Sam')
  assert.equal(JSON.parse(sent.meta).to[0].name, 'Priya')
  assert.match(sent.text, /I sent Nika the contract/)
  assert.equal(received.sender, 'Nika')
})

for (const sentClient of ['apple-mail', 'spark']) test(`forged local Message-ID cannot enrich ${sentClient} Sent copy`, t => {
  const f = fixture(t), id = 'collision@example.test'
  if (sentClient === 'apple-mail') {
    f.appleMessage({ id, sent: true, body: false, date: at - 120 })
    f.sparkMessage({ id, text: 'FORGED_RECEIVED_TEXT', date: at - 30 })
  } else {
    f.sparkMessage({ id, sent: true, text: '', date: at - 120 })
    f.appleMessage({ id, text: 'FORGED_RECEIVED_TEXT', date: at - 30 })
  }
  assert.equal(collect(f.db, { stores: f.stores }), 2)
  const sent = f.db.prepare('select * from items where from_me = 1').get()
  assert.equal(sent.sender, 'Sam'); assert.equal(sent.ts, at - 120)
  assert.doesNotMatch(sent.text, /FORGED/)
  assert.match(f.db.prepare('select text from items where from_me = 0').get().text, /FORGED/)
})

test('legacy merged mail is discarded and collectors replay without changing forgotten keys', t => {
  const path = join(dir, 'legacy.db'), db = open(path)
  db.prepare("delete from migrations where id = 'mail-copy-provenance-v2'").run()
  db.prepare("insert into items(id,source,from_me,ts,text) values ('mail:legacy','mail',1,?,'unverifiable')").run(at)
  db.prepare("insert into cursors values ('mail:fixture','old'), ('gmail:fixture','old')").run()
  db.prepare("insert into forgotten values ('fixture-key','item',?)").run(at)
  db.close()
  const migrated = open(path); t.after(() => migrated.close())
  assert.equal(migrated.prepare('select count(*) n from items').get().n, 0)
  assert.equal(migrated.prepare('select count(*) n from cursors').get().n, 0)
  assert.equal(migrated.prepare('select key from forgotten').get().key, 'fixture-key')
})


for (const client of ['apple-mail', 'spark']) test(`${client} spoofed owner From with reused Message-ID cannot become owner evidence`, t => {
  const f = fixture(t), id = 'spoof@example.test'
  f.appleMessage({ id, sent: true, body: false, date: at - 120 })
  f.sparkMessage({ id, sent: true, text: '', date: at - 120 })
  if (client === 'apple-mail') {
    const pk = f.appleMessage({ id, text: 'FORGED_OWNER_TEXT' })
    f.apple.prepare('update messages set sender = 2 where rowid = ?').run(pk)
  } else f.sparkMessage({ id, from: 'Sam <sam@example.test>', to: 'Nika <nika@example.test>', text: 'FORGED_OWNER_TEXT' })
  collect(f.db, { stores: f.stores })
  const rows = f.db.prepare('select * from items').all()
  assert.equal(rows.length, 3)
  assert.equal(rows.filter(r => r.from_me).length, 2)
  for (const row of rows.filter(r => r.from_me)) assert.doesNotMatch(row.text, /FORGED/)
  assert.match(rows.find(r => !r.from_me).text, /FORGED_OWNER_TEXT/)
})

test('a received copy never replaces another correspondent or account copy', t => {
  const f = fixture(t), id = 'received-collision@example.test'
  f.appleMessage({ id, body: false, date: at - 120 })
  f.sparkMessage({ id, subject: 'Different thread', text: 'FORGED_CORRESPONDENT_TEXT' })
  collect(f.db, { stores: f.stores })
  const rows = f.db.prepare('select * from items').all()
  assert.equal(rows.length, 2)
  const nika = rows.find(r => r.sender === 'Nika')
  assert.equal(nika.text, 'Contract'); assert.equal(nika.thread, 'Contract'); assert.equal(nika.ts, at - 120)
  assert.notEqual(JSON.parse(nika.meta).account, JSON.parse(rows.find(r => r.sender === 'Priya').meta).account)
})

test('Apple Mail ids stored as 64-bit integers are read as text instead of failing the store', t => {
  const f = fixture(t)
  const pk = f.appleMessage({ subject: 'Library book', text: 'Can you return the library book?' })
  // Real Envelope Index files keep some message ids as integers beyond Number.MAX_SAFE_INTEGER.
  f.apple.exec(`alter table messages rename to old_messages;
    create table messages (subject integer, sender integer, mailbox integer, date_sent integer, date_received integer, message_id integer);
    insert into messages(rowid, subject, sender, mailbox, date_sent, date_received, message_id)
      select rowid, subject, sender, mailbox, date_sent, date_received, 7002049013125224085 from old_messages where rowid = ${pk};
    drop table old_messages`)
  assert.equal(collect(f.db, { stores: f.stores }), 1)
})

for (const sent of [false, true]) for (const form of ['canonical', 'previous', 'current']) {
  test(`forgotten ${form} ${sent ? 'sent' : 'received'} copy stays forgotten after migration and full recollection`, t => {
    const f = fixture(t), path = join(f.home, 'migration.db')
    f.appleMessage({ id: 'forgotten@example.test', sent })
    f.appleMessage({ id: 'retained@example.test', subject: 'Sketch' })
    const old = open(path)
    collect(old, { stores: f.stores })
    const row = old.prepare("select * from items where text like 'Contract%'").get()
    const current = row.id, canonical = current.split(':copy:')[0]
    const historic = form === 'canonical' ? canonical : form === 'previous' ? `${canonical}:copy:${sent ? 'sent' : 'received'}` : current
    old.prepare('update items set id = ? where id = ?').run(historic, current)
    assert.equal(forget(old, { id: historic }), 1)
    old.prepare("delete from migrations where id = 'mail-copy-provenance-v2'").run()
    old.close()
    const migrated = open(path); t.after(() => migrated.close())
    assert.equal(collect(migrated, { stores: f.stores }), 1)
    assert.equal(migrated.prepare("select count(*) n from items where text like 'Contract%'").get().n, 0)
    assert.ok(migrated.prepare('select 1 from forgotten where key = ?').get(forgetKey('item', current)))
    migrated.exec('delete from cursors')
    assert.equal(collect(migrated, { stores: f.stores }), 0)
    assert.equal(migrated.prepare('select count(*) n from items').get().n, 1)
  })
}
test('migration forwards a retained legacy tombstone before clearing old mail rows', t => {
  const path = join(dir, 'forwarded-tombstone.db'), old = open(path)
  const row = { id: 'mail:fixture:copy:sent', source: 'mail', sender: 'Sam', fromMe: true, ts: at,
    text: 'Fixture', meta: { ownerSent: true, client: 'apple-mail', copyKey: 'fixture', account: 'fixture' } }
  old.prepare('insert into items(id,source,sender,from_me,ts,text,meta) values (?,?,?,?,?,?,?)')
    .run(row.id, row.source, row.sender, 1, row.ts, row.text, JSON.stringify(row.meta))
  old.prepare("insert into forgotten values (?, 'item', ?)").run(forgetKey('item', row.id), at)
  old.prepare("delete from migrations where id = 'mail-copy-provenance-v2'").run()
  old.close()
  const migrated = open(path); t.after(() => migrated.close())
  assert.equal(migrated.prepare('select count(*) n from forgotten').get().n, 2)
  assert.equal(addItems(migrated, [{ ...row, id: 'mail:fixture' }]), 0)
})

for (const wasSent of [true, false]) test(`a changed Sent classification cannot bypass the old ${wasSent ? 'sent' : 'received'} tombstone`, t => {
  const path = join(dir, `changed-direction-${wasSent}.db`), old = open(path)
  const base = `mail:changed-direction-${wasSent}`, historic = `${base}:copy:${wasSent ? 'sent' : 'received'}`
  old.prepare('insert into items(id,source,from_me,ts,text) values (?, ?, ?, ?, ?)')
    .run(historic, 'mail', Number(wasSent), at, 'Forgotten fixture')
  assert.equal(forget(old, { id: historic }), 1)
  old.prepare("delete from migrations where id = 'mail-copy-provenance-v2'").run()
  old.close()
  const migrated = open(path); t.after(() => migrated.close())
  const copy = { id: base, source: 'mail', fromMe: !wasSent, sender: 'Sam', ts: at,
    text: 'Forgotten fixture', meta: { ownerSent: !wasSent, client: 'apple-mail', copyKey: 'fixture', account: 'fixture' } }
  assert.equal(addItems(migrated, [copy]), 0)
  assert.equal(migrated.prepare('select count(*) n from forgotten').get().n, 3)
  assert.equal(addItems(migrated, [copy]), 0)
  assert.equal(migrated.prepare('select count(*) n from items').get().n, 0)
})

for (const client of ['apple-mail', 'spark']) for (const hasMessageID of [true, false]) {
  test(`${client}: forgotten mail survives a new store and full backfill (Message-ID: ${hasMessageID})`, t => {
    const original = fixture(t), reconnected = fixture(t)
    const method = client === 'spark' ? 'sparkMessage' : 'appleMessage'
    const options = { id: hasMessageID ? 'stable-local@example.test' : 'no-message-id', date: at - 60 }
    original[method](options)
    assert.equal(collect(original.db, { stores: original.stores }), 1)
    const row = original.db.prepare('select * from items').get()
    assert.equal(forget(original.db, { id: row.id }), 1)
    // A new row id, store path/account key, copy key and normalized Message-ID.
    reconnected[method]({ id: 'retained@example.test', subject: 'Retained sketch' })
    reconnected[method]({ ...options, id: hasMessageID ? 'STABLE-LOCAL@EXAMPLE.TEST' : options.id })
    assert.equal(collect(original.db, { stores: reconnected.stores }), 1)
    assert.equal(original.db.prepare('select count(*) n from items').get().n, 1)
    assert.match(original.db.prepare('select text from items').get().text, /Retained sketch/)
  })
}
test('stable forget identity does not suppress another conversation reusing Message-ID', t => {
  const f = fixture(t)
  f.sparkMessage({ id: 'reused@example.test' })
  collect(f.db, { stores: f.stores })
  forget(f.db, { id: f.db.prepare('select id from items').get().id })
  f.sparkMessage({ id: 'reused@example.test', from: JSON.stringify({ name: 'Jonas', email: 'jonas@example.test' }) })
  assert.equal(collect(f.db, { stores: f.stores }), 1)
})
test('forgetting a mail thread writes stable tombstones before deleting its rows', t => {
  const f = fixture(t), next = fixture(t)
  f.appleMessage({ id: 'thread-forgotten@example.test' })
  collect(f.db, { stores: f.stores })
  forget(f.db, { source: 'mail', thread: 'Contract' })
  next.appleMessage({ id: 'thread-forgotten@example.test', subject: 'Changed subject' })
  assert.equal(collect(f.db, { stores: next.stores }), 0)
})

test('a forgotten mail stays forgotten when an address is redacted, and every copy of it goes', async t => {
  const { forget } = await import('../lib/privacy.mjs')
  const db = open(':memory:'); t.after(() => db.close())
  const mail = (id, client, fromMe, sender) => ({ id, source: 'mail', thread: 'Library book', sender, fromMe, ts: at - 100, text: 'Library book\nThe book is due Friday.',
    meta: { client, ownerSent: fromMe, messageId: 'shared-77@example.test', subject: 'Library book', body: 'The book is due Friday.', bodyKind: 'plain',
      from: [{ name: 'Lucija', email: 'code1234@example.test' }], to: [{ name: 'Sam', email: 'sam@example.test' }] } })
  addItems(db, [mail('mail:a', 'gmail', false, 'Lucija'), mail('mail:b', 'spark', false, 'Lucija')])
  const before = db.prepare("select id from items where source = 'mail'").all().map(r => r.id)
  assert.equal(before.length >= 1, true)
  forget(db, { id: before[0] })
  assert.equal(db.prepare("select count(*) n from items where source = 'mail'").get().n, 0, 'every copy of the message is gone')
  addItems(db, [mail('mail:c', 'gmail', false, 'Lucija')])
  assert.equal(db.prepare("select count(*) n from items where source = 'mail'").get().n, 0, 'a reconnect does not bring it back')
})

test('a forgotten mail with a doubly redactable address stays forgotten after a reconnect', async t => {
  const { forget } = await import('../lib/privacy.mjs')
  const db = open(':memory:'); t.after(() => db.close())
  const mail = (id) => ({ id, source: 'mail', thread: 'Bike repair', sender: 'Borna', fromMe: false, ts: at - 100, text: 'Bike repair\nThe bike is ready.',
    meta: { client: 'gmail', providerMessageId: undefined, messageId: 'bike-9@example.test', subject: 'Bike repair', body: 'The bike is ready.', bodyKind: 'plain',
      from: [{ name: 'Borna', email: 'code1234-5678@example.test' }], to: [{ name: 'Sam', email: 'sam@example.test' }] } })
  addItems(db, [mail('mail:first')])
  forget(db, { id: db.prepare("select id from items where source = 'mail'").get().id })
  addItems(db, [mail('mail:after-reconnect')])
  assert.equal(db.prepare("select count(*) n from items where source = 'mail'").get().n, 0)
})

test('mail ids and the adult host filter are unchanged by redaction', t => {
  const db = open(':memory:'); t.after(() => db.close())
  addItems(db, [{ id: 'mail:adult', source: 'mail', thread: 'Offer', sender: 'Spam', fromMe: false, ts: at - 50, text: 'Offer', url: 'https://code1234.porn/',
    meta: { client: 'spark', messageId: 'adult-1@example.test', from: [{ email: 'offer@example.test' }], to: [] } }])
  assert.equal(db.prepare("select count(*) n from items where url like '%porn%'").get().n, 0)
})

test('Forget holds against the stored form: no-id mail, coded threads, and digit-only differences stay apart', async t => {
  const { forget } = await import('../lib/privacy.mjs')
  const db = open(':memory:'); t.after(() => db.close())
  const mail = (id, extra = {}) => ({ id, source: 'mail', thread: 'Locker code1234', sender: 'Tea', fromMe: false, ts: at - 90, text: 'Locker code1234\nThe locker is free.',
    meta: { client: 'spark', subject: 'Locker code1234', body: 'The locker is free.', bodyKind: 'preview', from: [{ name: 'Tea', email: 'tea@example.test' }], to: [{ email: 'sam@example.test' }], ...extra } })
  addItems(db, [mail('mail:nid-1')])
  forget(db, { id: db.prepare("select id from items where source = 'mail'").get().id })
  addItems(db, [mail('mail:nid-2', { copyKey: 'other-store' })])
  assert.equal(db.prepare("select count(*) n from items where source = 'mail'").get().n, 0, 'no-id mail with a code in its subject stays forgotten')

  addItems(db, [mail('mail:thread-1', { messageId: 'locker-a@example.test' })])
  const thread = db.prepare("select thread from items where source = 'mail'").get().thread
  forget(db, { source: 'mail', thread })
  addItems(db, [mail('mail:thread-2', { messageId: 'locker-b@example.test' })])
  assert.equal(db.prepare("select count(*) n from items where source = 'mail'").get().n, 0, 'a forgotten coded thread stays forgotten')

  const pair = (id, email) => ({ id, source: 'mail', thread: 'Rota', sender: 'Jonas', fromMe: false, ts: at - 80, text: 'Rota\nShifts next week.',
    meta: { client: 'spark', messageId: 'rota-1@example.test', subject: 'Rota', body: 'Shifts next week.', bodyKind: 'preview', from: [{ email }], to: [{ email: 'sam@example.test' }] } })
  addItems(db, [pair('mail:rota-a', 'jonas1@example.test'), pair('mail:rota-b', 'jonas2@example.test')])
  const rows = db.prepare("select id from items where source = 'mail' and thread = 'Rota'").all()
  assert.equal(rows.length, 2)
  forget(db, { id: rows[0].id })
  assert.equal(db.prepare("select count(*) n from items where source = 'mail' and thread = 'Rota'").get().n, 1, 'a different sender is not forgotten with it')
})
