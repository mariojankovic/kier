import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.KIER_DATA_DIR = mkdtempSync(join(tmpdir(), 'kier-reply-context-'))
after(() => rmSync(process.env.KIER_DATA_DIR, { recursive: true, force: true }))
const { open, addItems, now } = await import('../lib/db.mjs')
const { config } = await import('../lib/config.mjs')
const { burstOf, contextFor, contextForTag, needsContext, messages, tagPending, doubleCheck } = await import('../lib/tagger.mjs')

const AT = now() - 1800
const QUESTION = 'Jesi li završila knjigu iz knjižnice?'
const REPLIES = ['Preostalo mi je nekoliko stranica', 'Posljednje poglavlje je vrlo zanimljivo']
function vault(t) { const db = open(':memory:'); t.after(() => db.close()); return db }
function message(db, id, text, { ts = AT, owner = false, source = 'whatsapp', thread = 'Nika', group = false } = {}) {
  addItems(db, [{ id, source, thread, sender: owner ? config.me : 'Nika', fromMe: owner, ts, text, meta: { group } }])
  return db.prepare('select * from items where id = ?').get(id)
}
function tagged(db, id, { task = 0, said = null } = {}) {
  db.prepare('insert into tags(item_id,is_task,tagged_at,model,summary,said) values(?,?,?,\'fixture\',\'Fixture\',?)').run(id, task, AT, said)
}

const { modelFixture } = await import('./model-fixture.mjs')
await modelFixture({ decision: true })

test('a short answer keeps its owner question without importing an older work topic', t => {
  const db = vault(t)
  message(db, 'old-work', 'The cardboard maze needs more paper walls. '.repeat(8), { ts: AT - 300 })
  message(db, 'owner-question', QUESTION, { owner: true, ts: AT - 14 })
  message(db, 'part-1', REPLIES[0])
  const item = message(db, 'part-2', REPLIES[1], { ts: AT + 6 })
  const burst = burstOf(db, item)
  assert.equal(burst.text, REPLIES.join('\n'))
  assert.equal(needsContext(burst.text), false)
  const context = contextForTag(db, burst.start, burst.text)
  assert.deepEqual(context.map(c => [c.from, c.text]), [[config.me, QUESTION]])
  const user = messages({ ...item, text: burst.read }, context).at(-1).content
  assert.ok(user.indexOf(QUESTION) < user.indexOf('Message to tag:'))
  assert.ok(user.endsWith(REPLIES.join('\n')))
  assert.doesNotMatch(user, /cardboard|maze|walls/i)
})

test('same-second messages respect stored order, including the adjacent owner turn', t => {
  const db = vault(t)
  message(db, 'first', 'The next reply answers this.', { owner: true })
  const item = message(db, 'current', REPLIES[0])
  message(db, 'later', 'A different subject after the answer.', { owner: true })
  assert.deepEqual(contextFor(db, item, 8).map(c => c.text), ['The next reply answers this.'])
  assert.deepEqual(contextForTag(db, item).map(c => c.text), ['The next reply answers this.'])
})

test('extra reply context stays limited to recent direct incoming turns', t => {
  for (const [name, overrides, previous] of [
    ['group', { group: true }, {}],
    ['outgoing', { owner: true }, {}],
    ['stale', {}, { ts: AT - 181 }],
    ['long-current', { text: 'The current request is self-contained. '.repeat(12) }, {}],
    ['long-previous', {}, { text: 'The earlier work discussion is unrelated. '.repeat(12) }],
    ['unclassified-discord-channel', { source: 'discord', group: null }, { source: 'discord', group: null }],
  ]) {
    const db = vault(t)
    message(db, `${name}-question`, previous.text || QUESTION, { owner: true, ts: AT - 10, ...previous })
    const item = message(db, `${name}-reply`, overrides.text || REPLIES[0], overrides)
    assert.deepEqual(contextForTag(db, item), [], name)
  }
  const db = vault(t)
  message(db, 'question', QUESTION, { owner: true, ts: AT - 60 })
  message(db, 'intervening', 'A separate answer already arrived.', { ts: AT - 30 })
  const item = message(db, 'reply', REPLIES[0])
  assert.deepEqual(contextForTag(db, item), [])
})

test('existing short-reply referents still use the ordinary topic-bounded context', t => {
  const db = vault(t)
  message(db, 'old-work', 'The cardboard maze needs more paper walls. '.repeat(8), { ts: AT - 1200 })
  message(db, 'new-topic', 'BTW, can you add the missing icons?', { ts: AT - 600 })
  message(db, 'detail', 'We need the small sizes too.', { ts: AT - 590 })
  const item = message(db, 'owner', 'I am drawing them.', { ts: AT, owner: true })
  assert.deepEqual(contextForTag(db, item).map(c => c.text), ['BTW, can you add the missing icons?', 'We need the small sizes too.'])
})

