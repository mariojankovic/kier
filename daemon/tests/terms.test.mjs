import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.KIER_DATA_DIR = mkdtempSync(join(tmpdir(), 'kier-terms-'))
const { configPath } = await import('../lib/config.mjs')
const { TERMS_URL, TERMS_VERSION, termsAccepted } = await import('../lib/settings.mjs')
const { act } = await import('../lib/setup.mjs')

test('Setup records the terms version the owner agreed to', async () => {
  assert.equal(termsAccepted(), false)
  await act('terms')
  assert.equal(termsAccepted(), true)
  const saved = JSON.parse(readFileSync(configPath, 'utf8')).terms
  assert.equal(saved.version, TERMS_VERSION)
  assert.ok(Number.isInteger(saved.at))
})

test('the terms link is the public https page', () => {
  assert.equal(TERMS_URL, 'https://getkier.com/terms/')
})
