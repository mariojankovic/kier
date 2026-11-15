import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
// An owner who writes many languages: each one's "I paid" and "I sent" is read, and each one's doubts take it back.
const dir = mkdtempSync(join(tmpdir(), 'kier-completion-languages-'))
process.env.KIER_DATA_DIR = dir
writeFileSync(join(dir, 'config.json'), JSON.stringify({ me: 'Sam', languages: ['English', 'German', 'Spanish', 'French', 'Italian', 'Portuguese', 'Dutch'], online: false, workRoots: [] }))
after(() => rmSync(dir, { recursive: true, force: true }))
const { completedAction, matchesCompletedTask, newlyWritten } = await import('../lib/completion-evidence.mjs')

for (const text of ['Ich habe die Rechnung bezahlt.', 'Hab gerade überwiesen.', 'Ich habe den Vertrag geschickt.', 'He pagado la factura.', 'Ya pagué la factura.', 'Pagué la factura.',
  'Ya lo envié.', "J'ai payé la facture.", "J’ai déjà envoyé le contrat.", 'Ho pagato la fattura.', 'Ho già inviato il contratto.', 'Paguei a fatura.', 'Já enviei o contrato.',
  'Ik heb de factuur betaald.', 'Heb het contract verstuurd.']) {
  test(`a plain "I did it" counts: ${text}`, () => assert.equal(completedAction(text), true))
}
for (const text of ['Ich habe die Rechnung nicht bezahlt.', 'Ich werde morgen bezahlen.', 'Ich habe vielleicht schon bezahlt.', 'Hast du bezahlt?', 'Nika hat bezahlt.', 'Ich habe die Rechnung und die Miete bezahlt.',
  'No he pagado la factura.', 'Pague la factura.', 'Voy a pagar mañana.', 'Creo que ya pagué.', "Je n'ai pas payé.", 'Je vais payer demain.', "J'ai payé si je me souviens bien.",
  'Non ho pagato.', 'Pagherò domani.', 'Ho pagato se non sbaglio.', 'Não paguei.', 'Vou pagar amanhã.', 'Acho que já paguei.', 'Ik heb niet betaald.', 'Ik zal morgen betalen.', 'Heb jij betaald?',
  'Ik heb misschien al betaald.', 'Ich habe nur eine Anzahlung bezahlt.', 'He pagado solo una parte.']) {
  test(`doubt, refusal, a question or someone else does not count: ${text}`, () => assert.equal(completedAction(text), false))
}

test('a claim settles the card it names, by who and how much', () => {
  const pay = { summary: 'Pay Nika 20 EUR', amount: '20 EUR' }
  for (const said of ['Ich habe Nika 20 EUR überwiesen.', 'He pagado 20 EUR a Nika.', "J'ai payé 20 EUR à Nika.", 'Ho pagato 20 EUR a Nika.', 'Paguei 20 EUR à Nika.', 'Ik heb Nika 20 EUR betaald.']) {
    assert.equal(matchesCompletedTask(pay, said), true, said)
  }
  for (const said of ['Ich habe Filip 20 EUR überwiesen.', 'Ich habe Nika 15 EUR überwiesen.', 'Ho pagato 20 EUR per Nika.', 'Ik heb 20 EUR voor Nika betaald.', 'He enviado 20 EUR a Nika.']) {
    assert.equal(matchesCompletedTask(pay, said), false, said)
  }
})

test('the usual nouns are read across languages, since the card is in English', () => {
  const send = { summary: 'Send the contract to Tea' }
  for (const said of ['Ich habe Tea den Vertrag geschickt.', 'He enviado el contrato a Tea.', "J'ai envoyé le contrat à Tea.", 'Ho inviato il contratto a Tea.', 'Enviei o contrato à Tea.', 'Ik heb het contract naar Tea gestuurd.']) {
    assert.equal(matchesCompletedTask(send, said), true, said)
  }
  assert.equal(matchesCompletedTask(send, 'Ich habe Tea die Rechnung geschickt.'), false)
})

test('quoted mail and sign-offs in these languages are not the owner\'s words', () => {
  for (const tail of ['\nAm 12.11.2026 um 09:14 schrieb Jonas Berg:\nIch habe bezahlt.', '\nLe 12 nov. 2026 à 09:14, Jonas Berg a écrit :\nJ\'ai payé.', '\nEl 12 nov 2026, Jonas Berg escribió:\nHe pagado.',
    '\nIl giorno 12 nov 2026 Jonas Berg ha scritto:\nHo pagato.', '\nOp 12 nov 2026 schreef Jonas Berg:\nIk heb betaald.', '\nMit freundlichen Grüßen\nIch habe bezahlt.', '\nCordialement,\nJ\'ai payé.',
    '\nSaludos,\nHe pagado.', '\nMet vriendelijke groet,\nIk heb betaald.', '\nVon: Jonas\nIch habe bezahlt.']) {
    assert.equal(newlyWritten('Hallo.' + tail), 'Hallo.', tail)
  }
})
