import { test } from 'node:test'
import assert from 'node:assert/strict'
import { resolveDue } from '../lib/dates.mjs'

// Sat 2026-10-10 13:53 in the configured European timezone
const sat = Date.UTC(2026, 9, 10, 11, 53) / 1000

test('weekday words resolve forward from the sent date', () => {
  assert.equal(resolveDue('u pon', '2026-10-19', sat, 'moze to u pon rijesimo'), '2026-10-12')
  assert.equal(resolveDue('u petak', '', sat, 'vidimo se u petak'), '2026-10-16')
  assert.equal(resolveDue('subotu', '', sat, 'u subotu opet'), '2026-10-17')
})

test('relative words', () => {
  assert.equal(resolveDue('sutra', '', sat, 'javi mi sutra'), '2026-10-11')
  assert.equal(resolveDue('prekosutra', '', sat, 'prekosutra je rok'), '2026-10-12')
  assert.equal(resolveDue('večeras', '', sat, 'Riješit ću to večeras'), '2026-10-10')
  assert.equal(resolveDue('u 22:30', '', sat, 'Ej Nika, može u 22:30?'), '2026-10-10')
})

test('explicit dates', () => {
  assert.equal(resolveDue('do 31.10.2026', '', sat, 'za plaćanje do 31.10.2026'), '2026-10-31')
  assert.equal(resolveDue('25.9.', '', sat, 'molimo do 25.9. uplatite'), '2026-09-25')
  assert.equal(resolveDue('20 lis', '', sat, 'utorak, 20 lis u 09:00'), '2026-10-20')
  assert.equal(resolveDue('15.1.', '', Date.UTC(2026, 11, 20) / 1000, 'rok je 15.1.'), '2027-01-15')
})

test('words that are not in the message are ignored', () => {
  assert.equal(resolveDue('tomorrow', '2026-10-11', sat, 'Please send the diagram'), '')
  assert.equal(resolveDue('', '2026-10-11', sat, 'anything'), '')
})

test('an hour is not a Saturday', () => {
  assert.equal(resolveDue('sat', '', sat, 'treba mi jos sat'), '')
})

test('a date written with slashes follows the region, unless only one reading can be a date', () => {
  const us = { monthFirst: true }, elsewhere = { monthFirst: false }
  assert.equal(resolveDue('11/5', '', sat, 'send it by 11/5', us), '2026-11-05')
  assert.equal(resolveDue('11/5', '', sat, 'send it by 11/5', elsewhere), '2026-05-11')
  assert.equal(resolveDue('19/11', '', sat, 'due 19/11', us), '2026-11-19')
  assert.equal(resolveDue('11/19', '', sat, 'due 11/19', elsewhere), '2026-11-19')
  assert.equal(resolveDue('3/1/27', '', sat, 'renew on 3/1/27', us), '2027-03-01')
  assert.equal(resolveDue('3/1/2027', '', sat, 'renew on 3/1/2027', elsewhere), '2027-01-03')
})

test('"24/7" and a month that does not exist are not dates', () => {
  assert.equal(resolveDue('24/7', '', sat, 'support is there 24/7', { monthFirst: false }), '')
  assert.equal(resolveDue('40/40', '', sat, 'the score was 40/40', { monthFirst: true }), '')
})
