import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.KIER_DATA_DIR = mkdtempSync(join(tmpdir(), 'kier-due-'))
const { open, addItems, now } = await import('../lib/db.mjs')
const { tasks, events, today, plusDays } = await import('../lib/tasks.mjs')

const t = now()
const db = open(join(process.env.KIER_DATA_DIR, 'kier.db'))
const day = plusDays(today(), 3)
addItems(db, [
  { id: 'w1', source: 'whatsapp', thread: 'Nika', sender: 'Nika', fromMe: false, ts: t - 600, text: 'donesi nacrte u petak u 15:00' },
  { id: 'w2', source: 'whatsapp', thread: 'Filip', sender: 'Filip', fromMe: false, ts: t - 600, text: 'posalji mi racun do petka' },
  { id: 'w3', source: 'whatsapp', thread: 'Tea', sender: 'Tea', fromMe: false, ts: t - 600, text: 'javi se kad stigne' },
  { id: 'calendar:1:1', source: 'calendar', thread: 'Home', sender: 'Home', fromMe: true, ts: t + 3600, text: 'Kite fitting', meta: { allDay: false, end: t + 7200 } },
  { id: 'calendar:2:1', source: 'calendar', thread: 'Home', sender: 'Home', fromMe: true, ts: t + 3600, text: 'Lucija visits', meta: { allDay: true } },
])
const tag = db.prepare("insert into tags (item_id, is_task, summary, card, due, when_words, model, tagged_at) values (?, 1, ?, 'todo', ?, ?, 'test', ?)")
tag.run('w1', 'Bring Nika the drawings', day, 'u petak u 15:00', t)
tag.run('w2', 'Send Filip the invoice', day, 'do petka', t)
tag.run('w3', 'Tell Tea when it arrives', null, null, t)

test('a dated card carries the time it is due, and only a time that was said', () => {
  const byId = Object.fromEntries(tasks(db).map((c) => [c.id, c]))
  assert.equal(byId.w1.due_time, '15:00')
  assert.equal(byId.w2.due_time, null)
  assert.equal(byId.w3.due_time, null)
})

test('a timed event knows when it ends; an all-day one has no end', () => {
  const list = events(db, today(), plusDays(today(), 1))
  assert.equal(list.find((e) => e.id === 'calendar:1:1').end, t + 7200)
  assert.equal(list.find((e) => e.id === 'calendar:2:1').end, undefined)
})
