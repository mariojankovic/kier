// Existing synthetic verdict fixtures run through the real Unix decision transport.
import { after } from 'node:test'
import { createServer } from 'node:http'
import { chmodSync } from 'node:fs'
export async function modelFixture({ decision = true } = {}) {
  const { config } = await import('../lib/config.mjs')
  config.runtime = 'external'
  config.externalModel = { protocol: 'ollama', endpoint: 'https://model.example.test', model: 'fixture' }
  if (!decision) return
  const original = globalThis.fetch
  const { sockets } = await import('../lib/sidecar-client.mjs')
  const server = createServer(async (req, res) => {
    try {
      if (globalThis.fetch === original) throw Error('A synthetic fetch fixture is required')
      let body = ''; for await (const chunk of req) body += chunk
      const result = await globalThis.fetch(`http://kier-sidecar${req.url}`, { method: req.method, body })
      res.writeHead(result.ok ? 200 : 500, { 'content-type': 'application/json' })
      res.end(JSON.stringify(result.json ? await result.json() : {}))
    } catch { res.writeHead(500); res.end('{}') }
  })
  await new Promise((resolve, reject) => { server.on('error', reject); server.listen(sockets.decision, resolve) })
  chmodSync(sockets.decision, 0o600)
  after(() => new Promise(resolve => server.close(resolve)))
}
