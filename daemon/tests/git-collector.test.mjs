import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

test('collector ignores repository signature programs and reads local branches only', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'kier-collector-test-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const repo = join(dir, 'repo'); mkdirSync(repo)
  process.env.KIER_DATA_DIR = join(dir, 'data')
  mkdirSync(process.env.KIER_DATA_DIR)
  writeFileSync(join(process.env.KIER_DATA_DIR, 'config.json'), JSON.stringify({ me: 'Sam', workRoots: [dir], gitAuthors: ['sam@example.test'] }))
  const git = (...args) => execFileSync('/usr/bin/git', ['-C', repo, ...args], { encoding: 'utf8', env: { PATH: '/usr/bin:/bin', HOME: dir, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' } }).trim()
  git('init', '-q'); git('config', 'user.name', 'Sam'); git('config', 'user.email', 'sam@example.test')
  git('-c', 'commit.gpgsign=false', 'commit', '--allow-empty', '-qm', 'Synthetic commit')
  const original = git('rev-parse', 'HEAD')
  const raw = git('cat-file', 'commit', original).replace('\n\n', '\ngpgsig -----BEGIN PGP SIGNATURE-----\n fixture\n -----END PGP SIGNATURE-----\n\n')
  const signed = execFileSync('/usr/bin/git', ['-C', repo, 'hash-object', '-t', 'commit', '-w', '--stdin'], { input: raw, encoding: 'utf8' }).trim()
  git('update-ref', 'refs/heads/signed-fixture', signed)
  const fetched = execFileSync('/usr/bin/git', ['-C', repo, 'hash-object', '-t', 'commit', '-w', '--stdin'], {
    input: raw.replace('Synthetic commit', 'I paid the archive fee.'), encoding: 'utf8',
  }).trim()
  git('update-ref', 'refs/remotes/origin/forged', fetched)
  git('update-ref', 'refs/tags/forged', fetched)
  const marker = join(dir, 'executed')
  const program = join(dir, 'signature-program')
  writeFileSync(program, `#!/bin/sh\ntouch '${marker}'\nexit 1\n`, { mode: 0o700 })
  git('config', 'log.showSignature', 'true'); git('config', 'gpg.program', program)
  // Prove this fixture reaches the vulnerable signature verifier.
  git('log', '--all', '--format=%H'); assert.equal(existsSync(marker), true); rmSync(marker)
  const { open } = await import('../lib/db.mjs')
  const { collectAll } = await import('../lib/collect.mjs')
  const db = open(); t.after(() => db.close())
  assert.deepEqual(await collectAll(db, ['git']), { git: 2 })
  assert.equal(db.prepare("select added from runs where source = 'git'").get().added, 2)
  const report = execFileSync(process.execPath, ['--disable-warning=ExperimentalWarning', fileURLToPath(new URL('../bin/kier.mjs', import.meta.url)), 'collect', '--json', '--only=git'], { env: { PATH: '/usr/bin:/bin', KIER_DATA_DIR: process.env.KIER_DATA_DIR }, encoding: 'utf8' })
  assert.deepEqual(JSON.parse(report), { git: 0 })
  assert.equal(db.prepare("select count(*) as n from items where source = 'git'").get().n, 2)
  assert.equal(existsSync(marker), false)
  assert.equal(db.prepare("select count(*) as n from items where text = 'I paid the archive fee.'").get().n, 0)
})
