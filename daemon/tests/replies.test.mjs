import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.KIER_DATA_DIR = mkdtempSync(join(tmpdir(), 'kier-replies-'))
const { ownWords } = await import('../collectors/screenchats.mjs')

// An invented accessible reply contains the reply's own "STIZEM" under the invite it answers.
const invite = ['@Sam', '@Priya @Jonas 8.2. u 14:10 slazemo papirnate zmajeve u citaonici. Dodite ako zelite 🙂 i',
  '@Priya', '@Jonas', '8.2. u 14:10 slazemo papirnate zmajeve u citaonici. Dodite ako zelite',
  'i javite treba li jos papira']

test('a reply keeps only its own words', () => {
  assert.deepEqual(ownWords({ name: 'Jonas replying to Sam , STIZEM , 12:14 PM' }, [...invite, 'STIZEM']), ['STIZEM'])
})

test('a reply of several lines, dated with a comma of its own', () => {
  const m = { name: 'Priya replying to Borna , moze. uzimam zeleni papir, plavog vise nema. , 02/03/28, 10:06 AM' }
  assert.deepEqual(ownWords(m, ['@Borna', 'koju boju uzimamo', 'moze.', 'uzimam zeleni papir, plavog vise nema.']),
    ['moze.', 'uzimam zeleni papir, plavog vise nema.'])
})

test('a message that answers no one is left as it is', () => {
  const lines = ['zmaj je gotov. 👍']
  assert.deepEqual(ownWords({ name: 'Priya , zmaj je gotov. 👍 , 8:20 AM' }, lines), lines)
  assert.deepEqual(ownWords({}, lines), lines)
})

test('a reply with nothing of its own, only a picture, keeps nothing', () => {
  assert.deepEqual(ownWords({ name: 'Borna replying to Sam ,  , 4:12 PM' }, ['@Sam', 'evo nacrta zmaja']), [])
})

test('the hint under a message being edited is not a message', async () => {
  const { marked } = await import('../collectors/screenchats.mjs')
  const { out } = marked(Math.floor(Date.now() / 1000), [{ heading: 'Sam 1:35 PM', text: ['vec sam savio papir', 'escape to cancel • enter to save'] }])
  assert.deepEqual(out.map((m) => m.text), ['vec sam savio papir'])
})
