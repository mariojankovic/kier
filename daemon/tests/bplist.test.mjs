import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { parseBplist } from '../lib/bplist.mjs'

// plutil writes the same binary format Notification Center uses.
const binary = (value) => execFileSync('plutil', ['-convert', 'binary1', '-o', '-', '-'], { input: JSON.stringify(value) })

test('reads a notification shaped record', () => {
  const record = { app: 'com.viber.osx', req: { titl: 'Nika', subt: 'Radionica', body: 'Ponesi 28€ za glinu 🎨', thre: 'abc' }, date: 1_760_000_000.5, styl: 1 }
  assert.deepEqual(parseBplist(binary(record)), record)
})

test('reads long strings, nested arrays and booleans', () => {
  const value = { long: 'x'.repeat(300), list: [1, 2, [3, 'četiri']], ok: true, no: false }
  assert.deepEqual(parseBplist(binary(value)), value)
})

test('rejects anything that is not a binary plist', () => {
  assert.throws(() => parseBplist(Buffer.from('{"a":1}')))
})
