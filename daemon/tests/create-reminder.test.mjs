import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
const dir = mkdtempSync(join(tmpdir(), 'kier-create-reminder-'))
process.env.KIER_DATA_DIR = dir
writeFileSync(join(dir, 'config.json'), JSON.stringify({ me: 'Sam', languages: ['English'], timezone: 'Europe/Zagreb', online: false, workRoots: [] }))
after(() => rmSync(dir, { recursive: true, force: true }))
const { reminderRequest, createReminder } = await import('../lib/create-reminder.mjs')
const { open, now } = await import('../lib/db.mjs')
const { ask } = await import('../lib/ask.mjs')
const { tasks, brief, markTask, completed, today, plusDays } = await import('../lib/tasks.mjs')
const { phoneItems } = await import('../lib/phone.mjs')
const { setSwitch } = await import('../lib/settings.mjs')
const saturday = Date.UTC(2026, 9, 10, 11, 53) / 1000

for (const [q, title, due] of [
  ['Can you remind me to pay Nika (Puzzle club) tomorrow?', 'Pay Nika (Puzzle club)', '2026-10-11'],
  ['remind me about the contract on Monday', 'The contract', '2026-10-12'],
  ['Please add a task: send Priya the contract Friday', 'Send Priya the contract', '2026-10-16'],
  ['Podsjeti me da platim Nika sutra', 'Platim Nika', '2026-10-11'],
  ['Dodaj zadatak: nazvati Tea u petak', 'Nazvati Tea', '2026-10-16'],
  ['Možeš li podsjeti me na ugovor u petak?', 'Ugovor', '2026-10-16'],
  ['remind me tomorrow to call Jonas', 'Call Jonas', '2026-10-11'],
  ['podsjeti me u petak da nazovem Borna', 'Nazovem Borna', '2026-10-16'],
  ['add a task: send Lucija the sketch', 'Send Lucija the sketch', ''],
  ['remind me to call Filip', 'Call Filip', ''],
  ['Možeš li me podsjetiti da nazovem Tea u petak?', 'Nazovem Tea', '2026-10-16'],
  ['podsjeti me na ugovor', 'Ugovor', ''],
  ['set a reminder to pay Nika on 15.10.2026', 'Pay Nika', '2026-10-15'],
]) test(q, () => { const actual = reminderRequest(q, saturday); assert.equal(actual?.title, title); assert.equal(actual?.due, due) })

for (const q of ['did I remind Nika?', 'Have I reminded Tea?', 'Jesam li podsjetio Filip?', 'Nika said remind me to pay', 'do not remind me to pay', 'remind me about that tomorrow', 'remind me tomorrow about it', 'remind me to mark the card done', 'what does remind me to mean?', 'remind me what Nika said', 'remind me who Priya is']) {
  test(`does not create: ${q}`, () => {
    // Explicit references to a card belong to the existing action path.
    assert.equal(reminderRequest(q, saturday), null)
  })
}

test('Ask creates a redacted owner card immediately with Undo and normal Done flow', async t => {
  const db = open(':memory:'); t.after(() => db.close())
  const fetch = globalThis.fetch
  globalThis.fetch = () => { throw Error('No inference or network needed') }
  t.after(() => { globalThis.fetch = fetch })
  const r = await ask(db, 'can you remind me to pay Nika (Puzzle club) tomorrow?')
  assert.match(r.out, /^Added: Pay Nika \(Puzzle club\), tomorrow\.$/)
  assert.equal(r.actions[0].label, 'Undo')
  const card = tasks(db)[0]
  assert.equal(card.id, r.created)
  assert.equal(card.source, 'kier')
  assert.equal(card.from_me, true)
  assert.equal(card.confirmed, 1)
  assert.equal(card.maybe, false)
  assert.equal(card.due, plusDays(today(), 1))
  assert.equal(brief(db).soon.tasks[0].id, card.id)
  markTask(db, card.id, r.actions[0].status)
  assert.equal(brief(db).soon.tasks.length, 0)
  markTask(db, card.id, 'open'); markTask(db, card.id, 'done')
  assert.equal(completed(db)[0].id, card.id)
  assert.equal(completed(db)[0].completion_origin, 'owner')
})

test('undated owner reminders stay visible after the normal promise window', t => {
  const db = open(':memory:'); t.after(() => db.close())
  createReminder(db, reminderRequest('remind me to call Tea'), now() - 40 * 86400)
  assert.equal(brief(db).open.length, 1)
})

test('dated and undated reminders use the existing opt-in phone path', t => {
  const db = open(':memory:'); t.after(() => db.close())
  for (const q of ['remind me to call Jonas tomorrow', 'add a task: send Priya the sketch']) createReminder(db, reminderRequest(q))
  assert.equal(phoneItems(db, { decisionAvailable: true }).items.length, 0)
  setSwitch('phoneReminders', true)
  t.after(() => setSwitch('phoneReminders', false))
  const items = phoneItems(db, { decisionAvailable: true }).items
  assert.equal(items.length, 2)
  assert.ok(items.some(i => i.due === null))
  assert.ok(items.some(i => i.due === plusDays(today(), 1)))
  markTask(db, items[0].id, 'dismissed')
  assert.equal(phoneItems(db, { decisionAvailable: true }).items.length, 1)
})

