import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
process.env.KIER_DATA_DIR = mkdtempSync(join(tmpdir(), 'kier-scope-cache-'))
after(() => rmSync(process.env.KIER_DATA_DIR, { recursive: true, force: true }))
const { open, addItems, now } = await import('../lib/db.mjs')
const { readScope, authorization } = await import('../lib/authorization.mjs')
const { forget } = await import('../lib/privacy.mjs')

const ids = (db, auth) => readScope(db, auth).prepare('select id from items order by id').all().map((r) => r.id)
const message = (id, source, thread) => ({ id, source, thread, sender: thread, fromMe: false, ts: now(), text: `Library return for ${thread}`, meta: {} })

test('the cached scope follows new messages, Forget and a changed off-list at once', () => {
  const db = open(':memory:')
  try {
    addItems(db, [message('a', 'whatsapp', 'Nika'), message('b', 'whatsapp', 'Filip'), message('c', 'imessage', 'Tea')])
    const all = authorization(null, [])
    assert.deepEqual(ids(db, all), ['a', 'b', 'c'])
    assert.deepEqual(ids(db, all), ['a', 'b', 'c'], 'a repeated read uses the same answer')
    addItems(db, [message('d', 'whatsapp', 'Borna')])
    assert.deepEqual(ids(db, all), ['a', 'b', 'c', 'd'], 'a new message is readable at once')
    forget(db, { id: 'b' })
    assert.deepEqual(ids(db, all), ['a', 'c', 'd'], 'a forgotten message disappears at once')
    assert.deepEqual(ids(db, authorization(null, ['whatsapp'])), ['c'], 'a switched off source disappears at once')
    assert.deepEqual(ids(db, all), ['a', 'c', 'd'])
  } finally { db.close() }
})
