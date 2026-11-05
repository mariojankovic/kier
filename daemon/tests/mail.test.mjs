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
const { forget } = await import('../lib/privacy.mjs')
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
  assert.equal(rows[0].from_me, 1)
  assert.equal(rows[1].from_me, 1)
  assert.equal(rows[2].from_me, 0)
  assert.equal(rows[2].thread, 'Sketch')
  assert.equal(JSON.parse(rows[2].meta).conversationPk, 20)
  f.sparkMessage({ from: 'Sam <jonas@example.test>', subject: 'Claim' })
  collect(f.db, { stores: f.stores })
  assert.equal(f.db.prepare("select from_me from items where thread = 'Claim'").get().from_me, 0)
})

test('Message-ID deduplicates across both clients and remains stable after replay', t => {
  const f = fixture(t)
  f.appleMessage({ id: 'shared@example.test' }); f.sparkMessage({ id: '<shared@example.test>' })
  assert.equal(collect(f.db, { stores: f.stores }), 1)
  f.db.exec('delete from cursors')
  assert.equal(collect(f.db, { stores: f.stores }), 0)
  assert.equal(f.db.prepare('select count(*) n from items').get().n, 1)
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

test('sent mail resolves a cross-source owner task through the existing evidence path', async t => {
  const f = fixture(t)
  const reminder = createReminder(f.db, { title: 'Send Priya the contract', due: today(), when: '' }, at - 3600)
  f.sparkMessage({ sent: true, subject: 'Contract', text: 'Priya, I sent the contract you requested.' })
  collect(f.db, { stores: f.stores })
  const card = tasks(f.db).find(r => r.id === reminder.id)
  const lines = evidence(f.db, card)
  assert.equal(lines.length, 1)
  assert.equal(lines[0].owner, true)
  assert.match(lines[0].line, /email to Priya/)
  assert.equal(evidence(f.db, card, authorization(['kier'], [])).length, 0)
  const original = globalThis.fetch
  globalThis.fetch = async url => new Response(String(url).endsWith('/api/version') ? '{}' : JSON.stringify({ message: { content: JSON.stringify({ done: true, line: 1 }) } }))
  t.after(() => { globalThis.fetch = original })
  await resolvePending(f.db, 4, { now: true })
  assert.equal(tasks(f.db).find(r => r.id === reminder.id).state, 'handled')
  assert.equal(tasks(f.db).find(r => r.id === reminder.id).completion_origin, 'owner-message')
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


test('Apple Message-ID lookup deduplicates a subject-only copy and keeps sent evidence', t => {
  const f = fixture(t)
  f.appleMessage({ id: '42', body: false })
  f.apple.exec("create table message_ids (message_id text); insert into message_ids(rowid,message_id) values (42,'linked@example.test')")
  f.sparkMessage({ id: 'linked@example.test', subject: 'Contract', text: 'I sent Nika the contract.', sent: true })
  assert.equal(collect(f.db, { stores: f.stores }), 1)
  const rows = f.db.prepare('select * from items').all()
  assert.equal(rows.length, 1)
  assert.equal(rows[0].from_me, 1)
  assert.equal(rows[0].sender, 'Sam')
  assert.equal(JSON.parse(rows[0].meta).to[0].name, 'Priya')
  assert.match(rows[0].text, /I sent Nika the contract/)
})
