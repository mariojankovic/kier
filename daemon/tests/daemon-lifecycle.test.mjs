import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:net'
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawn, execFile } from 'node:child_process'
import { promisify } from 'node:util'
const dir = mkdtempSync(join(tmpdir(), 'kier-lifecycle-'))
after(() => rmSync(dir, { recursive: true, force: true }))
const run = promisify(execFile)

test('occupied port exits nonzero before any installed model launcher or maintenance runs', async t => {
  const occupied = createServer()
  await new Promise(r => occupied.listen(0, '127.0.0.1', r))
  t.after(() => occupied.close())
  writeFileSync(join(dir, 'config.json'), JSON.stringify({ me: 'Sam', fullName: 'Sam', runtime: 'mlx', port: occupied.address().port }))
  mkdirSync(join(dir, 'llm/bin'), { recursive: true })
  mkdirSync(join(dir, 'models/qwen3.5-9b-4bit'), { recursive: true })
  writeFileSync(join(dir, 'models/qwen3.5-9b-4bit/.kier-ready'), '')
  const marker = join(dir, 'worker-started')
  // A mock launcher only. No model, app, collector or installation is started.
  writeFileSync(join(dir, 'llm/bin/python'), `#!/bin/sh\ntouch '${marker}'\nexit 0\n`, { mode: 0o700 })
  mkdirSync(join(dir, 'extension'))
  const started = Date.now()
  await assert.rejects(run(process.execPath, ['--disable-warning=ExperimentalWarning', 'bin/kier.mjs', 'run'], {
    env: { KIER_DATA_DIR: dir, PATH: '/usr/bin:/bin' }, timeout: 10000,
  }), e => e.code === 1 && !e.killed)
  assert.ok(Date.now() - started < 10000)
  assert.equal(existsSync(marker), false)
  assert.equal(existsSync(join(dir, 'extension')), true, 'startup maintenance must wait for the listener')
})

const alive = pid => { try { process.kill(pid, 0); return true } catch { return false } }
const pause = ms => new Promise(r => setTimeout(r, ms))
for (const signal of ['SIGTERM', 'SIGINT', 'SIGHUP', 'SIGKILL']) {
  test(`worker guard kills a stubborn worker and its descendants when owner receives ${signal}`, async t => {
    const worker = join(dir, `worker-${signal}.mjs`), parent = join(dir, `parent-${signal}.mjs`)
    writeFileSync(worker, `import { spawn } from 'node:child_process'
process.on('SIGTERM', () => {})
const child = spawn(process.execPath, ['-e', "process.on('SIGTERM',()=>{});setInterval(()=>{},1000)"], { stdio: 'ignore' })
console.log(JSON.stringify({ worker: process.pid, descendant: child.pid }))
setInterval(() => {}, 1000)
`)
    writeFileSync(parent, `import { managedSpawn } from ${JSON.stringify(new URL('../lib/child-process.mjs', import.meta.url).href)}
const child = managedSpawn(process.execPath, [${JSON.stringify(worker)}])
child.stdout.pipe(process.stdout)
`)
    const owner = spawn(process.execPath, [parent], { stdio: ['ignore', 'pipe', 'pipe'] })
    let pids
    t.after(() => { owner.kill('SIGKILL'); for (const pid of Object.values(pids || {})) { try { process.kill(pid, 'SIGKILL') } catch {} } })
    pids = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(Error('mock worker did not start')), 20000)
      owner.stdout.once('data', data => { clearTimeout(timer); resolve(JSON.parse(String(data))) })
      owner.once('error', reject)
    })
    assert.ok(alive(pids.worker)); assert.ok(alive(pids.descendant))
    owner.kill(signal)
    for (let i = 0; i < 150 && Object.values(pids).some(alive); i++) await pause(25)
    assert.equal(alive(pids.worker), false)
    assert.equal(alive(pids.descendant), false)
  })
}
