import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.KIER_DATA_DIR = mkdtempSync(join(tmpdir(), 'kier-minute-'))
const { open, addItems, now } = await import('../lib/db.mjs')
const { tasks } = await import('../lib/tasks.mjs')

// Minute-resolution messages are ordered by their insertion sequence.
const t = Math.floor(now() / 60) * 60 - 600
const db = open(join(process.env.KIER_DATA_DIR, 'kier.db'))
addItems(db, [
  { id: 'a1', source: 'discord', thread: 'support', sender: 'Sam', fromMe: true, ts: t, text: 'na stolu su sve kocke' },
  { id: 'q1', source: 'discord', thread: 'support', sender: 'Borna', fromMe: false, ts: t, text: '@Sam jesi prebrojao plave kocke' },
  { id: 'a0', source: 'discord', thread: 'other', sender: 'Sam', fromMe: true, ts: t, text: 'na stolu su sve kocke' },
  { id: 'q2', source: 'discord', thread: 'other', sender: 'Borna', fromMe: false, ts: t, text: '@Sam jesi prebrojao plave kocke' },
  { id: 'a2', source: 'discord', thread: 'support', sender: 'Sam', fromMe: true, ts: t, text: 'da, upravo prebrojano' },
])
const tag = db.prepare("insert into tags (item_id, is_task, summary, card, model, tagged_at) values (?, 1, 'Confirm it is supported', 'reply', 'test', ?)")
tag.run('q1', t)
tag.run('q2', t)

test('an answer in the same minute, after the question, settles it', () => {
  const card = tasks(db).find((c) => c.id === 'q1')
  assert.equal(card.state, 'handled')
  assert.equal(card.reason, 'you replied in this chat')
})

test('a line of yours from that minute but before the question does not', () => {
  assert.equal(tasks(db).find((c) => c.id === 'q2').state, 'open')
})
