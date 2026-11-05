import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.KIER_DATA_DIR = mkdtempSync(join(tmpdir(), 'kier-reminder-notices-'))
after(() => rmSync(process.env.KIER_DATA_DIR, { recursive: true, force: true }))
const { open, addItems, now } = await import('../lib/db.mjs')
const { skipNotificationApp } = await import('../collectors/notifications.mjs')
const { excludeReminderNotices, pending, tagPending } = await import('../lib/tagger.mjs')

function vault(t) { const db = open(':memory:'); t.after(() => db.close()); return db }
function notice(db, id, { app = 'com.apple.reminders', source = 'notifications', quiet } = {}) {
  addItems(db, [{ id, source, sender: 'Reminders', thread: 'Reminders', ts: now() - 600,
    text: 'Attend an invented meeting at noon', meta: { app, conversation: 'com.apple.remindd.reminderAlarm', ...(quiet !== undefined && { quiet }) } }])
}
function tagged(db, id, { confirmed = null, status } = {}) {
  db.prepare('insert into tags(item_id,is_task,model,summary,second,confirmed,tagged_at) values (?,1,\'fixture\',\'Attend an invented meeting at noon\',0.374,?,?)').run(id, confirmed, now())
  if (status) db.prepare('insert into task_state(item_id,status,changed_at,reason) values (?,?,?,\'Existing choice or proof\')').run(id, status, now())
}

test('collection skips Reminders case-insensitively while keeping unrelated mail notifications', () => {
  assert.equal(skipNotificationApp('com.apple.reminders'), true)
  assert.equal(skipNotificationApp('com.apple.Reminders'), true)
  assert.equal(skipNotificationApp('com.apple.mail'), false)
  assert.equal(skipNotificationApp('com.example.messenger'), false)
})

test('reconciliation hides automatic reminder echoes without changing raw notices or state', t => {
  const db = vault(t)
  for (const [id, app, status] of [
    ['automatic', 'com.apple.Reminders', null],
    ['auto-handled', 'com.apple.reminders', 'handled'],
    ['mail-notice', 'com.apple.mail', null],
  ]) { notice(db, id, { app }); tagged(db, id, { status }) }
  notice(db, 'direct-mail', { source: 'mail' }); tagged(db, 'direct-mail')
  const raw = db.prepare('select * from items order by id').all()
  const states = db.prepare('select * from task_state order by item_id').all()
  assert.equal(excludeReminderNotices(db), 2)
  assert.equal(excludeReminderNotices(db), 0)
  const tags = Object.fromEntries(db.prepare('select item_id,is_task,model from tags').all().map(r => [r.item_id, r]))
  for (const id of ['automatic', 'auto-handled']) {
    assert.equal(tags[id].is_task, 0); assert.equal(tags[id].model, 'reminder-notice')
  }
  for (const id of ['mail-notice', 'direct-mail']) assert.equal(tags[id].is_task, 1)
  assert.deepEqual(db.prepare('select * from items order by id').all(), raw)
  assert.deepEqual(db.prepare('select * from task_state order by item_id').all(), states)
})

test('confirmed notices and explicit owner choices remain exactly as saved', t => {
  const db = vault(t)
  notice(db, 'mine'); tagged(db, 'mine', { confirmed: 1 })
  for (const status of ['open', 'snoozed', 'done', 'dismissed']) {
    notice(db, status); tagged(db, status, { status })
  }
  const tags = db.prepare('select * from tags order by item_id').all()
  const states = db.prepare('select * from task_state order by item_id').all()
  assert.equal(excludeReminderNotices(db), 0)
  assert.deepEqual(db.prepare('select * from tags order by item_id').all(), tags)
  assert.deepEqual(db.prepare('select * from task_state order by item_id').all(), states)
})

test('stored untagged Reminders notices never reach the model regardless of their quiet flag', async t => {
  const db = vault(t)
  notice(db, 'stored-default')
  notice(db, 'stored-mixed-case', { app: 'COM.APPLE.REMINDERS' })
  notice(db, 'stored-quiet', { quiet: true })
  assert.deepEqual(pending(db, 20), [])
  let requests = 0
  t.mock.method(globalThis, 'fetch', async () => { requests++; assert.fail('Reminders echoes must not make model requests') })
  assert.deepEqual(await tagPending(db), { tagged: 0 })
  assert.equal(requests, 0)
  assert.equal(db.prepare('select count(*) count from tags').get().count, 0)
  notice(db, 'mail', { app: 'com.apple.mail' })
  notice(db, 'plain-notification', { app: null })
  notice(db, 'direct-mail', { source: 'mail' })
  assert.deepEqual(pending(db, 20).map(r => r.id).sort(), ['direct-mail', 'mail', 'plain-notification'])
})
