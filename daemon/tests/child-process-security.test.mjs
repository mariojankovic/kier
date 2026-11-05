import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, rmSync, existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { childEnv, executable, execFileSync } from '../lib/child-process.mjs'
const dir = mkdtempSync(join(tmpdir(), 'kier-env-'))
after(() => rmSync(dir, { recursive: true, force: true }))
test('hostile inherited paths and interpreter startup settings never reach children', () => {
  const before = { ...process.env }
  const marker = join(dir, 'executed')
  writeFileSync(join(dir, 'id'), `#!/bin/sh\ntouch '${marker}'\n`, { mode: 0o700 })
  writeFileSync(join(dir, 'sitecustomize.py'), `open(${JSON.stringify(marker)}, 'w').close()`)
  const poison = { PATH: dir, PYTHONPATH: dir, PYTHONHOME: dir, PYTHONSTARTUP: marker, NODE_OPTIONS: '--import=' + marker, DYLD_INSERT_LIBRARIES: marker, LD_PRELOAD: marker }
  try {
    Object.assign(process.env, poison)
    const env = JSON.parse(execFileSync(process.execPath, ['-e', 'process.stdout.write(JSON.stringify(process.env))'], { encoding: 'utf8' }))
    for (const key of Object.keys(poison).filter(k => k !== 'PATH')) assert.equal(env[key], undefined)
    assert.notEqual(env.PATH, dir)
    assert.equal(executable('id'), '/usr/bin/id')
    execFileSync('id', ['-u'])
    const flags = JSON.parse(execFileSync('python3', ['-I', '-E', '-c', 'import sys,json; print(json.dumps([sys.flags.isolated,sys.flags.ignore_environment]))'], { encoding: 'utf8' }))
    assert.deepEqual(flags, [1, 1])
    assert.equal(existsSync(marker), false)
    for (const key of Object.keys(poison).filter(k => k !== 'PATH')) assert.equal(childEnv(poison)[key], undefined)
  } finally { process.env = before }
})
test('app and inference workers use controlled environment and isolated Python flags', () => {
  const app = readFileSync(new URL('../../app/main.swift', import.meta.url), 'utf8')
  assert.doesNotMatch(app, /child.environment = ProcessInfo/)
  for (const file of ['runtime', 'second', 'speak']) {
    const source = readFileSync(new URL(`../lib/${file}.mjs`, import.meta.url), 'utf8')
    assert.doesNotMatch(source, /\.\.\.process.env|env: process.env/)
    assert.match(source, /\[\s*["']-I["'],\s*["']-E["']/)
  }
})
