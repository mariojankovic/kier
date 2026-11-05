// Small JSON files read on hot paths (once per message or card): parsed again only when the file changes.
// Kier's own writers call forget() so a change is seen at once even within the same millisecond.
import { readFileSync, statSync } from 'node:fs'

const cache = new Map()

export function readJson(path) {
  const hit = cache.get(path)
  // Checked against the disk at most once a second; Kier's own writes forget the entry immediately.
  if (hit && performance.now() - hit.checked < 1000) return structuredClone(hit.value)
  let stamp
  try { const s = statSync(path); stamp = `${s.mtimeMs}:${s.size}:${s.ino}` } catch { cache.delete(path); throw Error('FILE_MISSING') }
  if (hit && hit.stamp === stamp) { hit.checked = performance.now(); return structuredClone(hit.value) }
  const value = JSON.parse(readFileSync(path, 'utf8'))
  cache.set(path, { stamp, value, checked: performance.now() })
  return structuredClone(value)
}

export const forget = (path) => cache.delete(path)
