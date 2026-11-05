import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
const dir = mkdtempSync(join(tmpdir(), 'kier-completion-fixture-'))
process.env.KIER_DATA_DIR = dir
writeFileSync(join(dir, 'config.json'), JSON.stringify({ me: 'Sam', languages: ['English', 'Croatian'], online: false, workRoots: [], phoneReminders: true }))
after(() => rmSync(dir, { recursive: true, force: true }))
const { newlyWritten, completedAction, authoredText, matchesCompletedTask, canCompleteReminder } = await import('../lib/completion-evidence.mjs')
const { open, addItems, now } = await import('../lib/db.mjs')
const { tasks, today, markTask } = await import('../lib/tasks.mjs')
const { phoneItems } = await import('../lib/phone.mjs')
const { evidence, recordCompletion } = await import('../lib/resolve.mjs')

for (const text of ['I will pay next week.', 'Not paid.', "I haven't paid.", 'Platit ću sljedeći tjedan.', 'Nisam platio.', 'Nije plaćeno.', 'Invoice paid', 'Nika paid.', 'Has it been paid?', 'I will have paid tomorrow.', 'Nika says I paid.', 'If I paid today, the date is fine.', 'I think I paid.', 'I paid half the invoice.', '"I paid the invoice."']) {
  test(`completion refuses intent, negation or ambiguity: ${text}`, () => assert.equal(completedAction(text), false))
}
for (const suffix of ['\n> I paid.', '\nOn Friday Nika wrote:\nI paid.', '\nFrom: Nika\nI paid.', '\n-----Original Message-----\nI paid.', '\n<div class="gmail_quote">I paid.', '\n<div id="divRplyFwdMsg">I paid.', '\n-- \nI paid.', '\nRegards,\nI paid.', '\nSent from my phone\nI paid.']) {
  test(`quotes and signatures cannot provide completion: ${JSON.stringify(suffix)}`, () => {
    assert.equal(newlyWritten('I will pay next week.' + suffix), 'I will pay next week.')
    assert.equal(completedAction(newlyWritten('Hello.' + suffix)), false)
  })
}
for (const text of ['I paid the invoice.', 'I have sent the contract.', 'Platio sam račun.', 'Uplatila sam iznos.']) {
  test(`unambiguous completed action: ${text}`, () => assert.equal(completedAction(text), true))
}

function fixture(t, { subject = 'Invoice not paid', body = 'I will pay next week.', client = 'apple-mail', bodyKind = 'plain', legacy = false, source = 'mail' } = {}) {
  const db = open(':memory:'); t.after(() => db.close())
  const base = { source, thread: subject, ts: now() - 120, meta: { client, ownerSent: false } }
  addItems(db, [{ ...base, id: 'request', sender: 'Nika', text: `${subject}\nPlease pay the invoice.` },
    { ...base, id: 'reply', sender: 'Sam', fromMe: true, ts: now() - 60, text: source === 'mail' ? `Re: ${subject}\n${body}` : body, meta: { client, ownerSent: true, ...(!legacy && { subject: `Re: ${subject}`, body, bodyKind }) } }])
  const request = db.prepare("select * from items where id like 'request%'").get()
  db.prepare("insert into tags(item_id,is_task,summary,due,amount,card,model,tagged_at) values (?,1,'Pay the invoice',?,'28 EUR','payment','fixture',?)").run(request.id, today(), now())
  return { db, id: request.id, card: () => tasks(db).find(r => r.id === request.id) }
}
for (const options of [
  {}, { subject: 'Račun nije plaćen', body: 'Platit ću sljedeći tjedan.' },
  { subject: 'Račun plaćen', body: 'Nisam platio.' },
  { body: 'Hello.\nOn Friday Nika wrote:\nI paid the invoice.' },
  { body: 'Hello.\n-- \nI paid the invoice.' },
  { client: 'gmail', bodyKind: 'preview', body: 'I paid the invoice.' },
  { client: 'spark', bodyKind: 'preview', body: 'I paid the invoice.' },
  { legacy: true, body: 'I paid the invoice.' },
]) test(`mail keeps payment and exported reminder open: ${JSON.stringify(options)}`, t => {
  const { db, id, card } = fixture(t, options)
  assert.equal(card().state, 'open')
  assert.notEqual(phoneItems(db, { decisionAvailable: false }).items.find(r => r.id === id)?.done, true)
  const lines = evidence(db, card())
  for (const line of lines) assert.equal(completedAction(line.text), false)
  recordCompletion(db, card(), lines[0], 'Model claims done')
  assert.equal(card().completion_origin, null)
  assert.notEqual(phoneItems(db, { decisionAvailable: false }).items.find(r => r.id === id)?.done, true)
  markTask(db, id, 'done')
  assert.equal(phoneItems(db, { decisionAvailable: false }).items.find(r => r.id === id)?.done, true)
})
for (const body of ['I paid 28 EUR for the invoice.', 'Platio sam račun od 28 EUR.']) test(`own matching body suggests done and the owner's tap settles it: ${body}`, t => {
  const { db, id, card } = fixture(t, { body })
  // Text matching only suggests: the card stays visible until the owner confirms.
  assert.equal(card().state, 'looks_done')
  assert.notEqual(phoneItems(db, { decisionAvailable: false }).items.find(r => r.id === id)?.done, true)
  markTask(db, id, 'done')
  assert.equal(phoneItems(db, { decisionAvailable: false }).items.find(r => r.id === id)?.done, true)
})
test('mail subjects never enter authored completion text', () => {
  assert.equal(authoredText({ source: 'mail', text: 'Re: Paid\nHello.', meta: { body: 'Hello.', bodyKind: 'plain', subject: 'Re: Paid' } }), 'Hello.')
})

