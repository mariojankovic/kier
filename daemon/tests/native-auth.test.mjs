import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, rmSync, chmodSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFileSync, execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { createServer } from 'node:http'
import { requestMAC, responseMAC, openBody, verifier, signedHeaders, signedFetch, signResponse, lineMAC, streamMAC } from '../lib/http-auth.mjs'

const dir = mkdtempSync(join(tmpdir(), 'kier-native-auth-'))
chmodSync(dir, 0o700)
after(() => rmSync(dir, { recursive: true, force: true }))
const epoch = Date.parse('2027-01-15T12:00:00Z') / 1000
const secret = 'a'.repeat(64), nonce = 'b'.repeat(32), timestamp = String(epoch)
writeFileSync(join(dir, 'token'), secret, { mode: 0o600 })
const run = promisify(execFile)

test('Swift shares JS MAC vectors and rejects fake, missing, changed and replayed response proofs', () => {
  const body = Buffer.from('{"close":["fixture"],"completionPolicy":"owner-verified"}')
  const target = '/api/find?q=Nika%20%26%20Tea&n=%C5%A1'
  const vector = { secret, nonce, timestamp, target, body: body.toString(),
    request: requestMAC(secret, 'POST', target, timestamp, nonce, body), response: responseMAC(secret, nonce, 200, body) }
  writeFileSync(join(dir, 'vector.json'), JSON.stringify(vector))
  writeFileSync(join(dir, 'main.swift'), `import Foundation
let v = try JSONSerialization.jsonObject(with: Data(contentsOf: URL(fileURLWithPath: CommandLine.arguments[1]))) as! [String: String]
let secret = Data(v["secret"]!.utf8), body = Data(v["body"]!.utf8), nonce = v["nonce"]!
assert(DaemonProof.request(secret, method: "POST", target: v["target"]!, timestamp: v["timestamp"]!, nonce: nonce, body: body) == v["request"]!)
assert(DaemonProof.accepts(secret, nonce: nonce, status: 200, body: body, signature: v["response"]))
assert(!DaemonProof.accepts(secret, nonce: nonce, status: 200, body: body, signature: nil))
assert(!DaemonProof.accepts(secret, nonce: nonce, status: 200, body: body, signature: String(repeating: "0", count: 64)))
assert(!DaemonProof.accepts(secret, nonce: nonce, status: 201, body: body, signature: v["response"]))
assert(!DaemonProof.accepts(secret, nonce: nonce, status: 200, body: Data("{}".utf8), signature: v["response"]))
assert(!DaemonProof.accepts(secret, nonce: String(repeating: "c", count: 32), status: 200, body: body, signature: v["response"]))
print(try DaemonProof.seal(secret, body: body).base64EncodedString())
`)
  const bin = join(dir, 'proof-test')
  execFileSync('swiftc', ['../app/DaemonClient.swift', join(dir, 'main.swift'), '-o', bin], { timeout: 60000, stdio: 'pipe' })
  const encrypted = Buffer.from(execFileSync(bin, [join(dir, 'vector.json')], { encoding: 'utf8' }).trim(), 'base64')
  assert.deepEqual(openBody(secret, encrypted), body)
  assert.equal(encrypted.includes(body), false)
})

test('actual Swift transport rejects a fake listener and redirects, then recovers with authenticated NDJSON', async t => {
  let mode = 'fake', calls = 0
  const verify = verifier(secret)
  const server = createServer(async (req, res) => {
    calls++
    const chunks = []; for await (const c of req) chunks.push(c)
    const wire = Buffer.concat(chunks)
    assert.equal(req.headers['x-kier-token'], undefined)
    assert.equal(wire.includes(Buffer.from('PRIVATE_FIXTURE')), false)
    const requestNonce = verify(req.method, req.url, req.headers, wire)
    assert.ok(requestNonce)
    assert.equal(openBody(secret, wire).toString(), 'PRIVATE_FIXTURE')
    if (mode === 'redirect') { res.writeHead(307, { location: '/leak' }); return res.end() }
    if (mode === 'fake') { res.setHeader('x-kier-response', '0'.repeat(64)); return res.end('{"on":true,"close":["fixture"]}') }
    signResponse(res, secret, requestNonce)
    res.writeHead(200, { 'content-type': 'application/x-ndjson' })
    res.write('{"status":"fixture"}\n')
    res.end('{"done":true}\n')
  })
  await new Promise(r => server.listen(0, '127.0.0.1', r))
  t.after(() => server.close())
  const url = `http://127.0.0.1:${server.address().port}/api/reminders?q=Nika%20%26%20Tea`
  writeFileSync(join(dir, 'client.swift'), `import Foundation
@main struct Probe {
  static func main() async throws {
    let client = DaemonClient(dataDirectory: CommandLine.arguments[1])
    var request = URLRequest(url: URL(string: CommandLine.arguments[2])!)
    request.httpMethod = "POST"
    request.httpBody = Data("PRIVATE_FIXTURE".utf8)
    do {
      let (data, _) = try await client.data(for: request)
      assert(CommandLine.arguments[3] == "good")
      assert(String(decoding: data, as: UTF8.self).contains("done"))
    } catch { assert(CommandLine.arguments[3] == "bad") }
  }
}
`)
  const bin = join(dir, 'client-test')
  execFileSync('swiftc', ['../app/DaemonClient.swift', join(dir, 'client.swift'), '-o', bin], { timeout: 60000, stdio: 'pipe' })
  await run(bin, [dir, url, 'bad'], { timeout: 15000 })
  mode = 'redirect'
  await run(bin, [dir, url, 'bad'], { timeout: 15000 })
  assert.equal(calls, 2, 'redirect must never be followed')
  mode = 'good'
  await run(bin, [dir, url, 'good'], { timeout: 15000 })
  assert.equal(calls, 3)
  mode = 'fake'
  await assert.rejects(signedFetch(secret, url, { method: 'POST', body: 'PRIVATE_FIXTURE' }), /DAEMON_UNAVAILABLE/)
})

