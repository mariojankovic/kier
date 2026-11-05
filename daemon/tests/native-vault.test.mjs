import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { PassThrough, Writable } from 'node:stream'
import { readFileSync, mkdtempSync, rmSync, mkdirSync, writeFileSync, copyFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { nativeVault, vaultCall } from '../lib/native-vault.mjs'

test('private native channel matches replies, fails closed and times out', async () => {
  const input = new PassThrough(); const frames = []
  const output = new Writable({ write(chunk, _, done) { frames.push(JSON.parse(String(chunk).slice(11))); done() } })
  const call = nativeVault(input, output, { timeout: 20 })
  const first = call('access')
  input.write(JSON.stringify({ id: 'unrelated', ok: true, value: 'wrong' }) + '\n')
  input.write(JSON.stringify({ id: frames[0].id, ok: true, value: 'fixture-access' }) + '\n')
  assert.equal(await first, 'fixture-access')
  const denied = call('disconnect')
  input.write(JSON.stringify({ id: frames[1].id, ok: false }) + '\n')
  await assert.rejects(denied, /KEYCHAIN_UNAVAILABLE/)
  await assert.rejects(call('access'), /NATIVE_UNAVAILABLE/)
  await assert.rejects(vaultCall('access'), /NATIVE_UNAVAILABLE/)
  const broken = new PassThrough(), writes = new Writable({ write(_, __, done) { done(Error('closed pipe')) } })
  await assert.rejects(nativeVault(broken, writes)('access'), /NATIVE_UNAVAILABLE/)
})

test('credential operation names never enter the native channel', async () => {
  const input = new PassThrough(), output = new Writable({ write() { assert.fail('credential frame sent') } })
  const call = nativeVault(input, output)
  for (const operation of ['get', 'set', 'delete', 'legacy-get', 'legacy-delete']) await assert.rejects(call(operation), /OPERATION_REFUSED/)
})

test('native storage uses a signed Kier-only ACL and never offers a credential CLI', () => {
  const native = readFileSync('../app/GmailVault.swift', 'utf8')
  assert.match(native, /SecCodeCheckValidity/)
  assert.match(native, /com\.getkier\.kier/)
  assert.match(native, /kSecCodeInfoTeamIdentifier/)
  assert.match(native, /SecAccessCreate\("Kier Gmail" as CFString, \[app\] as CFArray/)
  assert.match(native, /kSecAttrAccess as String: access/)
  assert.match(native, /SecKeychainSetUserInteractionAllowed\(false\)/)
  assert.doesNotMatch(native, /add-generic-password|token.*process\.arguments/)
  assert.doesNotMatch(readFileSync('lib/google.mjs', 'utf8'), /\/usr\/bin\/security/)
})


test('native and daemon Gmail paths have no legacy credential migration', () => {
  for (const path of ['../app/GmailVault.swift', '../app/NativeGoogleSession.swift', 'lib/google.mjs', 'lib/native-vault.mjs']) {
    assert.doesNotMatch(readFileSync(path, 'utf8'), /legacy|previous-|native-v1|migrat|\/usr\/bin\/security/i)
  }
})


test('complete sealed runtime is checked before launch and after resource replacement without Keychain access', { skip: process.platform !== 'darwin' }, () => {
  const dir = mkdtempSync(join(tmpdir(), 'kier-runtime-seal-'))
  try {
    const bundle = join(dir, 'Fixture.app'), contents = join(bundle, 'Contents')
    for (const path of ['MacOS', 'Resources/runtime', 'Resources/daemon/bin']) mkdirSync(join(contents, path), { recursive: true })
    copyFileSync('/usr/bin/true', join(contents, 'MacOS/Fixture'))
    copyFileSync('/usr/bin/true', join(contents, 'Resources/runtime/node'))
    writeFileSync(join(contents, 'Resources/daemon/bin/kier.mjs'), 'fixture JavaScript')
    writeFileSync(join(contents, 'Info.plist'), '<?xml version="1.0"?><plist version="1.0"><dict><key>CFBundleIdentifier</key><string>com.getkier.fixture</string><key>CFBundleExecutable</key><string>Fixture</string><key>CFBundlePackageType</key><string>APPL</string></dict></plist>')
    execFileSync('/usr/bin/codesign', ['--force', '--sign', '-', bundle], { stdio: 'pipe' })
    const binary = join(dir, 'seal-test')
    execFileSync('swiftc', ['../app/GmailVault.swift', '../app/NativeGoogleSession.swift', '../app/LinkPolicy.swift', 'tests/runtime-seal.swift', '-o', binary], { stdio: 'pipe' })
    assert.match(execFileSync(binary, [bundle], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }), /checks passed/)
    const main = readFileSync('../app/main.swift', 'utf8')
    assert.ok(main.indexOf('try gmailVault.prepareForLaunch') < main.indexOf('try child.run()'))
    assert.match(main, /KIER_NATIVE_VAULT"\] = bundled \? "1" : "0"/)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('native Google lifecycle keeps refresh credentials private with offline injected services', { skip: process.platform !== 'darwin' }, () => {
  const dir = mkdtempSync(join(tmpdir(), 'kier-native-google-'))
  try {
    const binary = join(dir, 'native-google-test')
    execFileSync('swiftc', ['../app/NativeGoogleSession.swift', '../app/LinkPolicy.swift', 'tests/native-google.swift', '-o', binary], { stdio: 'pipe' })
    assert.match(execFileSync(binary, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }), /12 native Google checks passed/)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})
