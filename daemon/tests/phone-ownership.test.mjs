import { test } from 'node:test'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
test('Swift ownership ledger preserves legacy containers, unrelated items and incomplete inventories', () => {
  const dir = mkdtempSync(join(tmpdir(), 'kier-phone-test-'))
  try {
    const bin = join(dir, 'ownership-test')
    execFileSync('swiftc', ['../app/PhoneOwnership.swift', 'tests/phone-ownership.swift', '-o', bin], { timeout: 60000, stdio: 'pipe' })
    execFileSync(bin, [], { timeout: 5000, stdio: 'pipe' })
  } finally { rmSync(dir, { recursive: true, force: true }) }
})