// Chat answers show as they form (0.7.11 had them arrive all at once): each line is checked on its own, so a changed,
// reordered, foreign or cut-off line never reaches the app.
test('Swift reads a streamed reply line by line and rejects changed, reordered, foreign and cut-off lines', async t => {
  let mode = 'good'
  const verify = verifier(secret)
  const framed = (n, line, key = nonce) => `${n} ${lineMAC(secret, key, n, line)} ${line}\n`
  const server = createServer(async (req, res) => {
    const chunks = []; for await (const c of req) chunks.push(c)
    const requestNonce = verify(req.method, req.url, req.headers, Buffer.concat(chunks))
    assert.ok(requestNonce)
    if (mode === 'good') {
      signResponse(res, secret, requestNonce)
      res.streamLines()
      res.writeHead(200, { 'content-type': 'application/x-ndjson' })
      res.write('{"status":"Thinking"}\n{"text":"Nika')
      await new Promise(r => setTimeout(r, 1500))
      res.write(' and Tea\u2028fixture"}\n')
      return res.end('{"done":true}\n')
    }
    const key = mode === 'foreign' ? 'c'.repeat(32) : requestNonce
    res.writeHead(200, { 'x-kier-stream': 'lines-v1', 'x-kier-response': streamMAC(secret, requestNonce, 200) })
    const first = framed(0, '{"text":"fine"}', key)
    if (mode === 'changed') return res.end(first + framed(1, '{"text":"Filip"}', key).replace('Filip', 'Borna') + framed(2, '', key))
    if (mode === 'reordered') return res.end(first + framed(2, '{"text":"Filip"}', key) + framed(1, '', key))
    if (mode === 'cut') return res.end(first + framed(1, '{"text":"Filip"}', key))
    return res.end(first + framed(1, '', key))
  })
  await new Promise(r => server.listen(0, '127.0.0.1', r))
  t.after(() => server.close())
  const url = `http://127.0.0.1:${server.address().port}/api/ask/stream`
  writeFileSync(join(dir, 'stream.swift'), `import Foundation
@main struct Probe {
  static func main() async {
    let client = DaemonClient(dataDirectory: CommandLine.arguments[1])
    var request = URLRequest(url: URL(string: CommandLine.arguments[2])!)
    request.httpMethod = "POST"
    request.httpBody = Data("PRIVATE_FIXTURE".utf8)
    let start = Date()
    var seen: [[String: Any]] = []
    var failed = false
    do {
      for try await line in client.lines(for: request) {
        seen.append(["line": String(decoding: line, as: UTF8.self), "at": Date().timeIntervalSince(start)])
      }
    } catch { failed = true }
    let out = try! JSONSerialization.data(withJSONObject: ["lines": seen, "failed": failed])
    print(String(decoding: out, as: UTF8.self))
  }
}
`)
  const bin = join(dir, 'stream-test')
  execFileSync('swiftc', ['../app/DaemonClient.swift', join(dir, 'stream.swift'), '-o', bin], { timeout: 60000, stdio: 'pipe' })
  const probe = async m => { mode = m; return JSON.parse((await run(bin, [dir, url], { timeout: 15000 })).stdout) }
  const good = await probe('good')
  assert.equal(good.failed, false)
  assert.deepEqual(good.lines.map(l => JSON.parse(l.line)), [{ status: 'Thinking' }, { text: 'Nika and Tea\u2028fixture' }, { done: true }])
  assert.ok(good.lines.at(-1).at - good.lines[0].at > 1, 'the first line arrives before the reply is finished')
  for (const m of ['changed', 'reordered']) {
    const r = await probe(m)
    assert.equal(r.failed, true, m)
    assert.deepEqual(r.lines.map(l => l.line), ['{"text":"fine"}'], m)
  }
  // Genuine lines of a reply that stops early still arrive; the missing close is the error.
  const cut = await probe('cut')
  assert.equal(cut.failed, true)
  assert.deepEqual(cut.lines.map(l => l.line), ['{"text":"fine"}', '{"text":"Filip"}'])
  const foreign = await probe('foreign')
  assert.equal(foreign.failed, true)
  assert.deepEqual(foreign.lines, [])
})

test('future timestamps remain replay-protected for the full acceptance window', () => {
  let now = epoch
  const verify = verifier(secret, () => now * 1000)
  const headers = signedHeaders(secret, 'GET', '/api/status', '', String(now + 60))
  assert.ok(verify('GET', '/api/status', headers, ''))
  now += 61
  assert.equal(verify('GET', '/api/status', headers, ''), null)
  now += 60
  assert.equal(verify('GET', '/api/status', headers, ''), null)
})

test('replay protection survives daemon restart', () => {
  const path = join(dir, 'replay.json'), target = '/api/reminders'
  const headers = signedHeaders(secret, 'POST', target)
  assert.ok(verifier(secret, Date.now, path)('POST', target, headers, ''))
  assert.equal(verifier(secret, Date.now, path)('POST', target, headers, ''), null)
})
