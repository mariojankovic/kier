import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.KIER_DATA_DIR = mkdtempSync(join(tmpdir(), 'kier-owner-action-'))
after(() => rmSync(process.env.KIER_DATA_DIR, { recursive: true, force: true }))
writeFileSync(join(process.env.KIER_DATA_DIR, 'config.json'), JSON.stringify({ me: 'Jonas', languages: ['Croatian', 'English'], runtime: 'ollama' }))
const { saveProfile } = await import('../lib/profile-state.mjs')
saveProfile({ aliases: ['Lucija Example'], people: [], groups: [] }, 0)
writeFileSync(join(process.env.KIER_DATA_DIR, 'handles.json'), JSON.stringify({ Discord: ['jonas_notes'] }))
const { replyQuestion, actionTitle } = await import('../lib/owner-action.mjs')
const { cards } = await import('../lib/second.mjs')
const { open, addItems, now } = await import('../lib/db.mjs')
const { tagPending } = await import('../lib/tagger.mjs')
const { tasks } = await import('../lib/tasks.mjs')

const me = ['Jonas', 'jonas_notes']
const incoming = (text, extra = {}) => ({ id: 'question', source: 'discord', thread: 'Workshop', sender: 'Tea', from_me: 0, ts: now() - 600, text, ...extra })
const title = 'Answer Tea: "can I use the spare adapter?"'
function vault(t) { const db = open(':memory:'); t.after(() => db.close()); return db }

// Made-up questions and work requests keep their different obligations.
const { modelFixture } = await import('./model-fixture.mjs')
await modelFixture({ decision: true })

test('a named permission or information question needs the owner answer', () => {
  for (const [text, question] of [
    ['@Jonas can I use the spare adapter?', 'can I use the spare adapter?'],
    ['Jonas, can I use the spare adapter?', 'can I use the spare adapter?'],
    ['@jonas_notes can I use the spare adapter?', 'can I use the spare adapter?'],
    ['@Jonas mogu opet koristiti rezervni adapter?', 'mogu opet koristiti rezervni adapter?'],
    ['Jonas, where is the spare adapter?', 'where is the spare adapter?'],
    ['@Jonas can you tell me where the adapter is?', 'can you tell me where the adapter is?'],
    ['@Jonas mozes mi reci gdje je adapter?', 'mozes mi reci gdje je adapter?'],
  ]) assert.equal(replyQuestion(incoming(text), me), question, text)
  assert.equal(replyQuestion(incoming('@Lucija can I use the spare adapter?')), 'can I use the spare adapter?')
  assert.equal(replyQuestion(incoming('@jonas_notes can I use the spare adapter?')), 'can I use the spare adapter?')
})

test('the question comes from message content, without notification metadata', () => {
  const sender = '\u2068Tea\u2069 (\u2068#sample\u2069, \u2068Text\u2069)'
  const item = incoming(`${sender}: @Jonas can I use the spare adapter?`, { source: 'notifications', thread: 'Discord', sender })
  assert.equal(replyQuestion(item, me), 'can I use the spare adapter?')
  assert.equal(actionTitle('Tea asks Jonas to schedule an adapter meeting', item, me), title)
})

test('work requests, quoted questions, other addressees and outgoing messages are left alone', () => {
  for (const text of [
    '@Jonas can you send the draft?',
    '@Jonas can you fix the importer?',
    '@Jonas can you check the export?',
    '@Jonas can you join the meeting tomorrow at 14:00?',
    '@Jonas do you mind fixing the importer?',
    '@Jonas can we meet tomorrow at 14:00?',
    '@Jonas could we meet tomorrow at 14:00?',
    '@Jonas mozes reci Niki da posalje nacrt?',
    '@Jonas can I have the invoice?',
    '@Jonas is it possible for you to fix the importer?',
    '@Filip can I use the spare adapter?',
    'Can I use the spare adapter?',
    'I can finish the export by noon, @Jonas?',
    'Jonas said: can I use the spare adapter?',
    'Tea asked "@Jonas can I use the spare adapter?"',
    '> @Jonas can I use the spare adapter?',
    '@Jonas123 can I use the spare adapter?',
  ]) assert.equal(replyQuestion(incoming(text), me), null, text)
  assert.equal(replyQuestion(incoming('@Jonas can I use the spare adapter?', { from_me: 1 }), me), null)
})

