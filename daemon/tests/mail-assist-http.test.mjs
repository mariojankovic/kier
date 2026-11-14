import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { createServer, request } from 'node:http'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { sealBody, signedHeaders, responseMAC, streamMAC, lineMAC } from '../lib/http-auth.mjs'

const dir = mkdtempSync(join(tmpdir(), 'kier-mail-http-'))
process.env.KIER_DATA_DIR = dir
const seen = []
let output = 'The team agreed to meet next week. A time still needs to be chosen.'
let modelStatus = 200
const model = createServer(async (req, res) => {
  let body = ''
  for await (const chunk of req) body += chunk
  const parsed = JSON.parse(body)
  seen.push({ path: req.url, body: parsed })
  if (parsed.stream && modelStatus === 200) {
    // An OpenAI-style server streams its answer as server-sent events, a few words at a time.
    res.writeHead(200, { 'content-type': 'text/event-stream' })
    for (const words of output.match(/\S+\s*/g)) res.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: words } }] })}\n\n`)
    res.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] })}\n\ndata: [DONE]\n\n`)
    return res.end()
  }
  res.writeHead(modelStatus, { 'content-type': 'application/json' })
  res.end(JSON.stringify({ choices: [{ message: { content: output } }] }))
})
await new Promise(resolve => model.listen(0, '127.0.0.1', resolve))
writeFileSync(join(dir, 'config.json'), JSON.stringify({
  me: 'Owner', fullName: 'Owner Example', off: [], runtime: 'external',
  externalModel: { protocol: 'openai', endpoint: `http://127.0.0.1:${model.address().port}/v1`, model: 'fixture-mail' },
}))
const { open } = await import('../lib/db.mjs')
const { serve } = await import('../lib/server.mjs')
const { tokenPath } = await import('../lib/config.mjs')
const { MAIL_ASSIST_MAX_BYTES } = await import('../lib/mail-assist.mjs')
const secret = 'b'.repeat(64)
writeFileSync(tokenPath, secret, { mode: 0o600 })
const db = open(':memory:')
const server = await serve(db, { port: 0 })
const port = server.address().port
after(async () => {
  await Promise.all([new Promise(resolve => server.close(resolve)), new Promise(resolve => model.close(resolve))])
  db.close()
  rmSync(dir, { recursive: true, force: true })
})

const valid = task => ({
  task, account: 'owner@example.com', thread: { subject: 'Next week', messages: [
    { from_name: 'Contact', from_email: 'contact@example.com', to: ['owner@example.com'], date: Math.floor(Date.now() / 1000), text: 'Can we meet next week?' },
  ] },
})
function send(path, { method = 'POST', input, raw, signed = true, encrypted = true, headers = {} } = {}) {
  const plain = raw === undefined ? (input === undefined ? Buffer.alloc(0) : Buffer.from(JSON.stringify(input))) : Buffer.from(raw)
  const wire = signed && encrypted && plain.length ? sealBody(secret, plain) : plain
  const proof = signed ? signedHeaders(secret, method, path, wire) : {}
  return new Promise((resolve, reject) => {
    const req = request({ hostname: '127.0.0.1', port, path, method, headers: { 'content-type': 'application/json', ...proof, ...headers } }, res => {
      const chunks = []
      res.on('data', chunk => chunks.push(chunk))
      res.on('end', () => {
        const body = Buffer.concat(chunks)
        if (signed && res.statusCode !== 401) {
          assert.equal(res.headers['x-kier-response'], responseMAC(secret, proof['x-kier-nonce'], res.statusCode, body))
        }
        resolve({ status: res.statusCode, headers: res.headers, body: JSON.parse(body.toString('utf8')) })
      })
    })
    req.on('error', reject)
    req.end(wire)
  })
}
const path = '/api/mail-assist'