test('an unavailable assistant never writes an owner reminder', async t => {
  const db = open(':memory:'); t.after(() => db.close())
  const r = await ask(db, 'remind me to call Nika', 'codex')
  assert.equal(r.unavailable, true)
  assert.equal(tasks(db).length, 0)
})


test('redaction applies before reminder titles become tags or confirmations', async t => {
  const db = open(':memory:'); t.after(() => db.close())
  const token = ['sk', 'synthetic_fixture_only_1234567890'].join('-')
  const r = await ask(db, `remind me to rotate ${token}`)
  assert.ok(!JSON.stringify(r).includes(token))
  assert.match(tasks(db)[0].summary, /\[SECRET\]/)
})

// The model fallback only extracts; a fake model stands in for the local one.
const { reminderIntent, modelReminder, ASK_DETAILS } = await import('../lib/create-reminder.mjs')
const fakeModel = (reply) => async () => ({ ok: true, json: async () => ({ message: { content: JSON.stringify(reply) } }) })

test('reminder intent catches unusual phrasings but not questions about the past', () => {
  for (const q of ['can you create a reminder', "don't let me forget to pay Filip", 'make a task to send the invoice', 'new reminder: dentist on Monday', 'napravi podsjetnik da platim struju', 'ne zaboravi mi reci za Teu'])
    assert.ok(reminderIntent(q), q)
  for (const q of ['did I remind Nika?', 'what did Tea forget?', 'who reminded Borna?', 'jesam li podsjetio Lucija?', 'how is the library book going?'])
    assert.equal(reminderIntent(q), false, q)
})

test('the model fallback builds a dated reminder, asks for details, or declines', async () => {
  const at = Math.floor(Date.UTC(2026, 10, 5, 12) / 1000)
  const made = await modelReminder('hey, can u remind me tomorrow to pay rent', fakeModel({ create: true, title: 'pay rent', when: 'tomorrow' }), 'm', at)
  assert.deepEqual([made.title, made.due, made.when], ['Pay rent', '2026-11-06', 'tomorrow'])
  assert.deepEqual(await modelReminder('can you create a reminder', fakeModel({ create: true, title: '', when: '' }), 'm', at), { needsDetails: true })
  assert.equal(await modelReminder('can you remind me what Borna said?', fakeModel({ create: false, title: '', when: '' }), 'm', at), null)
  assert.equal(await modelReminder('anything', async () => ({ ok: true, json: async () => ({ message: { content: 'not json' } }) }), 'm', at), null)
})

test('a title never keeps leading punctuation from the date it was split from', () => {
  assert.equal(reminderRequest('add a reminder for Friday: call Nika').title, 'Call Nika')
})

test('answering the details question creates the reminder', async () => {
  const db = open(':memory:')
  try {
    const r = await ask(db, 'call Jonas on Monday', 'kier', [{ q: 'can you create a reminder', a: ASK_DETAILS }])
    assert.match(r.out, /^Added: Call Jonas/)
    assert.ok(r.created)
  } finally { db.close() }
})

test('a time of day leaves the title, becomes HH:MM for cards and Reminders, and rolls to tomorrow once past', async () => {
  const { clockOf } = await import('../lib/tasks.mjs')
  const at = Math.floor(Date.UTC(2026, 10, 5, 18, 0) / 1000) // 19:00 in Zagreb, a Thursday
  const cases = [
    ['remind me to take out the trash tomorrow at 7', 'Take out the trash', '2026-11-06', '07:00'],
    ['remind me to take out the trash tomorrow at 7pm', 'Take out the trash', '2026-11-06', '19:00'],
    ['remind me to call Nika at 18:30', 'Call Nika', '2026-11-06', '18:30'],
    ['remind me to call Nika at 21:15', 'Call Nika', '2026-11-05', '21:15'],
    ['remind me in the morning to stretch', 'Stretch', '2026-11-06', '09:00'],
    ['podsjeti me sutra u 7 da iznesem smeće', 'Iznesem smeće', '2026-11-06', '07:00'],
    ['podsjeti me sutra navečer da nazovem Teu', 'Nazovem Teu', '2026-11-06', '19:00'],
    ['remind me to buy 2 tickets tomorrow', 'Buy 2 tickets', '2026-11-06', null],
  ]
  for (const [q, title, due, clock] of cases) {
    const r = reminderRequest(q, at)
    assert.equal(r.title, title, q); assert.equal(r.due, due, q)
    assert.equal(clockOf({ when_words: r.when }), clock, q)
  }
  assert.match(reminderRequest('podsjeti me sutra u 7 da iznesem smeće', at).when, /^sutra u 07:00$/)
})
