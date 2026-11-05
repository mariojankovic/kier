// Only the signed app's inherited pipes carry credentials. No socket, file or CLI command exposes them.
import { randomBytes } from 'node:crypto'
export function nativeVault(input, output, { timeout = 200000 } = {}) {
  const pending = new Map(); let buffer = ''
  const fail = () => { for (const p of pending.values()) { clearTimeout(p.timer); p.reject(Error('GMAIL_NATIVE_UNAVAILABLE')) }; pending.clear() }
  input.setEncoding('utf8')
  input.on('data', chunk => {
    buffer += chunk
    if (buffer.length > 65536) { buffer = ''; fail(); return }
    let end
    while ((end = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, end); buffer = buffer.slice(end + 1)
      try {
        const reply = JSON.parse(line), p = pending.get(reply.id)
        if (!p) continue
        pending.delete(reply.id); clearTimeout(p.timer)
        reply.ok === true ? p.resolve(reply.value) : p.reject(Error('GMAIL_KEYCHAIN_UNAVAILABLE'))
      } catch { fail() }
    }
  })
  input.on('end', fail); input.on('error', fail); output.on('error', fail)
  return (operation) => new Promise((resolve, reject) => {
    if (!['status', 'connect', 'disconnect', 'access'].includes(operation)) { reject(Error('GMAIL_OPERATION_REFUSED')); return }
    const id = randomBytes(16).toString('hex')
    const timer = setTimeout(() => { pending.delete(id); reject(Error('GMAIL_NATIVE_UNAVAILABLE')) }, timeout)
    pending.set(id, { resolve, reject, timer })
    output.write(`KIER_VAULT ${JSON.stringify({ id, operation })}\n`, error => { if (error) fail() })
  })
}
let channel
export function vaultCall(operation) {
  if (process.env.KIER_NATIVE_VAULT !== '1' || process.argv[2] !== 'run') return Promise.reject(Error('GMAIL_NATIVE_UNAVAILABLE'))
  channel ??= nativeVault(process.stdin, process.stdout)
  return channel(operation)
}
