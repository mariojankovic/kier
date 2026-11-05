import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync, spawn } from 'node:child_process'
import { mkdtempSync, rmSync, statSync, readFileSync, writeFileSync, chmodSync, symlinkSync, unlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
const dir = mkdtempSync(join(tmpdir(), 'kier-sidecar-test-'))
process.env.KIER_DATA_DIR = dir
writeFileSync(join(dir, 'config.json'), JSON.stringify({ me: 'Sam', fullName: 'Sam', runtime: 'mlx' }))
after(() => rmSync(dir, { recursive: true, force: true }))
const { sidecarHeaders, sidecarToken } = await import('../lib/sidecar-auth.mjs')
test('sidecar token is stable and private for all daemon clients', () => {
  const token = sidecarToken(); assert.equal(token.length, 64)
  assert.equal(sidecarHeaders()['x-kier-token'], token)
  assert.equal(statSync(join(dir, 'sidecar-token')).mode & 0o777, 0o600)
  for (const file of ['meaning', 'second', 'diagnostics', 'model-provider']) assert.match(readFileSync(new URL(`../lib/${file}.mjs`, import.meta.url), 'utf8'), /sidecarFetch\(/)
  for (const file of ['runtime', 'second']) assert.match(readFileSync(new URL(`../lib/${file}.mjs`, import.meta.url), 'utf8'), /KIER_SIDECAR_TOKEN: sidecarToken\(\)/)
})
test('both actual Python handler classes enforce auth, host, JSON, limits and safe errors', () => {
  execFileSync('python3', [new URL('./sidecar-security.py', import.meta.url).pathname], { timeout: 15000, stdio: 'pipe' })
})

test('real daemon clients use private Unix sockets for chat, embedding, health and decisions', async t => {
  const child = spawn('python3', [new URL('./sidecar-security.py', import.meta.url).pathname, '--serve-fixture'], {
    env: { ...process.env, KIER_SIDECAR_TOKEN: sidecarToken() }, stdio: ['ignore', 'pipe', 'pipe'],
  })
  t.after(() => child.kill())
  const endpoints = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(Error('fixture timeout')), 5000)
    child.once('error', reject)
    child.stdout.once('data', data => { clearTimeout(timer); resolve(JSON.parse(String(data))) })
  })
  const { modelFetch } = await import('../lib/model-provider.mjs')
  const { embed } = await import('../lib/meaning.mjs')
  const { up, decide, ask } = await import('../lib/second.mjs')
  assert.equal((await modelFetch('/api/version')).ok, true)
  const response = await modelFetch('/api/chat', { method: 'POST', body: JSON.stringify({ messages: [{ role: 'user', content: 'fixture' }], stream: false }) })
  assert.equal((await response.json()).message.content, 'fixture')
  assert.deepEqual(await embed(['fixture']), [[1]])
  assert.equal(await up(), true)
  assert.deepEqual(await decide([{ source: 'whatsapp', thread: 'Nika', sender: 'Nika', ts: 1, text: 'fixture' }]), [1])
  assert.equal((await ask([{}], {})).length, 1)
})

 test('unsafe endpoint types, permissions and directories fail before connection', async () => {
  const { sidecarFetch, sockets, verifySocket } = await import('../lib/sidecar-client.mjs')
  // The fixture's socket may still exist after its process exits.
  rmSync(sockets.llm, { force: true })
  writeFileSync(sockets.llm, 'fixture')
  await assert.rejects(sidecarFetch('llm', '/api/chat', { body: 'PRIVATE_MARKER' }), /IDENTITY/)
  unlinkSync(sockets.llm); symlinkSync(sockets.embed, sockets.llm)
  assert.throws(() => verifySocket(sockets.llm), /IDENTITY/)
  unlinkSync(sockets.llm)
  chmodSync(sockets.embed, 0o666)
  assert.throws(() => verifySocket(sockets.embed), /IDENTITY/)
  chmodSync(sockets.embed, 0o600)
  chmodSync(dir, 0o755)
  assert.throws(() => verifySocket(sockets.embed), /IDENTITY/)
  chmodSync(dir, 0o700)
 })

test('an impostor TCP listener receives neither health credentials nor private prompts', async t => {
  const { createServer } = await import('node:http')
  const { config } = await import('../lib/config.mjs')
  const { modelFetch } = await import('../lib/model-provider.mjs')
  const { embed } = await import('../lib/meaning.mjs')
  const { up, decide } = await import('../lib/second.mjs')
  let received = 0
  const impostor = createServer((_req, res) => { received++; res.end('{}') })
  await new Promise(resolve => impostor.listen(0, '127.0.0.1', resolve))
  t.after(() => impostor.close())
  config.ollama = `http://127.0.0.1:${impostor.address().port}`
  for (const name of ['llm.sock', 'embed.sock', 'd1.sock']) rmSync(join(dir, name), { force: true })
  await assert.rejects(modelFetch('/api/chat', { method: 'POST', body: 'PRIVATE_MARKER' }))
  await assert.rejects(embed(['PRIVATE_MARKER']))
  assert.equal(await up(), false)
  assert.equal(await decide([{ text: 'PRIVATE_MARKER' }]), null)
  assert.equal(received, 0)
})
