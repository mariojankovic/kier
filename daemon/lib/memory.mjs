// Pause background reading under memory pressure, with longer backoff after repeated warnings.
// Foreground questions remain available while background work waits.
import { execFileSync } from './child-process.mjs'

let level = 1
let readAt = 0
let until = 0
let strikes = 0
let lastStrike = 0
let backedOff = 0

// macOS's own reading: 1 fine, 2 warning, 4 critical. Read at most every few seconds; the loops all ask.
export function pressure(at = Date.now()) {
  if (at - readAt > 5000) {
    readAt = at
    try { level = Number(execFileSync('sysctl', ['-n', 'kern.memorystatus_vm_pressure_level'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim()) || 1 } catch { level = 1 }
  }
  return level
}

// { ok, note }: the note says what changed, once, for the log.
export function roomy(at = Date.now(), now = pressure(at)) {
  if (at < until) return { ok: false }
  if (now > 1) {
    if (at - lastStrike > 3600_000) strikes = 0
    strikes++
    backedOff++
    lastStrike = at
    const minutes = Math.min(30, 5 * 2 ** (strikes - 1))
    until = at + minutes * 60_000
    return { ok: false, note: `the Mac is short of memory: background reading waits ${minutes} min` }
  }
  return { ok: true, note: until ? (until = 0, 'memory is fine again: background reading goes on') : undefined }
}

// For the diagnostics report: the reading now, how often reading waited since the daemon started, and for how long still.
export const memoryState = (at = Date.now()) => ({ level: pressure(at), backedOff, waiting: until > at ? Math.ceil((until - at) / 60_000) : 0 })
