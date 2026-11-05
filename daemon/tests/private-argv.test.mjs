import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import child from 'node:child_process'
import { syncBuiltinESMExports } from 'node:module'
import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { mkdtempSync, writeFileSync, readFileSync, statSync, existsSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
const dir = mkdtempSync(join(tmpdir(), 'kier-argv-fixture-'))
process.env.KIER_DATA_DIR = dir
writeFileSync(join(dir, 'config.json'), JSON.stringify({ me: 'Sam', fullName: 'Sam' }))
const { claude, events } = await import('../lib/ask.mjs')
const { ask: doubleCheck } = await import('../lib/doublecheck.mjs')
const { render } = await import('../lib/speak.mjs')
const { notify } = await import('../lib/notify.mjs')
const { launchHandoff } = await import('../lib/handoff.mjs')
after(() => rmSync(dir, { recursive: true, force: true }))
const content = 'SYNTHETIC_PRIVATE_CONTENT Nika sent the fixture notes.'
function mockSpawn(t, output = '') {
  const calls = []
  t.mock.method(child, 'spawn', (command, args, options) => {
    const p = new EventEmitter()
    p.stdin = new PassThrough(); p.stdout = new PassThrough()
    p.kill = () => {}; p.unref = () => {}
    const call = { command, args, options, input: '', child: p }; calls.push(call)
    p.stdin.on('data', chunk => { call.input += chunk })
    setImmediate(() => { if (output) p.stdout.write(output); p.emit('close', 0) })
    return p
  })
  syncBuiltinESMExports()
  t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports() })
  return calls
}
test('Claude Ask sends the entire prompt through stdin with no content in argv', async t => {
  const calls = mockSpawn(t, JSON.stringify({ type: 'result', result: 'Fixture answer' }) + '\n')
  // A synthetic executable makes this independent of CLI installation.
  const result = await claude(content, { text() {}, status() {} }, (_cmd, args, event, input) => events('/fixture/claude', args, event, input))
  assert.equal(result.out, 'Fixture answer')
  assert.equal(calls[0].input, content)
  assert.ok(!JSON.stringify(calls[0].args).includes(content))
  assert.equal(calls[0].args[0], '-p')
})
test('double-check moves both the context and owner-specific instructions into stdin', async t => {
  const calls = mockSpawn(t, JSON.stringify({ result: '{"fixed":false}' }))
  await doubleCheck(content, '/fixture/claude')
  assert.ok(calls[0].input.includes(content))
  assert.ok(calls[0].input.includes('Sam'))
  assert.ok(!JSON.stringify(calls[0].args).includes(content))
  assert.ok(!JSON.stringify(calls[0].args).includes('Sam'))
  assert.ok(!calls[0].args.includes('--system-prompt'))
})
test('TTS consumes spoken text on stdin', t => {
  const calls = mockSpawn(t)
  render(content, 'fixture-audio')
  assert.equal(calls[0].input, content)
  assert.ok(!calls[0].args.includes('--text'))
  assert.ok(!JSON.stringify(calls[0].args).includes(content))
})
test('notification content is passed as an AppleScript program on stdin', t => {
  let call
  t.mock.method(child, 'execFileSync', (command, args, options) => { call = { command, args, options } })
  syncBuiltinESMExports()
  t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports() })
  notify(`- ${content}`)
  assert.deepEqual(call.args, ['-'])
  assert.ok(call.options.input.includes(content))
  assert.ok(!JSON.stringify(call.args).includes(content))
})
test('interactive handoffs use private files and remove them after mocked CLI success or failure', t => {
  const calls = mockSpawn(t)
  for (const agent of ['claude', 'codex']) for (const branch of [false, true]) for (const code of [0, 1]) {
    const record = join(dir, 'argv.json'), fake = join(dir, 'fake-cli')
    writeFileSync(fake, `#!${process.execPath}\nconst fs = require('node:fs');\nconst args = process.argv.slice(2);\nconst path = args.at(-1).match(/brief at (.*) and carry/)[1];\nfs.writeFileSync(${JSON.stringify(record)}, JSON.stringify({args, brief: fs.readFileSync(path, 'utf8')}));\nprocess.exit(${code});\n`, { mode: 0o700 })
    const paths = launchHandoff({ full: content, repo: dir, session: { id: 'fixture-session' } }, agent, fake, branch)
    assert.equal(statSync(paths.brief).mode & 0o777, 0o600)
    assert.equal(statSync(paths.script).mode & 0o777, 0o700)
    assert.equal(statSync(join(dir, 'tmp')).mode & 0o777, 0o700)
    assert.ok(!JSON.stringify(calls.at(-1).args).includes(content))
    assert.ok(!readFileSync(paths.script, 'utf8').includes(content))
    try { child.execFileSync('/bin/zsh', [paths.script], { stdio: 'pipe' }); assert.equal(code, 0) }
    catch (e) { assert.equal(e.status, code); assert.equal(code, 1) }
    const got = JSON.parse(readFileSync(record, 'utf8'))
    assert.equal(got.brief, content)
    assert.ok(!JSON.stringify(got.args).includes(content))
    assert.equal(existsSync(paths.brief), false)
    assert.equal(existsSync(paths.script), false)
  }
  const failed = launchHandoff({ full: content, repo: dir }, 'claude', '/fixture/claude')
  calls.at(-1).child.emit('error', Error('SYNTHETIC_FAILURE'))
  assert.equal(existsSync(failed.brief), false)
  assert.equal(existsSync(failed.script), false)
})
