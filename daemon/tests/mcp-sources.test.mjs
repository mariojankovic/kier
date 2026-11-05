import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
const dir = mkdtempSync(join(tmpdir(), 'kier-mcp-source-'))
process.env.KIER_DATA_DIR = dir
process.env.AMBIENT_SECRET = 'fixture-secret'
writeFileSync(join(dir, 'config.json'), JSON.stringify({ me: 'Sam', fullName: 'Sam', languages: ['English'], workRoots: [] }))
after(() => rmSync(dir, { recursive: true, force: true }))
const { sourceJob, sourceItems } = await import('../lib/mcp-sources.mjs')
const { sourceEnvironment } = await import('../lib/mcp-source-worker.mjs')
const { commandLine, mcpURL, editSource, sourceList } = await import('../lib/mcp-source-config.mjs')
const { mcpFetch } = await import('../lib/mcp-source-http.mjs')
const { collect } = await import('../collectors/mcp.mjs')
const { addItems, open, now } = await import('../lib/db.mjs')
const { save, setSource } = await import('../lib/settings.mjs')
const { permitsItem } = await import('../lib/app-permissions.mjs')
const { readScope, authorization } = await import('../lib/authorization.mjs')
const { forget } = await import('../lib/privacy.mjs')
const fixture = { id: 'fixture', name: 'Puzzle club', command: process.execPath, args: [new URL('./fixtures/mcp-server.mjs', import.meta.url).pathname], env: { FIXTURE_CALLS: join(dir, 'calls') }, tool: 'recent', arguments: { channel: 'Sketches' }, enabled: true }

