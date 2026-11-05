import { failure } from './errors.mjs'
import { execFile } from './child-process.mjs'
import { fileURLToPath } from 'node:url'
import * as ai from '../collectors/ai.mjs'
import * as browser from '../collectors/browser.mjs'
import * as calendar from '../collectors/calendar.mjs'
import * as calls from '../collectors/calls.mjs'
import * as downloads from '../collectors/downloads.mjs'
import * as git from '../collectors/git.mjs'
import * as mcp from '../collectors/mcp.mjs'
import * as gmail from '../collectors/gmail.mjs'
import * as mail from '../collectors/mail.mjs'
import * as imessage from '../collectors/imessage.mjs'
import * as notifications from '../collectors/notifications.mjs'
import * as screenchats from '../collectors/screenchats.mjs'
import { dropCopies, NeedsAccess } from '../collectors/util.mjs'
import * as whatsapp from '../collectors/whatsapp.mjs'
import { open, recordRun } from './db.mjs'
import { isOff } from './settings.mjs'

// screenchats reads what Eyes captured on screen, so it runs after everything else.
export const collectors = [whatsapp, imessage, mail, gmail, mcp, calls, calendar, notifications, browser, downloads, ai, git, screenchats]

// A collector that fails (no permission, app not installed) never stops the others.
export async function collectAll(db, only) {
  const report = {}
  for (const c of collectors) {
    if (only && !only.includes(c.source)) continue
    // Discord comes from what's read on screen; switched off, its conversations aren't put together any more.
    if (isOff(c.source === 'screenchats' ? 'discord' : c.source)) continue
    try {
      const added = await c.collect(db)
      recordRun(db, c.source, { ok: true, added })
      report[c.source] = added
    } catch (e) {
      const error = failure(e instanceof NeedsAccess ? 'ACCESS_REQUIRED' : 'COLLECT_FAILED').message
      recordRun(db, c.source, { ok: false, error })
      report[c.source] = error
    }
  }
  return report
}

// Collectors block while they copy databases (or while macOS shows a permission prompt), so the daemon runs
// them in a child process and the timeline stays responsive. The child keeps Kier as its responsible app.
const SCRIPT = fileURLToPath(new URL('../bin/kier.mjs', import.meta.url))
export async function collectInChild(only) {
  // Gmail is asynchronous and needs the native parent's private channel.
  let gmailReport = {}
  if ((!only || only.includes('gmail')) && process.env.KIER_NATIVE_VAULT === '1') {
    const db = open()
    try { gmailReport = await collectAll(db, ['gmail']) } finally { db.close() }
  }
  const selected = (only || collectors.map(c => c.source)).filter(s => s !== 'gmail')
  return { ...await collectLocal(selected), ...gmailReport }
}
const collectLocal = (only) => new Promise((resolve) => {
  const args = ['--disable-warning=ExperimentalWarning', SCRIPT, 'collect', '--json', ...(only ? [`--only=${only.join(',')}`] : [])]
  execFile(process.execPath, args, { timeout: 10 * 60_000 }, (err, stdout) => {
    dropCopies()
    if (err) return resolve({ error: failure(err.killed ? 'COLLECT_TIMEOUT' : 'COLLECT_FAILED').message })
    try { resolve(JSON.parse(stdout)) } catch { resolve({ error: 'COLLECT_REPORT_INVALID' }) }
  })
})
