import { test } from 'node:test'
import assert from 'node:assert/strict'
import { redact } from '../lib/redact.mjs'

test('IBAN and OIB are masked', () => {
  const { text, found } = redact('IBAN računa: HR' + '0'.repeat(19) + ' OIB: ' + '8'.repeat(11))
  assert.equal(text, 'IBAN računa: [IBAN] OIB: [OIB]')
  assert.deepEqual(found.sort(), ['iban', 'oib'])
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
