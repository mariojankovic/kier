import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
process.env.KIER_DATA_DIR = mkdtempSync(join(tmpdir(), 'kier-keep-closures-'))
after(() => rmSync(process.env.KIER_DATA_DIR, { recursive: true, force: true }))
const { open, addItems, now } = await import('../lib/db.mjs')

test('an update keeps earlier closures: answered chat cards stay closed, AI asks and fresh cards do not, Reminders deletions count as the owner', () => {
  const path = join(process.env.KIER_DATA_DIR, 'kier.db')
  let db = open(path)
  const old = now() - 5 * 86400, fresh = now() - 3600
  addItems(db, [
    { id: 'chat-ask', source: 'whatsapp', thread: 'Nika', sender: 'Nika', fromMe: false, ts: old, text: 'Can you check the library hours?' },
    { id: 'chat-answer', source: 'whatsapp', thread: 'Nika', sender: 'Sam', fromMe: true, ts: old + 600, text: 'Sure, will do' },
    { id: 'ai-ask', source: 'ai', thread: 'Session', sender: 'Claude', fromMe: false, ts: old, text: 'Should I merge it?' },
    { id: 'ai-answer', source: 'ai', thread: 'Session', sender: 'Sam', fromMe: true, ts: old + 60, text: 'Later' },
    { id: 'new-ask', source: 'whatsapp', thread: 'Filip', sender: 'Filip', fromMe: false, ts: fresh, text: 'Send me the bike photos' },
    { id: 'new-answer', source: 'whatsapp', thread: 'Filip', sender: 'Sam', fromMe: true, ts: fresh + 60, text: 'Ok' },
    { id: 'reminders:x', source: 'reminders', thread: 'Personal', sender: 'Sam', fromMe: true, ts: old, text: 'Return the library book' },
  ])
  for (const id of ['chat-ask', 'ai-ask', 'new-ask']) db.prepare("insert into tags (item_id, is_task, summary, card, model, tagged_at) values (?, 1, 'Task', 'todo', 'fixture', ?)").run(id, now())
  db.prepare("insert into task_state (item_id, status, changed_at, reason) values ('reminders:x', 'dismissed', 1, 'deleted in Reminders')").run()
  db.prepare("delete from migrations where id = 'keep-earlier-closures-v1'").run()
  db.close()
  db = open(path)
  try {
    const state = (id) => db.prepare('select status, completion_origin o from task_state where item_id = ?').get(id)
    assert.equal(state('chat-ask')?.status, 'handled')
    assert.equal(state('chat-ask')?.o, null, 'an earlier closure never claims owner completion')
    assert.equal(state('ai-ask'), undefined)
    assert.equal(state('new-ask'), undefined)
    assert.equal(state('reminders:x').o, 'reminders')
  } finally { db.close() }
})