test('mail assist requires the native HMAC proof, including for browser sessions', async () => {
  seen.length = 0
  assert.equal((await send(path, { input: valid('summarize'), signed: false })).status, 401)
  assert.equal((await send(path, { input: valid('summarize'), headers: { 'x-kier-signature': '0'.repeat(64) } })).status, 401)
  const issued = await send('/api/browser-ticket')
  const origin = `http://127.0.0.1:${port}`
  const bootstrap = await send('/auth/bootstrap', { signed: false, headers: { origin, 'x-kier-bootstrap': issued.body.ticket } })
  assert.equal(bootstrap.status, 200)
  assert.equal((await send(path, { signed: false, input: valid('summarize'), headers: { 'x-kier-token': bootstrap.body.token } })).status, 401)
  assert.equal(seen.length, 0)
})

test('mail assist rejects invalid methods, JSON and encrypted bodies with signed 400 errors', async () => {
  seen.length = 0
  for (const options of [{ method: 'GET' }, { raw: '{' }, { raw: '' }, { input: [] }, { input: { ...valid('summarize'), task: 'delete' } }, { input: valid('summarize'), encrypted: false }]) {
    const result = await send(path, options)
    assert.equal(result.status, 400)
    assert.equal(typeof result.body.error, 'string')
  }
  assert.equal(seen.length, 0)
})

test('mail assist enforces byte, message and text limits before inference', async () => {
  seen.length = 0
  const tooMany = valid('summarize')
  tooMany.thread.messages = Array.from({ length: 21 }, () => ({ ...tooMany.thread.messages[0] }))
  const tooLong = valid('summarize')
  tooLong.thread.messages[0].text = 'x'.repeat(8001)
  const unicode = valid('summarize')
  unicode.thread.messages = Array.from({ length: 20 }, () => ({ ...unicode.thread.messages[0], text: '界'.repeat(4000) }))
  for (const options of [{ raw: ' '.repeat(MAIL_ASSIST_MAX_BYTES + 1) }, { input: tooMany }, { input: tooLong }, { input: unicode }]) {
    const result = await send(path, options)
    assert.equal(result.status, 413)
    assert.equal(typeof result.body.error, 'string')
  }
  assert.equal(seen.length, 0)
})

test('signed summarize and draft requests run through the configured provider', async () => {
  seen.length = 0
  output = '<think>Internal reasoning must stay private.</think>The team agreed to meet next week. A time still needs to be chosen.'
  const summary = await send(path, { input: valid('summarize') })
  assert.equal(summary.status, 200)
  assert.deepEqual(Object.keys(summary.body).sort(), ['seconds', 'text'])
  assert.equal(summary.body.text, 'The team agreed to meet next week. A time still needs to be chosen.')
  assert.ok(Number.isFinite(summary.body.seconds) && summary.body.seconds >= 0)
  output = 'Yes, next week works. How about Tuesday?'
  const input = { ...valid('draft_reply'), instruction: 'Say yes and suggest Tuesday.' }
  const draft = await send(path, { input })
  assert.equal(draft.status, 200)
  assert.deepEqual(Object.keys(draft.body).sort(), ['context', 'seconds', 'text'])
  assert.equal(draft.body.text, output)
  assert.ok(Array.isArray(draft.body.context))
  assert.equal(seen.length, 2)
  for (const call of seen) {
    assert.equal(call.path, '/v1/chat/completions')
    assert.equal(call.body.model, 'fixture-mail')
    assert.equal(call.body.stream, false)
    assert.equal(call.body.messages[0].role, 'system')
  }
  assert.match(JSON.stringify(seen[1].body.messages), /Say yes and suggest Tuesday/)
})

test('triage returns exact JSON types and falls back safely on malformed model output', async () => {
  for (const [text, expected] of [
    ['{"bundle":"finance","important":true}', { bundle: 'finance', important: true }],
    ['{"bundle":"delete-everything","important":"true"}', { bundle: 'people', important: false }],
    ['This is not JSON.', { bundle: 'people', important: false }],
  ]) {
    output = text
    const result = await send(path, { input: valid('triage') })
    assert.equal(result.status, 200)
    assert.deepEqual(Object.keys(result.body).sort(), ['bundle', 'important', 'seconds'])
    assert.equal(result.body.bundle, expected.bundle)
    assert.equal(result.body.important, expected.important)
  }
})