test('stdio lists only read tools, calls once and never follows returned instructions', async () => {
  const listed = await sourceJob(fixture, 'list')
  assert.deepEqual(listed.tools.map(t => t.name), ['recent'])
  const result = await sourceJob(fixture)
  assert.equal(result.content.length, 2)
  assert.equal(readFileSync(join(dir, 'calls'), 'utf8'), 'recent\n')
  const items = sourceItems(fixture, result)
  assert.equal(items.length, 3); assert.match(items[0].thread, /^mcp:fixture:/); assert.equal(items[0].meta.channel, 'Sketches'); assert.equal(items[0].meta.mcpServer, 'Puzzle club'); assert.equal(items[0].sender, 'Nika')
  assert.equal(items[0].source, 'mcp'); assert.equal(items[0].fromMe, false)
  assert.equal(items[2].text, 'clean environment'); assert.equal(items[0].ts, Date.parse('2026-11-05T12:00:00Z') / 1000)
  await assert.rejects(sourceJob({ ...fixture, tool: 'destroy' }), /MCP_SOURCE_FAILED/)
  assert.equal(readFileSync(join(dir, 'calls'), 'utf8'), 'recent\n')
})
test('controlled environment and URL rules refuse secrets, startup hooks and redirects', async () => {
  const env = sourceEnvironment({ OWNER_KEY: 'fixture', NODE_OPTIONS: '--inspect', PATH: '/bad' })
  assert.equal(env.AMBIENT_SECRET, undefined); assert.equal(env.KIER_DATA_DIR, undefined); assert.equal(env.NODE_OPTIONS, undefined)
  assert.equal(env.OWNER_KEY, 'fixture'); assert.notEqual(env.PATH, '/bad')
  assert.deepEqual(commandLine('/usr/bin/node "file with spaces.mjs" --arg'), { command: '/usr/bin/node', args: ['file with spaces.mjs', '--arg'] })
  assert.throws(() => commandLine('node "broken'))
  for (const url of ['http://localhost:4000', 'http://192.168.1.1', 'https://127.0.0.1', 'file:///tmp/a', 'https://user:secret@example.test', 'https://server.local']) assert.throws(() => mcpURL(url))
  assert.equal(mcpURL('http://127.0.0.1:4000/mcp').port, '4000')
  await assert.rejects(mcpFetch('https://mcp.example.test')('https://other.example.test'), /HOST_REFUSED/)
})
test('schedule is ten minutes, on-demand bypasses it, items dedupe and switches hide them', async t => {
  save({ mcpSources: [fixture] }); setSource('mcp', true)
  const db = open(':memory:'); t.after(() => db.close())
  let calls = 0
  const result = { content: [{ type: 'text', text: JSON.stringify({ text: 'Please bring the sketch.', sender: 'Tea', channel: 'Garden', ts: now() }) }] }
  const run = async () => { calls++; return result }
  assert.equal(await collect(db, { run }), 1)
  assert.equal(await collect(db, { run }), 0); assert.equal(calls, 1)
  assert.equal(await collect(db, { run, at: now() + 601 }), 0); assert.equal(calls, 2)
  assert.equal(await collect(db, { run, force: true }), 0); assert.equal(calls, 3)
  let reader = readScope(db, authorization(null))
  assert.equal(reader.prepare('select * from items').all().length, 1)
  editSource({ id: fixture.id, enabled: false })
  assert.equal(permitsItem(sourceItems(fixture, result)[0]), false)
  reader = readScope(db, authorization(null)); assert.equal(reader.prepare('select * from items').all().length, 0)
  assert.equal(await collect(db, { run, force: true }), 0); assert.equal(calls, 3)
  editSource({ id: fixture.id, enabled: true })
  setSource('mcp', false)
  assert.equal(readScope(db, authorization(null)).prepare('select * from items').all().length, 0)
  assert.equal(await collect(db, { run, force: true }), 0)
  setSource('mcp', true)
  const item = sourceItems(fixture, result)[0]
  forget(db, { id: item.id }); assert.equal(addItems(db, [item]), 0)
  const redacted = sourceItems(fixture, { content: [{ type: 'text', text: 'Authorization: Bearer ' + ['sk', 'fixture' + '0'.repeat(36)].join('-') }] })
  addItems(db, redacted)
  assert.doesNotMatch(db.prepare('select text from items').get().text, /sk-fixture/)
  editSource({ id: fixture.id, remove: true })
  assert.equal(readScope(db, authorization(null)).prepare('select * from items').all().length, 0)
})
test('new sources start off, changed policy discards in-flight results and mapping is capped', async t => {
  const id = editSource({ name: 'Sketches', endpoint: '/usr/bin/true', enabled: true })
  assert.equal(sourceList().find(s => s.id === id).enabled, false)
  const db = open(':memory:'); t.after(() => db.close())
  save({ mcpSources: [fixture] })
  assert.equal(await collect(db, { force: true, run: async () => { editSource({ id: fixture.id, enabled: false }); return { content: [{ type: 'text', text: 'discarded' }] } } }), 0)
  const items = sourceItems(fixture, { content: Array.from({ length: 300 }, () => ({ type: 'text', text: 'x'.repeat(100000) })) })
  assert.ok(items.length <= 200); assert.ok(items.every(i => i.text.length <= 16000))
  assert.equal(sourceItems(fixture, { content: [{ type: 'resource', resource: { text: 'do not store' } }] }).length, 0)
})
test('hard timeout kills a hanging server and reparented detached grandchild', async t => {
  const pidFile = join(dir, 'pid'), detachedFile = join(dir, 'detached-pid')
  t.after(() => { for (const path of [pidFile, detachedFile]) { try { process.kill(Number(readFileSync(path, 'utf8')), 'SIGKILL') } catch {} } })
  await assert.rejects(sourceJob({ ...fixture, env: { FIXTURE_PID: pidFile, FIXTURE_HANG: '1', FIXTURE_DETACHED_PID: detachedFile } }, 'call', { timeout: 15000 }), /TIMEOUT/)
  assert.ok(existsSync(pidFile))
  const pids = [pidFile, detachedFile].map(path => Number(readFileSync(path, 'utf8')))
  let alive = true
  for (let i = 0; i < 40 && alive; i++) {
    await new Promise(r => setTimeout(r, 100))
    alive = pids.some(pid => { try { process.kill(pid, 0); return true } catch { return false } })
  }
  assert.equal(alive, false)
})