test('old inferred owner-message authority is revoked while explicit confirmation survives', t => {
  const path = join(dir, 'old-completion.db'), db = open(path)
  db.prepare("delete from migrations where id = 'authored-completion-v3'").run()
  addItems(db, ['inferred', 'confirmed'].map(id => ({ id, source: 'kier', ts: now(), text: 'Pay the invoice' })))
  db.exec("insert into task_state(item_id,status,changed_at,completion_origin) values ('inferred','handled',1,'owner-message'), ('confirmed','done',1,'owner')")
  db.close()
  const repaired = open(path); t.after(() => repaired.close())
  assert.equal(repaired.prepare("select status from task_state where item_id = 'inferred'").get().status, 'looks_done')
  assert.equal(repaired.prepare("select completion_origin from task_state where item_id = 'inferred'").get().completion_origin, null)
  assert.equal(repaired.prepare("select completion_origin from task_state where item_id = 'confirmed'").get().completion_origin, 'owner')
})

const rejectedStatements = [
  ['partial', 'I paid part of the bill.', 'Platio sam dio računa.'],
  ['partial only', 'I paid only part of the bill.', 'Platio sam samo dio računa.'],
  ['half', 'I paid half the bill.', 'Platio sam pola računa.'],
  ['hypothetical', 'If I paid the bill, I would tell you.', 'Da sam platio račun, javio bih ti.'],
  ['conditional', 'I would have paid 28 EUR.', 'Platio bih račun od 28 EUR.'],
  ['future', 'I will pay 28 EUR.', 'Platit ću račun od 28 EUR.'],
  ['negative', 'I have not paid 28 EUR.', 'Nisam platio račun od 28 EUR.'],
  ['ambiguous', 'Paid.', 'Plaćeno.'],
  ['different action', 'I sent the purchase order.', 'Poslao sam narudžbenicu.'],
  ['different object', 'I paid 19 EUR to Filip.', 'Platio sam Filipu 19 EUR.'],
]
for (const [category, ...statements] of rejectedStatements) for (const body of statements) for (const source of ['mail', 'whatsapp']) {
  test(`${source}: ${category} cannot settle a payment or complete its exported reminder: ${body}`, t => {
    const { db, id, card } = fixture(t, { body, source })
    assert.equal(card().state, ['partial', 'partial only', 'half', 'different object'].includes(category) ? 'looks_done' : 'open')
    const proof = evidence(db, card()).find(line => line.text === body)
    recordCompletion(db, card(), proof, 'Looks done: fixture verdict')
    assert.equal(card().state, 'looks_done')
    assert.equal(card().completion_origin, null)
    assert.notEqual(phoneItems(db, { decisionAvailable: false }).items.find(row => row.id === id)?.done, true)
    markTask(db, id, 'done')
    assert.equal(phoneItems(db, { decisionAvailable: false }).items.find(row => row.id === id)?.done, true)
  })
}
for (const [summary, amount, body, expected] of [
  ['Pay Nika', '', 'I paid Nika.', true], ['Plati Niki', '', 'Platio sam Niki.', true],
  ['Pay Nika', '', 'I paid Filip.', false], ['Plati Niki', '', 'Platio sam Filipu.', false],
  ['Pay the invoice', '28 EUR', 'I paid 28 EUR.', false], ['Plati račun', '28 EUR', 'Platio sam 28 EUR.', false],
  ['Send the contract', '', 'I sent the contract.', true], ['Pošalji ugovor', '', 'Poslao sam ugovor.', true],
  ['Send the contract', '', 'I sent the purchase order.', false], ['Pošalji ugovor', '', 'Poslao sam narudžbenicu.', false],
  ['Send the contract to Nika', '', 'I sent the contract to Filip.', false],
  ['Send the contract to Nika', '', 'I sent the contract to Nika.', true],
]) test(`action and object matching: ${summary} / ${body}`, () => {
  assert.equal(matchesCompletedTask({ summary, amount }, body), expected)
})
test('PhoneSync completion authority excludes every inferred origin, including old owner-message rows', () => {
  for (const completion_origin of [null, 'owner-message', 'owner-evidence', 'model']) assert.equal(canCompleteReminder({ completion_origin }), false)
  for (const completion_origin of ['owner', 'reminders']) assert.equal(canCompleteReminder({ completion_origin }), true)
})

