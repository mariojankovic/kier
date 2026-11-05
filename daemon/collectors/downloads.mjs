import { readdirSync, statSync } from 'node:fs'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { config, home } from '../lib/config.mjs'
import { addItems, cursor, now, setCursor } from '../lib/db.mjs'

// Only names and sizes; file contents are never read.
export const source = 'downloads'
const DIR = resolve(home, 'Downloads')
const size = (b) => (b > 1e9 ? `${(b / 1e9).toFixed(1)} GB` : b > 1e6 ? `${(b / 1e6).toFixed(1)} MB` : `${Math.ceil(b / 1e3)} KB`)

export function collect(db) {
  const since = Number(cursor(db, source, now() - config.backfillDays * 86400))
  let newest = since
  const items = []
  for (const e of readdirSync(DIR, { withFileTypes: true })) {
    if (e.name.startsWith('.') || /\.(crdownload|download|part)$/.test(e.name)) continue
    const path = resolve(DIR, e.name)
    let st
    try { st = statSync(path) } catch { continue }
    const ts = Math.floor(st.birthtimeMs / 1000)
    if (ts <= since) continue
    newest = Math.max(newest, ts)
    items.push({
      id: `${source}:${e.name}:${ts}`, source, thread: 'Downloads', sender: config.me, fromMe: true, ts,
      text: `Downloaded ${e.name}${e.isDirectory() ? ' (folder)' : ` (${size(st.size)})`}`, url: pathToFileURL(path).href,
    })
  }
  const added = addItems(db, items)
  setCursor(db, source, newest)
  return added
}
