import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, chmodSync, statSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
const dir = mkdtempSync(join(tmpdir(), 'kier-storage-test-'))
process.env.KIER_DATA_DIR = dir
mkdirSync(join(dir, 'tmp'), { mode: 0o755 })
chmodSync(dir, 0o755)
const { open } = await import('../lib/db.mjs')
const { snapshot } = await import('../collectors/util.mjs')
const { parse } = await import('../lib/tagger.mjs')
after(() => rmSync(dir, { recursive: true, force: true }))

test('existing data, temporary folders, databases and collector copies are private', () => {
  const path = join(dir, 'fixture.db')
  let db = open(path); db.close(); chmodSync(path, 0o644)
  db = open(path); db.close()
  assert.equal(statSync(dir).mode & 0o777, 0o700)
  assert.equal(statSync(join(dir, 'tmp')).mode & 0o777, 0o700)
  assert.equal(statSync(path).mode & 0o777, 0o600)
  chmodSync(path, 0o644)
  const copy = snapshot(path, 'fixture')
  assert.equal(statSync(join(dir, 'tmp/fixture.sqlite')).mode & 0o777, 0o600)
  copy.close()
})

test('invalid model output never appears in parser errors', () => {
  for (const raw of ['private fixture message', '{"summary":"private fixture message", invalid}']) {
    assert.throws(() => parse(raw, {}), e => e.message === 'unreadable model answer')
  }
})
