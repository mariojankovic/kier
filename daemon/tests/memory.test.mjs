import { test } from 'node:test'
import assert from 'node:assert/strict'
import { roomy } from '../lib/memory.mjs'

const min = 60_000
const t = Date.now()

test('background reading waits while memory is tight, longer each time within the hour', () => {
  assert.deepEqual(roomy(t, 1), { ok: true, note: undefined })
  assert.match(roomy(t + 1000, 2).note, /waits 5 min/)
  // Still waiting, even once macOS says it's fine: a few quiet minutes first.
  assert.equal(roomy(t + 2 * min, 1).ok, false)
  assert.deepEqual(roomy(t + 6 * min, 1), { ok: true, note: 'memory is fine again: background reading goes on' })
  assert.match(roomy(t + 7 * min, 4).note, /waits 10 min/)
  assert.equal(roomy(t + 12 * min, 1).ok, false)
  // An hour on from the last time, it starts again from a short wait.
  assert.equal(roomy(t + 18 * min, 1).ok, true)
  assert.match(roomy(t + 90 * min, 2).note, /waits 5 min/)
})
