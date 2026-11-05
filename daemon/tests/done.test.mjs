import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.KIER_DATA_DIR = mkdtempSync(join(tmpdir(), 'kier-done-'))
after(() => rmSync(process.env.KIER_DATA_DIR, { recursive: true, force: true }))
const { open, addItems, now } = await import('../lib/db.mjs')
const { completed, donePage, brief } = await import('../lib/tasks.mjs')
const t0 = now()
const day = 86400
function fixture(t) {
  const db = open(':memory:'); t.after(() => db.close())
  return db
}
function card(db, id, { at = t0 - 2 * 3600, done = t0 - 60, status = 'done', summary = `Finish ${id}`, thread = id } = {}) {
  addItems(db, [{ id, source: 'whatsapp', thread, sender: 'Nika', fromMe: false, ts: at, text: summary }])
  db.prepare("insert into tags(item_id,is_task,summary,model,tagged_at,card) values (?,1,?,'test',?,'todo')").run(id,summary,t0)
  if (status) db.prepare("insert into task_state(item_id,status,changed_at,reason) values (?,?,?,'test')").run(id,status,done)
}

test('the full Done list goes beyond the brief preview and paginates newest completions first', t => {
  const db = fixture(t)
  for (let i = 0; i < 9; i++) card(db, `task-${i}`, { done: t0 - i * 60 })
  assert.equal(brief(db).done.length,6)
  const first = donePage(db,{ limit: 4 })
  assert.equal(first.total,9)
  assert.equal(first.next,4)
  assert.deepEqual(first.cards.map(c=>c.id),['task-0','task-1','task-2','task-3'])
  const second = donePage(db,{ offset: first.next, limit: 4 })
  assert.equal(second.next,8)
  assert.deepEqual(second.cards.map(c=>c.id),['task-4','task-5','task-6','task-7'])
  assert.equal(donePage(db,{offset:8,limit:4}).next,null)
})

test('old tasks completed recently appear, but open, dismissed and stale completions do not', t => {
  const db = fixture(t)
  card(db,'old-task',{at:t0-500*day,done:t0-120})
  card(db,'open',{status:'open'})
  card(db,'dismissed',{status:'dismissed'})
  card(db,'stale',{at:t0-500*day,done:t0-400*day})
  card(db,'handled',{status:'handled',done:t0-60})
  assert.deepEqual(completed(db).map(c=>c.id),['handled','old-task'])
})

test('repeated cards share one entry and explicit reopening removes it immediately', t => {
  const db = fixture(t)
  card(db,'one',{thread:'same',summary:'Finish the archive page',done:t0-120})
  card(db,'two',{thread:'same',summary:'Finish the archive page',done:t0-60})
  assert.deepEqual(completed(db).map(c=>c.id),['two'])
  db.prepare("update task_state set status='open' where item_id='two'").run()
  assert.deepEqual(completed(db).map(c=>c.id),['one'])
})

test('page size and lookback are bounded independently of caller input', t => {
  const db = fixture(t)
  card(db,'current')
  card(db,'week-old',{at:t0-10*day,done:t0-8*day})
  assert.equal(donePage(db,{offset:-2,limit:-5}).cards.length,1)
  assert.equal(donePage(db,{limit:0,days:1}).total,1)
  assert.equal(donePage(db,{days:10000}).days,365)
})
