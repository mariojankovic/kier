import { test } from 'node:test'
import assert from 'node:assert/strict'
import { callRecord } from '../collectors/whatsapp.mjs'

// WhatsApp's call entries as they sit in ChatStorage, with a made-up contact id.
const jid = (n) => Buffer.from(`${'1'.repeat(n)}@lid`).toString('hex')
const answeredOnPhone = Buffer.from(`ba05350a2108001004180020002a170a13${jid(15)}8888888888888888888888888888888888888888`, 'hex')
const calledFromMac = Buffer.from(`a20420${'00'.repeat(32)}ba05330a210800100018a90220002a160a12${jid(14)}888888888888888888888888888888888888`, 'hex')
const missed = Buffer.from(`ba05340a2008001001180020002a160a12${jid(14)}8888888888888888888888888888888888888888`, 'hex')

test('a WhatsApp call answered on the phone reads as answered elsewhere, with no length', () => {
  assert.deepEqual(callRecord(answeredOnPhone), { video: false, outcome: 'elsewhere', seconds: 0 })
})

test('a WhatsApp call made from the Mac has its length, and a missed one is missed', () => {
  assert.deepEqual(callRecord(calledFromMac), { video: false, outcome: 'connected', seconds: 297 })
  assert.equal(callRecord(missed).outcome, 'missed')
  assert.equal(callRecord(Buffer.from('0800', 'hex')), null)
})
