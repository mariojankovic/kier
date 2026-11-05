// v1: newline-delimited UTF-8 fields, lowercase hex digests, raw encoded URL path/query.
import { createHash, createHmac, timingSafeEqual, randomBytes, createCipheriv, createDecipheriv } from 'node:crypto'
import { constants, openSync, closeSync, fstatSync, fchmodSync, readFileSync, writeFileSync, renameSync } from 'node:fs'

export const sha256 = body => createHash('sha256').update(body).digest('hex')
export const mac = (secret, text) => createHmac('sha256', secret).update(text).digest('hex')
export const equalMAC = (a, b) => typeof a === 'string' && /^[a-f0-9]{64}$/.test(a) && timingSafeEqual(Buffer.from(a, 'hex'), Buffer.from(b, 'hex'))
export const requestMAC = (secret, method, target, timestamp, nonce, body) => mac(secret, [method, target, timestamp, nonce, sha256(body)].join('\n'))
export const responseMAC = (secret, nonce, status, body) => mac(secret, [nonce, status, sha256(body)].join('\n'))
export function readSecret(path, create = false) {
  if (create) {
    try { writeFileSync(path, randomBytes(32).toString('hex'), { flag: 'wx', mode: 0o600 }) }
    catch (e) { if (e.code !== 'EEXIST') throw e }
  }
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW)
  try {
    const st = fstatSync(fd)
    if (!st.isFile() || st.uid !== process.getuid() || st.nlink !== 1) throw Error('PRIVATE_SECRET_REQUIRED')
    fchmodSync(fd, 0o600)
    const secret = readFileSync(fd, 'utf8')
    if (secret.length < 32 || secret.length > 256) throw Error('PRIVATE_SECRET_REQUIRED')
    return secret
  } finally { closeSync(fd) }
}

export function verifier(secret, clock = () => Date.now(), replayPath) {
  let seen = new Map()
  if (replayPath) {
    try {
      const entries = JSON.parse(readFileSync(replayPath, 'utf8'))
      if (!Array.isArray(entries) || entries.length > 10000 || entries.some(e =>
        !Array.isArray(e) || e.length !== 2 || !/^[a-f0-9]{32}$/.test(e[0]) || !Number.isSafeInteger(e[1]))) throw Error('REPLAY_STATE_INVALID')
      seen = new Map(entries)
    } catch (e) { if (e.code !== 'ENOENT') throw e }
  }
  return (method, target, headers, body) => {
    const timestamp = headers['x-kier-time'], nonce = headers['x-kier-nonce']
    const now = Math.floor(clock() / 1000)
    for (const [key, expiry] of seen) if (expiry < now) seen.delete(key)
    if (typeof timestamp !== 'string' || !/^\d{10}$/.test(timestamp) || Math.abs(now - Number(timestamp)) > 60 ||
        typeof nonce !== 'string' || !/^[a-f0-9]{32}$/.test(nonce) || seen.has(nonce) || seen.size >= 10000 ||
        !equalMAC(headers['x-kier-signature'], requestMAC(secret, method, target, timestamp, nonce, body))) return null
    // A future-dated request stays replay-protected until its entire acceptance window ends.
    seen.set(nonce, Number(timestamp) + 60)
    // Persist before dispatch so a daemon restart cannot make a captured write reusable.
    if (replayPath) {
      const temp = `${replayPath}.${process.pid}.tmp`
      writeFileSync(temp, JSON.stringify([...seen]), { mode: 0o600 })
      renameSync(temp, replayPath)
    }
    return nonce
  }
}

const bodyKey = secret => Buffer.from(mac(secret, 'kier-request-body-v1'), 'hex')
export function sealBody(secret, body) {
  const iv = randomBytes(12), cipher = createCipheriv('aes-256-gcm', bodyKey(secret), iv)
  return Buffer.concat([iv, cipher.update(body), cipher.final(), cipher.getAuthTag()])
}
export function openBody(secret, body) {
  if (body.length < 28) throw Error('INVALID_BODY')
  const decipher = createDecipheriv('aes-256-gcm', bodyKey(secret), body.subarray(0, 12))
  decipher.setAuthTag(body.subarray(-16))
  return Buffer.concat([decipher.update(body.subarray(12, -16)), decipher.final()])
}

export function signedHeaders(secret, method, target, body = Buffer.alloc(0), timestamp = String(Math.floor(Date.now() / 1000)), nonce = randomBytes(16).toString('hex')) {
  return { 'x-kier-time': timestamp, 'x-kier-nonce': nonce, 'x-kier-signature': requestMAC(secret, method, target, timestamp, nonce, body) }
}

// CLI callers authenticate the daemon before trusting tickets or any response data.
export async function signedFetch(secret, url, { method = 'GET', body, ...options } = {}) {
  const u = new URL(url), wire = body == null ? Buffer.alloc(0) : sealBody(secret, Buffer.from(body))
  const headers = signedHeaders(secret, method, u.pathname + u.search, wire)
  const response = await fetch(url, { ...options, method, redirect: 'error',
    headers: { ...options.headers, ...headers, ...(body != null && { 'content-type': 'application/json', 'x-kier-body': 'aes-gcm-v1' }) },
    ...(body != null && { body: wire }) })
  const data = Buffer.from(await response.arrayBuffer())
  if (!equalMAC(response.headers.get('x-kier-response'), responseMAC(secret, headers['x-kier-nonce'], response.status, data))) throw Error('DAEMON_UNAVAILABLE')
  return new Response(data, { status: response.status, headers: response.headers })
}

// Buffer signed output, including NDJSON. No partial answer is trusted before its MAC arrives.
export function signResponse(res, secret, nonce) {
  const chunks = [], end = res.end.bind(res), head = res.writeHead.bind(res)
  res.writeHead = (status, headers) => {
    res.statusCode = status
    for (const [key, value] of Object.entries(headers || {})) res.setHeader(key, value)
    return res
  }
  res.write = chunk => { if (chunk) chunks.push(Buffer.from(chunk)); return true }
  res.end = chunk => {
    if (chunk) chunks.push(Buffer.from(chunk))
    const body = Buffer.concat(chunks)
    res.setHeader('x-kier-response', responseMAC(secret, nonce, res.statusCode, body))
    head(res.statusCode)
    return end(body)
  }
}
