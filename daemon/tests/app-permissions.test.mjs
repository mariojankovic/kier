import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { execFileSync } from 'node:child_process'
const dir = mkdtempSync(join(tmpdir(), 'kier-origin-fixture-'))
process.env.KIER_DATA_DIR = dir
writeFileSync(join(dir, 'config.json'), JSON.stringify({ me: 'Sam', fullName: 'Sam' }))
const { open, addItems, now } = await import('../lib/db.mjs')
const { ingest } = await import('../lib/server.mjs')
const { quick } = await import('../lib/find.mjs')
const { setSource } = await import('../lib/settings.mjs')
const { readScope, localAuthorization } = await import('../lib/authorization.mjs')
const { appSources, permitsItem, capturePolicy } = await import('../lib/app-permissions.mjs')
after(() => rmSync(dir, { recursive: true, force: true }))

test('every mapped app obeys its switch across capture routes, including legacy names', () => {
  for (const [app, source] of Object.entries(appSources)) {
    for (const route of ['screen', 'notifications', 'clipboard', 'apps']) {
      assert.equal(permitsItem({ source: route, meta: { app: app.toUpperCase() } }, [source]), false, app)
      assert.equal(permitsItem({ source: route, thread: `${app}: fixture` }, [source]), false, app)
      assert.equal(permitsItem({ source: route, meta: { app } }, []), true, app)
    }
  }
})
test('Discord off rejects native ingest and notifications and hides existing rows centrally', async () => {
  const db = open(':memory:')
  const screen = { source: 'screen', thread: 'Discord: Nika', text: 'ORIGIN_FIXTURE', ts: now(), meta: { app: 'com.hnc.Discord' } }
  const notification = { ...screen, source: 'notifications', id: 'notification' }
  try {
    assert.equal(ingest(db, { items: [screen] }), 1)
    assert.equal(addItems(db, [notification]), 1)
    assert.ok((await quick(db, 'ORIGIN_FIXTURE')).length > 0)
    setSource('discord', false)
    assert.equal(ingest(db, { items: [{ ...screen, ts: now() + 1 }] }), 0)
    assert.equal(addItems(db, [{ ...notification, id: 'new-notification' }]), 0)
    assert.equal(db.prepare('select count(*) n from items').get().n, 2)
    assert.deepEqual(readScope(db, localAuthorization()).prepare('select * from items').all(), [])
    assert.deepEqual(await quick(db, 'ORIGIN_FIXTURE'), [])
  } finally { setSource('discord', true); db.close() }
})
test('native capture consumes daemon policy and rejects disabled origins before sending', () => {
  const policy = { ...capturePolicy(), disabled: ['discord', 'calendar', 'ai'] }
  const path = join(dir, 'policy.json')
  writeFileSync(path, JSON.stringify(policy))
  const main = join(dir, 'main.swift'), bin = join(dir, 'policy-test')
  writeFileSync(main, `import Foundation
let data = try Data(contentsOf: URL(fileURLWithPath: CommandLine.arguments[1]))
let policy = CapturePolicy(json: try JSONSerialization.jsonObject(with: data) as! [String: Any])!
assert(!policy.permits(source: "screen", app: "com.hnc.Discord"))
assert(!policy.permits(source: "notifications", app: "", name: "Discord: Nika"))
assert(!policy.permits(source: "clipboard", app: "com.apple.iCal"))
assert(!policy.permits(source: "apps", app: "com.openai.codex"))
assert(policy.permits(source: "screen", app: "com.tinyspeck.slackmacgap"))
assert(CapturePolicy(json: [:]) == nil)
`)
  execFileSync('swiftc', ['../app/CapturePolicy.swift', main, '-o', bin], { stdio: 'pipe', timeout: 60000 })
  execFileSync(bin, [path], { stdio: 'pipe' })
})
