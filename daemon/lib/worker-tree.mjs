// Runs in the separate guard, never on the daemon's event loop. ps output is
// consumed in memory only; process arguments and environments are never logged.
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
const exec = promisify(execFile)
const ps = async args => (await exec('/bin/ps', args, { env: { PATH: '/usr/bin:/bin', LC_ALL: 'C' }, timeout: 2000, maxBuffer: 16 * 1024 * 1024 })).stdout

export function processRows(output) {
  return String(output).trim().split('\n').flatMap(line => {
    const m = line.trim().match(/^(\d+)\s+(\d+)\s+(\d+)\s+(.+)$/)
    return m ? [{ pid: Number(m[1]), parent: Number(m[2]), uid: Number(m[3]), born: m[4] }] : []
  })
}
export function descendantRows(rows, root, known = new Map()) {
  const found = new Map(rows.filter(r => r.pid === root || known.get(r.pid) === r.born).map(r => [r.pid, r]))
  let changed = true
  while (changed) {
    changed = false
    for (const row of rows) if (!found.has(row.pid) && found.has(row.parent)) { found.set(row.pid, row); changed = true }
  }
  return [...found.values()]
}
export class WorkerTree {
  constructor(root, tag) { this.root = root; this.tag = tag; this.known = new Map(); this.started = Date.now() - 1000 }
  async scan({ orphans = false } = {}) {
    const rows = processRows(await ps(['-axo', 'pid=,ppid=,uid=,lstart='])).filter(r => r.uid === process.getuid() && r.pid !== process.pid)
    const found = descendantRows(rows, this.root, this.known)
    if (orphans) {
      // Detached double-forks may have already been reparented before a tree scan.
      // Match the full random marker, not names or server-supplied process IDs.
      const candidates = rows.filter(r => r.parent === 1 && !this.known.has(r.pid)
        && (!Number.isFinite(Date.parse(r.born)) || Date.parse(r.born) >= this.started))
      for (let i = 0; i < candidates.length; i += 64) {
        const batch = candidates.slice(i, i + 64)
        let output = ''
        try { output = await ps(['eww', '-p', batch.map(r => r.pid).join(','), '-o', 'pid=,command=']) } catch {}
        for (const line of output.split('\n')) {
          if (!line.includes(`KIER_WORKER_TAG=${this.tag}`)) continue
          const pid = Number(line.trim().match(/^\d+/)?.[0])
          const row = batch.find(r => r.pid === pid)
          if (row) found.push(row)
        }
      }
    }
    for (const row of found) this.known.set(row.pid, row.born)
    return descendantRows(rows, this.root, this.known)
  }
  async signal(signal) {
    let rows = []
    try { rows = await this.scan({ orphans: true }) } catch {}
    // Children first. Recheck birth identities on each scan to avoid stale PID kills.
    for (const row of rows.reverse()) { try { process.kill(row.pid, signal) } catch {} }
    try { process.kill(-this.root, signal) } catch {}
  }
}
