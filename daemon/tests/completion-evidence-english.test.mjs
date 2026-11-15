import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
// An owner who writes only English: words that mean something in another language do not act on their sentences.
const dir = mkdtempSync(join(tmpdir(), 'kier-completion-english-'))
process.env.KIER_DATA_DIR = dir
writeFileSync(join(dir, 'config.json'), JSON.stringify({ me: 'Sam', languages: ['English'], online: false, workRoots: [] }))
after(() => rmSync(dir, { recursive: true, force: true }))
const { completedAction, matchesCompletedTask } = await import('../lib/completion-evidence.mjs')

test('English claims read as before', () => {
  for (const text of ['I paid the invoice.', 'I have sent the contract.']) assert.equal(completedAction(text), true, text)
  for (const text of ['I will pay next week.', 'Not paid.', 'Nika says I paid.']) assert.equal(completedAction(text), false, text)
})

test('a word that is a doubt only in Croatian does not take an English claim back', () => {
  // "bi" is "would" in Croatian; in English it is the start of "bi-weekly".
  assert.equal(completedAction('I paid the bi-weekly fee.'), true)
  assert.equal(matchesCompletedTask({ summary: 'Pay the bi-weekly fee' }, 'I paid the bi-weekly fee.'), true)
})

test('claims in a language the owner does not write are left to the model', () => {
  for (const text of ['Platio sam račun.', 'Ich habe die Rechnung bezahlt.', 'Ho pagato la fattura.', 'Paguei a fatura.']) assert.equal(completedAction(text), false, text)
})
