import { sidecarFetch } from './sidecar-client.mjs'
import { modelFetch } from './model-provider.mjs'
// A report for a bug, built only from what is listed here: facts about Kier and this Mac, which parts run, numbers, and
// the kinds of trouble in the log. Never a name, message, chat, file, path, address or the apps you have; an error's
// own words can carry any of those, so only its kind is kept. Kier never sends it: Settings shows it whole and you copy
// it only when they choose.
import { execFileSync } from './child-process.mjs'
import { existsSync, openSync, readSync, statSync, closeSync } from 'node:fs'
import { cpus, totalmem, uptime } from 'node:os'
import { resolve } from 'node:path'
import { config, dataDir, usesExternalModel, usesMlx } from './config.mjs'
import { now } from './db.mjs'
import { embedReady, MLX } from './runtime.mjs'
import { installed as secondInstalled, up as secondUp } from './second.mjs'
import { memoryState } from './memory.mjs'
import { off, SOURCES } from './settings.mjs'

// What an error is about, from its words; the words themselves stay on the Mac.
const KINDS = [
  ['tagging', /"failed":\s*[1-9]/],
  ['code', /TypeError|ReferenceError|SyntaxError|RangeError|is not a function|Cannot read propert/],
  ['port in use', /EADDRINUSE|Error: listen/],
  ['permission', /not permitted|permission|denied|EACCES|EPERM|full disk access/i],
  ['timeout', /timed? ?out|timeout|aborted/i],
  ['memory', /out of memory|short of memory|memory pressure/i],
  ['model', /Traceback|local model stopped|search model stopped|second opinion stopped|mlx|metal/i],
  ['network', /fetch failed|ECONN|ENOTFOUND|EAI_AGAIN|network/i],
  ['missing', /ENOENT|no such file|not found|Cannot find|isn't installed/i],
  ['unreadable', /unreadable|JSON|parse|Unexpected token/i],
]
export const kindOf = (s) => KINDS.find(([, re]) => re.test(String(s)))?.[0] || 'other'
// A pass that failed nothing ("failed":0) and a clean exit ("stopped (0)") are no trouble.
const TROUBLE = /error|failed|stopped|Traceback|denied|not permitted|timed out|unreadable/i
const trouble_ = (line) => TROUBLE.test(line.replace(/"failed":\s*0\b/g, '').replace(/stopped \(0\)/g, ''))

const ago = (ts) => {
  if (!ts) return 'never'
  const m = Math.max(0, Math.round((now() - ts) / 60))
  return m < 90 ? `${m} min ago` : m < 48 * 60 ? `${Math.round(m / 60)} h ago` : `${Math.round(m / 1440)} days ago`
}
const sh = (cmd, args) => { try { return execFileSync(cmd, args, { encoding: 'utf8', timeout: 3000, stdio: ['ignore', 'pipe', 'ignore'] }).trim() } catch { return '?' } }
const up = async (name) => { try { return (await sidecarFetch(name, '/api/version', { signal: AbortSignal.timeout(1500) })).ok } catch { return false } }

// The last two days of the log, counted by kind of trouble: how many, and when the latest was.
function trouble() {
  const file = resolve(dataDir, 'kier.log')
  if (!existsSync(file)) return []
  const size = statSync(file).size
  const length = Math.min(size, 2_000_000)
  const buf = Buffer.alloc(length)
  const fd = openSync(file, 'r')
  readSync(fd, buf, 0, length, size - length)
  closeSync(fd)
  const counts = new Map()
  for (const line of buf.toString('utf8').split('\n')) if (trouble_(line)) { const k = kindOf(line); counts.set(k, (counts.get(k) || 0) + 1) }
  return [...counts].sort((a, b) => b[1] - a[1]).map(([k, n]) => `  ${k}: ${n}`)
}

export async function diagnostics(db, { steps = [] } = {}) {
  const count = (sql, ...p) => db.prepare(sql).get(...p).n
  const day = now() - 86400
  const mem = memoryState()
  const answering = async () => { try { return (await modelFetch('/api/version', { signal: AbortSignal.timeout(2000) })).ok } catch { return false } }
  const [model, search] = usesMlx ? await Promise.all([up('llm'), up('embed')])
    : usesExternalModel ? await Promise.all([answering(), up('embed')]) : [false, false]
  const lines = [
    `Kier daemon: up ${Math.round(process.uptime() / 60)} min, Node ${process.versions.node}`,
    `Mac: macOS ${sh('sw_vers', ['-productVersion'])}, ${cpus()[0]?.model || 'unknown chip'}, ${Math.round(totalmem() / 2 ** 30)} GB memory, up ${Math.round(uptime() / 3600)} h`,
    `Memory: ${['', 'fine', 'warning', '', 'critical'][mem.level] || mem.level} now; background reading waited ${mem.backedOff} time${mem.backedOff === 1 ? '' : 's'} since start${mem.waiting ? `, waiting ${mem.waiting} min more` : ''}`,
    `Model: ${usesMlx ? "Kier's own" : usesExternalModel ? `your server, ${config.externalModel.protocol}` : 'Ollama'} (${config.model}), ${model ? 'answering' : 'not answering'}; search by meaning ${embedReady() ? (search ? 'answering' : 'installed, not answering') : 'not installed'}; second opinion ${secondInstalled() ? (await secondUp() ? 'answering' : 'installed, loads when needed') : 'not installed'}`,
    '',
    'Setup:',
    ...steps.map((s) => `  ${s.id}: ${s.status}`),
    '',
    'Sources (on or off; last read; how it went; added in the last day; kept in the last 30 days):',
  ]
  const runs = new Map(db.prepare('select source, ok, at, added, error from runs').all().map((r) => [r.source, r]))
  // Discord and other chat apps come in through the screen reader's run; the clipboard and apps have no run of their
  // own, so the newest item stands in for when they were last read.
  const RUN = { discord: 'screenchats', screen: 'screenchats' }
  for (const { id } of SOURCES) {
    const src = id === 'screen' ? 'chat' : id
    const r = runs.get(RUN[id] || id)
    const kept = count('select count(*) n from items where source = ? and ts > ?', src, now() - 30 * 86400)
    const added = count('select count(*) n from items where source = ? and ts > ?', src, day)
    const newest = db.prepare('select max(ts) ts from items where source = ?').get(src).ts
    lines.push(`  ${id}: ${off().includes(id) ? 'off' : 'on'}; ${r ? ago(r.at) : newest ? `newest item ${ago(newest)}` : 'nothing yet'}; ${!r ? '-' : r.ok ? 'ok' : `failed (${kindOf(r.error)})`}; ${added}; ${kept}`)
  }
  const fingerprinted = count('select count(*) n from vectors')
  lines.push(
    '',
    'Reading:',
    `  waiting to be read: ${count("select count(*) n from items i left join tags t on t.item_id = i.id where t.item_id is null and i.ts > ? and i.source in ('whatsapp', 'imessage', 'discord', 'chat', 'mail', 'notifications', 'social')", now() - 7 * 86400)} from the last week`,
    `  read in the last day: ${count('select count(*) n from tags where tagged_at > ?', day)}, of them tasks: ${count('select count(*) n from tags where tagged_at > ? and is_task = 1', day)}, doubted by the second opinion: ${count('select count(*) n from tags where tagged_at > ? and is_task = 1 and second is not null and second < 0.15', day)}`,
    `  open cards: ${count("select count(*) n from tags t left join task_state s on s.item_id = t.item_id where t.is_task = 1 and s.item_id is null")}`,
    `  messages searchable by meaning: ${fingerprinted}`,
    `  plans read: ${count('select count(*) n from plans')}`,
    '',
    'Trouble in the log, by kind (words left out):',
    ...(trouble().length ? trouble() : ['  none']),
  )
  return lines.join('\n')
}
