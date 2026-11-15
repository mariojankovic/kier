import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
// An owner who writes many languages asks what is on a day in any of them.
const dir = mkdtempSync(join(tmpdir(), 'kier-day-question-'))
process.env.KIER_DATA_DIR = dir
writeFileSync(join(dir, 'config.json'), JSON.stringify({ me: 'Sam', languages: ['English', 'German', 'Spanish', 'French', 'Italian', 'Portuguese', 'Dutch', 'Croatian'], timezone: 'Europe/Berlin', online: false, workRoots: [] }))
after(() => rmSync(dir, { recursive: true, force: true }))
const { plansAsked, daysAsked } = await import('../lib/ask.mjs')
const { resolveDue } = await import('../lib/dates.mjs')
const { today, plusDays } = await import('../lib/tasks.mjs')
const day = (n) => [plusDays(today(), n), plusDays(today(), n)]

test('"what do I have tomorrow" is recognised in each language', () => {
  for (const q of ['What do I have tomorrow?', 'Was habe ich morgen?', '¿Qué tengo mañana?', "Qu'est-ce que j'ai demain ?", 'Cosa ho domani?', 'O que tenho amanhã?', 'Wat heb ik morgen?', 'Što imam sutra?',
    'Bin ich am Freitag frei?', 'Tengo algo el viernes?', 'Ho impegni questa settimana?', 'Ben ik dit weekend vrij?']) assert.equal(plansAsked(q), true, q)
})

test('a question about something else, or with no day in it, is not', () => {
  for (const q of ['Was hat Nika gesagt?', 'Was habe ich Nika geschickt?', '¿Qué dijo Tea ayer?', 'Wat heb ik Filip beloofd?', 'Cosa ho detto a Borna?']) assert.equal(plansAsked(q), false, q)
})

test('the day asked about is worked out from the owner\'s own words', () => {
  for (const q of ['Was habe ich morgen?', '¿Qué tengo mañana?', "Qu'est-ce que j'ai demain ?", 'Cosa ho domani?', 'O que tenho amanhã?', 'Wat heb ik morgen?']) assert.deepEqual(daysAsked(q), day(1), q)
  for (const q of ['Was habe ich übermorgen?', 'Cosa ho dopodomani?', 'Wat heb ik overmorgen?', '¿Qué tengo pasado mañana?']) assert.deepEqual(daysAsked(q), day(2), q)
  for (const q of ['Was habe ich heute Morgen?', '¿Qué tengo esta mañana?', 'Wat heb ik vanmorgen?', 'Cosa ho stamattina?', "Qu'est-ce que j'ai ce matin ?"]) assert.deepEqual(daysAsked(q), day(0), q)
})

test('weeks, weekends and weekdays mean what they mean in English', () => {
  assert.deepEqual(daysAsked('Was habe ich nächste Woche?'), daysAsked('what do I have next week'))
  assert.deepEqual(daysAsked('¿Qué tengo esta semana?'), daysAsked('what do I have this week'))
  assert.deepEqual(daysAsked('Ben ik dit weekend vrij?'), daysAsked('am I free this weekend'))
  assert.deepEqual(daysAsked('Ho impegni venerdì?'), daysAsked('do I have anything friday'))
  assert.deepEqual(daysAsked("Qu'est-ce que j'ai lundi ?"), daysAsked('what do I have monday'))
})

test('a word inside a longer word that was said is not read on its own', () => {
  const sat = Date.UTC(2026, 9, 10, 11, 53) / 1000
  assert.equal(resolveDue('vanmorgen', '', sat, 'ik heb het vanmorgen gestuurd'), '2026-10-10')
  assert.equal(resolveDue('esta mañana', '', sat, 'lo envié esta mañana'), '2026-10-10')
  assert.equal(resolveDue('heute morgen', '', sat, 'heute morgen geschickt'), '2026-10-10')
  assert.equal(resolveDue('morgen', '', sat, 'ich schicke es morgen'), '2026-10-11')
  assert.equal(resolveDue('prekosutra', '', sat, 'javim prekosutra'), '2026-10-12')
  assert.equal(resolveDue('sutra popodne', '', sat, 'vidimo se sutra popodne'), '2026-10-11')
})
