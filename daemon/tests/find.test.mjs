import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.KIER_DATA_DIR = mkdtempSync(join(tmpdir(), 'kier-find-'))
const { open, addItems, now } = await import('../lib/db.mjs')
const { quick } = await import('../lib/find.mjs')

const t = now()
const db = open(join(process.env.KIER_DATA_DIR, 'kier.db'))
addItems(db, [
  { id: 'w1', source: 'whatsapp', thread: 'Nika', sender: 'Sam', fromMe: true, ts: t - 86400, text: 'sutra popravljam mali bicikl za izmisljenu izlozbu' },
  { id: 'w2', source: 'whatsapp', thread: 'Nika', sender: 'Nika', fromMe: false, ts: t - 3600, text: 'Nika: where is the bicycle repair kit?' },
  { id: 'd1', source: 'downloads', thread: 'Downloads', sender: 'Downloads', fromMe: true, ts: t - 7200, text: 'Demo workshop logo.webm', url: 'file:///tmp/Demo%20workshop%20logo.webm' },
])
db.prepare("insert into tags (item_id, is_task, summary, card, model, tagged_at) values ('w1', 1, 'Return Nika''s bike on June 12', 'promise', 'test', ?)").run(t)

test('a card is found by its own title, ahead of messages that only share a word', async () => {
  // Search terms in English should find the related Croatian conversation.
  const found = await quick(db, 'nika bike')
  assert.equal(found[0].kind, 'card')
  assert.equal(found[0].open.card, 'w1')
})

test('a file opens in Finder', async () => {
  const [file] = await quick(db, 'demo logo')
  assert.equal(file.kind, 'file')
  assert.match(file.open.file, /^file:\/\//)
})
