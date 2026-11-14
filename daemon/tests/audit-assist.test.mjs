import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { createServer, request } from 'node:http'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { sealBody, signedHeaders, responseMAC } from '../lib/http-auth.mjs'

const dir = mkdtempSync(join(tmpdir(), 'kier-audit-assist-'))
process.env.KIER_DATA_DIR = dir
const seen = []
let output = JSON.stringify({ summary: 'Clear the old build cache first.', picks: [{ ref: 'a1', why: 'A stale build cache nobody uses.' }] })
const model = createServer(async (req, res) => {
  let body = ''
  for await (const chunk of req) body += chunk
  seen.push(JSON.parse(body))
  res.writeHead(200, { 'content-type': 'application/json' })
  res.end(JSON.stringify({ choices: [{ message: { content: output } }] }))
})
await new Promise(resolve => model.listen(0, '127.0.0.1', resolve))
writeFileSync(join(dir, 'config.json'), JSON.stringify({
  me: 'Owner', fullName: 'Owner Example', off: [], runtime: 'external',
  externalModel: { protocol: 'openai', endpoint: `http://127.0.0.1:${model.address().port}/v1`, model: 'fixture-audit' },
}))
const { auditAssist, validateAuditAssist, parseAdvice, auditEvidence, fallbackAdvice, explainEvidence, quickAdvice } = await import('../lib/audit-assist.mjs')
const { homedir } = await import('node:os')
const { open } = await import('../lib/db.mjs')
const { serve } = await import('../lib/server.mjs')
const { tokenPath } = await import('../lib/config.mjs')
const secret = 'c'.repeat(64)
writeFileSync(tokenPath, secret, { mode: 0o600 })
const db = open(':memory:')
const server = await serve(db, { port: 0 })
const port = server.address().port
after(async () => {
  await Promise.all([new Promise(resolve => server.close(resolve)), new Promise(resolve => model.close(resolve))])
  db.close()
  rmSync(dir, { recursive: true, force: true })
})

const valid = () => ({
  task: 'advise',
  machine: { free_bytes: 20e9, capacity_bytes: 500e9 },
  items: [
    { id: 'disk:/Volumes/Work/app/.next', category: 'disk', title: '.next', project: 'app', reason: 'Idle 9d, nothing running.', bytes: 4e9 },
    { id: 'stop:/Volumes/Work/app-wt', category: 'servers', title: 'feature-x', project: 'app', reason: 'Merged and pushed.', bytes: 0, memory_bytes: 1.2e9 },
    { id: 'disk:/tiny', category: 'disk', title: 'tiny', reason: 'Idle.', bytes: 2e3 },
  ],
  review: [{ title: 'node_modules', reason: 'Used yesterday.', bytes: 1e9 }],
  needs_you: { decisions: 2 },
})
const fixedModel = (content, calls = []) => async (path, options) => {
  calls.push(JSON.parse(options.body))
  return new Response(JSON.stringify({ message: { content } }))
}

test('audit-assist validates and normalizes requests', () => {
  const input = validateAuditAssist(valid())
  assert.equal(input.items.length, 3)
  assert.equal(input.items[1].bytes, 0)
  assert.deepEqual(input.needs_you, { decisions: 2, inactive_projects: 0 })
  const bad = [null, [], { ...valid(), task: 'delete' }, { ...valid(), items: 'x' }, { ...valid(), machine: [] },
    { ...valid(), items: [{ ...valid().items[0], category: 'home' }] }, { ...valid(), items: [valid().items[0], valid().items[0]] },
    { ...valid(), items: [{ ...valid().items[0], bytes: -1 }] }, { ...valid(), machine: { free_bytes: 1.5 } }]
  for (const input of bad) assert.throws(() => validateAuditAssist(input), error => error.status === 400)
  assert.throws(() => validateAuditAssist({ ...valid(), items: Array.from({ length: 201 }, (_, i) => ({ ...valid().items[0], id: `x${i}` })) }), error => error.status === 413)
})

