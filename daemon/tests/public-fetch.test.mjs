import { test } from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { publicAddress, publicURL, publicText } from '../lib/public-fetch.mjs'

test('public destination policy rejects local, private, metadata and transition addresses', () => {
  for (const ip of ['127.0.0.1', '10.1.2.3', '172.16.1.1', '192.168.1.1', '169.254.169.254', '100.100.100.200', '168.63.129.16', '0.0.0.0', '224.0.0.1', '::1', '::ffff:127.0.0.1', 'fc00::1', 'fe80::1', '2002:7f00:1::', '2001::1']) assert.equal(publicAddress(ip), false, ip)
  for (const ip of ['8.8.8.8', '2606:4700:4700::1111']) assert.equal(publicAddress(ip), true)
  for (const url of ['http://example.test', 'https://127.1', 'https://[::1]', 'https://example.test:4779', 'https://sam@example.test', 'file:///tmp/fixture']) assert.throws(() => publicURL(url))
})
function transport(routes, addresses = [{ address: '8.8.8.8', family: 4 }]) {
  let connections = 0
  return { get connections() { return connections }, lookup: (_host, _opts, cb) => cb(null, typeof addresses === 'function' ? addresses(connections) : addresses),
    request(url, opts, callback) {
      const req = new EventEmitter(); req.destroy = () => {}; req.end = () => {
        connections++
        opts.lookup(url.hostname, { all: true }, (err, chosen) => {
          if (err) return queueMicrotask(() => req.emit('error', err))
          assert.equal(chosen.length, 1); assert.equal(opts.agent, false)
          const route = routes[connections - 1] || routes.at(-1)
          if (route.hang) return
          const res = new PassThrough(); res.statusCode = route.status || 200; res.headers = route.headers || {}
          queueMicrotask(() => { callback(res); if (!res.destroyed) res.end(route.body || '') })
        })
      }; return req
    } }
}
test('redirects repeat connect-time DNS validation and reject rebinding', async () => {
  const io = transport([{ status: 302, headers: { location: '/next' } }], n => [{ address: n === 1 ? '8.8.8.8' : '10.0.0.1', family: 4 }])
  await assert.rejects(publicText('https://example.test', io)); assert.equal(io.connections, 2)
  const mixed = transport([{ body: 'no' }], [{ address: '8.8.8.8', family: 4 }, { address: '::1', family: 6 }])
  await assert.rejects(publicText('https://example.test', mixed))
  await assert.rejects(publicText('https://example.test', transport([{ status: 302, headers: { location: 'http://example.test' } }])))
})
test('redirects, response bytes and total duration are bounded', async () => {
  const io = transport([{ status: 302, headers: { location: '/next' } }])
  await assert.rejects(publicText('https://example.test', { ...io, redirects: 2 })); assert.equal(io.connections, 3)
  await assert.rejects(publicText('https://example.test', { ...transport([{ body: '12345' }]), maxBytes: 4 }))
  await assert.rejects(publicText('https://example.test', { ...transport([{ headers: { 'content-length': '100' } }]), maxBytes: 4 }))
  await assert.rejects(publicText('https://example.test', { ...transport([{ hang: true }]), timeout: 10 }))
  assert.equal(await publicText('https://example.test', transport([{ body: 'fixture' }])), 'fixture')
})

test('every redirect status validates the next hop before opening it', async () => {
  for (const status of [301, 302, 303, 307, 308]) {
    for (const location of ['https://127.0.0.1/private', 'https://169.254.169.254/', 'https://[::ffff:127.0.0.1]/', 'http://example.test', 'https://example.test:4777/']) {
      const io = transport([{ status, headers: { location } }])
      await assert.rejects(publicText('https://example.test', io))
      assert.equal(io.connections, 1)
    }
  }
  const io = transport([
    { status: 301, headers: { location: 'https://second.example.test/' } },
    { status: 308, headers: { location: 'https://third.example.test/' } },
    { body: 'must not arrive' },
  ], n => [{ address: n < 3 ? '8.8.8.8' : '192.168.0.1', family: 4 }])
  await assert.rejects(publicText('https://example.test', io))
  assert.equal(io.connections, 3)
})
