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
addItems(db, [mail('mail:s1', 'sweep', 'Kite plans'), mail('mail:p1', 'spark', 'Boat plans')])
// Stored ids are the vault's own; find each copy by the app it came from.
const idOf = (client) => db.prepare("select id from items where source = 'mail' and json_extract(meta, '$.client') = ?").get(client).id
const tag = db.prepare("insert into tags (item_id, is_task, summary, card, model, tagged_at) values (?, 1, 'Send Nika the kite drawings', 'reply', 'test', ?)")
tag.run(idOf('sweep'), t)
tag.run(idOf('spark'), t)

test('mail read from Sweep offers to open Sweep; other mail keeps its own way', () => {
  const card = (client) => tasks(db).find((c) => c.id === idOf(client))
  assert.equal(card('sweep').open_app, 'Sweep')
  assert.equal(card('spark').open_app, null)
})

test('Sweep counts as a mail app for the Mail switch', () => {
  assert.equal(appSources.sweep, 'mail')
})
