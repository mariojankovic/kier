import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, statSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { request } from 'node:http'
import { signedHeaders, responseMAC, sealBody, signedFetch } from '../lib/http-auth.mjs'

const dir = mkdtempSync(join(tmpdir(), 'kier-http-test-'))
process.env.KIER_DATA_DIR = dir
const secret = 'a'.repeat(64)
const { open } = await import('../lib/db.mjs')
const { serve } = await import('../lib/server.mjs')
const { tokenPath } = await import('../lib/config.mjs')
writeFileSync(tokenPath, secret, { mode: 0o644 })
const db = open(':memory:')
const server = await serve(db, { port: 0 })
const port = server.address().port
const auth = { signed: true }
after(() => { server.close(); db.close(); rmSync(dir, { recursive: true, force: true }) })
const get = (path, headers = {}, method = 'GET', body = '') => new Promise((resolve, reject) => {
  headers = { ...headers }
  if (headers.signed) { delete headers.signed; headers = { ...signedHeaders(secret, method, path, body), ...headers } }
  const req = request({ hostname: '127.0.0.1', port, path, headers, method }, res => {
    let body = ''; res.on('data', chunk => { body += chunk }); res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body }))
  }); req.on('error', reject); req.end(body)
})

test('API authentication, host and origin checks reject untrusted callers', async () => {
  assert.equal((await get('/api/status')).status, 401)
  assert.equal((await get('/api/status', auth)).status, 200)
  assert.equal((await get('/api/status', { ...auth, host: 'evil.example' })).status, 403)
  assert.equal((await get('/api/status', { ...auth, origin: 'https://evil.example' })).status, 403)
  assert.equal((await get('/api/status', { ...auth, origin: `http://127.0.0.1:${port}` })).status, 200)
  const weird = 'é'.repeat(secret.length)
  assert.equal((await get('/api/status', { 'x-kier-token': weird })).status, 401)
})

test('cookies and URL bearer tokens are refused; one-use bootstrap is exact-origin bound', async () => {
  assert.equal((await get('/api/status', { cookie: `kier=${secret}` })).status, 401)
  const old = await get('/?k=' + secret)
  assert.equal(old.headers['set-cookie'], undefined)
  assert.equal(old.status, 200)
  const issue = await get('/api/browser-ticket', auth, 'POST')
  const { ticket } = JSON.parse(issue.body)
  const origin = `http://127.0.0.1:${port}`
  for (const headers of [{}, { origin: 'null' }, { origin: `http://127.0.0.1:${port + 1}` }, { origin: `http://localhost:${port}` }]) {
    assert.equal((await get('/auth/bootstrap', { ...headers, 'x-kier-bootstrap': ticket }, 'POST')).status, 403)
  }
  const r = await get('/auth/bootstrap', { origin, 'x-kier-bootstrap': ticket }, 'POST')
  assert.equal(r.status, 200)
  assert.equal(r.headers['set-cookie'], undefined)
  assert.equal(r.headers['cache-control'], 'no-store')
  assert.equal(r.headers['referrer-policy'], 'no-referrer')
  assert.equal(r.headers['x-frame-options'], 'DENY')
  const browserAuth = { 'x-kier-token': JSON.parse(r.body).token }
  assert.equal((await get('/api/status', browserAuth)).status, 200)
  assert.equal((await get('/api/status', { ...browserAuth, host: `localhost:${port}` })).status, 401)
  assert.equal((await get('/auth/bootstrap', { origin, 'x-kier-bootstrap': ticket }, 'POST')).status, 403)
  assert.equal(statSync(tokenPath).mode & 0o777, 0o600)
})

test('static routing is an exact allowlist and malformed URLs do not stop the server', async () => {
  for (const path of ['/../lib/config.mjs', '/%2e%2e/lib/config.mjs', '/ui/../../token']) assert.equal((await get(path, auth)).status, 404)
  assert.equal((await get('http://', auth)).status, 500)
  assert.equal((await get('/api/status', auth)).status, 200)
})

