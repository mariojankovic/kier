import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.KIER_DATA_DIR = mkdtempSync(join(tmpdir(), 'kier-diag-'))
const { open, addItems, now, recordRun } = await import('../lib/db.mjs')
const { diagnostics, kindOf } = await import('../lib/diagnostics.mjs')

// Everything personal a vault holds, and the places it leaks into: a failed read's error, the log, a Setup step's words.
const fixtureHome = ['', 'home', 'fixture'].join('/')
const t = now()
const db = open(join(process.env.KIER_DATA_DIR, 'kier.db'))
addItems(db, [
  { id: 'p1', source: 'whatsapp', thread: 'Secret Project Group', sender: 'Nika Example', fromMe: false, ts: t - 600,
    text: 'my booking reference is 5862, delivery to Example Lane 7', url: 'https://example.com/private?token=abc', meta: { group: true } },
  { id: 'p2', source: 'browser', thread: 'example.com', sender: 'Sam', fromMe: true, ts: t - 300, text: 'Account login - Example Finance', url: 'https://finance.example.com/login' },
])
db.prepare("insert into tags (item_id, is_task, summary, card, model, tagged_at) values ('p1', 1, 'Send Nika the booking photos', 'todo', 'test', ?)").run(t)
recordRun(db, 'whatsapp', { ok: false, error: `EACCES: permission denied, open '${fixtureHome}/Library/Group Containers/ChatStorage.sqlite' (nika@example.com)` })
writeFileSync(join(process.env.KIER_DATA_DIR, 'kier.log'), [
  '12:00:01 tag {"tagged":3,"failed":0}',
  '12:00:02 tag error: unreadable answer: Nika says the booking is in the cabinet',
  `12:00:03 local model: Traceback (most recent call last): File "${fixtureHome}/kier/llm_server.py"`,
  '12:00:04 search index fetch failed',
  '12:00:05 second opinion stopped (0)',
].join('\n'))
const steps = [{ id: 'fda', status: 'todo', detail: 'Nika Example, your Full Disk Access' }, { id: 'agent', status: 'done', detail: ['', 'home', 'fixture'].join('/') }]

test('the report holds nothing personal', async () => {
  const report = await diagnostics(db, { steps })
  for (const secret of ['Nika', 'Example', 'booking', '5862', 'Example Lane', 'Secret Project', 'example.com', 'token', ['', 'home', 'fixture'].join('/'), '@', 'Example Finance', 'Account', 'Sam'])
    assert.ok(!report.includes(secret), `"${secret}" got into the report`)
})

test('what it does hold: steps, sources, and trouble by kind', async () => {
  const report = await diagnostics(db, { steps })
  assert.match(report, /fda: todo/)
  assert.match(report, /whatsapp: on; .*; failed \(permission\); 1; 1/)
  assert.match(report, /unreadable: 1/)
  assert.match(report, /model: 1/)
  assert.match(report, /network: 1/)
  // a pass with nothing failed and a clean exit aren't trouble
  assert.doesNotMatch(report, /other:/)
})

test('kinds of trouble', () => {
  assert.equal(kindOf('tag {"tagged":2,"failed":3}'), 'tagging')
  assert.equal(kindOf("TypeError: Cannot read properties of undefined (reading 'x')"), 'code')
  assert.equal(kindOf('Error: listen EADDRINUSE: address already in use 127.0.0.1:4777'), 'port in use')
  assert.equal(kindOf('the request timed out'), 'timeout')
})
