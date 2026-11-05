import { externalSender } from './evidence-trust.mjs'
import { mcpThread } from './mcp-identity.mjs'
import { createHash } from 'node:crypto'
import { managedSpawn } from './child-process.mjs'
import { validateSource } from './mcp-source-config.mjs'

export function sourceJob(value, mode = 'call', { timeout = 30000 } = {}) {
  const source = validateSource(value)
  return new Promise((resolve, reject) => {
    const child = managedSpawn(process.execPath, ['--disable-warning=ExperimentalWarning', new URL('./mcp-source-worker.mjs', import.meta.url).pathname], { stdio: ['pipe', 'pipe', 'ignore'] })
    let output = '', done = false
    const finish = (error, result) => {
      if (done) return
      done = true; clearTimeout(timer)
      // Closing the guard pipe starts tree and inherited-marker cleanup in the supervisor.
      child.stdio[3]?.destroy()
      error ? reject(Error(error)) : resolve(result)
    }
    const timer = setTimeout(() => finish('MCP_SOURCE_TIMEOUT'), timeout)
    child.stdout.setEncoding('utf8')
    child.stdout.on('data', chunk => {
      output += chunk
      if (output.length > 1024 * 1024) return finish('MCP_SOURCE_TOO_LARGE')
      // The worker emits exactly one JSON result. Do not wait on inherited pipes
      // held by a server descendant after that result is complete.
      try {
        const result = JSON.parse(output)
        finish(result.error ? 'MCP_SOURCE_FAILED' : null, result)
      } catch {}
    })
    child.on('error', () => finish('MCP_SOURCE_FAILED'))
    child.on('exit', code => {
      if (code !== 0) return finish('MCP_SOURCE_FAILED')
      try { finish(null, JSON.parse(output)) } catch { finish('MCP_SOURCE_FAILED') }
    })
    child.stdin.on('error', () => {})
    child.stdin.end(JSON.stringify({ source, mode }))
  })
}
const short = value => typeof value === 'string' ? value.slice(0, 200) : ''
export function sourceItems(source, result, at = Math.floor(Date.now() / 1000)) {
  const items = []; let remaining = 256 * 1024
  for (const block of (result.content || []).slice(0, 200)) {
    if (block.type !== 'text' || typeof block.text !== 'string' || remaining <= 0) continue
    const raw = block.text.slice(0, Math.min(64000, remaining)); remaining -= raw.length
    let parsed
    try { parsed = JSON.parse(raw) } catch {}
    const rows = Array.isArray(parsed) ? parsed : Array.isArray(parsed?.items) ? parsed.items : Array.isArray(parsed?.messages) ? parsed.messages : [parsed ?? raw]
    for (const row of rows.slice(0, 200 - items.length)) {
      const text = (typeof row === 'string' ? row : typeof row?.text === 'string' ? row.text : typeof row?.content === 'string' ? row.content : typeof row?.message === 'string' ? row.message : JSON.stringify(row))?.slice(0, 16000)
      if (!text) continue
      const channel = short(row?.channel)
      const thread = mcpThread(source.id, channel)
      const sender = short(row?.sender?.name) || short(row?.sender) || short(row?.from?.name) || short(row?.from) || short(row?.author?.name) || short(row?.author) || source.name
      const date = row?.ts ?? row?.timestamp ?? row?.date
      let ts = typeof date === 'number' || typeof date === 'string' && /^\d+(?:\.\d+)?$/.test(date) ? Number(date) : Date.parse(date) / 1000
      if (ts > 1e12) ts /= 1000
      if (!Number.isFinite(ts) || ts <= 0 || ts > at + 86400) ts = at
      const digest = createHash('sha256').update(JSON.stringify([source.id, row])).digest('hex')
      items.push({ id: `mcp:${source.id}:${digest}`, source: 'mcp', sourceId: source.id, thread, sender: externalSender(sender), ts: Math.floor(ts), text,
        fromMe: false, meta: { mcpSource: source.id, mcpServer: source.name, channel, threadVersion: 1, untrusted: true } })
    }
  }
  return items
}
