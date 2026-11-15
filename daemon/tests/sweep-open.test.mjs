import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.KIER_DATA_DIR = mkdtempSync(join(tmpdir(), 'kier-sweep-open-'))
const { open, addItems, now } = await import('../lib/db.mjs')
const { tasks } = await import('../lib/tasks.mjs')
const { appSources } = await import('../lib/app-permissions.mjs')

const t = now()
const db = open(join(process.env.KIER_DATA_DIR, 'kier.db'))
const mail = (id, client, thread) => ({ id, source: 'mail', thread, sender: 'Nika', fromMe: false, ts: t - 600,
  text: `${thread}\nCan you send the drawings by Friday?`, meta: { client, ownerSent: false, messageId: `${id}@example.test`, subject: thread,
    body: 'Can you send the drawings by Friday?', bodyKind: 'plain', from: [{ name: 'Nika', email: 'nika@example.test' }], to: [{ name: 'Sam', email: 'sam@example.test' }] } })
const fromKierMail = mail('mail:s1', 'sweep', 'Kite plans')
fromKierMail.meta.threadId = '<kite+plans@example.test>'
const inBoth = mail('mail:b1', 'apple-mail', 'Sail plans')
inBoth.meta.kierMailThread = 'thread-sail'
const lookedFor = mail('mail:n1', 'apple-mail', 'Oar plans')
lookedFor.meta.kierMailThread = ''
addItems(db, [fromKierMail, mail('mail:p1', 'spark', 'Boat plans'), inBoth, lookedFor])
// Stored ids are the vault's own; find each copy by the app it came from.
const idOf = (client) => db.prepare("select id from items where source = 'mail' and json_extract(meta, '$.client') = ?").get(client).id
const tag = db.prepare("insert into tags (item_id, is_task, summary, card, model, tagged_at) values (?, 1, 'Send Nika the kite drawings', 'reply', 'test', ?)")
tag.run(idOf('sweep'), t)
tag.run(idOf('spark'), t)
const idOfThread = (thread) => db.prepare("select id from items where source = 'mail' and thread = ?").get(thread).id
tag.run(idOfThread('Sail plans'), t)
tag.run(idOfThread('Oar plans'), t)

test('mail read from Kier Mail offers to open Kier Mail; other mail keeps its own way', () => {
  const card = (client) => tasks(db).find((c) => c.id === idOf(client))
  assert.equal(card('sweep').open_app, 'Kier Mail')
  assert.equal(card('spark').open_app, null)
})

test('a card for mail from Kier Mail carries Kier Mail\'s own link to that conversation, and no other mail does', () => {
  const card = (client) => tasks(db).find((c) => c.id === idOf(client))
  // The same form Kier Mail's Copy Link writes: the thread's id, percent-encoded, and nothing else.
  assert.equal(card('sweep').open_link, 'sweep://thread/%3Ckite%2Bplans%40example.test%3E')
  assert.equal(card('spark').open_link, null)
  assert.equal(JSON.parse(card('sweep').meta).client, 'sweep', 'the window tells Kier Mail\'s mail by this, to show its mark')
})

test('mail read from another app that is also in Kier Mail opens there too; mail that is not keeps its own way', () => {
  const card = (thread) => tasks(db).find((c) => c.id === idOfThread(thread))
  assert.equal(card('Sail plans').open_app, 'Kier Mail')
  assert.equal(card('Sail plans').open_link, 'sweep://thread/thread-sail')
  assert.equal(card('Oar plans').open_app, null)
  assert.equal(card('Oar plans').open_link, null)
})

test('Kier Mail counts as a mail app for the Mail switch, under its name and its first name', () => {
  assert.equal(appSources.sweep, 'mail')
  assert.equal(appSources['kier mail'], 'mail')
  assert.equal(appSources['com.kier.mail'], 'mail')
})
