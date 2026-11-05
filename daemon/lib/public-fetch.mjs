// HTTPS requests resolve and validate addresses in the socket's lookup callback.
// Each redirect uses a new connection and repeats validation; no ambient proxy/agent.
import { lookup as dnsLookup } from 'node:dns'
import { isIP } from 'node:net'
import { request as httpsRequest } from 'node:https'

export function publicAddress(address) {
  if (isIP(address) === 4) {
    const [a, b, c] = address.split('.').map(Number)
    return !(a === 0 || a === 10 || a === 127 || a >= 224 || (a === 100 && b >= 64 && b <= 127) ||
      (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && (b === 168 || (b === 0 && (c === 0 || c === 2)) || (b === 88 && c === 99))) ||
      (a === 198 && (b === 18 || b === 19 || (b === 51 && c === 100))) || (a === 203 && b === 0 && c === 113) || address === '168.63.129.16')
  }
  if (isIP(address) !== 6) return false
  const normalized = new URL(`https://[${address}]/`).hostname.slice(1, -1)
  const [first, second = '0'] = normalized.split(':').map(x => parseInt(x || '0', 16))
  // Only global unicast; excludes mapped IPv4, ULA, link-local, multicast and
  // transition/special-purpose prefixes that could route to an embedded private IP.
  return first >= 0x2000 && first <= 0x3fff && first !== 0x2002 && first !== 0x3fff &&
    !(first === 0x2001 && (second < 0x200 || second === 0xdb8))
}
export function publicURL(value) {
  const url = new URL(value)
  const host = url.hostname.replace(/^\[|\]$/g, '')
  if (url.protocol !== 'https:' || url.username || url.password || (url.port && url.port !== '443') ||
    (isIP(host) && !publicAddress(host)) || !host || /(^|\.)(localhost|local|internal)$/.test(host)) throw Error('PUBLIC_FETCH_DESTINATION')
  return url
}
export async function publicText(value, { lookup = dnsLookup, request = httpsRequest, maxBytes = 512 * 1024, timeout = 6000, redirects = 3 } = {}) {
  const deadline = Date.now() + timeout
  const get = (url) => new Promise((resolve, reject) => {
    let req, timer
    const fail = () => { clearTimeout(timer); req?.destroy(); reject(Error('PUBLIC_FETCH_FAILED')) }
    const connectLookup = (host, options, callback) => lookup(host, { all: true, verbatim: true }, (err, addresses) => {
      if (err || !addresses?.length || addresses.some(a => !publicAddress(a.address))) return callback(Error('PUBLIC_FETCH_DESTINATION'))
      const chosen = addresses[0]
      callback(null, options.all ? [chosen] : chosen.address, chosen.family)
    })
    timer = setTimeout(fail, Math.max(1, deadline - Date.now()))
    try {
      req = request(url, { agent: false, lookup: connectLookup, headers: { 'user-agent': 'Kier', accept: 'application/json, text/html, application/xml', 'accept-encoding': 'identity' } }, res => {
        if ([301, 302, 303, 307, 308].includes(res.statusCode)) {
          clearTimeout(timer); res.destroy(); return resolve({ location: res.headers.location })
        }
        if (res.statusCode < 200 || res.statusCode >= 300 || (res.headers['content-encoding'] && res.headers['content-encoding'] !== 'identity') || Number(res.headers['content-length']) > maxBytes) { res.destroy(); return fail() }
        const chunks = []; let bytes = 0
        res.on('data', chunk => { bytes += chunk.length; if (bytes > maxBytes) { res.destroy(); fail() } else chunks.push(chunk) })
        res.on('error', fail)
        res.on('aborted', fail)
        res.on('end', () => { clearTimeout(timer); resolve({ body: Buffer.concat(chunks).toString('utf8') }) })
      })
      req.on('error', fail); req.end()
    } catch { fail() }
  })
  let url = publicURL(value)
  for (let hop = 0; hop <= redirects; hop++) {
    if (Date.now() >= deadline) throw Error('PUBLIC_FETCH_TIMEOUT')
    const result = await get(url)
    if (typeof result.body === 'string') return result.body
    if (!result.location || hop === redirects) throw Error('PUBLIC_FETCH_REDIRECT')
    url = publicURL(new URL(result.location, url))
  }
  throw Error('PUBLIC_FETCH_FAILED')
}
