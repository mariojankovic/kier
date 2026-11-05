import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.KIER_DATA_DIR = mkdtempSync(join(tmpdir(), 'kier-reminders-'))
const { open, now } = await import('../lib/db.mjs')
const { syncReminders } = await import('../lib/reminders.mjs')
const { tasks, markTask, plusDays, today } = await import('../lib/tasks.mjs')
const { phoneItems } = await import('../lib/phone.mjs')

const db = open(join(process.env.KIER_DATA_DIR, 'kier.db'))
const t = now()
const due = plusDays(today(), 3)
const workshop = { id: 'r1', title: 'Confirm Workshop details', due, time: null, list: 'Personal', created: t - 3600, done: false }
const call = { id: 'r2', title: 'Call Borna', due, time: '10:00', list: 'Personal', created: t - 7200, done: false }
const card = (id) => tasks(db).find((c) => c.id === `reminders:${id}`)
const mark = (id, status, at = now()) => db.prepare(`insert into task_state (item_id, status, changed_at, reason) values (?, ?, ?, 'test')
  on conflict(item_id) do update set status = excluded.status, changed_at = excluded.changed_at`).run(`reminders:${id}`, status, at)

test('your reminders become cards, dated as in Reminders', () => {
  assert.deepEqual(syncReminders(db, [workshop, call]), { close: [], reopen: [], completionPolicy: 'owner-verified' })
  assert.equal(card('r1').state, 'open')
  assert.equal(card('r1').due, due)
  assert.equal(card('r1').summary, 'Confirm Workshop details')
  assert.equal(card('r1').open_app, 'com.apple.reminders')
})

test('owner confirmation in Kier is ticked off in Reminders', () => {
  markTask(db, 'reminders:r1', 'done')
  assert.deepEqual(syncReminders(db, [workshop, call]).close, ['r1'])
})

test('ticked off in Reminders: done in Kier', () => {
  syncReminders(db, [workshop, { ...call, done: true, completed: now() }])
  assert.equal(card('r2').state, 'done')
  assert.equal(card('r2').reason, 'ticked off in Reminders')
})

test('put back here after it was ticked off: it opens there again, and stays open here', () => {
  mark('r2', 'open', now() + 5)
  const answer = syncReminders(db, [workshop, { ...call, done: true, completed: now() }])
  assert.deepEqual(answer.reopen, ['r2'])
  assert.equal(card('r2').state, 'open')
})

test('deleted in Reminders: gone from Kier; an empty read deletes nothing', () => {
  const lunch = { id: 'r3', title: 'Book lunch', due, time: null, list: 'Personal', created: t, done: false }
  syncReminders(db, [lunch])
  syncReminders(db, [])
  assert.equal(card('r3').state, 'open')
  syncReminders(db, [workshop])
  assert.equal(card('r3').state, 'dismissed')
})

test("Kier's list in Reminders never gets a copy of your own reminders", async () => {
  const { setSwitch } = await import('../lib/settings.mjs')
  setSwitch('phoneReminders', true)
  // Call Borna is open and dated within the fortnight Kier's list covers, so only the rule keeps it out.
  assert.equal(card('r2').state, 'open')
  assert.ok(!phoneItems(db).items.some((i) => String(i.id).startsWith('reminders:')))
})

test('your reminders never wait under Maybe yours, whatever the second opinion made of them', () => {
  db.prepare("update tags set second = 0.05 where item_id = 'reminders:r1'").run()
  assert.equal(card('r1').maybe, false)
})

test('"Mine" takes a doubted card out of Maybe yours for good', () => {
  db.prepare("insert or ignore into items (id, source, thread, sender, from_me, ts, text) values ('w1', 'whatsapp', 'Sample group', 'Filip', 0, ?, 'can you count the puzzle pieces')").run(now())
  db.prepare("insert or ignore into tags (item_id, is_task, summary, card, model, tagged_at, second) values ('w1', 1, 'Count the puzzle pieces', 'todo', 'test', ?, 0.05)").run(now())
  const doubted = () => tasks(db).find((c) => c.id === 'w1').maybe
  assert.equal(doubted(), true)
  db.prepare("update tags set confirmed = 1 where item_id = 'w1'").run()
  assert.equal(doubted(), false)
})

test('Your reminders in Setup and in What Kier reads are one switch', async () => {
  const { setSource, setSwitch, myReminders, off } = await import('../lib/settings.mjs')
  setSwitch('myReminders', true)
  assert.equal(myReminders(), true)
  setSource('reminders', false)
  assert.equal(myReminders(), false)
  assert.ok(off().includes('reminders'))
  // off, their cards leave the list
  assert.ok(!tasks(db).some((c) => c.id.startsWith('reminders:')))
  setSwitch('myReminders', true)
  assert.ok(!off().includes('reminders'))
  assert.ok(tasks(db).some((c) => c.id.startsWith('reminders:')))
})

test('your own promise never waits under Maybe yours', () => {
  db.prepare("insert or ignore into items (id, source, thread, sender, from_me, ts, text) values ('p1', 'whatsapp', 'Borna', 'Sam', 1, ?, 'sad cu sloziti slagalicu')").run(now())
  db.prepare("insert or ignore into tags (item_id, is_task, summary, card, model, tagged_at, second) values ('p1', 1, 'Assemble the puzzle', 'promise', 'test', ?, 0.05)").run(now())
  assert.equal(tasks(db).find((c) => c.id === 'p1').maybe, false)
})

test('"rename this to …" in a card\'s chat names the new title', async () => {
  const { renameTo } = await import('../lib/ask.mjs')
  assert.equal(renameTo('rename this to "Add ability to bring own model to Kier"'), 'Add ability to bring own model to Kier')
  assert.equal(renameTo('Rename it to Send Nika the photos.'), 'Send Nika the photos')
  assert.equal(renameTo('call it Pay the hosting bill'), 'Pay the hosting bill')
  assert.equal(renameTo('change the title to Book the venue'), 'Book the venue')
  assert.equal(renameTo('preimenuj ovo u Platiti racun'), 'Platiti racun')
  assert.equal(renameTo('call him back tomorrow?'), null)
  assert.equal(renameTo('what did she say about the rename?'), null)
})
