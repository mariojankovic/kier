import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.KIER_DATA_DIR = mkdtempSync(join(tmpdir(), 'kier-priority-action-'))
after(() => rmSync(process.env.KIER_DATA_DIR, { recursive: true, force: true }))
writeFileSync(join(process.env.KIER_DATA_DIR, 'config.json'), JSON.stringify({ me: 'Jonas', languages: ['Croatian', 'English'], runtime: 'ollama' }))
writeFileSync(join(process.env.KIER_DATA_DIR, 'profile.json'), JSON.stringify({ aliases: [], people: [], groups: [] }))
writeFileSync(join(process.env.KIER_DATA_DIR, 'handles.json'), JSON.stringify({ Discord: ['jonas_notes'] }))

const { priorityStatement, actionCard } = await import('../lib/owner-action.mjs')
const { cards } = await import('../lib/second.mjs')
const { parse, tagPending } = await import('../lib/tagger.mjs')
const { tasks } = await import('../lib/tasks.mjs')
const { open, addItems, now } = await import('../lib/db.mjs')

const me = ['Jonas', 'jonas_notes']
const incoming = (text, extra = {}) => ({ id: 'priority', source: 'whatsapp', thread: 'Nika', sender: 'Nika', from_me: 0, ts: now() - 600, text, ...extra })
const ordering = 'Prvo je arhiva, pa onda katalog.'
function vault(t) { const db = open(':memory:'); t.after(() => db.close()); return db }

const { modelFixture } = await import('./model-fixture.mjs')
await modelFixture({ decision: true })

test('incoming declarative priorities are not owner tasks across chat spellings', () => {
  for (const text of [
    ordering,
    'Katalog nam je zadnji.',
    'Prvo je pretraživanje, pa onda izvještaji.',
    'Prvo je pretrazivanje, pa onda izvjestaji.',
    'Katalog nam bu zadnji.',
    'First storage, then search.',
    'Search should come last.',
    'Storage comes first, search comes last.',
    'Pa izvjestaji ko slag na kraju.',
    'Prvo je arhiva.\nKatalog je zadnji.',
  ]) assert.equal(priorityStatement(incoming(text), me), true, text)
})

test('ordering words do not swallow imperatives, addressed messages or mixed asks', () => {
  for (const text of [
    'Prvo napravi arhivu pa dodaj katalog.',
    'Prvo slozi arhivu pa katalog.',
    'Prvo popravi arhivu, katalog je zadnji.',
    'Prvo obrisi stari zapis pa katalog.',
    'Prvo otvori arhivu pa katalog.',
    'First deploy the archive, then test the search.',
    'First write the guide, then publish the index.',
    'First rename the table, then reindex it.',
    'First alphabetize the index, then reconcile the labels.',
    'Prvo preslozi izbornik pa prevedi gumbe.',
    'Prvo je arhiva, autoriziraj novi kljuc.',
    'Prvo je arhiva pa otvori katalog.',
    'Prvo je arhiva pa autoriziraj novi kljuc.',
    'Prvo je arhiva i ukljuci provjeru.',
    'First storage.',
    'Prvo katalog.',
    'Search should come last, can you update the roadmap?',
    'Katalog nam je zadnji, posalji mi nacrt.',
    'Prvo je arhiva, molim potvrdu redoslijeda.',
    'Jonas, prvo arhiva pa katalog.',
    '@jonas_notes prvo arhiva pa katalog.',
    'Ti prvo arhivu pa katalog.',
    'Prvo arhiva pa katalog?',
    'Jel prvo arhiva pa katalog',
  ]) assert.equal(priorityStatement(incoming(text), me), false, text)
})

test('ownership and existing payment or follow-up rules retain precedence', () => {
  for (const extra of [
    { from_me: 1 }, { amount: '12 EUR' }, { model: 'relay' }, { model: 'later' },
    { source: 'reminders' }, { source: 'calendar' }, { source: 'ai' }, { source: 'git' },
  ]) assert.equal(priorityStatement(incoming(ordering, extra), me), false, JSON.stringify(extra))
})

