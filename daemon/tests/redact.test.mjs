import { test } from 'node:test'
import assert from 'node:assert/strict'
import { redact } from '../lib/redact.mjs'

test('IBAN and OIB are masked', () => {
  const { text, found } = redact('IBAN računa: HR' + '0'.repeat(19) + ' OIB: ' + '8'.repeat(11))
  assert.equal(text, 'IBAN računa: [IBAN] OIB: [ID]')
  assert.deepEqual(found.sort(), ['iban', 'id'])
})

test('a labelled national or tax number is masked, whichever country it is from', () => {
  // Built from repeats so no real-looking number sits in the source.
  const d = (n) => '8'.repeat(n)
  for (const [said, kept] of [
    ['my SSN is ' + [d(3), d(2), d(4)].join('-'), 'my SSN is [ID]'],
    ['ssn: ' + d(9) + ' thanks', 'ssn: [ID] thanks'],
    ['National Insurance number QQ ' + [d(2), d(2), d(2)].join(' ') + ' C, as asked', 'National Insurance number [ID], as asked'],
    ['Steuer-ID: ' + [d(2), d(3), d(3), d(3)].join(' '), 'Steuer-ID: [ID]'],
    ['mi DNI es ' + d(8) + 'Z', 'mi DNI es [ID]'],
    ['Codice fiscale RSSMRA' + d(2) + 'T' + d(2) + 'A' + d(3) + 'S', 'Codice fiscale [ID]'],
    ['CPF ' + [d(3), d(3), d(3)].join('.') + '-' + d(2), 'CPF [ID]'],
    ['BSN ' + d(9) + ' en verder niets', 'BSN [ID] en verder niets'],
    ['numéro de sécurité sociale : ' + [d(1), d(2), d(2), d(2), d(3), d(3), d(2)].join(' '), 'numéro de sécurité sociale : [ID]'],
    ['JMBG ' + d(13), 'JMBG [ID]'],
  ]) assert.equal(redact(said).text, kept, said)
})

test('a label without a number, or an everyday word that looks like one, stays', () => {
  for (const s of ['The SSN is required on page 2', 'Ich habe nie 12345 Schritte geschafft', 'Steuernummer 2026 fehlt noch', 'social security office, 12345 Main Street',
    'BSN meeting moved to room 12']) assert.deepEqual(redact(s), { text: s, found: [] }, s)
})

test('login codes are masked', () => {
  assert.equal(redact('Your verification code is 482913').text, 'Your verification code is [CODE]')
  assert.equal(redact('Vaš jednokratni kod: 5521').text, 'Vaš jednokratni kod: [CODE]')
  assert.equal(redact('Kod za prijavu je 123456').text, 'Kod za prijavu je [CODE]')
})

test('"kod" meaning "at" and money amounts stay', () => {
  const s = 'Filip je kod Jonasa kupio stalak za 85€'
  assert.equal(redact(s).text, s)
})

test('only card numbers that pass Luhn are masked', () => {
  assert.equal(redact('kartica ' + ['4111', '1111', '1111', '1111'].join(' ')).text, 'kartica [CARD]')
  assert.equal(redact('ticket 888888888888888888888888').text, 'ticket 888888888888888888888888')
})

test('mentions and links with long ids are not cards', () => {
  for (const s of ['@' + '8'.repeat(14) + ' primjer', 'https://example.com/status/' + '8'.repeat(19), 'watch/?v=' + '8'.repeat(16)]) {
    assert.equal(redact(s).text, s)
  }
})

test('keys and passwords', () => {
  assert.equal(redact('key ' + ['sk', 'ant', 'api03', 'a'.repeat(24)].join('-')).text, 'key [SECRET]')
  assert.equal(redact('lozinka: Tajna123!').text, 'lozinka: [PASSWORD]')
})

test('ordinary text is untouched', () => {
  const s = 'Ponesi 28€ za glinu u srijedu'
  assert.deepEqual(redact(s), { text: s, found: [] })
})
