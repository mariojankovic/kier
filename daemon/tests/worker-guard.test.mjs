import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
const guard = new URL('../lib/worker-guard.mjs', import.meta.url).pathname
const run = (code) => spawn(process.execPath, [guard, process.execPath, '-e', code], { stdio: ['ignore', 'ignore', 'ignore', 'pipe'] })
const ended = (child, ms = 10000) => new Promise((done, fail) => {
  const timer = setTimeout(() => { child.kill('SIGKILL'); fail(Error('guard still running')) }, ms)
  child.on('exit', (code, signal) => { clearTimeout(timer); done({ code, signal }) })
})

// A model sidecar that stops on its own must take its guard with it, or the daemon never sees it stop and never
// starts it again (0.7.10: the local model died and every caller got "not running" until Kier was restarted).
test('the guard exits when its worker exits normally', async () => {
  assert.deepEqual(await ended(run('process.exit(0)')), { code: 0, signal: null })
  assert.deepEqual(await ended(run('process.exit(3)')), { code: 3, signal: null })
})

test('the guard stops its worker when the owner goes away', async () => {
  const child = run('setInterval(() => {}, 1000)')
  await new Promise(r => setTimeout(r, 500))
  child.stdio[3].destroy()
  assert.equal((await ended(child)).signal, 'SIGTERM')
})