test('the model sees short refs and sizes, never ids, and biggest first', () => {
  const { refs, evidence } = auditEvidence(validateAuditAssist(valid()))
  assert.equal(refs.get('a1').id, 'stop:/Volumes/Work/app-wt')
  assert.equal(evidence.safe_to_clean[0].frees_memory, '1.2 GB')
  assert.equal(evidence.machine.disk_free_percent, 4)
  assert.ok(!JSON.stringify(evidence).includes('/Volumes/Work'))
})

test('picks are limited to listed refs, deduplicated and cleaned of dashes', () => {
  const { refs } = auditEvidence(validateAuditAssist(valid()))
  const advice = parseAdvice('```json\n' + JSON.stringify({ summary: 'Do this — now', picks: [
    { ref: 'a2', why: 'Big cache' }, { ref: 'a2', why: 'again' }, { ref: 'a9', why: 'invented' }, { ref: '/etc', why: 'path' }, 'x'] }) + '\n```', refs)
  assert.deepEqual(advice, { summary: 'Do this - now', picks: [{ id: 'disk:/Volumes/Work/app/.next', why: 'Big cache' }] })
  const sized = parseAdvice(JSON.stringify({ summary: 'Go.', picks: [{ ref: 'a1', why: 'It is a running server that frees 790 MB of memory.' }, { ref: 'a2', why: 'Scratch space with no chat and frees 8.3 GB.' }] }), refs)
  assert.deepEqual(sized.picks.map(pick => pick.why), ['It is a running server.', 'Scratch space with no chat.'])
  assert.equal(parseAdvice('not json', refs), null)
  assert.equal(parseAdvice(JSON.stringify({ summary: '', picks: [] }), refs), null)
})

test('unusable model output falls back to the biggest wins', async () => {
  const result = await auditAssist(valid(), { fetchModel: fixedModel('sorry') })
  assert.equal(result.fallback, true)
  assert.deepEqual(result.picks.map(pick => pick.id), ['stop:/Volumes/Work/app-wt', 'disk:/Volumes/Work/app/.next', 'disk:/tiny'])
  assert.deepEqual(fallbackAdvice({ items: [] }), { summary: 'Nothing worth cleaning right now.', picks: [] })
})

test('an empty list answers without calling the model', async () => {
  const result = await auditAssist({ ...valid(), items: [] }, { fetchModel: () => assert.fail('called model') })
  assert.deepEqual(result.picks, [])
})

test('a model failure is a 503', async () => {
  await assert.rejects(auditAssist(valid(), { fetchModel: async () => new Response('', { status: 500 }) }), error => error.status === 503)
})

function send(path, { method = 'POST', input, signed = true, encrypted = true } = {}) {
  const plain = input === undefined ? Buffer.alloc(0) : Buffer.from(JSON.stringify(input))
  const wire = signed && encrypted && plain.length ? sealBody(secret, plain) : plain
  const proof = signed ? signedHeaders(secret, method, path, wire) : {}
  return new Promise((resolve, reject) => {
    const req = request({ hostname: '127.0.0.1', port, path, method, headers: { 'content-type': 'application/json', ...proof } }, res => {
      const chunks = []
      res.on('data', chunk => chunks.push(chunk))
      res.on('end', () => {
        const body = Buffer.concat(chunks)
        if (signed && res.statusCode !== 401) assert.equal(res.headers['x-kier-response'], responseMAC(secret, proof['x-kier-nonce'], res.statusCode, body))
        resolve({ status: res.statusCode, body: JSON.parse(body.toString('utf8')) })
      })
    })
    req.on('error', reject)
    req.end(wire)
  })
}

test('the route needs the native proof and a sealed body, and maps refs back to ids', async () => {
  seen.length = 0
  assert.equal((await send('/api/audit-assist', { input: valid(), signed: false })).status, 401)
  assert.equal((await send('/api/audit-assist', { input: valid(), encrypted: false })).status, 400)
  assert.equal((await send('/api/audit-assist', { method: 'GET' })).status, 400)
  assert.equal(seen.length, 0)
  const answer = await send('/api/audit-assist', { input: valid() })
  assert.equal(answer.status, 200)
  assert.equal(answer.body.summary, 'Clear the old build cache first.')
  assert.deepEqual(answer.body.picks, [{ id: 'stop:/Volumes/Work/app-wt', why: 'A stale build cache nobody uses.' }])
  assert.equal(seen.length, 1)
  assert.ok(!JSON.stringify(seen[0]).includes('/Volumes/Work'))
})