test('priority-looking schedules keep their temporal and arrangement evidence', () => {
  for (const text of [
    'Prvo je sastanak, pa onda obilazak.',
    'Prvo je arhiva sutra, pa onda katalog.',
    'First the meeting, then the workshop.',
    'First storage at 11:30, then search.',
  ]) assert.equal(priorityStatement(incoming(text), me), false, text)
})

test('transport sender labels do not become task evidence', () => {
  const sender = '\u2068Nika\u2069 (\u2068#sample\u2069, \u2068Text\u2069)'
  const item = incoming(`${sender}: ${ordering}`, { source: 'notifications', thread: 'Discord', sender })
  assert.equal(priorityStatement(item, me), true)
})

test('unsupported appointments use the message rather than an invented summary', () => {
  const item = incoming('Please repair the archive index.', { summary: 'Join the archive meeting tomorrow', due: '2026-12-07', when_words: 'tomorrow' })
  assert.equal(actionCard('appointment', item), 'todo')
  assert.equal(actionCard('appointment', incoming('@Jonas where is the spare key?')), 'reply')
  for (const card of ['todo', 'reply', 'payment', 'promise', 'callback']) assert.equal(actionCard(card, item), card)
})

test('real appointment words and times preserve appointment choices', () => {
  for (const text of [
    'Prekosutra u 11 sastanak.',
    'Prekosutra u citaonici.',
    'Sastanak kod ulaza.',
    'Join the call.',
    'Tomorrow at 11:30.',
    'U petak u 9.',
    'Dojdi v soboto ob 12.',
  ]) assert.equal(actionCard('appointment', incoming(text)), 'appointment', text)
})

test('second-opinion card choices are checked without reordering their batch', async t => {
  const requested = []
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    const path = new URL(url).pathname
    if (path === '/health') return { ok: true }
    assert.equal(path, '/ask')
    const body = JSON.parse(options.body)
    requested.push(...body.states)
    return { ok: true, json: async () => ({ answers: body.states.map(() => ({ card: { choice: 'appointment' } })) }) }
  })
  assert.deepEqual(await cards([
    incoming('Please repair the archive index.', { id: 'work' }),
    incoming('Prekosutra u 11 sastanak.', { id: 'meeting' }),
    incoming('@Jonas where is the spare key?', { id: 'reply' }),
    incoming(ordering, { id: 'payment', amount: '12 EUR' }),
  ]), ['todo', 'appointment', 'reply', 'payment'])
  assert.equal(requested.length, 2)
})

test('parsing rejects a confident invented implementation for a priority statement', () => {
  const verdict = parse(JSON.stringify({ is_task: true, summary: 'Implement the archive and catalogue', when: 'tomorrow', due: '2026-12-07', amount: '', urgency: 3 }), incoming(ordering))
  assert.equal(verdict.is_task, 0)
  assert.equal(verdict.urgency, 0)
  assert.equal(verdict.when_words, '')
  assert.equal(verdict.due, '')
  assert.doesNotMatch(verdict.summary, /implement/i)
})

