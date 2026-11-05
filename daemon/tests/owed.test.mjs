import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.KIER_DATA_DIR = mkdtempSync(join(tmpdir(), 'kier-owed-'))
const { open, addItems, now } = await import('../lib/db.mjs')
const { owed, tasks } = await import('../lib/tasks.mjs')

const t = now()
const db = open(join(process.env.KIER_DATA_DIR, 'kier.db'))
const msg = (id, source, thread, sender, fromMe, ago, text, meta) => ({ id, source, thread, sender, fromMe, ts: t - ago, text, meta })
addItems(db, [
  msg('w1', 'whatsapp', 'Nika', 'Sam', true, 3 * 3600, 'sutra ti saljem nacrt brodica'),
  msg('w2', 'whatsapp', 'Nika', 'Nika', false, 120, 'bok, stize papir?'),
  msg('g1', 'whatsapp', 'Team', 'Sam', true, 2 * 3600, 'I will fold the paper boat', { group: true }),
  msg('g2', 'whatsapp', 'Team', 'Jonas', false, 3600, '@Sam can you send me the paper template?', { group: true }),
  msg('g3', 'whatsapp', 'Team', 'Filip', false, 300, 'lunch?', { group: true }),
  msg('g4', 'whatsapp', 'Team', 'Jonas', false, 200, 'also, any news?', { group: true }),
])
const tag = db.prepare('insert into tags (item_id, is_task, summary, card, model, tagged_at) values (?, 1, ?, ?, ?, ?)')
tag.run('w1', 'Send Nika the folding diagram', 'promise', 'test', t)
tag.run('g1', 'Fix the deploy', 'promise', 'test', t)
tag.run('g2', 'Send Jonas the paper template', 'todo', 'test', t)
const live = tasks(db).filter((x) => ['open', 'overdue'].includes(x.state) && !x.maybe)

test('when someone you owe writes again, what you owe them comes back', () => {
  const o = owed(db, live, t)
  assert.deepEqual(o.map((x) => [x.who, x.card.summary]), [['Nika', 'Send Nika the folding diagram'], ['Jonas', 'Send Jonas the paper template']])
})

test('a group\'s chatter never brings back your promise to the whole group', () => {
  assert.ok(!owed(db, live, t).some((x) => x.card.summary === 'Fix the deploy'))
})

test('nothing comes back once the message is older than 20 minutes', () => {
  assert.deepEqual(owed(db, live, t + 3600), [])
})
