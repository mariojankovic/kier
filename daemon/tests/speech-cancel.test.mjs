import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import child from 'node:child_process'
import { syncBuiltinESMExports } from 'node:module'
import { once, EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { managedSpawn } from '../lib/child-process.mjs'
const dir = mkdtempSync(join(tmpdir(), 'kier-speech-cancel-'))
process.env.KIER_DATA_DIR = dir
mkdirSync(join(dir, 'tts/bin'), { recursive: true })
mkdirSync(join(dir, 'models/ming-tts-8bit'), { recursive: true })
writeFileSync(join(dir, 'tts/bin/python'), 'fixture')
writeFileSync(join(dir, 'config.json'), JSON.stringify({ me: 'Sam', online: false, workRoots: [] }))
after(() => rmSync(dir, { recursive: true, force: true }))

for (const signal of ['SIGTERM', 'SIGINT', 'SIGHUP']) test(`guard reports ${signal} cancellation after worker cleanup`, async t => {
  const guard = managedSpawn(process.execPath, ['-e', "process.on('SIGTERM',()=>{});console.log('ready');setInterval(()=>{},1000)"])
  t.after(() => guard.kill('SIGKILL'))
  await once(guard.stdout, 'data')
  const exited = once(guard, 'exit')
  guard.kill(signal)
  assert.deepEqual(await exited, [null, signal])
})
test('cancellation during successful worker-exit cleanup overrides zero status', async t => {
  const guard = managedSpawn(process.execPath, ['-e', "console.log('ready')"])
  t.after(() => guard.kill('SIGKILL'))
  await once(guard.stdout, 'data')
  await new Promise(resolve => setTimeout(resolve, 150))
  const exited = once(guard, 'exit'); guard.kill('SIGTERM')
  assert.deepEqual(await exited, [null, 'SIGTERM'])
})
test('worker self-termination is propagated to its caller', async t => {
  const guard = managedSpawn(process.execPath, ['-e', "process.kill(process.pid,'SIGTERM')"])
  t.after(() => guard.kill('SIGKILL'))
  assert.deepEqual(await once(guard, 'exit'), [null, 'SIGTERM'])
})
test('stopped and superseded renders never play or fall back, even after a late successful exit', async t => {
  const { say, stop } = await import('../lib/speak.mjs')
  const spawned = []
  t.mock.method(child, 'spawn', (command, args) => {
    const worker = new EventEmitter()
    worker.stdin = new PassThrough(); worker.kill = () => true
    spawned.push({ worker, command, args })
    return worker
  })
  syncBuiltinESMExports()
  t.after(() => { stop(); t.mock.restoreAll(); syncBuiltinESMExports() })
  const first = say('First fixture answer')
  stop(); first.emit('exit', null, 'SIGTERM')
  assert.equal(spawned.length, 1)
  const late = say('Late fixture answer')
  stop(); late.emit('exit', 0, null)
  assert.equal(spawned.length, 2)
  const old = say('Old fixture answer'), current = say('Current fixture answer')
  old.emit('exit', 0, null)
  assert.equal(spawned.length, 4)
  const prefixes = spawned.map(row => row.args[row.args.indexOf('--file_prefix') + 1])
  assert.equal(new Set(prefixes).size, 4)
  current.emit('exit', 0, null)
  assert.equal(spawned.length, 5)
  assert.ok(spawned[4].args[1].endsWith('/afplay'))
  assert.ok(spawned[4].args[2].endsWith(prefixes[3] + '.wav'))
})

async function audioFixture(t) {
  const speech = await import('../lib/speak.mjs')
  const spawned = []
  t.mock.method(child, 'spawn', (command, args) => {
    const worker = new EventEmitter()
    worker.stdin = new PassThrough(); worker.kill = () => { worker.killed = true; return true }
    const prefix = args[args.indexOf('--file_prefix') + 1]
    const path = args.includes('--file_prefix') ? join(dir, 'tmp', `${prefix}.wav`) : args[2]
    if (args.includes('--file_prefix')) writeFileSync(path, 'fixture audio')
    spawned.push({ worker, command, args, path })
    return worker
  })
  syncBuiltinESMExports()
  t.after(() => { speech.stop(); t.mock.restoreAll(); syncBuiltinESMExports() })
  return { ...speech, spawned }
}
async function removed(path) {
  const { existsSync } = await import('node:fs')
  for (let attempt = 0; attempt < 100 && existsSync(path); attempt++) await new Promise(resolve => setTimeout(resolve, 5))
  assert.equal(existsSync(path), false)
}
for (const ending of ['played', 'canceled', 'error']) test(`utterance WAV is deleted after playback ${ending}`, async t => {
  const f = await audioFixture(t)
  const gen = f.say('Fixture answer'), path = f.spawned[0].path
  gen.emit('exit', 0, null)
  const player = f.spawned[1].worker
  assert.equal(f.spawned[1].path, path)
  if (ending === 'canceled') { f.stop(); assert.equal(player.killed, true) }
  if (ending === 'error') player.emit('error', Error('fixture playback failure'))
  else player.emit('exit', ending === 'played' ? 0 : null, ending === 'played' ? null : 'SIGTERM')
  await removed(path)
  assert.equal(f.speaking(), false)
})
for (const ending of ['canceled', 'late success', 'failed', 'error', 'superseded']) test(`utterance WAV is deleted after rendering ${ending}`, async t => {
  const f = await audioFixture(t)
  const gen = f.say('Fixture answer'), path = f.spawned[0].path
  if (ending === 'superseded') f.say('New fixture answer')
  else if (['canceled', 'late success'].includes(ending)) f.stop()
  if (ending === 'error') gen.emit('error', Error('fixture render failure'))
  else {
    // A canceled renderer can still write output before the guard finishes cleanup.
    writeFileSync(path, 'late fixture audio')
    gen.emit('exit', ending === 'canceled' ? null : ending === 'failed' ? 1 : 0, ending === 'canceled' ? 'SIGTERM' : null)
  }
  await removed(path)
  if (ending === 'superseded') {
    const next = f.spawned[1]; f.stop(); next.worker.emit('exit', null, 'SIGTERM'); await removed(next.path)
  }
  assert.equal(f.spawned.some(row => row.args[1].endsWith('/afplay')), false)
})
for (const ending of ['played', 'canceled', 'failed']) test(`prerendered brief WAV is deleted when ${ending}`, async t => {
  const f = await audioFixture(t), { open } = await import('../lib/db.mjs')
  const db = open(':memory:'); t.after(() => db.close())
  assert.equal(f.prerender(db), true)
  const { worker, path } = f.spawned[0]
  if (ending === 'canceled') { f.stop(); worker.emit('exit', 0, null) }
  else if (ending === 'failed') worker.emit('exit', 1, null)
  else {
    worker.emit('exit', 0, null)
    assert.equal(f.prerender(db), false)
    f.speak(db)
    assert.equal(f.spawned[1].path, path)
    f.spawned[1].worker.emit('exit', 0, null)
  }
  await removed(path)
})
test('startup sweeps stale speech caches without deleting unrelated files or an active render', async t => {
  const f = await audioFixture(t)
  const stale = ['kier-say.wav', 'kier-say-123-4.wav', 'kier-brief.wav', 'kier-brief-next.wav', 'kier-brief.txt', 'kier-brief-123-4.wav']
  for (const name of [...stale, 'fixture.wav', 'handoff-fixture.txt']) writeFileSync(join(dir, 'tmp', name), 'fixture')
  const gen = f.say('Active fixture'), path = f.spawned[0].path
  await f.sweepSpeechFiles()
  for (const name of stale) await removed(join(dir, 'tmp', name))
  const { existsSync, readFileSync } = await import('node:fs')
  for (const retained of [path, join(dir, 'tmp/fixture.wav'), join(dir, 'tmp/handoff-fixture.txt')]) assert.equal(existsSync(retained), true)
  f.stop(); gen.emit('exit', null, 'SIGTERM'); await removed(path)
  const main = readFileSync('bin/kier.mjs', 'utf8')
  assert.ok(main.indexOf('await serve(db, { install })') < main.indexOf('await sweepSpeechFiles()'))
  assert.ok(main.indexOf('await sweepSpeechFiles()') < main.indexOf('startRuntime((line)'))
})

for (const state of ['cached', 'playing']) test(`cancel removes a ${state} brief WAV`, async t => {
  const f = await audioFixture(t), { open } = await import('../lib/db.mjs')
  const db = open(':memory:'); t.after(() => db.close())
  f.prerender(db)
  const { worker, path } = f.spawned[0]
  worker.emit('exit', 0, null)
  if (state === 'playing') f.speak(db)
  f.stop()
  if (state === 'playing') f.spawned[1].worker.emit('exit', null, 'SIGTERM')
  await removed(path)
})