test('incoming descriptions become owner actions while outgoing descriptions stay', () => {
  const request = incoming('@Jonas please send the draft')
  assert.equal(actionTitle('Tea asks Jonas to send the draft', request, me), 'Send the draft')
  assert.equal(actionTitle('Tea asks Jonas to send the draft', { ...request, from_me: 1 }, me), 'Tea asks Jonas to send the draft')
  assert.equal(actionTitle('Tea asks Filip to send the draft', request, me), 'Tea asks Filip to send the draft')
  assert.equal(actionTitle('Send the draft', request, me), 'Send the draft')
  assert.equal(actionTitle('Tea asks Jonas to schedule an adapter meeting', incoming('@Jonas can I use the spare adapter?'), me), title)
})

test('plain reply cards need no decision model, while promises and payments keep precedence', async t => {
  t.mock.method(globalThis, 'fetch', () => assert.fail('these card types need no model'))
  const question = incoming('@Jonas can I use the spare adapter?')
  assert.deepEqual(await cards([
    question,
    { ...question, id: 'payment', amount: '20 EUR' },
    { ...question, id: 'promise', from_me: 1 },
  ]), ['reply', 'payment', 'promise'])
})

test('mixed card batches preserve their input order and only send unknown types to d1', async t => {
  const requests = []
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    const path = new URL(url).pathname
    if (path === '/health') return { ok: true }
    assert.equal(path, '/ask')
    const body = JSON.parse(options.body); requests.push(body)
    return { ok: true, json: async () => ({ answers: body.states.map(s => ({ card: { choice: s.message_to_judge.text.includes('Join') ? 'appointment' : 'todo' } })) }) }
  })
  assert.deepEqual(await cards([
    incoming('@Jonas can you send the draft?', { id: 'work' }),
    incoming('@Jonas can I use the spare adapter?', { id: 'reply' }),
    incoming('Join us tomorrow at 14:00.', { id: 'meeting' }),
    incoming('@Jonas can I use the spare adapter?', { id: 'payment', amount: '20 EUR' }),
  ]), ['todo', 'reply', 'appointment', 'payment'])
  assert.equal(requests.length, 1)
  assert.deepEqual(requests[0].states.map(s => s.message_to_judge.text), ['@Jonas can you send the draft?', 'Join us tomorrow at 14:00.'])
})

test('fresh tagging repairs task titles and card types without promoting a non-task', async t => {
  const db = vault(t)
  addItems(db, [
    incoming('@Jonas can I use the spare adapter?', { id: 'reply', thread: 'Adapter' }),
    incoming('Jonas, please send the draft.', { id: 'work', thread: 'Draft' }),
    incoming('The draft is already sent.', { id: 'news', thread: 'News' }),
  ])
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    const path = new URL(url).pathname
    if (path === '/api/version' || path === '/health') return { ok: true }
    const body = JSON.parse(options.body)
    if (path === '/api/chat') {
      const text = body.messages.at(-1).content
      const reply = text.includes('spare adapter?')
      return { ok: true, json: async () => ({ message: { content: JSON.stringify({
        is_task: !text.includes('already sent'),
        summary: reply ? 'Tea asks Jonas to schedule an adapter meeting' : 'Tea asks Jonas to send the draft',
        when: '', due: '', amount: '', urgency: 1,
      }) } }) }
    }
    if (path === '/decide') return { ok: true, json: async () => ({ p_task: body.messages.map(() => 0.95) }) }
    if (path === '/ask') return { ok: true, json: async () => ({ answers: body.states.map(() => ({ card: { choice: 'todo' } })) }) }
    assert.fail(`unexpected fetch: ${url}`)
  })
  const result = await tagPending(db)
  assert.equal(result.tagged, 3)
  assert.equal(result.failed, 0)
  const tags = Object.fromEntries(db.prepare('select * from tags').all().map(r => [r.item_id, r]))
  assert.equal(tags.reply.is_task, 1)
  assert.equal(tags.reply.card, 'reply')
  assert.equal(tags.reply.summary, title)
  assert.equal(tags.work.is_task, 1)
  assert.equal(tags.work.card, 'todo')
  assert.equal(tags.work.summary, 'Send the draft')
  assert.equal(tags.news.is_task, 0)
  assert.equal(tags.news.summary, 'Tea asks Jonas to send the draft')
  assert.equal(tasks(db).find(r => r.id === 'reply').card, 'reply')
})