test('an unavailable configured model returns a clear signed 503', async () => {
  modelStatus = 503
  try {
    const result = await send(path, { input: valid('summarize') })
    assert.equal(result.status, 503)
    assert.match(result.body.error, /not ready|setting up|unavailable/i)
    assert.ok(!result.body.error.includes(String(model.address().port)))
  } finally { modelStatus = 200 }
})

// A streamed reply as Kier Mail reads it: the status signed up front, then each line checked by its number and MAC,
// up to the empty closing line.
function sendStream(input) {
  const plain = Buffer.from(JSON.stringify(input)), wire = sealBody(secret, plain)
  const proof = signedHeaders(secret, 'POST', path, wire), nonce = proof['x-kier-nonce']
  return new Promise((resolve, reject) => {
    const req = request({ hostname: '127.0.0.1', port, path, method: 'POST', headers: { 'content-type': 'application/json', ...proof } }, res => {
      const chunks = []
      res.on('data', chunk => chunks.push(chunk))
      res.on('end', () => {
        const body = Buffer.concat(chunks).toString('utf8')
        if (res.headers['x-kier-stream'] !== 'lines-v1') return resolve({ status: res.statusCode, streamed: false, body: JSON.parse(body) })
        assert.equal(res.headers['x-kier-response'], streamMAC(secret, nonce, res.statusCode))
        const frames = body.split('\n').slice(0, -1), lines = []
        frames.forEach((frame, seq) => {
          const [n, mac, ...rest] = frame.split(' '), payload = rest.join(' ')
          assert.equal(Number(n), seq)
          assert.equal(mac, lineMAC(secret, nonce, seq, Buffer.from(payload)))
          if (payload) lines.push(JSON.parse(payload))
        })
        assert.equal(frames.at(-1).split(' ').slice(2).join(' '), '', 'the reply ends with its closing line')
        resolve({ status: res.statusCode, streamed: true, lines })
      })
    })
    req.on('error', reject)
    req.end(wire)
  })
}

test('stream: true sends a summary as signed lines as it forms, then the same result', async () => {
  seen.length = 0
  output = 'The team agreed to meet next week. A time still needs to be chosen.'
  const reply = await sendStream({ ...valid('summarize'), stream: true })
  assert.equal(reply.status, 200)
  assert.equal(reply.streamed, true)
  const texts = reply.lines.filter(line => 'text' in line && !line.done).map(line => line.text)
  assert.ok(texts.length > 3, 'several updates before the end')
  assert.ok(texts.every((text, i) => i === 0 || text.startsWith(texts[i - 1])), 'each update extends the last')
  const done = reply.lines.at(-1)
  assert.equal(done.done, true)
  assert.equal(done.text, output)
  assert.equal(seen.at(-1).body.stream, true)
})

test('stream: true for a reply ends with its context; triage or a bad stream value is a plain 400', async () => {
  output = 'Yes, next week works. How about Tuesday?'
  const draft = await sendStream({ ...valid('draft_reply'), stream: true })
  assert.equal(draft.lines.at(-1).done, true)
  assert.equal(draft.lines.at(-1).text, output)
  assert.ok(Array.isArray(draft.lines.at(-1).context))
  seen.length = 0
  for (const input of [{ ...valid('triage'), stream: true }, { ...valid('summarize'), stream: 'yes' }]) {
    const result = await sendStream(input)
    assert.equal(result.streamed, false)
    assert.equal(result.status, 400)
  }
  assert.equal(seen.length, 0)
})

test('stream: true when the model is not ready ends the stream with a signed error line', async () => {
  modelStatus = 503
  try {
    const reply = await sendStream({ ...valid('summarize'), stream: true })
    assert.equal(reply.streamed, true)
    assert.equal(reply.lines.at(-1).status, 503)
    assert.equal(typeof reply.lines.at(-1).error, 'string')
  } finally { modelStatus = 200 }
})
