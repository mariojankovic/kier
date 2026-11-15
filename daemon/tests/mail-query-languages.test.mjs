import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
// An owner who writes many languages: a date typed into Kier Mail's search means the same in each of them.
const dir = mkdtempSync(join(tmpdir(), 'kier-mail-query-languages-'))
process.env.KIER_DATA_DIR = dir
writeFileSync(join(dir, 'config.json'), JSON.stringify({ me: 'Sam', fullName: 'Sam', languages: ['English', 'German', 'Spanish', 'French', 'Italian', 'Portuguese', 'Dutch'], online: false, off: [] }))
after(() => rmSync(dir, { recursive: true, force: true }))
const { dateRange } = await import('../lib/mail-query.mjs')
const TODAY = '2026-11-14'
const same = (theirs, english) => assert.deepEqual(dateRange(theirs, TODAY, 1), dateRange(english, TODAY, 1), `${theirs} = ${english}`)

test('English reads as before', () => {
  assert.deepEqual(dateRange('two weeks ago', TODAY, 1), { after: '2026-10-26', before: '2026-11-02' })
  assert.deepEqual(dateRange('a month ago', TODAY, 1), { after: '2026-10-01', before: '2026-11-01' })
  assert.deepEqual(dateRange('since March', TODAY, 1), { after: '2026-03-01', before: null })
  assert.deepEqual(dateRange('last friday', TODAY, 1), { after: '2026-11-13', before: '2026-11-14' })
})

const cases = {
  German: [['gestern', 'yesterday'], ['letzte Woche', 'last week'], ['diese Woche', 'this week'], ['letzten Monat', 'last month'], ['im März', 'march'], ['März 2025', 'march 2025'],
    ['vor zwei Wochen', 'two weeks ago'], ['seit Montag', 'since monday'], ['vor Oktober', 'before october'], ['in den letzten 3 Tagen', 'last 3 days'], ['letzten Freitag', 'last friday'], ['bis Freitag', 'until friday']],
  Spanish: [['ayer', 'yesterday'], ['la semana pasada', 'last week'], ['este mes', 'this month'], ['el mes pasado', 'last month'], ['hace dos semanas', 'two weeks ago'], ['los últimos 3 días', 'last 3 days'],
    ['desde el lunes', 'since monday'], ['antes de octubre', 'before october'], ['marzo de 2025', 'march 2025'], ['el viernes pasado', 'last friday'], ['el año pasado', 'last year']],
  French: [["aujourd'hui", 'today'], ['hier', 'yesterday'], ['la semaine dernière', 'last week'], ['ce mois', 'this month'], ['le mois dernier', 'last month'], ['il y a deux semaines', 'two weeks ago'],
    ['les 3 derniers jours', 'last 3 days'], ['depuis lundi', 'since monday'], ['avant octobre', 'before october'], ['mars 2025', 'march 2025'], ["jusqu'à vendredi", 'until friday'], ['vendredi dernier', 'last friday']],
  Italian: [['ieri', 'yesterday'], ['la settimana scorsa', 'last week'], ['la scorsa settimana', 'last week'], ['questo mese', 'this month'], ['il mese scorso', 'last month'], ['due settimane fa', 'two weeks ago'],
    ['gli ultimi 3 giorni', 'last 3 days'], ['da lunedì', 'since monday'], ['prima di ottobre', 'before october'], ['marzo 2025', 'march 2025'], ['fino a venerdì', 'until friday'], ['venerdì scorso', 'last friday']],
  Portuguese: [['ontem', 'yesterday'], ['a semana passada', 'last week'], ['este mês', 'this month'], ['o mês passado', 'last month'], ['há duas semanas', 'two weeks ago'], ['os últimos 3 dias', 'last 3 days'],
    ['desde segunda-feira', 'since monday'], ['antes de outubro', 'before october'], ['março de 2025', 'march 2025'], ['até sexta', 'until friday'], ['sexta passada', 'last friday']],
  Dutch: [['gisteren', 'yesterday'], ['vorige week', 'last week'], ['deze week', 'this week'], ['afgelopen maand', 'last month'], ['twee weken geleden', 'two weeks ago'], ['de laatste 3 dagen', 'last 3 days'],
    ['sinds maandag', 'since monday'], ['voor oktober', 'before october'], ['maart 2025', 'march 2025'], ['tot vrijdag', 'until friday'], ['vorige vrijdag', 'last friday']],
}
for (const [language, pairs] of Object.entries(cases)) test(`${language} date words mean what the English ones mean`, () => {
  for (const [theirs, english] of pairs) { assert.notEqual(dateRange(english, TODAY, 1), null, english); same(theirs, english) }
})

test('the day before yesterday has a word in most of them', () => {
  for (const words of ['vorgestern', 'anteayer', 'avant-hier', "l'altro ieri", 'anteontem', 'eergisteren']) assert.deepEqual(dateRange(words, TODAY, 1), { after: '2026-11-12', before: '2026-11-13' }, words)
})

test('what Kier does not know stays unread, in any language', () => {
  for (const words of ['bald', 'pronto', 'nächste Woche', 'la semaine prochaine', 'domani', 'ooit', 'irgendwann']) assert.equal(dateRange(words, TODAY, 1), null, words)
})