const subject = () => ({ task: 'explain', subject: { kind: 'worktree', title: 'agent/wip-3', project: 'app',
  facts: ['Not merged into main', 'Unpushed commits: 1', `Path: ${homedir()}/Work/app-wt`],
  entries: [{ name: 'src/checkout.ts', note: 'modified' }, { name: 'node_modules', note: 'build cache' }, { name: 'notes.txt' }] } })

test('explain validates its subject', () => {
  const input = validateAuditAssist(subject())
  assert.equal(input.subject.entries[2].note, '')
  const bad = [{ ...subject(), subject: null }, { ...subject(), subject: { ...subject().subject, kind: 'home' } },
    { ...subject(), subject: { ...subject().subject, title: ' ' } }, { ...subject(), subject: { ...subject().subject, facts: [1] } },
    { ...subject(), subject: { ...subject().subject, entries: [{ note: 'x' }] } }, { ...subject(), subject: { ...subject().subject, entries: 'x' } }]
  for (const input of bad) assert.throws(() => validateAuditAssist(input), error => error.status === 400)
  assert.throws(() => validateAuditAssist({ ...subject(), subject: { ...subject().subject, facts: Array(13).fill('x') } }), error => error.status === 413)
  assert.throws(() => validateAuditAssist({ ...subject(), subject: { ...subject().subject, entries: Array(81).fill({ name: 'x' }) } }), error => error.status === 413)
  assert.throws(() => validateAuditAssist({ ...valid(), task: 'delete' }), error => /advise or explain/.test(error.message))
})

test('explain shows the model names and notes with the home folder hidden', () => {
  const evidence = explainEvidence(validateAuditAssist(subject()))
  assert.deepEqual(evidence.uncommitted_files, ['src/checkout.ts (modified)', 'node_modules (build cache)', 'notes.txt'])
  assert.equal(evidence.facts[2], 'Path: ~/Work/app-wt')
  const disk = explainEvidence(validateAuditAssist({ ...subject(), subject: { ...subject().subject, kind: 'disk', entries: Array.from({ length: 50 }, (_, i) => ({ name: `f${i}` })) } }))
  assert.equal(disk.contents.length, 40)
  assert.equal(disk.more_not_shown, 10)
})

test('explain returns one clean paragraph and fails closed', async () => {
  const calls = []
  const result = await auditAssist(subject(), { fetchModel: fixedModel('<think>hm</think>**Looks like real work** \u2014 one source file.\n\nKeep it for now.', calls) })
  assert.equal(result.text, 'Looks like real work - one source file. Keep it for now.')
  assert.match(calls[0].messages[0].content, /Git worktree/)
  assert.equal(calls[0].format, undefined)
  await assert.rejects(auditAssist(subject(), { fetchModel: fixedModel('  ') }), error => error.status === 503)
  await assert.rejects(auditAssist(subject(), { fetchModel: async () => new Response('', { status: 500 }) }), error => error.status === 503)
})

test('the route answers explain over the signed channel', async () => {
  seen.length = 0
  const previous = output
  output = 'A build cache. It comes back on the next install.'
  try {
    const answer = await send('/api/audit-assist', { input: { ...subject(), subject: { ...subject().subject, kind: 'disk' } } })
    assert.equal(answer.status, 200)
    assert.equal(answer.body.text, 'A build cache. It comes back on the next install.')
    assert.ok(!JSON.stringify(seen[0]).includes(homedir()))
    assert.equal((await send('/api/audit-assist', { input: { task: 'explain' } })).status, 400)
  } finally { output = previous }
})

// A quick ask: one yes or no per item from a single pass, in the order the model saw them (biggest first).
const yes = share => ({ options: { true: share, false: 1 - share }, covered: 0.99 })

