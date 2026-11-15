import { test } from 'node:test'
import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import { mailBanner, mailCopy, reconcileMailCopies } from '../lib/mail-copies.mjs'

// One mail as the mailbox holds it, and the banner the mail app showed for it.
const mail = { id: 'mail', source: 'mail', thread: 'Roof repair invoice', sender: 'Borna Vuk', from_me: 0, ts: 1000,
  text: 'Roof repair invoice\nPlease pay the attached invoice by Friday.',
  meta: JSON.stringify({ client: 'spark', subject: 'Roof repair invoice', body: 'Please pay the attached invoice by Friday.', from: [{ name: 'Borna Vuk', email: 'borna@example.test' }] }) }
const banner = { id: 'banner', source: 'notifications', thread: 'Spark Mail', sender: 'Borna Vuk', from_me: 0, ts: 1020,
  text: 'Borna Vuk (Roof repair invoice): Please pay the attached invoice by Friday.', meta: JSON.stringify({ app: 'com.readdle.sparkdesktop-setapp' }) }

function fixture(t, rows = [mail, banner]) {
  const db = new DatabaseSync(':memory:'); t.after(() => db.close())
  db.exec(`create table items(id text primary key, source text, thread text, sender text, from_me int, ts int, text text, meta text);
    create table tags(item_id text primary key, is_task int, model text, confirmed int);
    create table task_state(item_id text primary key, status text, changed_at int, reason text, url text, completion_origin text)`)
  for (const r of rows) db.prepare('insert into items values (?, ?, ?, ?, ?, ?, ?, ?)').run(r.id, r.source, r.thread, r.sender, r.from_me, r.ts, r.text, r.meta)
  return db
}

test('a mail app\'s banner is the same mail as the one in the mailbox', (t) => {
  const db = fixture(t)
  assert.equal(mailCopy(db, banner).id, 'mail')
  assert.equal(mailCopy(db, mail), null)
})

test('every mail app Kier reads is recognised, and no other app is', () => {
  for (const app of ['com.apple.mail', 'com.readdle.smartemail-macos', 'com.readdle.smartemail-macos-setapp', 'com.readdle.sparkdesktop', 'com.readdle.sparkdesktop-setapp', 'com.kier.mail', 'COM.APPLE.MAIL']) {
    assert.equal(mailBanner({ ...banner, meta: JSON.stringify({ app }) }), true, app)
  }
  assert.equal(mailBanner({ ...banner, thread: 'Kier Mail', meta: JSON.stringify({ app: 'com.example.earlier' }) }), true)
  for (const app of ['com.tinyspeck.slackmacgap', 'com.example.mailbox', '']) assert.equal(mailBanner({ ...banner, thread: 'Slack', meta: JSON.stringify({ app }) }), false, app)
  assert.equal(mailBanner({ ...mail }), false)
})

test('Kier Mail writes the subject into the banner\'s body, and is matched the same', (t) => {
  const own = { ...banner, thread: 'Kier Mail', text: 'Borna Vuk: Roof repair invoice\nPlease pay the attached invoice by Friday.', meta: JSON.stringify({ app: 'com.kier.mail' }) }
  const db = fixture(t, [mail, own])
  assert.equal(mailCopy(db, own).id, 'mail')
})

test('another subject, another sender, another day or another app stays a banner of its own', (t) => {
  const db = fixture(t)
  const others = [
    { ...banner, text: 'Borna Vuk (Roof repair invoice 2): Please pay the attached invoice by Friday.' },
    { ...banner, text: 'Borna Vuk (Gutter repair): Please pay the attached invoice by Friday.' },
    { ...banner, sender: 'Lucija Berg', text: 'Lucija Berg (Roof repair invoice): Here is the other invoice we spoke about.' },
    { ...banner, ts: 1000 + 5 * 86400 },
    { ...banner, ts: 1000 - 3600 },
    { ...banner, thread: 'Slack', meta: JSON.stringify({ app: 'com.tinyspeck.slackmacgap' }) },
    { ...banner, text: 'Borna Vuk: New message' },
  ]
  for (const item of others) assert.equal(mailCopy(db, item), null, item.text)
})

test('a sender the app names differently is still matched by the mail\'s own opening words', (t) => {
  const db = fixture(t)
  const renamed = { ...banner, sender: 'Roofer', text: 'Roofer (Roof repair invoice): Please pay the attached invoice by Friday.' }
  assert.equal(mailCopy(db, renamed).id, 'mail')
  assert.equal(mailCopy(db, { ...renamed, text: 'Roofer (Roof repair invoice): Thanks, got it.' }), null)
})

