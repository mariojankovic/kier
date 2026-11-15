import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
// An owner who writes many languages: a question put to them by name is theirs to answer, a request for work is not
// a question, and an arrangement keeps its appointment card, in each language.
process.env.KIER_DATA_DIR = mkdtempSync(join(tmpdir(), 'kier-owner-action-languages-'))
after(() => rmSync(process.env.KIER_DATA_DIR, { recursive: true, force: true }))
writeFileSync(join(process.env.KIER_DATA_DIR, 'config.json'), JSON.stringify({ me: 'Sam', languages: ['English', 'German', 'Spanish', 'French', 'Italian', 'Portuguese', 'Dutch'], runtime: 'ollama' }))
const { replyQuestion, actionCard } = await import('../lib/owner-action.mjs')
const { now } = await import('../lib/db.mjs')
const me = ['Sam']
const incoming = (text) => ({ id: 'q', source: 'whatsapp', thread: 'Puzzle club', sender: 'Tea', from_me: 0, ts: now() - 600, text })

test('a question put to the owner by name wants an answer', () => {
  for (const [text, question] of [
    ['Sam, wann kommst du morgen?', 'wann kommst du morgen?'],
    ['Hallo Sam, wo ist der Schlüssel?', 'wo ist der Schlüssel?'],
    ['Sam, kannst du mir sagen, wann es losgeht?', 'kannst du mir sagen, wann es losgeht?'],
    ['Sam, ¿dónde está la llave?', '¿dónde está la llave?'],
    ['Sam, est-ce que tu peux me dire quand ça commence ?', 'est-ce que tu peux me dire quand ça commence ?'],
    ['Ciao Sam, dove sono le chiavi?', 'dove sono le chiavi?'],
    ['Sam, onde está a chave?', 'onde está a chave?'],
    ['Sam, wanneer kom je?', 'wanneer kom je?'],
    ['Sam, when are you coming?', 'when are you coming?'],
  ]) assert.equal(replyQuestion(incoming(text), me), question, text)
})

test('a request for work is not a question to answer', () => {
  for (const text of ['Sam, kannst du mir die Datei schicken?', 'Sam, ¿puedes enviarme el archivo?', 'Sam, peux-tu envoyer le fichier ?', 'Sam, puoi mandarmi il file?',
    'Sam, podes enviar o ficheiro?', 'Sam, kun je het bestand sturen?', 'Sam, can you send the file?']) assert.equal(replyQuestion(incoming(text), me), null, text)
})

test('what someone else is said to have asked is not put to the owner', () => {
  for (const text of ['Sam, Nika sagt wann kommst du?', 'Sam, Filip ha detto dove sono le chiavi?']) assert.equal(replyQuestion(incoming(text), me), null, text)
})

test('an arrangement keeps its appointment card when the message names a meeting or a day', () => {
  for (const text of ['Treffen wir uns am Freitag zum Mittagessen', 'Quedamos el viernes para comer', 'On se retrouve vendredi pour déjeuner', 'Ci vediamo venerdì a pranzo',
    'Vemo-nos sexta para almoçar', 'Zullen we vrijdag lunchen', 'Kaffee übermorgen', 'Lunch on Friday']) assert.equal(actionCard('appointment', incoming(text)), 'appointment', text)
})

test('with no meeting and no day in it, an appointment the model named becomes a to-do', () => {
  for (const text of ['Das Dokument ist fertig', 'El documento está listo', 'Le document est prêt', 'The document is ready']) assert.equal(actionCard('appointment', incoming(text)), 'todo', text)
})