test('a quick ask picks in one pass and writes nothing', async () => {
  const calls = []
  const sweep = async ask => { calls.push(ask); return { results: [yes(0.9), yes(0.8), yes(0.1)] } }
  const out = await auditAssist({ ...valid(), quick: true }, { sweep, quickHere: () => true, fetchModel: () => assert.fail('wrote an answer'), clock: () => 0 })
  assert.deepEqual(out, { summary: 'Worth cleaning now: about 4.0 GB of disk and 1.2 GB of memory.', quick: true, seconds: 0, picks: [
    { id: 'stop:/Volumes/Work/app-wt', why: 'Merged and pushed.' }, { id: 'disk:/Volumes/Work/app/.next', why: 'Idle 9d, nothing running.' }] })
  const [ask] = calls
  assert.equal(calls.length, 1)
  assert.equal(ask.prompts.length, 3)
  assert.deepEqual(ask.prompts.map(prompt => prompt[1].content.slice(-22)), ['The item to decide: a1', 'The item to decide: a2', 'The item to decide: a3'])
  assert.equal(new Set(ask.prompts.map(prompt => prompt[1].content.slice(0, -2))).size, 1, 'the same list for every item')
  assert.ok(!JSON.stringify(ask.prompts).includes('/Volumes/Work'), 'ids and paths stay out of the prompt')
  assert.equal(ask.lead, '{"clean_now":')
  assert.deepEqual(ask.choices, ['true', 'false'])
  assert.equal(ask.share, 'all')
  assert.ok(!ask.asked, 'gives way to anything the owner asks')
  const none = await auditAssist({ ...valid(), quick: true }, { sweep: async () => ({ results: [yes(0.2), yes(0.3), yes(0.1)] }), quickHere: () => true, fetchModel: () => assert.fail('wrote an answer') })
  assert.deepEqual([none.summary, none.picks, none.quick], ['Nothing worth cleaning right now.', [], true])
  assert.deepEqual(quickAdvice(validateAuditAssist(valid()), validateAuditAssist(valid()).items).picks.map(pick => pick.id), ['stop:/Volumes/Work/app-wt', 'disk:/Volumes/Work/app/.next', 'disk:/tiny'])
})

test('a quick ask never loads the model: a failed pass gives the biggest wins', async () => {
  for (const sweep of [async () => null, async () => { throw Error('no') }, async () => ({ results: [yes(0.9), { ...yes(0.9), covered: 0.2 }, yes(0.9)] }), async () => ({ results: [yes(0.9)] })]) {
    const out = await auditAssist({ ...valid(), quick: true }, { sweep, quickHere: () => true, fetchModel: () => assert.fail('wrote an answer') })
    assert.equal(out.fallback, true)
    assert.equal(out.quick, true)
    assert.deepEqual(out.picks.map(pick => pick.id), ['stop:/Volumes/Work/app-wt', 'disk:/Volumes/Work/app/.next', 'disk:/tiny'])
  }
})

test('quick is a flag: with the owner\'s own model server, or without it, the advice is written as before', async () => {
  const written = JSON.stringify({ summary: 'Stop the server.', picks: [{ ref: 'a1', why: 'Left running.' }] })
  const there = await auditAssist({ ...valid(), quick: true }, { sweep: () => assert.fail('asked in one pass'), quickHere: () => false, fetchModel: fixedModel(written) })
  assert.deepEqual([there.summary, there.quick, there.picks.length], ['Stop the server.', undefined, 1])
  const plain = await auditAssist(valid(), { sweep: () => assert.fail('asked in one pass'), quickHere: () => true, fetchModel: fixedModel(written) })
  assert.equal(plain.summary, 'Stop the server.')
  assert.equal(validateAuditAssist({ ...valid(), quick: true }).quick, true)
  assert.equal('quick' in validateAuditAssist({ ...valid(), quick: false }), false)
  assert.throws(() => validateAuditAssist({ ...valid(), quick: 'yes' }), error => error.status === 400)
})
