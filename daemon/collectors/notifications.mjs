import { permitsItem } from '../lib/app-permissions.mjs'
import { execFileSync } from '../lib/child-process.mjs'
import { basename, resolve } from 'node:path'
import { appKinds } from '../lib/apps.mjs'
import { parseBplist } from '../lib/bplist.mjs'
import { config, home } from '../lib/config.mjs'
import { addItems } from '../lib/db.mjs'
import { redact } from '../lib/redact.mjs'
import { APPLE_EPOCH, snapshot } from './util.mjs'

// Every notification any app shows on this Mac: Viber, Messenger or Discord in the browser, Slack, mail.
// That makes it the one capture route for apps with no readable data of their own. Notification Center keeps
// only what hasn't been dismissed, so this runs every 30 seconds instead of every 5 minutes.
export const source = 'notifications'
const PATH = resolve(home, 'Library/Group Containers/group.com.apple.usernoted/db2/db')

// Kier's own, and apps whose data Kier reads directly from their database, where each message comes with its chat
// around it. App ids are compared in lower case: WhatsApp reports itself as net.whatsapp.whatsapp, and the mixed case
// spelling here let its notifications in as context-free duplicates.
const SKIP = new Set(['com.getkier.kier', 'net.whatsapp.whatsapp', 'com.apple.mobilesms', 'com.apple.ical', 'com.apple.reminders', ...(config.notificationSkip || [])]
  .map((id) => id.toLowerCase()))
export const skipNotificationApp = (id) => SKIP.has(String(id).toLowerCase())
// Kinds of app whose notifications are kept for search but never turned into tasks.
const QUIET = new Set(['developer', 'system', 'media'])

const names = new Map()
function appName(id) {
  if (!names.has(id)) {
    let name = id.split('.').filter((p) => !['com', 'app', 'desktop', 'setapp', 'mac'].includes(p)).pop() || id
    const safe = id.replace(/[^\w.-]/g, '')
    try {
      const path = execFileSync('mdfind', [`kMDItemCFBundleIdentifier == "${safe}"`], { encoding: 'utf8', timeout: 3000, stdio: ['ignore', 'pipe', 'ignore'] }).split('\n')[0]
      if (path) name = basename(path, '.app')
      // Spotlight doesn't index Setapp apps; Launch Services still knows their names.
      else name = execFileSync('osascript', ['-e', `name of application id "${safe}"`], { encoding: 'utf8', timeout: 3000, stdio: ['ignore', 'pipe', 'ignore'] }).trim() || name
    } catch {}
    names.set(id, name)
  }
  return names.get(id)
}

export function collect(db) {
  const nc = snapshot(PATH, source)
  try {
    const rows = nc.db.prepare(`select r.uuid, r.data, r.delivered_date, a.identifier app from record r join app a on a.app_id = r.app_id
      where r.delivered_date is not null`).all()
    const items = []
    const kinds = appKinds(db)
    for (const r of rows) {
      const kind = kinds.get(r.app)
      // Banking, password and health apps are never read, not even their notifications.
      if (!permitsItem({ source, meta: { app: r.app } }) || skipNotificationApp(r.app) || kind?.route === 'never') continue
      let p
      try { p = parseBplist(r.data) } catch { continue }
      const req = p.req || {}
      // Some apps send localised titles as a dictionary instead of text; those parts are skipped.
      const str = (v) => (typeof v === 'string' ? v.trim() : '')
      const title = str(req.titl)
      const body = str(req.body)
      if (!title && !body) continue
      // The brief's own notification is posted through osascript, so macOS files it under Script Editor.
      if (r.app === 'com.apple.scripteditor2' && /^Kier$/.test(title)) continue
      // GitHub mail about your own repositories ("[owner/repo] PR run failed", bot reviews) is automated: kept for
      // search, never a task. A person asking you something on GitHub writes from their own name, so this is narrow.
      const automated = /\[[\w.-]+\/[\w.-]+\]/.test(`${title} ${str(req.subt)} ${body}`) || /\[bot\]$/i.test(title)
      const sub = str(req.subt)
      const { text, found } = redact(`${title}${sub ? ` (${sub})` : ''}${body ? `: ${body}` : ''}`)
      items.push({
        id: `${source}:${Buffer.from(r.uuid).toString('hex')}`, source, thread: appName(r.app), sender: title || appName(r.app), fromMe: false,
        ts: Math.floor(r.delivered_date + APPLE_EPOCH), text,
        meta: { app: r.app, conversation: req.thre || null, ...((QUIET.has(kind?.kind) || automated) && { quiet: true }), ...(found.length && { redacted: found }) },
      })
    }
    return addItems(db, items)
  } finally {
    nc.close()
  }
}
