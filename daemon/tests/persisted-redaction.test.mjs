import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
const dir = mkdtempSync(join(tmpdir(), 'kier-redaction-fixture-'))
process.env.KIER_DATA_DIR = dir
writeFileSync(join(dir, 'config.json'), JSON.stringify({ me: 'Sam', fullName: 'Sam' }))
const { open, addItems } = await import('../lib/db.mjs')
after(() => rmSync(dir, { recursive: true, force: true }))
const token = ['sk', 'synthetic_fixture_only_1234567890'].join('-')
const items = () => [
  { id: 'ai-fixture', source: 'ai', ts: 1, thread: `Session ${token}`, sender: `Sam ${token}`, text: `AI title ${token}`, url: `https://example.test/${token}`,
    meta: { title: token, nested: [{ request: token, n: 3, flag: true, empty: null }] } },
  { id: 'calendar-fixture', source: 'calendar', ts: 1, thread: 'Calendar', text: `Summary ${token}`, meta: { summary: token, location: `Room ${token}` } },
]
test('insert redacts AI titles, calendar locations and every nested content string', () => {
  const db = open(':memory:')
  try {
    assert.equal(addItems(db, items()), 2)
    const rows = db.prepare('select * from items order by id').all()
    assert.ok(!JSON.stringify(rows).includes(token))
    assert.equal(rows[0].thread, 'Session [SECRET]')
    assert.equal(rows[0].sender, 'Sam [SECRET]')
    assert.deepEqual(JSON.parse(rows[0].meta).nested, [{ request: '[SECRET]', n: 3, flag: true, empty: null }])
    assert.equal(JSON.parse(rows[1].meta).location, 'Room [SECRET]')
  } finally { db.close() }
})
test('startup repairs legacy rows and cached text once, with an idempotent migration record', () => {
  const path = join(dir, 'legacy.db')
  let db = open(path)
  db.exec('delete from migrations')
  for (const i of items()) db.prepare('insert into items (id,source,ts,thread,sender,text,url,meta) values (?,?,?,?,?,?,?,?)')
    .run(i.id, i.source, i.ts, i.thread, i.sender ?? null, i.text, i.url ?? null, JSON.stringify(i.meta))
  db.prepare('insert into chats(key,ts,q,a) values (?,?,?,?)').run('general', 1, token, token)
  db.close()
  db = open(path)
  const snapshot = JSON.stringify(db.prepare('select * from items order by id').all())
  assert.ok(!snapshot.includes(token))
  assert.ok(!JSON.stringify(db.prepare('select * from chats').all()).includes(token))
  assert.equal(db.prepare('select count(*) n from migrations').get().n, 1)
  const at = db.prepare('select at from migrations').get().at
  db.close()
  db = open(path)
  try {
    assert.equal(JSON.stringify(db.prepare('select * from items order by id').all()), snapshot)
    assert.equal(db.prepare('select at from migrations').get().at, at)
  } finally { db.close() }
})
test('the repair keeps search fingerprints of unchanged messages and drops only redacted ones', () => {
  const path = join(dir, 'vectors.db')
  let db = open(path)
  db.exec('delete from migrations')
  const insert = db.prepare('insert into items (id,source,ts,thread,sender,text,url,meta) values (?,?,?,?,?,?,?,?)')
  insert.run('clean', 'whatsapp', 1, 'Nika', 'Nika', 'See you at the library', null, '{ "group": false }')
  insert.run('leaky', 'whatsapp', 2, 'Filip', 'Filip', `key ${token}`, null, '{"group":false}')
  const vec = db.prepare('insert into vectors (item_id, v) values (?, ?)')
  vec.run('clean', Buffer.alloc(8)); vec.run('leaky', Buffer.alloc(8))
  db.close()
  db = open(path)
  try {
    assert.deepEqual(db.prepare('select item_id from vectors order by item_id').all().map((r) => r.item_id), ['clean'])
    assert.equal(db.prepare("select meta from items where id = 'clean'").get().meta, '{ "group": false }')
  } finally { db.close() }
})