test('fresh tagging sends the whole short reply burst with its question and stores no invented task', async t => {
  const db = vault(t)
  const question = message(db, 'question', QUESTION, { owner: true, ts: AT - 14 }); tagged(db, question.id)
  message(db, 'first', REPLIES[0])
  message(db, 'last', REPLIES[1], { ts: AT + 6 })
  const primary = []
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    const path = new URL(url).pathname
    if (path === '/api/version') return { ok: true }
    assert.equal(path, '/api/chat')
    const body = JSON.parse(options.body); primary.push(body)
    return { ok: true, json: async () => ({ message: { content: JSON.stringify({ is_task: false, summary: 'Nika opisuje knjigu iz knjižnice', when: '', due: '', amount: '', urgency: 0 }) } }) }
  })
  const result = await tagPending(db)
  assert.equal(result.tagged, 2); assert.equal(result.failed, 0)
  assert.equal(primary.length, 1)
  const user = primary[0].messages.at(-1).content
  assert.match(user, /Earlier in this chat \(context only\):/)
  assert.ok(user.includes(QUESTION)); assert.ok(user.endsWith(REPLIES.join('\n')))
  assert.equal(db.prepare("select is_task from tags where item_id='last'").get().is_task, 0)
  assert.equal(db.prepare("select said from tags where item_id='last'").get().said, REPLIES.join('\n'))
})

test('secondary ownership and card checks get the same preceding turn and original burst separately', async t => {
  const db = vault(t)
  message(db, 'question', QUESTION, { owner: true, ts: AT - 14 })
  message(db, 'first', REPLIES[0])
  const last = message(db, 'last', REPLIES[1], { ts: AT + 6 })
  tagged(db, last.id, { task: 1, said: REPLIES.join('\n') })
  const requests = new Map()
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    const path = new URL(url).pathname
    if (path === '/health') return { ok: true }
    const body = JSON.parse(options.body); requests.set(path, body)
    if (path === '/decide') return { ok: true, json: async () => ({ p_task: [0.01] }) }
    if (path === '/ask') return { ok: true, json: async () => ({ answers: [{ card: { choice: 'todo' } }] }) }
    assert.fail(`unexpected request ${url}`)
  })
  assert.deepEqual(await doubleCheck(db), { checked: 1 })
  const decision = requests.get('/decide').messages[0]
  assert.equal(decision.text, REPLIES.join('\n'))
  assert.deepEqual(decision.context.map(c => [c.from, c.text]), [[config.me, QUESTION]])
  const card = requests.get('/ask').states[0]
  assert.equal(card.message_to_judge.text, REPLIES.join('\n'))
  assert.deepEqual(card.earlier_messages, decision.context)
  assert.equal(db.prepare("select second from tags where item_id='last'").get().second, 0.01)
})

test('real pickup requests and invitations remain tasks with their original message intact', async t => {
  for (const [kind, text] of [
    ['pickup', 'Can you pick me up tomorrow at 10:20?'],
    ['invite', 'Join me for a puzzle tomorrow at 15:10.'],
  ]) {
    const db = vault(t)
    const question = message(db, `${kind}-question`, 'What are your plans tomorrow?', { owner: true, ts: AT - 14 }); tagged(db, question.id)
    message(db, kind, text)
    const requests = []
    t.mock.method(globalThis, 'fetch', async (url, options) => {
      const path = new URL(url).pathname
      if (path === '/api/version' || path === '/health') return { ok: true }
      const body = JSON.parse(options.body)
      if (path === '/api/chat') {
        requests.push(body)
        return { ok: true, json: async () => ({ message: { content: JSON.stringify({ is_task: true, summary: kind === 'pickup' ? 'Pick Nika up tomorrow' : 'Join Nika for a puzzle tomorrow', when: 'tomorrow', due: '', amount: '', urgency: 1 }) } }) }
      }
      if (path === '/decide') return { ok: true, json: async () => ({ p_task: [0.95] }) }
      if (path === '/ask') return { ok: true, json: async () => ({ answers: [{ card: { choice: kind === 'invite' ? 'appointment' : 'todo' } }] }) }
      assert.fail(`unexpected request ${url}`)
    })
    const result = await tagPending(db)
    assert.equal(result.failed, 0)
    assert.equal(requests.length, 1)
    assert.ok(requests[0].messages.at(-1).content.endsWith(text))
    const saved = db.prepare('select is_task,second,card from tags where item_id=?').get(kind)
    assert.equal(saved.is_task, 1); assert.equal(saved.second, 0.95)
    assert.equal(saved.card, kind === 'invite' ? 'appointment' : 'todo')
  }
})
