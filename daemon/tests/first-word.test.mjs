import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.KIER_DATA_DIR = mkdtempSync(join(tmpdir(), 'kier-first-word-'))
writeFileSync(join(process.env.KIER_DATA_DIR, 'config.json'), JSON.stringify({ me: 'Jonas', languages: ['Croatian', 'English'] }))
const { open, addItems, now } = await import('../lib/db.mjs')
const { config } = await import('../lib/config.mjs')
const { ASK_VERBS } = await import('../lib/lang.mjs')
const { tagPending, settles, FIRST_WORD, FIRST_NO, OWN_ASKS } = await import('../lib/tagger.mjs')
const { waiting } = await import('../lib/tasks.mjs')
const { modelFixture } = await import('./model-fixture.mjs')
await modelFixture({ decision: true })

// Invented chats. The full reading is a stub: anything about a contract is a task, the owner asking for a list is
// summarised the way a request is, the rest is small talk. `read` lists what it was shown.
function vault(t, name, items) {
  const db = open(join(process.env.KIER_DATA_DIR, `${name}.db`))
  t.after(() => db.close())
  addItems(db, items)
  const read = []
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    const path = new URL(url).pathname
    if (path === '/api/version' || path === '/health') return { ok: true }
    const body = JSON.parse(options.body)
    if (path === '/api/chat') {
      const shown = body.messages.at(-1).content
      read.push(shown)
      const task = /contract/.test(shown)
      const summary = task ? 'Send the contract' : /send me the list/.test(shown) ? 'Jonas asks Filip to send the list of films' : 'Small talk'
      return { ok: true, json: async () => ({ message: { content: JSON.stringify({ is_task: task, when: '', due: '', amount: '', urgency: task ? 1 : 0, summary }) } }) }
    }
    if (path === '/decide') return { ok: true, json: async () => ({ p_task: body.messages.map(() => 0.93) }) }
    if (path === '/ask') return { ok: true, json: async () => ({ answers: body.states.map(() => ({ card: { choice: 'todo' } })) }) }
    assert.fail(`unexpected fetch: ${url}`)
  })
  const tags = () => Object.fromEntries(db.prepare('select * from tags').all().map((r) => [r.item_id, r]))
  return { db, read, tags }
}
const at = now()
const chat = (id, thread, text, extra = {}) => ({ id, source: 'whatsapp', sender: thread, thread, ts: at - 900, text, ...extra })
const mine = (id, thread, text) => chat(id, thread, text, { sender: 'Jonas', fromMe: true })
const items = () => [
  chat('joke', 'Tea', 'haha that film was something else'),
  chat('ask', 'Priya', 'can you send me the signed contract tomorrow?'),
  chat('unsure', 'Borna', 'we should sort that thing out at some point'),
  mine('chat', 'Lucija', 'sounds good to me, see you at the film'),
  mine('request', 'Filip', 'Filip, send me the list of films by Thursday'),
]
// The model's side of a batch, scripted: how sure the first word is "false", and for the owner's own messages how much
// of what would start the summary is a request verb.
const sweeper = (calls, { no = (shown) => (/film/.test(shown) ? 0.99 : /contract/.test(shown) ? 0.02 : 0.7), asks = (shown) => (/send me the list/.test(shown) ? 0.8 : 0.01), second = true } = {}) => async (request) => {
  calls.push(request)
  return { results: request.prompts.map((p, k) => {
    const shown = p.at(-1).content, f = no(shown)
    return { options: { true: 1 - f, false: f }, covered: 0.99, ...(second && request.more?.for.includes(k) && { more: { options: {}, covered: asks(shown) } }) }
  }) }
}

