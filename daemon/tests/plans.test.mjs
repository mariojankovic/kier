import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.KIER_DATA_DIR = mkdtempSync(join(tmpdir(), 'kier-plans-'))
const { datesOf, group, parse, shows } = await import('../lib/plans.mjs')

const at = (iso) => Math.floor(Date.parse(`${iso}T10:00:00Z`) / 1000)
const row = (item_id, sent, what, day, starts = '', ends = '', more = {}) =>
  ({ item_id, source: 'whatsapp', thread: 'Puzzle club', ts: at(sent), what, day, starts, ends, weekly: 0, cancelled: 0, ...more })

// Invented weekly sessions, rescheduled once and repeated in a later week.
const puzzles = [
  row('a', '2028-02-04', 'Puzzle club', '2028-02-11', '10:20', '11:50'),
  row('b', '2028-02-08', 'Puzzle club', '2028-02-11', '10:20', '11:50'),
  row('c', '2028-02-11', 'Puzzle club', '2028-02-11', '13:10', '14:40'),
  row('d', '2028-02-21', 'Puzzle club', '2028-02-25', '13:10', '14:40'),
]

test('messages about the same club make one weekly plan at the latest time', () => {
  const [p, ...rest] = group(puzzles)
  assert.equal(rest.length, 0)
  assert.equal(p.weekly, true)
  assert.deepEqual([p.what, p.starts, p.ends, p.weekday], ['Puzzle club', '13:10', '14:40', 5])
  assert.deepEqual(datesOf(p, '2028-03-06', '2028-03-12'), ['2028-03-10'])
})

test('a weekly plan stops eight weeks after it was last mentioned, and skips a cancelled week', () => {
  const [p] = group([...puzzles, row('e', '2028-03-06', 'Puzzle club', '2028-03-10', '', '', { cancelled: 1 })])
  assert.deepEqual(datesOf(p, '2028-03-06', '2028-03-19'), ['2028-03-17'])
  const [q] = group(puzzles)
  assert.deepEqual(datesOf(q, '2028-04-17', '2028-05-04'), [])
})

test('a one-off plan is only its own day, and a different thing in the same chat stays apart', () => {
  const plans = group([...puzzles, row('f', '2028-03-03', 'Walk with Filip', '2028-03-10', '12:10')])
  assert.equal(plans.length, 2)
  const walk = plans.find((p) => p.what === 'Walk with Filip')
  assert.equal(walk.weekly, false)
  assert.deepEqual(datesOf(walk, '2028-03-05', '2028-04-03'), ['2028-03-10'])
})

test('a plan without a time doesn\'t show: mostly talk, when a discussion mentions a weekday but no appointment', () => {
  const [battle] = group([row('g', '2028-03-04', 'Puzzle sorting', '2028-03-10', '', '', { thread: 'Borna', weekly: 1 })])
  assert.equal(shows(battle), false)
  assert.equal(shows(group(puzzles)[0]), true)
})

test('the day comes from the message, never from the model', () => {
  const item = { id: 'x', ts: at('2028-02-21'), text: 'Slazemo puzzle ovaj petak od 13:10 do 14:40 u citaonici.' }
  const p = parse('{"plan": true, "when": "ovaj petak", "start": "13:10", "end": "14:40", "weekly": false, "what": "Puzzle club", "due": "2028-04-28"}', item)
  assert.deepEqual([p.is_plan, p.day, p.starts, p.ends], [1, '2028-02-25', '13:10', '14:40'])
  // Words the message doesn't have are made up: no plan.
  assert.equal(parse('{"plan": true, "when": "next Monday", "start": "", "what": "Puzzle club"}', item).is_plan, 0)
  // A bare time is the day it was sent (a club time announced that morning).
  const moved = { id: 'y', ts: at('2028-02-11'), text: 'Danas je klub od 13:10 do 14:40.' }
  assert.equal(parse('{"plan": true, "when": "", "start": "13:10", "end": "14:40", "what": "Puzzle club"}', moved).day, '2028-02-11')
})