test('of two mails with one subject the banner belongs to the nearest', (t) => {
  const reply = { ...mail, id: 'reply', ts: 9000, text: 'Roof repair invoice\nA reminder.', meta: JSON.stringify({ client: 'spark', subject: 'Roof repair invoice', body: 'A reminder.', from: [{ name: 'Borna Vuk', email: 'borna@example.test' }] }) }
  const db = fixture(t, [mail, reply, banner])
  assert.equal(mailCopy(db, banner).id, 'mail')
  assert.equal(mailCopy(db, { ...banner, ts: 9010 }).id, 'reply')
})

test('a banner that became a task is folded into its mail, and what was decided on it is kept', (t) => {
  const db = fixture(t)
  db.exec("insert into tags(item_id, is_task, model) values ('banner', 1, 'model'), ('mail', 1, 'model'); insert into task_state values ('banner', 'looks_done', 1100, 'Looks done: you said \"paid\"', null, null)")
  assert.equal(reconcileMailCopies(db, 2000), 1)
  assert.equal(db.prepare("select is_task from tags where item_id = 'mail'").get().is_task, 1)
  assert.deepEqual({ ...db.prepare("select is_task, model from tags where item_id = 'banner'").get() }, { is_task: 0, model: 'mail-copy' })
  assert.equal(db.prepare("select status from task_state where item_id = 'mail'").get().status, 'looks_done')
  assert.equal(reconcileMailCopies(db, 2000), 0)
})

test('the mail\'s own state wins, and a banner waits until its mail is a task too', (t) => {
  const db = fixture(t)
  db.exec("insert into tags(item_id, is_task, model) values ('banner', 1, 'model'); insert into task_state values ('banner', 'done', 1100, 'marked in the timeline', null, 'owner'), ('mail', 'dismissed', 1200, 'marked in the timeline', null, 'owner')")
  assert.equal(reconcileMailCopies(db, 2000), 0)
  db.exec("insert into tags(item_id, is_task, model) values ('mail', 0, 'model')")
  assert.equal(reconcileMailCopies(db, 2000), 0)
  assert.equal(db.prepare("select is_task from tags where item_id = 'banner'").get().is_task, 1)
  db.exec("update tags set is_task = 1 where item_id = 'mail'")
  assert.equal(reconcileMailCopies(db, 2000), 1)
  assert.equal(db.prepare("select status from task_state where item_id = 'mail'").get().status, 'dismissed')
})

test('a banner with no mail behind it stays a task', (t) => {
  const db = fixture(t, [banner])
  db.exec("insert into tags(item_id, is_task, model) values ('banner', 1, 'model')")
  assert.equal(reconcileMailCopies(db, 2000), 0)
  assert.equal(db.prepare("select is_task from tags where item_id = 'banner'").get().is_task, 1)
})

test('the tagger never reads a banner whose mail it already has', async (t) => {
  const { mkdtempSync, rmSync } = await import('node:fs')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  process.env.KIER_DATA_DIR = mkdtempSync(join(tmpdir(), 'kier-mail-copies-'))
  t.after(() => rmSync(process.env.KIER_DATA_DIR, { recursive: true, force: true }))
  const { open, addItems, now } = await import('../lib/db.mjs')
  const { firstPrompts, pending } = await import('../lib/tagger.mjs')
  const db = open(':memory:'); t.after(() => db.close())
  const at = now() - 900
  const body = 'Please pay the attached invoice by Friday.'
  addItems(db, [
    { id: 'mail:roof', source: 'mail', thread: 'Roof repair invoice', sender: 'Borna Vuk', fromMe: false, ts: at, text: `Roof repair invoice\n${body}`,
      meta: { client: 'spark', ownerSent: false, messageId: 'roof@example.test', subject: 'Roof repair invoice', body, bodyKind: 'preview', from: [{ name: 'Borna Vuk', email: 'borna@example.test' }], to: [{ name: 'Sam', email: 'sam@example.test' }] } },
    { id: 'notifications:roof', source: 'notifications', thread: 'Spark Mail', sender: 'Borna Vuk', fromMe: false, ts: at + 20, text: `Borna Vuk (Roof repair invoice): ${body}`, meta: { app: 'com.readdle.sparkdesktop-setapp' } },
    { id: 'notifications:bill', source: 'notifications', thread: 'Spark Mail', sender: 'City Water', fromMe: false, ts: at + 40, text: 'City Water (Your bill is ready): Please pay your water bill by the end of the month.', meta: { app: 'com.readdle.sparkdesktop-setapp' } },
  ])
  const asked = firstPrompts(db, pending(db, 20)).map((p) => p.id)
  // The mail is read, the banner of that mail is not, and a banner whose mail Kier does not hold still is.
  assert.equal(asked.includes('notifications:roof'), false)
  assert.equal(asked.includes('notifications:bill'), true)
  assert.equal(asked.some((id) => id.startsWith('mail:')), true)
})
