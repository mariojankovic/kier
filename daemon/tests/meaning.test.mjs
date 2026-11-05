import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.KIER_DATA_DIR = mkdtempSync(join(tmpdir(), 'kier-meaning-'))
const { open, addItems, now } = await import('../lib/db.mjs')
const { pack, similarity, search } = await import('../lib/meaning.mjs')

const unit = (v) => { const n = Math.hypot(...v); return v.map((x) => x / n) }

test('a fingerprint kept at one byte a number compares almost exactly like the full one', () => {
  const a = unit(Array.from({ length: 256 }, (_, i) => Math.sin(i * 1.7)))
  const b = unit(Array.from({ length: 256 }, (_, i) => Math.sin(i * 1.7) + Math.cos(i * 0.3) * 0.5))
  const exact = a.reduce((s, x, i) => s + x * b[i], 0)
  assert.ok(Math.abs(similarity(a, pack(b)) - exact) < 0.01, `${similarity(a, pack(b))} vs ${exact}`)
  assert.equal(pack(b).length, 260)
  // Stored and read back, the way search does: SQLite returns the blob as a Uint8Array.
  const db = open(join(process.env.KIER_DATA_DIR, 'kier.db'))
  db.prepare('insert or replace into vectors (item_id, v) values (?, ?)').run('x', pack(b))
  const back = db.prepare('select v from vectors where item_id = ?').get('x').v
  assert.ok(Math.abs(similarity(a, back) - exact) < 0.01)
})

test('without the search model, words still find messages, and a named person narrows them to that chat', async () => {
  const db = open(join(process.env.KIER_DATA_DIR, 'kier.db'))
  const t = now()
  addItems(db, [
    { id: 'a1', source: 'whatsapp', thread: 'Nika', sender: 'Nika', fromMe: false, ts: t - 300, text: 'kad je launch?' },
    { id: 'a2', source: 'whatsapp', thread: 'Nika', sender: 'Sam', fromMe: true, ts: t - 200, text: 'launch je u petak' },
    { id: 'b1', source: 'whatsapp', thread: 'Jonas', sender: 'Jonas', fromMe: false, ts: t - 100, text: 'launch party?' },
  ])
  assert.deepEqual((await search(db, 'What did I tell Nika about the launch?')).map((m) => m.id), ['a1', 'a2'])
  assert.deepEqual((await search(db, 'when is the launch')).map((m) => m.id), ['a1', 'a2', 'b1'])
})
