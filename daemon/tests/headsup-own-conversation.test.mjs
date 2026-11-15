import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.KIER_DATA_DIR = mkdtempSync(join(tmpdir(), 'kier-headsup-'))
const { open, addItems, now } = await import('../lib/db.mjs')
const { brief, plusDays, today } = await import('../lib/tasks.mjs')
const { candidates, conversationAround, stale } = await import('../lib/headsup.mjs')

const t = now()
const db = open(join(process.env.KIER_DATA_DIR, 'kier.db'))
const due = plusDays(today(), 3)
const mail = (id, sender, subject, body, ago) => ({ id, source: 'mail', thread: subject, sender, fromMe: false, ts: t - ago,
  text: `${subject}\n${body}`, meta: { client: 'apple-mail', ownerSent: false, messageId: `${id}@example.test`, subject, body, bodyKind: 'plain',
    from: [{ name: sender, email: `${sender.split(' ')[0].toLowerCase()}@example.test` }], to: [{ name: 'Sam', email: 'sam@example.test' }] } })
addItems(db, [
  mail('mail:roof', 'Borna Vuk', 'Roof repair invoice', 'Please pay the attached invoice by Friday.', 3600),
  mail('mail:roof2', 'Borna Vuk', 'Roof repair invoice', 'The account number is on the second page.', 1800),
  // Another person, another errand, and the word the two share.
  mail('mail:other', 'Jonas Berg', 'Subscription invoice', 'Confirm whether to cancel the subscription before the next invoice.', 2400),
  mail('mail:gutter', 'Lucija Novak', 'Gutter quote', 'Can you confirm the quote by Friday?', 1200),
])
const idOf = (thread, n = 0) => db.prepare("select id from items where source = 'mail' and thread = ? order by ts").all(thread)[n].id
const roof = idOf('Roof repair invoice'), gutter = idOf('Gutter quote')
const tag = db.prepare("insert into tags (item_id, is_task, due, when_words, summary, card, model, tagged_at) values (?, 1, ?, 'by Friday', ?, 'reply', 'test', ?)")
tag.run(roof, due, 'Pay the roof repair invoice', t)
tag.run(gutter, due, 'Confirm the gutter quote', t)
const keep = db.prepare('insert or replace into heads_up (key, important, label, words, context, at, asked) values (?, 1, ?, ?, ?, ?, ?)')

test('a dated task not asked about yet is a candidate, and carries the task it belongs to', () => {
  const found = candidates(db)
  assert.deepEqual(found.map((c) => c.key).sort(), [`${gutter}@${due}`, `${roof}@${due}`].sort())
  assert.equal(found.find((c) => c.key.startsWith(roof)).task, roof)
})

test('a task\'s context is read from its own conversation only', () => {
  const said = conversationAround(db, roof)
  assert.deepEqual(said.map((m) => m.sender), ['Borna Vuk', 'Borna Vuk'])
  assert.ok(said.every((m) => m.thread === 'Roof repair invoice'))
  assert.equal(said.some((m) => /subscription|gutter/i.test(m.text)), false)
  assert.deepEqual(conversationAround(db, 'mail:nothing'), [])
})

test('a banner or a reminder has no conversation to read from', () => {
  addItems(db, [
    { id: 'notifications:a', source: 'notifications', thread: 'Chat app', sender: 'Tea', fromMe: false, ts: t - 500, text: 'Tea: bring the forms on Friday', meta: { app: 'com.example.chat' } },
    { id: 'notifications:b', source: 'notifications', thread: 'Chat app', sender: 'Priya', fromMe: false, ts: t - 400, text: 'Priya: lunch tomorrow?', meta: { app: 'com.example.chat' } },
  ])
  assert.deepEqual(conversationAround(db, 'notifications:a').map((m) => m.sender), ['Tea'])
})

test('a heads-up kept under the earlier way of finding context is looked at again, once', () => {
  keep.run(`${roof}@${due}`, 'Pay roof invoice', '["invoice"]', 'Confirm with Jonas whether to cancel the subscription', t, 2)
  keep.run(`${gutter}@${due}`, 'Gutter quote', '[]', '', t, 3)
  assert.deepEqual(stale(db).map((c) => c.key), [`${roof}@${due}`])
  assert.deepEqual(candidates(db), [])
  keep.run(`${roof}@${due}`, 'Pay roof invoice', '[]', '', t, 3)
  assert.deepEqual(stale(db), [])
})

test('a kept heads-up shows on the days ahead while its task is open', () => {
  const ahead = brief(db).ahead
  assert.deepEqual(ahead.map((x) => x.label).sort(), ['Gutter quote', 'Pay roof invoice'])
})

test('a task that looks done already is not announced, and is not asked about', () => {
  db.prepare("insert into task_state (item_id, status, changed_at, reason) values (?, 'looks_done', ?, 'Looks done: confirm this obligation was fully completed')").run(roof, t)
  const b = brief(db)
  assert.equal(b.soon.tasks.some((x) => x.id === roof), true)
  assert.deepEqual(b.ahead.map((x) => x.label), ['Gutter quote'])
  db.prepare('delete from heads_up where key = ?').run(`${roof}@${due}`)
  assert.deepEqual(candidates(db), [])
  assert.deepEqual(stale(db), [])
})

test('once it is open again it is announced as before', () => {
  db.prepare('delete from task_state where item_id = ?').run(roof)
  assert.deepEqual(candidates(db).map((c) => c.key), [`${roof}@${due}`])
})
