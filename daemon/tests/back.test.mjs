import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.KIER_DATA_DIR = mkdtempSync(join(tmpdir(), 'kier-back-'))
const { open, addItems, now } = await import('../lib/db.mjs')
const { brief } = await import('../lib/tasks.mjs')

const t = now()
const db = open(join(process.env.KIER_DATA_DIR, 'kier.db'))
const msg = (id, thread, sender, fromMe, ago, text) => ({ id, source: 'whatsapp', thread, sender, fromMe, ts: t - ago, text })
addItems(db, [
  // Your own promise without a date, two days old: off the list after a day...
  msg('p1', 'Tea', 'Sam', true, 2 * 86400, 'bum nacrtal papirnati brodic'),
  //...until Tea writes again.
  msg('p2', 'Tea', 'Tea', false, 2 * 3600, 'jel brodic gotov?'),
  msg('q1', 'Filip', 'Sam', true, 2 * 86400, 'posaljem ti nacrt za zmaja'),
])
const tag = db.prepare("insert into tags (item_id, is_task, summary, card, model, tagged_at) values (?, 1, ?, 'promise', 'test', ?)")
tag.run('p1', 'Check the package contents', t)
tag.run('q1', 'Send Filip the kite diagram', t)

test('a promise brought back by its person writing again is on the list for that day', () => {
  // "Borna just wrote. You still owe this" named a card that had already left the list.
  const ids = brief(db).open.map((c) => c.id)
  assert.ok(ids.includes('p1'))
  assert.ok(!ids.includes('q1'))
})