test('streamable HTTP works over owner loopback and refuses redirect destinations', async t => {
  const { createServer } = await import('node:http')
  let calls = 0, redirect = false
  const server = createServer(async (req, res) => {
    if (redirect) { res.writeHead(302, { location: 'https://other.example.test/mcp' }); res.end(); return }
    if (req.method !== 'POST') { res.writeHead(405); res.end(); return }
    let body = ''; for await (const part of req) body += part
    const input = JSON.parse(body)
    if (input.id === undefined) { res.writeHead(202); res.end(); return }
    let result
    if (input.method === 'initialize') result = { protocolVersion: '2025-03-26', capabilities: { tools: {} }, serverInfo: { name: 'Fixture', version: '1.0.0' } }
    if (input.method === 'tools/list') result = { tools: [{ name: 'recent', annotations: { readOnlyHint: true }, inputSchema: { type: 'object' } }] }
    if (input.method === 'tools/call') { calls++; assert.equal(input.params.name, 'recent'); result = { content: [{ type: 'text', text: 'Tea has the sketches.' }] } }
    res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ jsonrpc: '2.0', id: input.id, result }))
  })
  await new Promise(r => server.listen(0, '127.0.0.1', r))
  t.after(() => { server.close(); server.closeAllConnections() })
  const source = { id: 'http-fixture', name: 'Sketches', url: `http://127.0.0.1:${server.address().port}/mcp`, tool: 'recent', arguments: {} }
  assert.equal((await sourceJob(source)).content[0].text, 'Tea has the sketches.'); assert.equal(calls, 1)
  redirect = true
  await assert.rejects(sourceJob(source), /MCP_SOURCE_FAILED/)
  assert.equal(calls, 1)
})

test('authorization refreshes after collection through a separate SQLite connection', t => {
  save({ mcpSources: [fixture] }); setSource('mcp', true)
  const path = join(dir, 'shared.db'), db = open(path), writer = open(path)
  t.after(() => { writer.close(); db.close() })
  assert.equal(readScope(db, authorization(null)).prepare('select * from items').all().length, 0)
  const items = sourceItems(fixture, { content: [{ type: 'text', text: 'Borna has the sketches.' }] })
  assert.equal(addItems(writer, items), 1)
  assert.equal(readScope(db, authorization(null)).prepare('select * from items').all().length, 1)
  editSource({ id: fixture.id, enabled: false })
  assert.equal(readScope(db, authorization(null)).prepare('select * from items').all().length, 0)
})

test('configured server identity isolates conversation reads and whole-thread Forget', async t => {
  const other = { ...fixture, id: 'second', name: 'Garden club' }
  save({ mcpSources: [fixture, other] }); setSource('mcp', true)
  const db = open(':memory:'); t.after(() => db.close())
  const result = text => ({ content: [{ type: 'text', text: JSON.stringify({ text, sender: 'Nika', channel: 'shared', ts: now() - 10, mcpServer: 'Forged', sourceId: fixture.id }) }] })
  const a = sourceItems(fixture, result('FIRST_MARKER'))[0], b = sourceItems(other, result('SECOND_MARKER'))[0]
  addItems(db, [a, b])
  assert.notEqual(a.thread, b.thread)
  assert.equal(b.meta.mcpServer, 'Garden club')
  assert.equal(b.sourceId, 'second')
  assert.deepEqual(db.prepare('select text from items where source = ? and thread = ?').all('mcp', a.thread).map(r => r.text), ['FIRST_MARKER'])
  const { aboutItem } = await import('../lib/resolve.mjs')
  assert.doesNotMatch(await aboutItem(db, a.id), /SECOND_MARKER/)
  assert.equal(forget(db, { source: 'mcp', thread: a.thread }), 1)
  assert.equal(addItems(db, [a]), 0)
  assert.equal(db.prepare('select text from items').get().text, 'SECOND_MARKER')
  assert.equal(addItems(db, sourceItems(other, result('SECOND_NEW'))), 1)
})

test('legacy MCP rows receive isolated keys and configured attribution on reopen', t => {
  save({ mcpSources: [fixture] })
  const path = join(dir, 'legacy-mcp.db'), db = open(path)
  db.prepare("delete from migrations where id = 'mcp-thread-identity-v1'").run()
  db.prepare("insert into items(id,source,source_id,thread,sender,ts,text) values ('legacy','mcp','fixture','shared','Nika',?,'fixture')").run(now())
  db.close()
  const migrated = open(path); t.after(() => migrated.close())
  const row = migrated.prepare('select * from items').get()
  assert.match(row.thread, /^mcp:fixture:/)
  assert.equal(JSON.parse(row.meta).mcpServer, 'Puzzle club')
  assert.equal(JSON.parse(row.meta).channel, 'shared')
})


test('source environment retains the supervisor marker and refuses source overrides', () => {
  process.env.KIER_WORKER_TAG = 'fixture-supervisor-tag'
  try {
    assert.equal(sourceEnvironment({ KIER_WORKER_TAG: 'spoofed' }).KIER_WORKER_TAG, 'fixture-supervisor-tag')
  } finally { delete process.env.KIER_WORKER_TAG }
})
