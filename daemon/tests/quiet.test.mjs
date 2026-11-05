import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.KIER_DATA_DIR = mkdtempSync(join(tmpdir(), 'kier-quiet-'))
const { open, addItems, now } = await import('../lib/db.mjs')
const { brief } = await import('../lib/tasks.mjs')

const t = now()
const db = open(join(process.env.KIER_DATA_DIR, 'kier.db'))
addItems(db, [
  { id: 'g1', source: 'whatsapp', thread: 'Sample group', sender: 'Filip', fromMe: false, ts: t - 600, text: 'ej, jel ova kutija za plave kocke?', meta: { group: true } },
  { id: 'g2', source: 'whatsapp', thread: 'Sample group', sender: 'Filip', fromMe: false, ts: t - 300, text: 'Sam mozes sloziti kocke?', meta: { group: true } },
])
const tag = db.prepare("insert into tags (item_id, is_task, summary, card, model, tagged_at, quiet) values (?, 1, ?, 'todo', 'test', ?, ?)")
// Asked in a group Sam hadn't written in, to no one by name: likely for whoever was talking.
tag.run('g1', 'Identify the box for blue blocks', t, 1)
tag.run('g2', 'Sort the blocks', t, null)

test('a request read in a quiet group waits under Maybe yours, one naming you is on the list', () => {
  const b = brief(db)
  assert.deepEqual(b.maybe.map((c) => c.id), ['g1'])
  assert.ok(b.open.some((c) => c.id === 'g2'))
})

test('asked of someone else by @-mention: Maybe yours; the sender mentioned, an email, or you named: not', async () => {
  const { elsewhere } = await import('../lib/tagger.mjs')
  const me = ['Sam', 'sam_notes']
  assert.equal(elsewhere('Fali jedna kocka... pogledaj ispod stola @Borna', 'Priya ("Missing block", support)', me), true)
  assert.equal(elsewhere('@Jonas treba kutija za kocke?', 'Priya (#sample, Text)', me), true)
  assert.equal(elsewhere('@filip_notes has invited you to collaborate on the filip_notes/gallery repository', 'filip_notes', me), false)
  assert.equal(elsewhere('@Sam ili @Borna', 'Priya', me), false)
  assert.equal(elsewhere('@sam_notes can you look', 'Borna', me), false)
  assert.equal(elsewhere('Kontakt je visitor@example.com', 'Priya', me), false)
  assert.equal(elsewhere('Add to Favorites @Jonas Server Tag: DEMO pomakni ulijevo', 'Borna', me), false)
})

test('a burst that calls someone else by name is theirs; telling you to tell them, or naming you, is not', async () => {
  const { calledOther } = await import('../lib/tagger.mjs')
  const me = ['Sam', 'sam_notes']
  addItems(db, [
    { id: 'c0', source: 'discord', thread: '#sample', sender: 'Jonas', fromMe: false, ts: t - 900, text: 'moja kutija je prazna' },
    { id: 'c1', source: 'discord', thread: '#sample', sender: 'Borna', fromMe: false, ts: t - 60, text: 'Daj uzmi kocke s police' },
  ])
  const item = { source: 'discord', thread: '#sample', sender: 'Borna', from_me: 0, ts: t - 60 }
  assert.equal(calledOther(db, item, 'Hej Jonas\nDaj uzmi kocke s police', me), true)
  assert.equal(calledOther(db, item, 'Jonase, uzmi kocke', me), true)
  assert.equal(calledOther(db, item, 'reci Jonasu da uzme kocke s police', me), false)
  assert.equal(calledOther(db, item, 'Sam i Jonas, uzmite kocke', me), false)
  assert.equal(calledOther(db, item, 'Dok ne stigne\nmozes li to pogledati', me), false)
  assert.equal(calledOther(db, { ...item, sender: 'Jonas' }, 'Jonas ovdje\nmozes li to pogledati', me), false)
})
