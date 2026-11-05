// MCP HTTP uses the same public-address rules as public-fetch, with an explicit
// loopback exception for an owner-configured local server. No redirects or proxies.
import { request as http } from 'node:http'
import { request as https } from 'node:https'
import { lookup } from 'node:dns'
import { Readable, Transform } from 'node:stream'
import { publicAddress } from './public-fetch.mjs'
import { mcpURL } from './mcp-source-config.mjs'
export function mcpFetch(endpoint) {
  const origin = mcpURL(endpoint).origin
  return async (value, init = {}) => {
    const url = mcpURL(value)
    if (url.origin !== origin) throw Error('MCP_HOST_REFUSED')
    return new Promise((resolve, reject) => {
      const fail = () => reject(Error('MCP_HTTP_FAILED'))
      const req = (url.protocol === 'http:' ? http : https)(url, {
        method: init.method || 'GET', headers: Object.fromEntries(new Headers(init.headers)), agent: false, signal: init.signal,
        lookup: (host, options, callback) => lookup(host, { all: true, verbatim: true }, (error, found) => {
          if (error || !found?.length || found.some(a => !publicAddress(a.address))) return callback(Error('MCP_HOST_REFUSED'))
          callback(null, options.all ? [found[0]] : found[0].address, found[0].family)
        }),
      }, res => {
        if (res.statusCode >= 300 && res.statusCode < 400) { res.destroy(); fail(); return }
        let bytes = 0
        const cap = new Transform({ transform(chunk, _, done) {
          bytes += chunk.length
          if (bytes > 2 * 1024 * 1024) done(Error('MCP_RESPONSE_TOO_LARGE')); else done(null, chunk)
        } })
        res.on('error', e => cap.destroy(e)); cap.on('close', () => res.destroy())
        const headers = new Headers()
        for (const [key, value] of Object.entries(res.headers)) if (value !== undefined) headers.set(key, Array.isArray(value) ? value.join(', ') : value)
        if ([204, 205, 304].includes(res.statusCode)) { res.resume(); resolve(new Response(null, { status: res.statusCode, headers })); return }
        resolve(new Response(Readable.toWeb(res.pipe(cap)), { status: res.statusCode, headers }))
      })
      req.setTimeout(15000, () => req.destroy())
      req.on('error', fail)
      req.end(init.body)
    })
  }
}
