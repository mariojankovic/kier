import { chmodSync, copyFileSync, existsSync, readdirSync, rmSync, statSync } from 'node:fs'
import { resolve } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { tmpDir } from '../lib/config.mjs'

export const APPLE_EPOCH = 978_307_200

export class NeedsAccess extends Error {}

// The private copies are whole chat databases, so they don't outlive the read: after a collect,
// and when the daemon starts, every copy made more than half a minute ago goes. Only those, so a copy another reader
// has just made stays.
export function dropCopies() {
  const before = Date.now() - 30_000
  for (const f of readdirSync(tmpDir)) {
    if (!/\.sqlite(-wal|-shm)?$/.test(f)) continue
    const p = resolve(tmpDir, f)
    try { if (statSync(p).birthtimeMs < before) rmSync(p, { force: true }) } catch {}
  }
}

// Apps keep their databases open and mid-write, so read a private copy (with its WAL) instead of the live file.
export function snapshot(path, name) {
  if (!existsSync(path)) throw Error(`${path} not found`)
  const dest = resolve(tmpDir, `${name}.sqlite`)
  try {
    for (const ext of ['', '-wal', '-shm']) {
      rmSync(dest + ext, { force: true })
      if (existsSync(path + ext)) { copyFileSync(path + ext, dest + ext); chmodSync(dest + ext, 0o600) }
    }
  } catch (e) {
    if (e.code === 'EPERM' || e.code === 'EACCES') throw new NeedsAccess('needs Full Disk Access')
    throw e
  }
  const db = new DatabaseSync(dest)
  return { db, close: () => { db.close(); for (const ext of ['', '-wal', '-shm']) rmSync(dest + ext, { force: true }) } }
}

export const minutes = (s) => (s >= 60 ? `${Math.round(s / 60)} min` : `${Math.round(s)} s`)
