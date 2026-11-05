import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.KIER_DATA_DIR = mkdtempSync(join(tmpdir(), 'kier-model-'))
const { validateModelConfig, testModelConnection, configureModelUsage } = await import('../lib/model-provider.mjs')

// A stand-in for LM Studio or any OpenAI-compatible server, and one for Ollama, on this Mac.
const seen = []
const server = createServer(async (req, res) => {
  let body = ''
  for await (const chunk of req) body += chunk
  seen.push({ url: req.url, auth: req.headers.authorization || null, body: body ? JSON.parse(body) : null })
  res.setHeader('content-type', 'application/json')
  if (req.url === '/v1/models') return res.end(JSON.stringify({ data: [{ id: 'local-9b' }, { id: 'local-27b' }] }))
  if (req.url === '/v1/chat/completions') return res.end(JSON.stringify({ choices: [{ message: { content: '{"ok":true}' } }] }))
  if (req.url === '/api/tags') return res.end(JSON.stringify({ models: [{ name: 'qwen3.5:9b' }] }))
  if (req.url === '/api/chat') return res.end(JSON.stringify({ message: { role: 'assistant', content: '{"ok":true}' }, done: true }))
  res.statusCode = 404; res.end('{}')
})
await new Promise((r) => server.listen(0, '127.0.0.1', r))
after(() => server.close())
const base = `http://127.0.0.1:${server.address().port}`

test('an address is a plain http(s) base: no credentials, query or fragment', () => {
  assert.equal(validateModelConfig({ protocol: 'openai', endpoint: `${base}/`, model: 'm' }).endpoint, `${base}/v1`)
  assert.equal(validateModelConfig({ protocol: 'ollama', endpoint: base, model: 'm' }).endpoint, base)
  assert.throws(() => validateModelConfig({ protocol: 'openai', endpoint: 'http://user:pw@example.com', model: 'm' }))
  assert.throws(() => validateModelConfig({ protocol: 'openai', endpoint: 'http://example.com/?key=1', model: 'm' }))
  assert.throws(() => validateModelConfig({ protocol: 'openai', endpoint: 'file:///etc/passwd', model: 'm' }))
  assert.throws(() => validateModelConfig({ protocol: 'other', endpoint: base, model: 'm' }))
  assert.throws(() => validateModelConfig({ protocol: 'openai', endpoint: base, model: '' }))
})

test('checking an OpenAI-compatible server lists its models and proves the chosen one answers in JSON', async () => {
  seen.length = 0
  const listed = await testModelConnection({ protocol: 'openai', endpoint: base, model: '' })
  assert.deepEqual(listed.models, ['local-9b', 'local-27b'])
  const checked = await testModelConnection({ protocol: 'openai', endpoint: base, model: 'local-9b', apiKey: 'sk-test' })
  assert.equal(checked.checked, true)
  const chat = seen.find((r) => r.url === '/v1/chat/completions')
  assert.equal(chat.body.model, 'local-9b')
  assert.deepEqual(chat.body.response_format, { type: 'json_object' })
  // The key goes to the server it belongs to, as a bearer token, and nowhere else.
  assert.equal(chat.auth, 'Bearer sk-test')
})

test('checking an Ollama server uses its own API', async () => {
  const checked = await testModelConnection({ protocol: 'ollama', endpoint: base, model: 'qwen3.5:9b' })
  assert.deepEqual(checked.models, ['qwen3.5:9b'])
  assert.equal(checked.checked, true)
})

test('a server that is down says so, without the address or key', async () => {
  await assert.rejects(testModelConnection({ protocol: 'openai', endpoint: 'http://127.0.0.1:9', model: 'm', apiKey: 'sk-secret' }),
    (e) => /Could not reach/.test(e.message) && !e.message.includes('sk-secret'))
})

test('only a byte count is reported for a server off this Mac, and nothing for one on it', async () => {
  const reports = []
  configureModelUsage((u) => reports.push(u))
  await testModelConnection({ protocol: 'openai', endpoint: base, model: 'local-9b' })
  assert.equal(reports.length, 0, 'a server on this Mac counted as sent')
  configureModelUsage(() => {})
})


test('HTTP is restricted to loopback and literal private LAN addresses', () => {
  const check = endpoint => validateModelConfig({ protocol: 'ollama', endpoint, model: 'm' })
  for (const host of ['localhost', '127.0.0.1', '10.0.0.5', '172.16.0.2', '172.31.255.254', '192.168.1.2', '[::1]', '[fd12::5]']) {
    assert.doesNotThrow(() => check(`http://${host}:11434`), host)
  }
  for (const host of ['example.com', '127.example.com', 'localhost.example.com', 'server.local', '172.15.0.1', '172.32.0.1', '169.254.169.254', '0.0.0.0', '[2001:db8::1]', '[::ffff:7f00:1]']) {
    assert.throws(() => check(`http://${host}`), /must use HTTPS/, host)
    assert.doesNotThrow(() => check(`https://${host}`), host)
  }
})

test('a local model cannot redirect a probe and its credentials to another service', async () => {
  let received = 0
  const destination = createServer((req, res) => { received++; res.end('{}') })
  await new Promise(r => destination.listen(0, '127.0.0.1', r))
  const redirect = createServer((req, res) => {
    res.writeHead(302, { location: `http://127.0.0.1:${destination.address().port}/models` }); res.end()
  })
  await new Promise(r => redirect.listen(0, '127.0.0.1', r))
  try {
    await assert.rejects(testModelConnection({ protocol: 'openai', endpoint: `http://127.0.0.1:${redirect.address().port}`, model: '', apiKey: 'test-secret' }), /Could not reach/)
    assert.equal(received, 0)
  } finally { redirect.close(); destination.close() }
})

test('implicit legacy Ollama cannot receive private prompts without an explicit BYOM selection', async () => {
  const { config } = await import('../lib/config.mjs')
  const { modelFetch } = await import('../lib/model-provider.mjs')
  config.runtime = 'auto'
  config.ollama = base
  seen.length = 0
  assert.throws(() => modelFetch('/api/chat', { method: 'POST', body: 'PRIVATE_MARKER' }), /Choose your model server/)
  assert.equal(seen.length, 0)
})
