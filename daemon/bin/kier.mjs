#!/usr/bin/env -S node --disable-warning=ExperimentalWarning
import { background } from '../lib/background.mjs'
import { initializeGmail } from '../lib/google.mjs'
import { readSecret, signedFetch } from '../lib/http-auth.mjs'
import { notify } from '../lib/notify.mjs'
import { syncCallbacks } from '../lib/callbacks.mjs'
import { sent } from '../lib/settings.mjs'
import { configureModelUsage } from '../lib/model-provider.mjs'
import { execFileSync } from '../lib/child-process.mjs'
import { mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { install, loaded, logPath, uninstall } from '../lib/agent.mjs'
import { collectAll, collectInChild } from '../lib/collect.mjs'
import { config, dataDir, home, tokenPath } from '../lib/config.mjs'
import { cursor, open, setCursor } from '../lib/db.mjs'
import { discover } from '../lib/apps.mjs'
import { purgeAdult } from '../lib/privacy.mjs'
import { warm as warmHandoffs } from '../lib/handoff.mjs'
import { build as buildProfile, due as profileDue, isBuilding as profileBuilding } from '../lib/profile.mjs'
import { mergeSame } from '../lib/merge.mjs'
import { checkStalled } from '../lib/stalled.mjs'
import { doubleCheck } from '../lib/doublecheck.mjs'
import { checkHeadsUps } from '../lib/headsup.mjs'
import { explainAsks, resolvePending, resolveWaiting } from '../lib/resolve.mjs'
import { logTo as secondLog } from '../lib/second.mjs'
import { prerender, speak, sweepSpeechFiles } from '../lib/speak.mjs'
import { dropCopies } from '../collectors/util.mjs'
import { startRuntime } from '../lib/runtime.mjs'
import { indexPending } from '../lib/meaning.mjs'
import { roomy } from '../lib/memory.mjs'
import { readPending } from '../lib/plans.mjs'
import { CHROMIUM } from '../collectors/browser.mjs'
import { serve } from '../lib/server.mjs'
import { fullDiskAccess, steps } from '../lib/setup.mjs'
import { quietElsewhere, excludeSenderPromises, excludeUnaddressedGroups, excludeReminderNotices, tagPending } from '../lib/tagger.mjs'
import { brief, briefMoment, briefText, moments, today } from '../lib/tasks.mjs'

import { errorRecord } from '../lib/errors.mjs'
// Model work waits while the Mac is short of memory (memory.mjs).
function room() {
  const r = roomy()
  if (r.note) console.log(stamp(), r.note)
  return r.ok
}

// Search by meaning (meaning.mjs): 32 messages at a time with a pause between, so the first index of a vault takes a
// quarter of an hour in the background instead of minutes flat out, and the runtime is never busy for more than a
// moment; after that, whatever arrives, once a minute.
async function indexForSearch() {
  let done = 0
  for (;;) {
    if (!room()) { await new Promise((r) => setTimeout(r, 60_000)); continue }
    // The runtime starts alongside the daemon: until it answers, a quick retry rather than a minute's wait.
    const n = await indexPending(db, 32).catch((e) => { console.log(stamp(), 'search index', errorRecord('BACKGROUND_FAILED')); return -1 })
    if (n > 0) done += n
    if ((n > 0 && done % 1024 < n) || (!n && done)) { console.log(stamp(), 'search index', done); if (!n) done = 0 }
    await new Promise((r) => setTimeout(r, n > 0 ? 2000 : n < 0 ? 10_000 : 60_000))
  }
}

// Plans agreed in chats (plans.mjs): the whole vault once, newest first, then new messages as they settle. A few at a
// time with pauses between, so a question asked meanwhile waits seconds at most.
async function readPlans() {
  let done = 0
  for (;;) {
    if (!room()) { await new Promise((r) => setTimeout(r, 60_000)); continue }
    const n = await readPending(db, 4).catch((e) => { console.log(stamp(), 'plans', errorRecord('BACKGROUND_FAILED')); return -1 })
    if (n > 0) done += n
    if (!n && done) { console.log(stamp(), 'plans read', done); done = 0 }
    await new Promise((r) => setTimeout(r, n > 0 ? 3000 : n < 0 ? 30_000 : 60_000))
  }
}

// Kier 0.3.4 set up a browser extension's helper in every Chromium browser and copied the extension into the vault;
// the extension is shelved (branch chrome-extension) and Kier stays all local, so whatever 0.3.4 left goes again.
function removeExtension() {
  const support = resolve(home, 'Library/Application Support')
  for (const [, dir] of CHROMIUM) rmSync(resolve(support, dir, 'NativeMessagingHosts/com.getkier.kier.json'), { force: true })
  for (const left of ['extension', 'native-host', 'extension-seen', 'inbox']) rmSync(resolve(dataDir, left), { recursive: true, force: true })
}

const [cmd = 'help', ...args] = process.argv.slice(2)
const db = open()
// The adapter hands over a byte count, never the prompt: what went to a model server off this Mac, for "Sent to the cloud".
configureModelUsage(({ bytes } = {}) => { if (bytes > 0) db.prepare("insert into outbound (ts, kind, agent, bytes) values (?, 'inference', 'your-model', ?)").run(Math.floor(Date.now() / 1000), Math.floor(bytes)) })
const stamp = () => new Date().toTimeString().slice(0, 8)
const url = `http://127.0.0.1:${config.port}`


function writeBrief(send) {
  const text = briefText(brief(db))
  const dir = resolve(dataDir, 'briefs')
  mkdirSync(dir, { recursive: true })
  writeFileSync(resolve(dir, `${today()}-${new Date().getHours()}.txt`), text)
  // A fortnight of them, no more: they quote the chats.
  const keep = new Date(Date.now() - 14 * 86400_000).toISOString().slice(0, 10)
  for (const f of readdirSync(dir)) if (f.slice(0, 10) < keep) rmSync(resolve(dir, f), { force: true })
  // Under Kier.app the island shows it (tasks.mjs moments); on its own, the daemon still sends a notification.
  if (send && process.env.KIER_APP) moments.brief = briefMoment(brief(db))
  else if (send) notify(text)
  return text
}

async function run() {
  // Fail before any worker, collector, maintenance or launcher starts.
  await serve(db, { install })
  await sweepSpeechFiles()
  // Reminders already have a direct source; their alerts must never create another task.
  excludeReminderNotices(db)
  // Set the forward-only callback boundary before backfill or the brief becomes visible.
  syncCallbacks(db)
  // Started by Kier.app: when macOS quits the app (as it does after a permission change) this process is left
  // behind holding the port, and every new start fails. It goes with the app.
  if (process.env.KIER_APP) setInterval(() => { if (process.ppid === 1) process.exit(0) }, 5000).unref()
  if (process.env.KIER_NATIVE_VAULT === '1') await initializeGmail().catch(() => console.log(stamp(), 'Gmail native storage unavailable'))
  dropCopies()
  removeExtension()
  startRuntime((line) => console.log(stamp(), line))
  console.log(`${stamp()} timeline on ${url}`)
  // Adult items saved before the filter existed, or before their site joined the list.
  const purged = purgeAdult(db)
  if (purged) console.log(stamp(), `removed ${purged} adult items`)
  secondLog((line) => console.log(stamp(), line))
  // Open cards asked of someone else by @-mention, read before that rule, wait under Maybe yours. Once.
  if (!cursor(db, 'tagger-elsewhere', null)) { console.log(stamp(), 'asked of someone else', quietElsewhere(db)); setCursor(db, 'tagger-elsewhere', 1) }
  if (!cursor(db, 'tagger-called', null)) { console.log(stamp(), 'called someone else by name', quietElsewhere(db)); setCursor(db, 'tagger-called', 1) }
  // Clear promises by other senders never belong on the owner's task list.
  if (!cursor(db, 'tagger-sender-promises-v2', null)) { console.log(stamp(), 'sender promises', excludeSenderPromises(db)); setCursor(db, 'tagger-sender-promises-v2', 1) }
  if (!cursor(db, 'tagger-unaddressed-groups', null)) { console.log(stamp(), 'unaddressed groups', excludeUnaddressedGroups(db)); setCursor(db, 'tagger-unaddressed-groups', 1) }
  let lastCollect = 0
  let lastNotes = 0
  let lastRender = 0
  let lastStalled = 0
  let lastAhead = 0
  let lastDeep = 0
  let nextDiscover = Date.now() + 30_000
  let waiting = false
  const sent = new Set()
  const report = () => console.log(stamp(), errorRecord('BACKGROUND_FAILED'))
  background(indexForSearch, { report, retry: true })
  background(readPlans, { report, retry: true })
  for (;;) {
    try {
    // What each installed app is for: daily, and every 10 minutes while some still wait for d1.
    if (Date.now() > nextDiscover) {
      const d = await discover(db).catch((e) => ({ error: errorRecord('BACKGROUND_FAILED') }))
      console.log(stamp(), 'apps', JSON.stringify(d))
      nextDiscover = Date.now() + (d.waiting || d.error ? 10 * 60_000 : 24 * 3600_000)
    }
    // Notifications disappear when dismissed, so they're read every 30 seconds.
    if (lastCollect && Date.now() - lastNotes > 30_000 && fullDiskAccess()) {
      const n = await collectInChild(['notifications'])
      if (n.notifications) console.log(stamp(), 'notifications', JSON.stringify(n))
      lastNotes = Date.now()
    }
    if (Date.now() - lastCollect > 5 * 60_000) {
      // Without Full Disk Access every read would raise its own macOS prompt, so wait for the one switch.
      if (!fullDiskAccess()) {
        if (!waiting) console.log(stamp(), `waiting for Full Disk Access, see ${url}/setup`)
        waiting = true
        await collectInChild(['gmail', 'mcp'])
        lastCollect = Date.now()
      } else {
        waiting = false
        console.log(stamp(), 'collect', JSON.stringify(await collectInChild()))
        lastCollect = Date.now()
      }
    }
    const hm = new Date().toTimeString().slice(0, 5)
    if (config.briefTimes.includes(hm) && !sent.has(`${today()} ${hm}`)) {
      sent.add(`${today()} ${hm}`)
      writeBrief(true)
      // Off unless the owner turns it on: a voice at 08:00 is lovely at home and awkward in a meeting.
      if (config.speakBrief && hm === config.briefTimes[0]) background(() => speak(db), { report })
      console.log(stamp(), 'brief sent')
    }
    // Call history is deterministic and should stay current even while the model waits for memory.
    syncCallbacks(db)
    // Everything from here reads with the model, which waits while the Mac is short of memory.
    if (!room()) { await new Promise((r) => setTimeout(r, 30_000)); continue }
    const t = await tagPending(db, { limit: 10 })
    syncCallbacks(db)
    if (t.tagged || t.checked || t.error) console.log(stamp(), 'tag', JSON.stringify(t))
    // The open cards' hand-offs are worked out ahead, on every pass, so the menu is ready when you open it.
    { const b = brief(db); warmHandoffs(db, [...b.forgotten, ...b.today.tasks, ...b.open].slice(0, 12).map((c) => c.id)).catch(() => {}) }
    // Learn who the owner is on the first run, and again each week, while nothing new waits to be read.
    if (!t.tagged && profileDue() && !profileBuilding()) buildProfile(db).then(() => console.log(stamp(), 'profile updated')).catch((e) => console.log(stamp(), 'profile', errorRecord('BACKGROUND_FAILED')))
    // Keep the spoken brief rendered, so pressing play is instant.
    if (!t.tagged && Date.now() - lastRender > 10 * 60_000) { lastRender = Date.now(); background(() => prerender(db), { report }) }
    // With nothing new to read, see whether open tasks got done in the meantime.
    // Busy: only cards you've just answered; quiet: anything due for a look.
    const done = await resolvePending(db, t.tagged || t.checked ? 2 : 4, { answered: !!(t.tagged || t.checked) }).catch((e) => ({ error: errorRecord('BACKGROUND_FAILED') }))
    // And whether what you asked others for has arrived.
    if (!t.tagged && !t.checked && !done.checked) {
      const w = await resolveWaiting(db).catch((e) => ({ error: errorRecord('BACKGROUND_FAILED') }))
      if (w.resolved || w.error) console.log(stamp(), 'waiting', JSON.stringify(w))
      // And make an AI's unanswered question readable on its own.
      const x = await explainAsks(db).catch((e) => ({ error: errorRecord('BACKGROUND_FAILED') }))
      if (x.explained || x.error) console.log(stamp(), 'explain', JSON.stringify(x))
    }
    if (done.resolved || done.error) console.log(stamp(), 'resolve', JSON.stringify(done))
    // New cards are compared with the open ones from the same chat, so one piece of work stays one card.
    const merged = await mergeSame(db).catch((e) => ({ error: errorRecord('BACKGROUND_FAILED') }))
    if (merged.merged || merged.error) console.log(stamp(), 'merge', JSON.stringify(merged))
    // Every few minutes, what AI sessions left unfinished: pull requests still open, changes never committed.
    if (Date.now() - lastStalled > 5 * 60_000) {
      lastStalled = Date.now()
      const stalled = await checkStalled(db).catch((e) => ({ error: errorRecord('BACKGROUND_FAILED') }))
      if (stalled.stalled || stalled.closed || stalled.error) console.log(stamp(), 'stalled', JSON.stringify(stalled))
    }
    // Tomorrow's events and dated tasks get one question each: worth a heads-up today? (headsup.mjs)
    if (!t.tagged && Date.now() - lastAhead > 10 * 60_000) {
      lastAhead = Date.now()
      const a = await checkHeadsUps(db).catch((e) => ({ error: errorRecord('BACKGROUND_FAILED') }))
      if (a.checked || a.error) console.log(stamp(), 'heads-up', JSON.stringify(a))
    }
    // A card the done-check couldn't settle, with commits after it, gets one look from the owner's Claude. It takes
    // half a minute, so it runs alongside rather than holding up the pass.
    if (Date.now() - lastDeep > 10 * 60_000) {
      lastDeep = Date.now()
      doubleCheck(db).then((r) => { if (r.checked) console.log(stamp(), 'claude check', JSON.stringify(r)) })
        .catch((e) => console.log(stamp(), 'claude check', errorRecord('BACKGROUND_FAILED')))
    }
    // Busy while there is a backlog, idle otherwise.
    await new Promise((r) => setTimeout(r, t.tagged || t.checked || done.checked ? 500 : 30_000))
    } catch { report(); await new Promise(r => setTimeout(r, 1000)) }
  }
}

// What double-clicking Kier.app does: make sure the agent runs, then show setup until it's finished.
async function openApp() {
  if (!loaded()) install()
  // Read the owner's secret locally; a fresh nonce proves the listener before any browser launch.
  const token = () => readSecret(tokenPath)
  let ready = false
  for (let i = 0; i < 40; i++) {
    try { if ((await signedFetch(token(), `${url}/api/status`)).ok) { ready = true; break } } catch {}
    await new Promise((r) => setTimeout(r, 250))
  }
  if (!ready) throw Error('DAEMON_UNAVAILABLE')
  const todo = (await steps(db)).some((s) => s.status === 'todo' && s.action)
  // Inside Kier.app the page opens in Kier's own window; from a terminal, in the browser.
  if (process.env.KIER_APP) console.log(todo ? '/setup' : '/')
  else {
    const response = await signedFetch(token(), `${url}/api/browser-ticket`, { method: 'POST' })
    if (!response.ok) throw Error('BROWSER_BOOTSTRAP_FAILED')
    const { ticket } = await response.json()
    execFileSync('/usr/bin/open', [`${url}${todo ? '/setup' : '/'}#bootstrap=${encodeURIComponent(ticket)}`], { stdio: 'ignore' })
  }
}

// Counts and table structure only, never message text. Run it as the app (`open -a Kier --args diag`)
// so it has Kier's Full Disk Access; the report lands in diag.json.
async function diag() {
  const { snapshot } = await import('../collectors/util.mjs')
  const { home } = await import('../lib/config.mjs')
  const sources = {
    imessage: ['Library/Messages/chat.db', [
      "select count(*) total, sum(text is null) no_text, sum(text is null and attributedBody is not null) body_only, datetime(max(date) / 1e9 + (9783072 * 100), 'unixepoch') newest from message",
      "select count(*) last_30_days from message where date / 1e9 + (9783072 * 100) > strftime('%s', 'now', '-30 days')",
      'select associated_message_type, item_type, count(*) n from message group by 1, 2 order by n desc limit 6',
    ]],
    calls: ['Library/Application Support/CallHistoryDB/CallHistory.storedata', [
      'select ZSERVICE_PROVIDER, ZORIGINATED, ZANSWERED, sum(ZDURATION = 0) zero_seconds, count(*) n from ZCALLRECORD group by 1, 2, 3',
    ]],
    calendar: ['Library/Group Containers/group.com.apple.calendar/Calendar.sqlitedb', [
      "select group_concat(name, ' ') columns from pragma_table_info('CalendarItem')",
      'select entity_type, count(*) n from CalendarItem group by 1',
    ]],
    notifications: ['Library/Group Containers/group.com.apple.usernoted/db2/db', [
      "select group_concat(name, ' ') tables from sqlite_master where type = 'table'",
      "select group_concat(name, ' ') record_columns from pragma_table_info('record')",
      "select group_concat(name, ' ') app_columns from pragma_table_info('app')",
      "select count(*) records, datetime(min(delivered_date) + (9783072 * 100), 'unixepoch') oldest, datetime(max(delivered_date) + (9783072 * 100), 'unixepoch') newest from record",
      'select a.identifier, count(*) n from record r join app a on a.app_id = r.app_id group by 1 order by n desc limit 25',
      'select hex(substr(data, 1, 8)) magic, length(data) bytes from record limit 1',
    ]],
  }
  const report = {}
  for (const [name, [path, queries]] of Object.entries(sources)) {
    try {
      const s = snapshot(resolve(home, path), `diag-${name}`)
      try { report[name] = queries.map((q) => { try { return s.db.prepare(q).all() } catch (e) { return errorRecord('BACKGROUND_FAILED') } }) } finally { s.close() }
    } catch (e) {
      report[name] = errorRecord('BACKGROUND_FAILED')
    }
  }
  // Shape of a notification record: key names, value types and lengths only, never the text.
  try {
    const { parseBplist } = await import('../lib/bplist.mjs')
    const s = snapshot(resolve(home, 'Library/Group Containers/group.com.apple.usernoted/db2/db'), 'diag-notes')
    try {
      const shape = (v) => v == null ? 'null' : typeof v === 'string' ? `string(${v.length})` : Buffer.isBuffer(v) ? `data(${v.length})`
        : v instanceof Date ? 'date' : Array.isArray(v) ? `array(${v.length})` : typeof v === 'object' ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, shape(x)])) : typeof v
      report.notification_shape = s.db.prepare('select data from record order by delivered_date desc limit 3').all().map((r) => shape(parseBplist(r.data)))
    } finally { s.close() }
  } catch (e) {
    report.notification_shape = errorRecord('BACKGROUND_FAILED')
  }
  // Does the attributedBody decoder find text in messages that only have the newer format?
  try {
    const { bodyText } = await import('../collectors/imessage.mjs')
    const s = snapshot(resolve(home, 'Library/Messages/chat.db'), 'diag-body')
    try {
      const bodies = s.db.prepare('select attributedBody b from message where text is null and attributedBody is not null').all().map((r) => bodyText(r.b))
      report.imessage_decoder = { tried: bodies.length, decoded: bodies.filter((t) => t && t.trim()).length, odd_bytes: bodies.filter((t) => t && /�/.test(t)).length }
    } finally { s.close() }
  } catch (e) {
    report.imessage_decoder = errorRecord('BACKGROUND_FAILED')
  }
  // Are the unnamed callers really missing from Contacts, or is the matching wrong?
  const { contacts } = await import('../collectors/contacts.mjs')
  const book = contacts()
  const unnamed = db.prepare("select distinct thread from items where source = 'calls' and thread glob '*[0-9][0-9][0-9][0-9]*'").all()
  report.contacts = { known_numbers: book.size, unnamed_callers: unnamed.length, unnamed_but_in_contacts: unnamed.filter((r) => book.has(r.thread.replace(/\D/g, '').slice(-9))).length }
  writeFileSync(resolve(dataDir, 'diag.json'), JSON.stringify(report, null, 1))
}

