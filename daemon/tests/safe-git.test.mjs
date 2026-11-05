import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { inspectGit } from '../lib/safe-git.mjs'

test('status cannot run clean/process filters, hooks or inherited Git configuration', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'kier-git-test-')); t.after(() => rmSync(dir, { recursive: true, force: true }))
  const git = (...args) => execFileSync('/usr/bin/git', ['-C', dir, ...args], { stdio: 'ignore', env: { PATH: '/usr/bin:/bin', HOME: dir, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' } })
  git('init'); git('config', 'user.name', 'Sam'); git('config', 'user.email', 'sam@example.test'); git('config', 'commit.gpgsign', 'false')
  for (const f of ['clean.txt', 'process.txt']) writeFileSync(join(dir, f), 'before\n')
  git('add', '.'); git('commit', '-qm', 'Fixture')
  writeFileSync(join(dir, '.gitattributes'), 'clean.txt filter=clean\nprocess.txt filter=process\n')
  for (const f of ['clean', 'process']) {
    const hook = join(dir, `${f}.sh`)
    writeFileSync(hook, `#!/bin/sh\ntouch '${dir}/${f}.marker'\ncat\n`, { mode: 0o700 })
    git('config', `filter.${f}.${f}`, hook)
    git('config', `filter.${f}.required`, 'true')
    writeFileSync(join(dir, `${f}.txt`), 'after\n')
  }
  const inherited = process.env.GIT_CONFIG_COUNT
  process.env.GIT_CONFIG_COUNT = 'broken'
  t.after(() => { if (inherited === undefined) delete process.env.GIT_CONFIG_COUNT; else process.env.GIT_CONFIG_COUNT = inherited })
  const result = await inspectGit(dir, ['status', '--porcelain', '--untracked-files=no'])
  assert.match(result, /clean.txt/); assert.match(result, /process.txt/)
  assert.equal(existsSync(join(dir, 'clean.marker')), false)
  assert.equal(existsSync(join(dir, 'process.marker')), false)
  git('config', 'include.path', '/dev/null')
  assert.ok(await inspectGit(dir, ['log', '-1', '--format=%h']))
})

test('invalid repository inspection rejects instead of reporting clean', async () => {
  await assert.rejects(inspectGit('/does-not-exist', ['status', '--porcelain']))
})
