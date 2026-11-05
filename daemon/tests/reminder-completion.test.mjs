import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, rmSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

const dir = mkdtempSync(join(tmpdir(), 'kier-reminder-completion-'))
process.env.KIER_DATA_DIR = dir
writeFileSync(join(dir, 'config.json'), JSON.stringify({ me: 'Sam', fullName: 'Sam', online: false, workRoots: [] }))
after(() => rmSync(dir, { recursive: true, force: true }))
const { open, addItems, now } = await import('../lib/db.mjs')
const { tasks, markTask, brief, today, completed } = await import('../lib/tasks.mjs')
const { syncReminders } = await import('../lib/reminders.mjs')
const { evidence, resolvePending, recordCompletion } = await import('../lib/resolve.mjs')
const { phoneItems } = await import('../lib/phone.mjs')
const { setSwitch } = await import('../lib/settings.mjs')
const { modelFixture } = await import('./model-fixture.mjs')
await modelFixture({ decision: false })

function fixture(t, { owner = false, sender = 'Nika', text = 'I paid the archive fee.' } = {}) {
  const db = open(':memory:')
  t.after(() => db.close())
  const reminder = { id: 'archive', title: 'Pay the archive fee', list: 'Personal', created: now() - 7200, due: today(), done: false }
  syncReminders(db, [reminder])
  addItems(db, [{ id: 'proof', source: 'whatsapp', thread: 'Archive club', sender, fromMe: owner, ts: now() - 600, text }])
  const card = () => tasks(db).find(row => row.id === 'reminders:archive')
  return { db, reminder, card }
}

function model(t, verdict) {
  const original = globalThis.fetch
  globalThis.fetch = async (url) => {
    if (String(url).endsWith('/api/version')) return new Response('{}')
    assert.ok(String(url).endsWith('/api/chat'))
    return new Response(JSON.stringify({ message: { content: JSON.stringify(verdict) } }))
  }
  t.after(() => { globalThis.fetch = original })
}

test('third-party payment claim becomes Looks done with evidence and no write-back', async t => {
  const { db, reminder, card } = fixture(t)
  const lines = evidence(db, card())
  assert.equal(lines[0].owner, false)
  model(t, { done: true, line: 1, why: 'Paid', owner: true })
  assert.equal((await resolvePending(db, 4, { now: true })).resolved, 1)
  assert.equal(card().state, 'looks_done')
  assert.match(card().reason, /Nika: I paid the archive fee/)
  assert.deepEqual(syncReminders(db, [reminder]).close, [])
  assert.ok(brief(db).today.tasks.some(row => row.id === card().id && row.state === 'looks_done'))
  assert.ok(!completed(db).some(row => row.id === card().id))
})

test('Confirm uses the owner mark path and authorizes write-back', async t => {
  const { db, reminder, card } = fixture(t)
  model(t, { done: true, line: 1 })
  await resolvePending(db, 4, { now: true })
  markTask(db, card().id, 'done')
  assert.equal(card().state, 'done')
  assert.equal(card().completion_origin, 'owner')
  const result = syncReminders(db, [reminder])
  assert.deepEqual(result.close, ['archive'])
  assert.equal(result.completionPolicy, 'owner-verified')
})

test('a model verdict without a valid evidence line needs confirmation', async t => {
  const { db, reminder, card } = fixture(t)
  model(t, { done: true, line: 0, why: 'The fee appears settled.' })
  await resolvePending(db, 4, { now: true })
  assert.equal(card().state, 'looks_done')
  assert.match(card().reason, /fee appears settled/)
  assert.deepEqual(syncReminders(db, [reminder]).close, [])
})

test('a sender using the owner name is still third-party evidence', async t => {
  const { db, reminder, card } = fixture(t, { sender: 'Sam' })
  model(t, { done: true, line: 1 })
  await resolvePending(db, 4, { now: true })
  assert.equal(card().state, 'looks_done')
  assert.deepEqual(syncReminders(db, [reminder]).close, [])
})

test('imported outgoing evidence still needs owner confirmation for an owner reminder', async t => {
  const { db, reminder, card } = fixture(t, { owner: true, sender: 'Sam' })
  assert.equal(evidence(db, card())[0].owner, true)
  model(t, { done: true, line: 1 })
  await resolvePending(db, 4, { now: true })
  assert.equal(card().state, 'looks_done')
  assert.equal(card().completion_origin, null)
  assert.deepEqual(syncReminders(db, [reminder]).close, [])
  markTask(db, card().id, 'done')
  assert.deepEqual(syncReminders(db, [reminder]).close, ['archive'])
})

test('an invalid model evidence index cannot invent owner completion', async t => {
  const { db, reminder, card } = fixture(t, { owner: true, sender: 'Sam', text: 'Has the archive fee been paid?' })
  // The model alone cannot invent owner provenance when its evidence index is invalid.
  model(t, { done: true, line: 99 })
  await resolvePending(db, 4, { now: true })
  assert.equal(card().state, 'looks_done')
  assert.deepEqual(syncReminders(db, [reminder]).close, [])
})

test('legacy inferred and agent-written completion fails closed', t => {
  const { db, reminder, card } = fixture(t)
  for (const status of ['handled', 'done']) {
    db.prepare(`insert into task_state (item_id, status, changed_at, reason) values (?, ?, ?, 'Looks done: unverified verdict')
      on conflict(item_id) do update set status = excluded.status`).run(card().id, status, now())
    assert.equal(card().state, 'looks_done')
    assert.deepEqual(syncReminders(db, [reminder]).close, [])
  }
})

