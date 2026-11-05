import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

test('Swift link policy removes unsafe markdown destinations and rejects native schemes', { skip: process.platform !== 'darwin' }, t => {
  const dir = mkdtempSync(join(tmpdir(), 'kier-link-test-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  writeFileSync(join(dir, 'main.swift'), `
import Foundation
for scheme in ["https", "http", "mailto", "HTTPS"] {
  let url = URL(string: "\\(scheme):example.test")!
  precondition(LinkPolicy.allows(url))
  precondition(markdown("[label](\\(url.absoluteString))").runs.contains { $0.link != nil })
}
for target in ["file:///tmp/fixture", "custom:fixture", "x-apple:fixture", "javascript:alert", "sms:fixture", "relative"] {
  let url = URL(string: target)!
  precondition(!LinkPolicy.allows(url))
  precondition(!LinkPolicy.open(url))
  precondition(safeLink(target) == nil)
  let rendered = markdown("[label](\\(target)) **bold**")
  precondition(rendered.runs.allSatisfy { $0.link == nil })
  precondition(String(rendered.characters).contains("label"))
}
let mixed = markdown("[good](https://example.test) [bad](file:///tmp/fixture) [also bad](custom:fixture)")
precondition(mixed.runs.compactMap { $0.link }.count == 1)
`)
  const binary = join(dir, 'links')
  execFileSync('xcrun', ['swiftc', resolve('../app/LinkPolicy.swift'), join(dir, 'main.swift'), '-o', binary])
  execFileSync(binary)
})

test('all native URL opens and markdown parsing use the central policy', () => {
  for (const name of readdirSync('../app').filter(n => n.endsWith('.swift') && n !== 'LinkPolicy.swift')) {
    const text = readFileSync(join('../app', name), 'utf8')
    assert.doesNotMatch(text, /NSWorkspace\.shared\.open\s*\(/, name)
    assert.doesNotMatch(text, /AttributedString\(markdown:/, name)
  }
  for (const name of ['Window.swift', 'Orb.swift']) {
    assert.match(readFileSync(join('../app', name), 'utf8'), /environment\(\\\.openURL, LinkPolicy\.action\)/)
  }
})
