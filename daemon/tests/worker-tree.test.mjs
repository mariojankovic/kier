import { test } from 'node:test'
import assert from 'node:assert/strict'
import { processRows, descendantRows } from '../lib/worker-tree.mjs'
test('tree traversal follows parents across sessions and rejects reused PIDs', () => {
  const entries = [[10, 1, 'first'], [11, 10, 'second'], [12, 11, 'third'], [13, 1, 'fourth']]
  const rows = processRows(entries.map(([pid, parent, born]) => `${pid} ${parent} ${process.getuid()} ${born}`).join('\n'))
  assert.deepEqual(descendantRows(rows, 10).map(r => r.pid), [10, 11, 12])
  assert.deepEqual(descendantRows(rows, 99, new Map([[13, 'old birth']])).map(r => r.pid), [])
  assert.deepEqual(descendantRows(rows, 99, new Map([[13, rows[3].born]])).map(r => r.pid), [13])
})
