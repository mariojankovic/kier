import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { mkdtempSync, rmSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
const dir = mkdtempSync(join(tmpdir(), 'kier-log-test-'))
process.env.KIER_DATA_DIR = dir
after(() => rmSync(dir, { recursive: true, force: true }))
const { parse } = await import('../lib/plans.mjs')
const { searchWords } = await import('../lib/headsup.mjs')
const { judge } = await import('../lib/resolve.mjs')
const { open } = await import('../lib/db.mjs')
const { childDiagnostics, errorRecord, parseModelJSON } = await import('../lib/errors.mjs')
const marker = 'PRIVATE_MODEL_STDERR_MARKER'
const broken = `{"value":"${marker}", broken}`
const safe = (err) => { assert.doesNotMatch(String(err.stack), new RegExp(marker)); return true }

const { modelFixture } = await import('./model-fixture.mjs')
await modelFixture({ decision: false })

test('plans parser exposes a fixed code for malformed and non-object model answers', () => {
  for (const value of [broken, marker]) assert.throws(() => parse(value, {}), err => { assert.equal(err.message, 'PLANS_JSON_INVALID'); return safe(err) })
})
test('heads-up and resolve parser failures never expose the model response', async t => {
  const old = globalThis.fetch
  globalThis.fetch = async () => new Response(JSON.stringify({ message: { content: broken } }))
  t.after(() => { globalThis.fetch = old })
  await assert.rejects(searchWords('fixture', 'fixture'), err => { assert.equal(err.message, 'HEADSUP_JSON_INVALID'); return safe(err) })
  const db = open(':memory:'); t.after(() => db.close())
  await assert.rejects(judge(db, { source: 'ai', sender: 'Nika', text: 'fixture', ts: 1 }, []), safe)
})
test('runtime and decision stdout, stderr and spawn errors emit only bounded codes', () => {
  const child = new EventEmitter(); child.stdout = new EventEmitter(); child.stderr = new EventEmitter()
  const logs = []; childDiagnostics(child, line => logs.push(line))
  for (let n = 0; n < 20; n++) { child.stdout.emit('data', marker); child.stderr.emit('data', `Traceback ${marker}`) }
  child.emit('error', Error(marker))
  assert.equal(logs.length, 3); assert.doesNotMatch(logs.join(''), new RegExp(marker))
  for (const line of logs) assert.match(JSON.parse(line).code, /^SIDECAR_/)
})
test('routine background errors and every remaining model JSON boundary use fixed diagnostics', () => {
  assert.doesNotMatch(JSON.stringify(errorRecord(marker)), new RegExp(marker))
  assert.throws(() => parseModelJSON(broken), safe)
  const bin = readFileSync(new URL('../bin/kier.mjs', import.meta.url), 'utf8')
  assert.doesNotMatch(bin, /\be\.message\b/)
  for (const file of ['runtime', 'second']) {
    const text = readFileSync(new URL(`../lib/${file}.mjs`, import.meta.url), 'utf8')
    assert.match(text, /childDiagnostics\(child, log\)/)
    assert.doesNotMatch(text, /\be\.message\b|String\(d\)/)
  }
  for (const file of ['resolve', 'ask', 'handoff', 'tagger']) {
    const text = readFileSync(new URL(`../lib/${file}.mjs`, import.meta.url), 'utf8')
    assert.doesNotMatch(text, /JSON\.parse\(\(await res\.json\(\)\)\.message/)
  }
  const collect = readFileSync(new URL('../lib/collect.mjs', import.meta.url), 'utf8')
  assert.doesNotMatch(collect, /\be(?:rr)?\.message\b/)
})

test('runtime installer subprocess errors discard raw stderr and command details', async () => {
  const { runtimeCommand } = await import('../lib/runtime.mjs')
  await assert.rejects(runtimeCommand(process.execPath, ['-e', `process.stderr.write('${marker}'); process.exit(1)`]), err => {
    assert.equal(err.message, 'SUBPROCESS_FAILED'); return safe(err)
  })
})
