import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
// An owner who writes German: the day words the model hands back are read in their language.
const dir = mkdtempSync(join(tmpdir(), 'kier-reminder-german-'))
process.env.KIER_DATA_DIR = dir
writeFileSync(join(dir, 'config.json'), JSON.stringify({ me: 'Jonas', languages: ['German', 'English'], timezone: 'Europe/Berlin', online: false, workRoots: [] }))
after(() => rmSync(dir, { recursive: true, force: true }))
const { reminderFrom, reminderIntent } = await import('../lib/create-reminder.mjs')
const thursday = Date.UTC(2026, 10, 5, 9, 0) / 1000

test('German day words give the reminder its day', () => {
  assert.deepEqual(reminderFrom('Zahnarzt anrufen', 'morgen', 'erinnere mich morgen an den Zahnarzt', thursday), { title: 'Zahnarzt anrufen', due: '2026-11-06', when: 'morgen' })
  assert.deepEqual(reminderFrom('Miete zahlen', 'übermorgen', 'übermorgen Miete zahlen', thursday), { title: 'Miete zahlen', due: '2026-11-07', when: 'übermorgen' })
})

test('"am Freitag" is a day, not the morning', () => {
  assert.deepEqual(reminderFrom('Miete zahlen', 'am Freitag', 'erinnere mich am Freitag an die Miete', thursday), { title: 'Miete zahlen', due: '2026-11-06', when: 'am Freitag' })
})

test('a time written with a colon is kept, and English still works', () => {
  assert.deepEqual(reminderFrom('Tea anrufen', 'morgen 18:30', 'morgen 18:30 Tea anrufen', thursday), { title: 'Tea anrufen', due: '2026-11-06', when: 'morgen at 18:30' })
  assert.deepEqual(reminderFrom('Call the dentist', 'tomorrow', 'remind me to call the dentist tomorrow', thursday), { title: 'Call the dentist', due: '2026-11-06', when: 'tomorrow' })
})

test('German words for remembering count as asking for a reminder', () => {
  assert.equal(reminderIntent('erinnere mich morgen an den Zahnarzt'), true)
  assert.equal(reminderIntent('vergiss nicht die Miete'), true)
})