test('Not done clears completion authority and keeps the original open', t => {
  const { db, reminder, card } = fixture(t)
  markTask(db, card().id, 'done')
  markTask(db, card().id, 'open')
  assert.equal(card().state, 'open')
  assert.equal(card().completion_origin, null)
  assert.deepEqual(syncReminders(db, [reminder]).close, [])
})

test('completion in Apple Reminders settles a pending suggestion', t => {
  const { db, reminder, card } = fixture(t)
  recordCompletion(db, card(), null, 'Looks done: a message claimed completion')
  syncReminders(db, [{ ...reminder, done: true, completed: now() }])
  assert.equal(card().state, 'done')
  assert.equal(card().completion_origin, 'reminders')
})

test('inferred completion never ticks an exported reminder without owner authority', t => {
  const { db } = fixture(t)
  db.prepare("insert into tags (item_id, is_task, summary, due, card, model, tagged_at) values ('proof', 1, 'Pay the archive fee', ?, 'payment', 'test', ?)").run(today(), now())
  const task = tasks(db).find(row => row.id === 'proof')
  recordCompletion(db, task, { owner: false }, 'Looks done: Nika confirmed it')
  assert.equal(tasks(db).find(row => row.id === 'proof').state, 'looks_done')
  setSwitch('phoneReminders', true)
  t.after(() => setSwitch('phoneReminders', false))
  assert.equal(phoneItems(db, { decisionAvailable: false }).items.find(row => row.id === 'proof').done, undefined)
})

test('schema migration preserves explicit owner marks but not inferred ones', t => {
  const path = join(dir, 'legacy.db')
  const legacy = new DatabaseSync(path)
  legacy.exec(`create table task_state (item_id text primary key, status text, changed_at integer, reason text, url text);
    insert into task_state values ('owner', 'done', 1, 'marked in the timeline', null),
      ('guess', 'handled', 1, 'Looks done: a model said so', null)`)
  legacy.close()
  const db = open(path)
  t.after(() => db.close())
  assert.equal(db.prepare("select completion_origin from task_state where item_id = 'owner'").get().completion_origin, 'owner')
  assert.equal(db.prepare("select completion_origin from task_state where item_id = 'guess'").get().completion_origin, null)
})

test('native reminder sync requires the verified completion policy', () => {
  const source = readFileSync('../app/PhoneSync.swift', 'utf8')
  assert.match(source, /answer.completionPolicy == "owner-verified" && answer.close.contains/)
  const ui = readFileSync('../app/Orb.swift', 'utf8')
  assert.match(ui, /card.needsConfirmation \? "Confirm" : "Mark done"/)
  assert.match(ui, /if card.needsConfirmation/)
})

test('an AI session claim is model evidence and cannot close an original reminder', async t => {
  const { db, reminder, card } = fixture(t)
  db.prepare("delete from items where id = 'proof'").run()
  addItems(db, [{ id: 'agent-proof', source: 'ai', thread: 'Archive', sender: 'Claude', fromMe: true,
    ts: now() - 600, text: 'The archive fee is paid.', meta: { kind: 'session', latest: 'The archive fee is paid.' } }])
  assert.equal(evidence(db, card())[0].owner, false)
  model(t, { done: true, line: 1 })
  await resolvePending(db, 4, { now: true })
  assert.equal(card().state, 'looks_done')
  assert.deepEqual(syncReminders(db, [reminder]).close, [])
})

test('a forged-author commit claiming done is advisory and requires Confirm', async t => {
  const { db, reminder, card } = fixture(t)
  db.prepare("delete from items where id = 'proof'").run()
  addItems(db, [{ id: 'commit-proof', source: 'git', thread: 'archive', sender: 'Sam', fromMe: true,
    ts: now() - 600, text: 'I paid the archive fee.', meta: {} }])
  assert.equal(evidence(db, card())[0].owner, false)
  model(t, { done: true, line: 1, owner: true })
  await resolvePending(db, 4, { now: true })
  assert.equal(card().state, 'looks_done')
  assert.equal(card().completion_origin, null)
  assert.deepEqual(syncReminders(db, [reminder]).close, [])
  markTask(db, card().id, 'done')
  assert.deepEqual(syncReminders(db, [reminder]).close, ['archive'])
})

test('Git or unknown proof cannot gain authority through an owner flag', t => {
  const { db, reminder, card } = fixture(t)
  for (const kind of ['git', 'github', 'ai', undefined]) {
    db.prepare('delete from task_state').run()
    recordCompletion(db, card(), { kind, owner: true }, 'Looks done: claimed completion')
    assert.equal(card().state, 'looks_done')
    assert.deepEqual(syncReminders(db, [reminder]).close, [])
  }
})

test('legacy owner evidence cannot write back because its source was not recorded', t => {
  const { db, reminder, card } = fixture(t)
  db.prepare(`insert into task_state (item_id, status, changed_at, completion_origin)
    values (?, 'handled', ?, 'owner-evidence')`).run(card().id, now())
  assert.equal(card().state, 'looks_done')
  assert.deepEqual(syncReminders(db, [reminder]).close, [])
})


test('imported owner-message state alone cannot authorize native write-back', t => {
  const { db, reminder, card } = fixture(t)
  db.prepare("insert into task_state(item_id,status,changed_at,completion_origin) values (?,'handled',?,'owner-message')").run(card().id, now())
  assert.equal(card().state, 'looks_done')
  assert.deepEqual(syncReminders(db, [reminder]).close, [])
})