test('cached cards show owner actions and reply types without rewriting stored tags', t => {
  const db = vault(t)
  addItems(db, [
    incoming('@Jonas can I use the spare adapter?', { id: 'reply', thread: 'Adapter' }),
    incoming('Jonas, please send the draft.', { id: 'work', thread: 'Draft' }),
    incoming('The draft is already sent.', { id: 'news', thread: 'News' }),
  ])
  const save = db.prepare("insert into tags(item_id,is_task,summary,card,model,tagged_at,second) values(?,?,?,'todo','fixture',?,0.95)")
  save.run('reply', 1, 'Tea asks Jonas to schedule an adapter meeting', now())
  save.run('work', 1, 'Tea asks Jonas to send the draft', now())
  save.run('news', 0, 'Tea asks Jonas to send the draft', now())
  const before = db.prepare('select * from tags order by item_id').all()
  const visible = Object.fromEntries(tasks(db).map(r => [r.id, r]))
  assert.equal(visible.reply.card, 'reply')
  assert.equal(visible.reply.summary, title)
  assert.equal(visible.work.card, 'todo')
  assert.equal(visible.work.summary, 'Send the draft')
  assert.equal(visible.news, undefined)
  assert.deepEqual(db.prepare('select * from tags order by item_id').all(), before)
})

test('acknowledging an indirect work request does not complete the work', t => {
  const db = vault(t)
  const at = now() - 600
  addItems(db, [
    incoming('@Jonas do you mind fixing the importer?', { id: 'work', ts: at }),
    incoming('I will look at it after lunch.', { id: 'ack', sender: 'Jonas', fromMe: true, ts: at + 120 }),
  ])
  db.prepare("insert into tags(item_id,is_task,summary,card,model,tagged_at,second) values('work',1,'Fix the importer','todo','fixture',?,0.95)").run(at)
  const task = tasks(db).find(r => r.id === 'work')
  assert.equal(task.card, 'todo')
  assert.equal(task.summary, 'Fix the importer')
  assert.equal(task.state, 'open')
  assert.equal(task.answered, at + 120)
})

test('relay and later rules keep their work cards and titles in the cached view', t => {
  const db = vault(t)
  const rows = [
    ['relay', '@Jonas mozes reci Niki da posalje nacrt?', 'Tell Nika to send the draft'],
    ['later', '@Jonas can you let me know when the archive is ready?', 'Tell Tea when the archive is ready'],
  ]
  for (const [model, text, summary] of rows) {
    addItems(db, [incoming(text, { id: model, thread: model })])
    db.prepare("insert into tags(item_id,is_task,summary,card,model,tagged_at,second) values(?,1,?,'todo',?,?,0.95)").run(model, summary, model, now())
  }
  const before = db.prepare('select * from tags order by item_id').all()
  const visible = Object.fromEntries(tasks(db).map(r => [r.id, r]))
  for (const [model, , summary] of rows) {
    assert.equal(visible[model].card, 'todo', model)
    assert.equal(visible[model].summary, summary, model)
    assert.equal(visible[model].state, 'open', model)
  }
  assert.deepEqual(db.prepare('select * from tags order by item_id').all(), before)
})
