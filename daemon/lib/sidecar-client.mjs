// Socket identity is checked before even the authentication header leaves Kier.
import { lstatSync, realpathSync } from 'node:fs'
import { request } from 'node:http'
import { Readable } from 'node:stream'
import { dirname, resolve } from 'node:path'
import { dataDir } from './config.mjs'
import { sidecarHeaders } from './sidecar-auth.mjs'
export const sockets = Object.freeze({ llm: resolve(dataDir, 'llm.sock'), embed: resolve(dataDir, 'embed.sock'), decision: resolve(dataDir, 'd1.sock') })
export function verifySocket(path) {
  if (!Object.values(sockets).includes(path)) throw Error('SIDECAR_SOCKET_PATH')
  const dir = lstatSync(dataDir), socket = lstatSync(path)
  if (!dir.isDirectory() || dir.uid !== process.getuid() || (dir.mode & 0o777) !== 0o700 ||
      realpathSync(dirname(path)) !== realpathSync(dataDir) || !socket.isSocket() ||
      socket.uid !== process.getuid() || (socket.mode & 0o777) !== 0o600) throw Error('SIDECAR_SOCKET_IDENTITY')
  return path
}
export async function sidecarFetch(name, path, options = {}) {
  const socketPath = verifySocket(sockets[name])
  if (!/^\/[a-z0-9/_-]+$/.test(path)) throw Error('SIDECAR_ROUTE')
  return new Promise((done, fail) => {
    const body = options.body
    const req = request({ socketPath, path, method: options.method || 'GET', agent: false,
      signal: options.signal, headers: { ...sidecarHeaders(), host: 'kier-sidecar', ...(body != null && { 'content-length': Buffer.byteLength(body) }) } }, res => {
      // Never follow a redirect, and retain streaming and abort semantics.
      if (res.statusCode >= 300 && res.statusCode < 400) { res.destroy(); fail(Error('SIDECAR_REDIRECT')); return }
      done(new Response(Readable.toWeb(res), { status: res.statusCode, headers: res.headers }))
    })
    req.on('error', () => fail(Error('SIDECAR_CONNECTION_FAILED')))
    req.end(body)
  })
}
