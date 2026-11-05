import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const root = mkdtempSync(join(tmpdir(), 'kier-ai-meta-'))
process.env.KIER_DATA_DIR = join(root, 'vault')
after(() => rmSync(root, { recursive: true, force: true }))
const { claude, codex, codexApp, collect } = await import('../collectors/ai.mjs')
const { open, now } = await import('../lib/db.mjs')
const at = now() - 3 * 3600
const timestamp = offset => new Date((at + offset) * 1000).toISOString()
const row = (type, payload, offset = 0) => ({ type, payload, timestamp: timestamp(offset) })
const message = (role, text, offset) => row('response_item', { type: 'message', role, id: `${role}-${offset}`, content: [{ type: role === 'user' ? 'input_text' : 'output_text', text }] }, offset)
function transcript(name, metadata, model = 'gpt-6.1-sol', extra = []) {
  const path = join(root, `${name}.jsonl`)
  const records = [row('session_meta', { id: name, cwd: '/example/project', ...metadata }), ...extra,
    row('turn_context', { model }), message('user', 'Add an archive page', 5), message('assistant', 'Should I add a search box?', 60)]
  writeFileSync(path, records.map(r => JSON.stringify(r)).join('\n') + '\n')
  return path
}

test('Codex Desktop sessions retain their product identity, model and app', () => {
  for (const originator of ['Codex Desktop', 'codex_work_desktop']) {
    const s = codex(transcript(`desktop-${originator}`, { originator, source: 'vscode' }))
    assert.equal(s.provider, 'codex')
    assert.equal(s.model, 'gpt-6.1-sol')
    assert.equal(s.agent, 'Sol')
    assert.equal(s.app, 'desktop')
    assert.equal(s.originator, originator)
  }
})

test('GPT and Astra models remain Codex sessions without changing familiar agent labels', () => {
  for (const [model, agent] of [['gpt-6.1', 'Codex'], ['gpt-6-astra', 'Astra'], ['gpt-6.1-sol', 'Sol']]) {
    const s = codex(transcript(`model-${agent}`, { source: 'vscode', originator: 'Codex Desktop' }, model))
    assert.equal(s.agent, agent)
    assert.equal(s.provider, 'codex')
    assert.equal(s.model, model)
  }
})

test('the vscode source alone does not turn editor or CLI sessions into desktop sessions', () => {
  assert.equal(codexApp({ source: 'vscode', originator: 'codex_vscode' }), 'terminal')
  assert.equal(codexApp({ source: 'cli', originator: 'codex_cli_rs' }), 'terminal')
  assert.equal(codexApp({ client: { name: 'Codex Desktop' } }), 'desktop')
})

test('the header still identifies a desktop session beyond the transcript tail', () => {
  const path = transcript('large-desktop', { originator: 'Codex Desktop', source: 'vscode' }, 'gpt-6.1',
    [row('response_item', { type: 'function_call_output', output: 'x'.repeat(4 * 1024 * 1024 + 1024) })])
  const s = codex(path)
  assert.equal(s.app, 'desktop')
  assert.equal(s.session, 'large-desktop')
  assert.equal(s.provider, 'codex')
})

test('exec and spawned agents remain outside the owner conversations', () => {
  for (const [i, metadata] of [{ source: 'exec' }, { source: { subagent: { thread_spawn: {} } } }, { source: 'vscode', thread_source: 'subagent' }].entries()) {
    assert.equal(codex(transcript(`own-${i}`, metadata)).own, true)
  }
})

test('Claude retains its desktop parsing and gains only its explicit provider', () => {
  const path = join(root, 'claude-session.jsonl')
  writeFileSync(path, [
    { type: 'user', cwd: '/example/claude', entrypoint: 'claude-desktop', origin: { kind: 'human' }, timestamp: timestamp(5), message: { content: 'Review the archive page' } },
    { type: 'assistant', uuid: 'answer', timestamp: timestamp(60), message: { content: [{ type: 'text', text: 'Should I adjust the spacing?' }] } },
  ].map(r => JSON.stringify(r)).join('\n') + '\n')
  const s = claude(path)
  assert.equal(s.agent, 'Claude')
  assert.equal(s.provider, 'claude')
  assert.equal(s.app, 'desktop')
  assert.equal(s.ask.text, 'Should I adjust the spacing?')
})

test('collection adds metadata to session and question rows, including existing stored rows', t => {
  const codexDir = join(root, 'codex-collector')
  mkdirSync(codexDir)
  const source = join(codexDir, 'collected.jsonl')
  writeFileSync(source, [
    row('session_meta', { id: 'collected', cwd: '/example/project', originator: 'Codex Desktop', source: 'vscode' }),
    row('turn_context', { model: 'gpt-6.1' }), message('user', 'Add an archive page', 5), message('assistant', 'Should I add a search box?', 60),
  ].map(r => JSON.stringify(r)).join('\n') + '\n')
  const db = open(join(root, 'test.db')); t.after(() => db.close())
  collect(db, { claudeDir: join(root, 'no-claude'), codexDir })
  const rows = db.prepare("select id, meta from items where source='ai' order by id").all()
  assert.equal(rows.length, 2)
  for (const r of rows) {
    const meta = JSON.parse(r.meta)
    assert.equal(meta.provider, 'codex')
    assert.equal(meta.model, 'gpt-6.1')
    assert.equal(meta.app, 'desktop')
  }
  db.prepare("update items set meta = json_remove(meta, '$.provider', '$.model', '$.app')").run()
  collect(db, { claudeDir: join(root, 'no-claude'), codexDir })
  for (const r of db.prepare('select meta from items').all()) assert.equal(JSON.parse(r.meta).provider, 'codex')
})