test('fresh tagging checks the whole burst while preserving imperative work', async t => {
  const db = vault(t)
  const at = now() - 1200
  addItems(db, [
    incoming('Prvo je arhiva.', { id: 'order-first', thread: 'Ordering', ts: at }),
    incoming('Katalog nam je zadnji.', { id: 'order-last', thread: 'Ordering', ts: at + 8 }),
    incoming('Prvo napravi arhivu.', { id: 'work-first', thread: 'Work', ts: at + 120 }),
    incoming('Katalog nam je zadnji.', { id: 'work-last', thread: 'Work', ts: at + 128 }),
  ])
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    const path = new URL(url).pathname
    if (path === '/api/version' || path === '/health') return { ok: true }
    const body = JSON.parse(options.body)
    if (path === '/api/chat') return { ok: true, json: async () => ({ message: { content: JSON.stringify({ is_task: true, summary: 'Implement the archive and catalogue', when: '', due: '', amount: '', urgency: 3 }) } }) }
    if (path === '/decide') return { ok: true, json: async () => ({ p_task: body.messages.map(() => 0.98) }) }
    if (path === '/ask') return { ok: true, json: async () => ({ answers: body.states.map(() => ({ card: { choice: 'appointment' } })) }) }
    assert.fail(`unexpected fetch: ${url}`)
  })
  const result = await tagPending(db)
  assert.equal(result.tagged, 4)
  assert.equal(result.failed, 0)
  const saved = Object.fromEntries(db.prepare('select * from tags').all().map(row => [row.item_id, row]))
  assert.equal(saved['order-first'].is_task, 0)
  assert.equal(saved['order-last'].is_task, 0)
  assert.equal(saved['order-last'].said, 'Prvo je arhiva.\nKatalog nam je zadnji.')
  assert.equal(saved['work-last'].is_task, 1)
  assert.equal(saved['work-last'].card, 'todo')
  assert.equal(saved['work-last'].said, 'Prvo napravi arhivu.\nKatalog nam je zadnji.')
})

test('cached cards drop unclaimed priorities and repair types without DB changes', t => {
  const db = vault(t)
  const rows = [
    { id: 'drop', text: ordering },
    { id: 'burst', text: 'Katalog nam je zadnji.', said: 'Prvo je arhiva.\nKatalog nam je zadnji.' },
    { id: 'mixed', text: 'Katalog nam je zadnji.', said: 'Prvo napravi arhivu.\nKatalog nam je zadnji.' },
    { id: 'work', text: 'Please repair the archive index.' },
    { id: 'meeting', text: 'Prekosutra u 11 sastanak.' },
    { id: 'confirmed', text: ordering, confirmed: 1 },
    { id: 'done', text: ordering, status: 'done' },
    { id: 'reopened', text: ordering, status: 'open' },
    { id: 'snoozed', text: ordering, status: 'snoozed' },
    { id: 'outgoing', text: ordering, fromMe: true },
    { id: 'payment', text: ordering, amount: '12 EUR', card: 'payment' },
    { id: 'reminder', text: ordering, source: 'reminders' },
  ]
  const save = db.prepare('insert into tags(item_id,is_task,summary,card,model,tagged_at,second,said,confirmed,amount) values(?,1,?,?,\'fixture\',?,0.98,?,?,?)')
  for (const row of rows) {
    addItems(db, [incoming(row.text, { ...row, thread: row.id })])
    save.run(row.id, 'Implement the archive and catalogue', row.card || 'appointment', now(), row.said ?? null, row.confirmed ?? null, row.amount ?? '')
    if (row.status) db.prepare('insert into task_state(item_id,status,changed_at,reason) values(?,?,?,?)').run(row.id, row.status, now(), 'owner choice')
  }
  const before = db.prepare('select * from tags order by item_id').all()
  const states = db.prepare('select * from task_state order by item_id').all()
  const visible = Object.fromEntries(tasks(db).map(row => [row.id, row]))
  assert.equal(visible.drop, undefined)
  assert.equal(visible.burst, undefined)
  assert.equal(visible.mixed.card, 'todo')
  assert.equal(visible.work.card, 'todo')
  assert.equal(visible.meeting.card, 'appointment')
  for (const id of ['confirmed', 'done', 'reopened', 'snoozed', 'outgoing', 'payment', 'reminder']) assert.ok(visible[id], id)
  assert.deepEqual(db.prepare('select * from tags order by item_id').all(), before)
  assert.deepEqual(db.prepare('select * from task_state order by item_id').all(), states)
})