test('browser bootstrap and subsequent page navigation attach headers only to the exact API origin', async () => {
  const { browserAPI } = await import('../ui/api.mjs')
  const { ticket } = JSON.parse((await get('/api/browser-ticket', auth, 'POST')).body)
  const origin = `http://127.0.0.1:${port}`
  const storage = new Map()
  let replaced = false
  const context = {
    location: { origin, hash: '#bootstrap=' + ticket, pathname: '/', search: '' },
    history: { replaceState(_a, _b, path) { assert.equal(path, '/'); replaced = true } },
    sessionStorage: { getItem: k => storage.get(k), setItem: (k,v) => storage.set(k,v) },
    fetch: (path, opts) => {
      assert.equal(opts.credentials, 'omit'); assert.equal(opts.redirect, 'error')
      const headers = new Headers(opts.headers)
      if (opts.method === 'POST') headers.set('origin', origin)
      return fetch(new URL(path, origin), { ...opts, headers })
    },
  }
  const api = await browserAPI(context)
  assert.ok(replaced)
  assert.equal((await api('/api/status')).status, 200)
  assert.throws(() => api(`http://127.0.0.1:${port + 1}/api/status`), /origin/)
  assert.throws(() => api('/auth/bootstrap'), /origin/)
  context.location.hash = ''
  const nextPage = await browserAPI(context)
  assert.equal((await nextPage('/api/status')).status, 200)
  for (const path of ['/', '/setup', '/vault']) assert.match((await get(path)).body, /const fetch = await browserAPI/)
})


test('raw secrets, stale signatures, replays and wrong signatures cannot read owner data', async () => {
  const path = '/api/capture-policy'
  assert.equal((await get(path, { 'x-kier-token': secret })).status, 401)
  // Well outside the 60 second window, so a second ticking over between signing and checking can't bring one back in.
  assert.equal((await get(path, signedHeaders(secret, 'GET', path, '', String(Math.floor(Date.now() / 1000) - 120)))).status, 401)
  assert.equal((await get(path, signedHeaders(secret, 'GET', path, '', String(Math.floor(Date.now() / 1000) + 120)))).status, 401)
  assert.equal((await get(path, signedHeaders('wrong', 'GET', path))).status, 401)
  const headers = signedHeaders(secret, 'GET', path)
  const response = await get(path, headers)
  assert.equal(response.status, 200)
  assert.equal(response.headers['x-kier-response'], responseMAC(secret, headers['x-kier-nonce'], response.status, response.body))
  assert.equal((await get(path, headers)).status, 401)
  assert.equal((await get(path + '?changed=1', signedHeaders(secret, 'GET', path))).status, 401)
  assert.equal((await get(path, signedHeaders(secret, 'POST', path))).status, 401)
})

test('encrypted native bodies are authenticated before parsing or mutation; errors are signed', async () => {
  const path = '/api/ingest', body = sealBody(secret, Buffer.from(JSON.stringify({ items: [] })))
  const headers = { ...signedHeaders(secret, 'POST', path, body), 'content-type': 'application/json' }
  assert.equal((await get(path, headers, 'POST', body)).status, 200)
  const tampered = Buffer.from(body); tampered[15] ^= 1
  assert.equal((await get(path, { ...signedHeaders(secret, 'POST', path, body), 'content-type': 'application/json' }, 'POST', tampered)).status, 401)
  const malformed = sealBody(secret, Buffer.from('{'))
  const bad = { ...signedHeaders(secret, 'POST', path, malformed), 'content-type': 'application/json' }
  const response = await get(path, bad, 'POST', malformed)
  assert.equal(response.status, 500)
  assert.equal(response.headers['x-kier-response'], responseMAC(secret, bad['x-kier-nonce'], 500, response.body))
  const cli = await signedFetch(secret, `http://127.0.0.1:${port}/api/ingest`, { method: 'POST', body: JSON.stringify({ items: [] }) })
  assert.equal((await cli.json()).ok, true)
})

test('browser credentials expire and cannot mint fresh launch credentials', async () => {
  const { ticket } = JSON.parse((await get('/api/browser-ticket', auth, 'POST')).body)
  const origin = `http://127.0.0.1:${port}`
  const { token } = JSON.parse((await get('/auth/bootstrap', { origin, 'x-kier-bootstrap': ticket }, 'POST')).body)
  assert.notEqual(token, secret)
  assert.equal((await get('/api/browser-ticket', { 'x-kier-token': token }, 'POST')).status, 404)
  const clock = Date.now
  try {
    Date.now = () => clock() + 10 * 60_000 + 1
    assert.equal((await get('/api/status', { 'x-kier-token': token })).status, 401)
  } finally { Date.now = clock }
})
