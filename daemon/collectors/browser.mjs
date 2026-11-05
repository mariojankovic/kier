import { existsSync, readdirSync } from 'node:fs'
import { resolve } from 'node:path'
import { config, home } from '../lib/config.mjs'
import { localDate } from '../lib/dates.mjs'
import { addItems, cursor, now, setCursor } from '../lib/db.mjs'
import { NeedsAccess, snapshot } from './util.mjs'

// Every browser on this Mac, in every profile, not just one: the Chromium family keeps the same History database in
// each profile folder, Safari and Firefox have their own. Each keeps its own place, so a second browser is read once.
export const source = 'browser'
const SUPPORT = resolve(home, 'Library/Application Support')
const CHROME_EPOCH = 11_644_473_600
const SAFARI_EPOCH = 978_307_200
export const CHROMIUM = [['Helium', 'net.imput.helium'], ['Chrome', 'Google/Chrome'], ['Arc', 'Arc/User Data'], ['Brave', 'BraveSoftware/Brave-Browser'],
  ['Edge', 'Microsoft Edge'], ['Vivaldi', 'Vivaldi'], ['Opera', 'com.operasoftware.Opera'], ['Dia', 'Dia/User Data'], ['Chromium', 'Chromium']]

// Link shorteners and redirect hops would show every click twice.
const HOPS = ['t.co', 'l.facebook.com', 'lm.facebook.com', 'l.instagram.com', 'out.reddit.com', 'lnkd.in', 'bit.ly']
const skip = (u) =>
  !/^https?:/.test(u.protocol) || ['localhost', '127.0.0.1', ...HOPS].includes(u.hostname) ||
  (u.hostname.startsWith('www.google.') && u.pathname === '/url') ||
  config.blockedDomains.some((d) => u.hostname === d || u.hostname.endsWith(`.${d}`))

const dirs = (base) => { try { return readdirSync(base, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name) } catch { return [] } }

// The history files there are: each with a key for its place, the way it counts time, and its query.
function histories() {
  const out = []
  for (const [name, dir] of CHROMIUM) {
    const base = resolve(SUPPORT, dir)
    // Most keep one folder per profile; Opera keeps its history at the top.
    const profiles = existsSync(resolve(base, 'History')) ? [''] : dirs(base).filter((d) => d === 'Default' || /^Profile \d+$/.test(d))
    for (const p of profiles) {
      const path = resolve(base, p, 'History')
      if (!existsSync(path)) continue
      // Helium's default profile keeps the key and ids it always had, so nothing already kept comes in twice.
      const legacy = name === 'Helium' && p === 'Default'
      const slug = `${name}-${p || 'default'}`.toLowerCase().replace(/[^a-z0-9]+/g, '-')
      out.push({ name, path, key: legacy ? source : `${source}:${slug}`, prefix: legacy ? '' : `${slug}:`, epoch: CHROME_EPOCH, scale: 1000000,
        sql: `select u.id, u.url, u.title, v.visit_time / 1000000 - ${CHROME_EPOCH} ts, cast(v.visit_time as text) t
          from visits v join urls u on u.id = v.url where v.visit_time > cast(? as integer) order by v.visit_time` })
    }
  }
  const safari = resolve(home, 'Library/Safari/History.db')
  if (existsSync(safari)) {
    out.push({ name: 'Safari', path: safari, key: `${source}:safari`, prefix: 'safari:', epoch: -SAFARI_EPOCH, scale: 1,
      sql: `select i.id, i.url, v.title, cast(v.visit_time + ${SAFARI_EPOCH} as integer) ts, cast(v.visit_time as text) t
        from history_visits v join history_items i on i.id = v.history_item where v.visit_time > cast(? as real) order by v.visit_time` })
  }
  for (const p of dirs(resolve(SUPPORT, 'Firefox/Profiles'))) {
    const path = resolve(SUPPORT, 'Firefox/Profiles', p, 'places.sqlite')
    if (!existsSync(path)) continue
    const slug = `firefox-${p}`.toLowerCase().replace(/[^a-z0-9]+/g, '-')
    out.push({ name: 'Firefox', path, key: `${source}:${slug}`, prefix: `${slug}:`, epoch: 0, scale: 1000000,
      sql: `select p.id, p.url, p.title, v.visit_date / 1000000 ts, cast(v.visit_date as text) t
        from moz_historyvisits v join moz_places p on p.id = v.place_id where v.visit_date > cast(? as integer) order by v.visit_date` })
  }
  return out
}

function read(db, b) {
  const h = snapshot(b.path, b.key.replace(/[^a-z0-9]+/gi, '-'))
  try {
    // Chromium and Firefox count microseconds, past what a JS number holds exactly, so the cursor stays a string.
    const start = now() - config.backfillDays * 86400
    const since = cursor(db, b.key, b.scale === 1 ? String(start + b.epoch) : String(BigInt(start + b.epoch) * BigInt(b.scale)))
    const rows = h.db.prepare(b.sql).all(since)
    // One entry per page per day; a page read ten times on Tuesday is one memory.
    const items = new Map()
    for (const r of rows) {
      let u
      try { u = new URL(r.url) } catch { continue }
      if (skip(u)) continue
      const ts = Number(r.ts)
      const id = `${source}:${b.prefix}${r.id}:${localDate(ts).join('-')}`
      if (items.has(id)) { items.get(id).meta.visits++; continue }
      const query = /(^|\.)google\.[a-z.]+$/.test(u.hostname) && u.pathname === '/search' ? u.searchParams.get('q') : null
      items.set(id, {
        id, source, thread: u.hostname.replace(/^www\./, ''), sender: config.me, fromMe: true, ts,
        text: query ? `Searched Google: ${query}` : r.title || r.url, url: r.url, meta: { visits: 1, browser: b.name },
      })
    }
    const added = addItems(db, [...items.values()])
    if (rows.length) setCursor(db, b.key, rows.at(-1).t)
    return added
  } finally {
    h.close()
  }
}

export function collect(db) {
  const all = histories()
  let added = 0
  let blocked = 0
  for (const b of all) {
    try { added += read(db, b) } catch (e) { if (e instanceof NeedsAccess) blocked++ }
  }
  // Only when nothing at all could be read does setup need to ask for access.
  if (all.length && blocked === all.length) throw new NeedsAccess('needs Full Disk Access')
  return added
}
