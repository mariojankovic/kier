import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, existsSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
const dir = mkdtempSync(join(tmpdir(), 'kier-profile-fixture-'))
process.env.KIER_DATA_DIR = dir
writeFileSync(join(dir, 'config.json'), JSON.stringify({ me: 'Sam', fullName: 'Sam', about: '' }))
const { open, addItems, now } = await import('../lib/db.mjs')
const { build, profile, profileText, due } = await import('../lib/profile.mjs')
const { forget } = await import('../lib/privacy.mjs')
const { setSource } = await import('../lib/settings.mjs')
const { forgetKey } = await import('../lib/privacy.mjs')
after(() => rmSync(dir, { recursive: true, force: true }))
const fixture = () => {
  const db = open(':memory:')
  addItems(db, [{ id: 'fixture', source: 'discord', thread: 'Nika', sender: 'Sam', fromMe: true, ts: now(), text: 'SYNTHETIC_PROFILE_MARKER release planning notes' }])
  return db
}
test('Forget removes the profile and a pending build cannot restore it', async () => {
  const db = fixture()
  try {
    await build(db, async () => 'SYNTHETIC_PROFILE_MARKER')
    assert.ok(profile())
    let finish
    const pending = build(db, () => new Promise(resolve => { finish = resolve }))
    forget(db, { id: 'fixture' })
    assert.equal(existsSync(join(dir, 'profile.json')), false)
    assert.equal(profile(), null)
    assert.equal(profileText(), '')
    assert.equal(due(), true)
    finish('SYNTHETIC_PROFILE_MARKER')
    await assert.rejects(pending, /PROFILE_INVALIDATED/)
    assert.equal(existsSync(join(dir, 'profile.json')), false)
  } finally { db.close() }
})
test('source revocation invalidates a pending build and rebuild excludes disabled and forgotten data', async () => {
  const db = fixture()
  try {
    addItems(db, [{ id: 'forgotten', source: 'git', thread: 'FORGOTTEN_PROJECT', ts: now(), text: 'fixture' }])
    db.prepare('insert into forgotten values (?, ?, ?)').run(forgetKey('item', 'forgotten'), 'item', now())
    let finish
    const pending = build(db, () => new Promise(resolve => { finish = resolve }))
    setSource('discord', false)
    finish('SYNTHETIC_PROFILE_MARKER')
    await assert.rejects(pending, /PROFILE_INVALIDATED/)
    assert.equal(profileText(), '')
    const prompts = []
    await build(db, async (...args) => { prompts.push(args.join('\n')); return 'Permitted fixture' })
    assert.doesNotMatch(prompts.join('\n'), /SYNTHETIC_PROFILE_MARKER|FORGOTTEN_PROJECT/)
    assert.ok(profile())
  } finally { setSource('discord', true); db.close() }
})