test('a sure "false" is settled in one pass; a "true", an unsure one, or the owner asking someone gets the full reading', async (t) => {
  const { db, read, tags } = vault(t, 'settled', items())
  const calls = []
  const result = await tagPending(db, { sweep: sweeper(calls) })
  assert.equal(result.tagged, 5)
  assert.equal(result.failed, 0)
  assert.equal(calls.length, 1)
  const [asked] = calls
  assert.deepEqual([asked.lead, asked.choices], ['{"is_task":', ['true', 'false']])
  assert.equal(asked.prompts.length, 5)
  // Only the owner's own are asked the second thing, and it is the rest of a "false" answer up to their name.
  const own = (p) => /"fromMe":true/.test(p.at(-1).content)
  assert.deepEqual(asked.more.for.map((k) => own(asked.prompts[k])), [true, true])
  assert.equal(asked.prompts.filter(own).length, 2)
  assert.equal(asked.more.lead, 'false,"when":"","due":"","amount":"","urgency":0,"summary":"Jonas')
  assert.deepEqual(asked.more.choices, ASK_VERBS.map((v) => ` ${v}`))
  assert.equal(JSON.parse(`${asked.lead}${asked.more.lead} asks Filip to wait"}`).summary, 'Jonas asks Filip to wait', 'the two leads make the start of a real answer')

  const got = tags()
  for (const id of ['joke', 'chat']) assert.deepEqual([got[id].is_task, got[id].model, got[id].summary], [0, FIRST_WORD, ''], id)
  assert.ok(!read.some((shown) => /haha that film|see you at the film/.test(shown)), 'nothing more was written for them')
  assert.deepEqual([got.ask.is_task, got.ask.model], [1, config.model])
  assert.deepEqual([got.unsure.is_task, got.unsure.model], [0, config.model])
  assert.ok(0.7 < FIRST_NO)
  // The owner's request is not a task of theirs, and its summary is what Waiting on others shows.
  assert.deepEqual([got.request.is_task, got.request.model, got.request.summary], [0, config.model, 'Jonas asks Filip to send the list of films'])
  assert.deepEqual(waiting(db).map((w) => [w.id, w.who, w.what]), [['request', 'Filip', 'send the list of films']])
})

test('what settles: sure of "false", the answer was on the form, and for the owner\'s own also sure of asking no one', () => {
  const result = (no, covered, asks) => ({ options: { true: 1 - no, false: no }, covered, ...(asks !== undefined && { more: { options: {}, covered: asks } }) })
  assert.equal(settles(result(0.95, 0.99), false), true)
  assert.equal(settles(result(FIRST_NO - 0.01, 0.99), false), false)
  assert.equal(settles(result(0.99, 0.5), false), false)
  assert.equal(settles(result(0.99, 0.99, OWN_ASKS / 2), true), true)
  assert.equal(settles(result(0.99, 0.99, OWN_ASKS * 2), true), false)
  assert.equal(settles(result(0.99, 0.99), true), false, 'the owner\'s own with no second answer is never settled')
  assert.equal(settles(undefined, false), false)
})

test('with no forms, or a batch that gave way, everything is read in full as before', async (t) => {
  for (const [name, sweep] of [['none', async () => null], ['failed', async () => { throw Error('gave way') }]]) {
    const { db, read, tags } = vault(t, name, items())
    assert.equal((await tagPending(db, { sweep })).tagged, 5)
    assert.equal(read.length, 5)
    assert.ok(Object.values(tags()).every((r) => r.model === config.model))
  }
})

test('a pass that answers only the first question settles nothing of the owner\'s own', async (t) => {
  const { db, tags } = vault(t, 'first-only', items())
  await tagPending(db, { sweep: sweeper([], { second: false }) })
  const got = tags()
  assert.equal(got.joke.model, FIRST_WORD)
  assert.deepEqual([got.chat.model, got.request.model], [config.model, config.model])
})

test('a "false" the model put aside part of its answer for is not taken', async (t) => {
  const { db, tags } = vault(t, 'covered', [chat('joke', 'Tea', 'haha that film was something else')])
  const sweep = async ({ prompts }) => ({ results: prompts.map(() => ({ options: { true: 0.01, false: 0.99 }, covered: 0.4 })) })
  await tagPending(db, { sweep })
  assert.equal(tags().joke.model, config.model)
})

test('a chat that moved on between the pass and the reading is read in full', async (t) => {
  // A short message is read with the chat before it. `arrives` is another line landing in that chat while the batch
  // is being asked; without it the same message is settled, which is what shows the arrival is why it isn't.
  const earlier = (id, text, ago) => chat(id, 'Tea', text, { ts: at - ago })
  for (const arrives of [false, true]) {
    const { db, read, tags } = vault(t, `moved-${arrives}`, [earlier('before', 'did you watch the documentary in the end', 3000), chat('short', 'Tea', 'haha film', { ts: at - 600 })])
    const settle = (id) => db.prepare("insert into tags (item_id, is_task, model, tagged_at) values (?, 0, 'test', ?)").run(id, at)
    settle('before')
    const sweep = async (request) => {
      const out = await sweeper([])(request)
      if (arrives) { addItems(db, [earlier('late', 'and what did you think of the ending', 2900)]); settle('late') }
      return out
    }
    await tagPending(db, { sweep })
    assert.equal(tags().short.model, arrives ? config.model : FIRST_WORD)
    assert.equal(read.some((shown) => /haha film/.test(shown)), arrives)
  }
})

test('switched off, nothing is asked', async (t) => {
  const { db, read } = vault(t, 'off', items())
  config.firstWord = false
  t.after(() => { config.firstWord = true })
  const calls = []
  await tagPending(db, { sweep: sweeper(calls) })
  assert.equal(calls.length, 0)
  assert.equal(read.length, 5)
})