const commands = {
  diag,
  apps: async () => {
    console.log(await discover(db))
    for (const r of db.prepare("select name, kind, printf('%.2f', confidence) p, route, electron from apps where route != 'usage' or kind is null order by route, name").all()) console.log(`${r.route?.padEnd(22) ?? 'unclassified'.padEnd(22)} ${(r.kind || '?').padEnd(10)} ${r.p}  ${r.name}${r.electron ? ' (Electron)' : ''}`)
  },
  open: openApp,
  install: () => { install(); console.log(`Kier runs at login. Log: ${logPath}\nFinish setup at ${url}/setup`) },
  uninstall: () => { uninstall(); console.log('Kier no longer runs at login.') },
  collect: async () => {
    const only = args.find((a) => a.startsWith('--only='))?.slice(7).split(',')
    const report = await collectAll(db, only)
    console.log(args.includes('--json') ? JSON.stringify(report) : report)
  },
  tag: async () => console.log(await tagPending(db, { limit: Number(args[0]) || 25 })),
  brief: () => console.log(writeBrief(args.includes('--notify'))),
  // Abandoned audio from a daemon that died abruptly is swept however Kier starts.
  serve: async () => { sweepSpeechFiles().catch(() => {}); await serve(db, { install }); console.log(url) },
  run,
  status: () => {
    for (const r of db.prepare('select * from runs order by source').all()) console.log(r.source.padEnd(10), r.ok ? `ok, +${r.added}` : r.error)
    console.log(db.prepare('select source, count(*) n from items group by source').all())
  },
  help: () => console.log('kier open | run | install | uninstall | collect | tag [n] | brief [--notify] | serve | status'),
}
try { await (commands[cmd] || commands.help)() } catch {
  console.error(JSON.stringify(errorRecord('BACKGROUND_FAILED')))
  process.exit(1)
}
