import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.KIER_DATA_DIR = mkdtempSync(join(tmpdir(), 'kier-phone-'))
const { clockOf } = await import('../lib/tasks.mjs')

test('a time in the task\'s words is its reminder time; a date with dots is not a time', () => {
  const at = (w) => clockOf({ when_words: w })
  assert.equal(at('u 9.30'), '09:30')
  assert.equal(at('at 14:00'), '14:00')
  assert.equal(at('u 17.45h'), '17:45')
  // A dotted day and month is a date, not an alert time.
  assert.equal(at('9.11.'), null)
  assert.equal(at('do 15.11.'), null)
  assert.equal(at('9.11.2026'), null)
  assert.equal(at('sutra u 10'), null)
})