for (const [summary, amount, body, expected] of [
  ['Pay the invoice', '28 EUR', 'I paid 28 USD for lunch.', false],
  ['Plati račun', '28 EUR', 'Platio sam ručak 28 USD.', false],
  ['Pay the invoice', '28 EUR', 'I paid 28 EUR for lunch.', false],
  ['Plati račun', '28 EUR', 'Platio sam ručak 28 EUR.', false],
  ['Pay the supplier', '28 EUR', 'I paid the supplier a deposit.', false],
  ['Plati dobavljaču', '28 EUR', 'Platio sam dobavljaču predujam.', false],
  ['Pay Nika', '28 EUR', 'I paid Nika 14 EUR.', false],
  ['Plati Niki', '28 EUR', 'Platio sam Niki 14 EUR.', false],
  ['Pay Nika', '28 EUR', 'I paid Nika.', false],
  ['Plati Niki', '28 EUR', 'Platio sam Niki.', false],
  ['Pay Nika', '28 EUR', 'I paid Nika 28.', false],
  ['Pay Nika', '28', 'I paid Nika 28 EUR.', false],
  ['Pay Nika', '28 EUR', 'I paid Nika 28 EUR.', true],
  ['Plati Niki', '28 EUR', 'Platio sam Niki 28 EUR.', true],
  ['Pay Nika', '28.50 EUR', 'I paid Nika 28.50 EUR.', true],
  ['Plati Niki', '28,50 EUR', 'Platio sam Niki 28,50 EUR.', true],
  ['Pay Nika for lunch', '28 EUR', 'I paid Nika 28 EUR for rent.', false],
  ['Pay Nika for lunch', '28 EUR', 'I paid Filip 28 EUR for lunch.', false],
  ['Pay the supplier', '', 'I paid the supplier a deposit.', false],
  ['Pay the supplier', '', 'I paid the supplier an instalment.', false],
  ['Pay the supplier', '', 'I paid the supplier a down payment.', false],
  ['Plati dobavljaču', '', 'Platio sam dobavljaču ratu.', false],
  ['Plati dobavljaču', '', 'Platio sam dobavljaču akontaciju.', false],
  ['Send the contract to Nika', '', 'I sent the sketch to Nika.', false],
  ['Pošalji Niki ugovor', '', 'Poslao sam Niki skicu.', false],
  ['Pošalji Niki ugovor', '', 'Poslao sam Filipu ugovor.', false],
  ['Pošalji Niki ugovor', '', 'Poslao sam Niki ugovor.', true],
  ['Send invoice 12 to Nika', '', 'I sent invoice 13 to Nika.', false],
  ['Send the contract for lunch', '', 'I sent the contract for rent.', false],
]) test(`strict obligation matching: ${summary} / ${amount} / ${body}`, () => {
  assert.equal(matchesCompletedTask({ summary, amount }, body), expected)
})
test('recipient headers cannot override a different explicit destination', () => {
  const task = { summary: 'Send the contract to Nika' }
  assert.equal(matchesCompletedTask(task, 'I sent the contract to Filip.', [{ name: 'Nika' }]), false)
  assert.equal(matchesCompletedTask(task, 'I sent the contract.', [{ name: 'Nika' }]), true)
})
for (const body of ['I paid 28 USD for lunch.', 'Platio sam ručak 28 USD.', 'I paid the supplier a deposit.', 'Platio sam dobavljaču predujam.']) {
  test(`weak completion only suggests confirmation: ${body}`, t => {
    const { db, id, card } = fixture(t, { body })
    assert.equal(card().state, 'looks_done')
    recordCompletion(db, card(), evidence(db, card()).find(line => line.text === body), 'Fixture completion claim')
    assert.equal(card().state, 'looks_done')
    assert.equal(card().completion_origin, null)
    assert.notEqual(phoneItems(db, { decisionAvailable: false }).items.find(row => row.id === id)?.done, true)
  })
}

for (const [summary, amount, body] of [
  ['Pay Nika', '28 SEK', 'I paid Nika 28 NOK.'],
  ['Pay Nika', '28', 'I paid Nika 28 PLN.'],
  ['Pay Nika', '28 EUR', 'I paid Filip 28 EUR for Nika.'],
  ['Plati Niki', '28 EUR', 'Platio sam Filipu 28 EUR za Niku.'],
  ['Pay the supplier', '', 'I paid the supplier deposits.'],
  ['Pay the supplier', '', 'I paid the supplier in instalments.'],
  ['Pay the supplier', '', 'I paid the supplier the first payment.'],
  ['Send it', '', 'I sent it.'],
]) test(`incomplete identifying evidence stays advisory: ${body}`, () => {
  assert.equal(matchesCompletedTask({ summary, amount }, body), false)
})

// Rule matching keeps meeting phrasings it misreads; none of them may hide an unfinished card.
for (const body of ['I paid the bank 28 EUR instead of the supplier.', 'I sent the blue invoice.', 'I paid 28 EUR for the invoice.'])
  test(`a misleading match only suggests, never hides: ${body}`, t => {
    const { card } = fixture(t, { body })
    assert.notEqual(card().state, 'handled')
  })
