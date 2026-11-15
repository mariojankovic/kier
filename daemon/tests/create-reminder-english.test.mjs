import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
// An owner who writes only English: the Croatian phrasings Kier knows must not act on what they type.
const dir = mkdtempSync(join(tmpdir(), 'kier-reminder-english-'))
process.env.KIER_DATA_DIR = dir
writeFileSync(join(dir, 'config.json'), JSON.stringify({ me: 'Sam', languages: ['English'], timezone: 'Europe/Berlin', online: false, workRoots: [] }))
after(() => rmSync(dir, { recursive: true, force: true }))
const { reminderRequest, reminderQuestion, reminderIntent } = await import('../lib/create-reminder.mjs')
const thursday = Date.UTC(2026, 10, 5, 9, 0) / 1000

test('"do" before a number is a verb, not a time', () => {
  assert.deepEqual(reminderRequest('remind me to do 5 pushups', thursday), { title: 'Do 5 pushups', due: '', when: '' })
  assert.deepEqual(reminderRequest('remind me to do 20 minutes of stretching tomorrow', thursday), { title: 'Do 20 minutes of stretching', due: '2026-11-06', when: 'tomorrow' })
})

test('English times and days still read as before', () => {
  assert.deepEqual(reminderRequest('remind me to pay Nika by 7', thursday), { title: 'Pay Nika', due: '2026-11-05', when: 'at 19:00' })
  assert.deepEqual(reminderRequest('remind me to call Tea tomorrow am', thursday), { title: 'Call Tea', due: '2026-11-06', when: 'tomorrow at 09:00' })
  assert.deepEqual(reminderRequest('remind me to book a table for 8 on Friday', thursday), { title: 'Book a table for 8', due: '2026-11-06', when: 'on Friday' })
})

test('a request in a language the owner does not write is left to the model, not read by rule', () => {
  assert.equal(reminderRequest('podsjeti me sutra da nazovem Filipa', thursday), null)
  assert.equal(reminderQuestion('podsjeti me što je Lucija rekla'), false)
  assert.equal(reminderIntent('zapamti ovo'), false)
  assert.equal(reminderIntent("don't let me forget the rent"), true)
})
