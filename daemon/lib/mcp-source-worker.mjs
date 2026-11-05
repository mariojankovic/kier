// One owner-selected tool, once. No sampling, elicitation, roots or tool chaining.
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { childEnv, executable } from './child-process.mjs'
import { validateSource } from './mcp-source-config.mjs'
import { mcpFetch } from './mcp-source-http.mjs'
export function sourceEnvironment(explicit = {}) {
  const safe = childEnv(explicit)
  for (const key of Object.keys(safe)) if (!['HOME', 'PATH', 'LANG', 'TMPDIR', 'KIER_WORKER_TAG'].includes(key) && !Object.hasOwn(explicit, key)) delete safe[key]
  return safe
}
export async function runSource(value, mode = 'call') {
  const source = validateSource(value)
  const transport = source.url ? new StreamableHTTPClientTransport(new URL(source.url), { fetch: mcpFetch(source.url) })
    : new StdioClientTransport({ command: executable(source.command), args: source.args, env: sourceEnvironment(source.env), stderr: 'ignore', maxBufferSize: 2 * 1024 * 1024 })
  const client = new Client({ name: 'kier-source', version: '1.0.0' }, { capabilities: {} })
  try {
    await client.connect(transport)
    const tools = []; let cursor
    for (let page = 0; page < 5; page++) {
      const result = await client.listTools(cursor ? { cursor } : {})
      tools.push(...result.tools.slice(0, 100))
      cursor = result.nextCursor
      if (!cursor) break
    }
    const readable = tools.filter(t => t.annotations?.readOnlyHint === true).slice(0, 100)
    if (mode === 'list') return { tools: readable.map(t => ({ name: t.name, description: (t.description || '').slice(0, 500), inputSchema: t.inputSchema })) }
    if (!readable.some(t => t.name === source.tool)) throw Error('MCP_READ_TOOL_REQUIRED')
    const result = await client.callTool({ name: source.tool, arguments: source.arguments })
    if (result.isError) throw Error('MCP_TOOL_FAILED')
    let remaining = 256 * 1024
    return { content: (result.content || []).filter(c => c.type === 'text' && typeof c.text === 'string').slice(0, 200).map(c => {
      const text = c.text.slice(0, Math.min(64000, remaining)); remaining -= text.length
      return { type: 'text', text }
    }).filter(c => c.text) }
  } finally { await client.close() }
}
if (process.argv[1] === new URL(import.meta.url).pathname) {
  let input = ''
  process.stdin.setEncoding('utf8')
  process.stdin.on('data', chunk => { input += chunk; if (input.length > 128000) process.exit(1) })
  process.stdin.on('end', async () => {
    try {
      const { source, mode } = JSON.parse(input)
      const result = await runSource(source, mode)
      process.stdout.write(JSON.stringify(result), () => process.exit(0))
    } catch { process.stdout.write('{"error":"MCP_SOURCE_FAILED"}', () => process.exit(1)) }
  })
}
