import { permitsItem } from './app-permissions.mjs'
// What every installed app is for, and how Kier may read it. Facts macOS already has come first (the
// category each developer declares, whether it's built on Electron); d1 judges only what those leave open.
// The rules at the bottom decide the route, and are never learned: some kinds of app are never read.
import { execFileSync } from './child-process.mjs'
import { existsSync, readdirSync, writeFileSync } from 'node:fs'
import { basename, resolve } from 'node:path'
import { dataDir, home } from './config.mjs'
import { now } from './db.mjs'
import { ask } from './second.mjs'

const DIRS = ['/Applications', '/Applications/Utilities', '/Applications/Setapp', resolve(home, 'Applications'), '/System/Applications', '/System/Applications/Utilities']

export const KINDS = {
  chat: 'Messaging or calls with people, like WhatsApp, Discord, Slack, Telegram or Signal',
  email: 'Email',
  calendar: 'Calendar, reminders or scheduling',
  finance: 'Banking, payments, investing or crypto',
  passwords: 'Passwords, keys, VPN or security',
  health: 'Health, medical or fitness',
  social: 'Social media feeds, like Instagram, X or TikTok',
  work: 'Work tools: documents, notes, project management, design or browsers',
  developer: 'Developer tools: code editors, terminals, databases or AI coding assistants',
  media: 'Music, video, photos, games or entertainment',
  system: 'System utilities, menu bar tools, drivers or settings',
}

// Developers declare a category in each app's Info.plist; most map straight to a kind.
const CATEGORY = {
  'public.app-category.finance': 'finance', 'public.app-category.healthcare-fitness': 'health', 'public.app-category.medical': 'health',
  'public.app-category.developer-tools': 'developer', 'public.app-category.games': 'media', 'public.app-category.music': 'media',
  'public.app-category.video': 'media', 'public.app-category.entertainment': 'media', 'public.app-category.photography': 'media',
  'public.app-category.utilities': 'system', 'public.app-category.productivity': 'work', 'public.app-category.business': 'work',
  'public.app-category.graphics-design': 'work', 'public.app-category.education': 'work', 'public.app-category.reference': 'work',
}

// Apps whose data Kier reads directly from their own database.
const DATABASE = new Set(['net.whatsapp.WhatsApp', 'com.apple.MobileSMS', 'com.apple.iCal'])
// Apps for talking to people, never left to a guess: WeChat and others declare "social networking", which d1 could
// read as a feed and only take their notifications.
const CHAT_APPS = new Set(['com.tencent.xinWeChat', 'ru.keepcoder.Telegram', 'org.whispersystems.signal-desktop', 'com.viber.osx',
  'com.facebook.archon.developerID', 'com.tinyspeck.slackmacgap', 'com.microsoft.teams2', 'com.hnc.Discord'])
const NEVER = new Set(['finance', 'passwords', 'health'])

export function scan() {
  const apps = new Map()
  for (const dir of DIRS) {
    if (!existsSync(dir)) continue
    for (const entry of readdirSync(dir)) {
      if (!entry.endsWith('.app')) continue
      const path = resolve(dir, entry)
      let plist
      try { plist = JSON.parse(execFileSync('plutil', ['-convert', 'json', '-o', '-', resolve(path, 'Contents/Info.plist')], { encoding: 'utf8', timeout: 3000, stdio: ['ignore', 'pipe', 'ignore'] })) } catch { continue }
      const bundle = plist.CFBundleIdentifier
      if (!bundle || apps.has(bundle)) continue
      apps.set(bundle, {
        bundle, path, name: plist.CFBundleDisplayName || plist.CFBundleName || basename(entry, '.app'),
        category: plist.LSApplicationCategoryType || '',
        electron: existsSync(resolve(path, 'Contents/Frameworks/Electron Framework.framework')),
      })
    }
  }
  return [...apps.values()]
}

// A guess d1 isn't sure of counts as "other" (usage only). The never-read kinds take less certainty,
// because wrongly reading a banking app costs more than wrongly ignoring a calculator.
function route(kind, bundle, confidence) {
  if (bundle === 'com.getkier.kier') return 'usage'
  if (confidence != null && confidence < (NEVER.has(kind) ? 0.3 : 0.5)) return 'usage'
  if (NEVER.has(kind)) return 'never'
  if (DATABASE.has(bundle)) return 'database'
  if (kind === 'chat') return 'notifications+screen'
  if (kind === 'email' || kind === 'calendar' || kind === 'social') return 'notifications'
  return 'usage'
}

// Scans installed apps, classifies new ones and writes the lists Kier.app's eyes read.
export async function discover(db) {
  db.exec(`create table if not exists apps (bundle text primary key, name text, path text, category text, kind text,
    confidence real, electron integer, route text, checked_at integer)`)
  const known = new Map(db.prepare('select bundle, kind, confidence from apps').all().map((r) => [r.bundle, r]))
  const found = scan()
  const save = db.prepare(`insert into apps (bundle, name, path, category, kind, confidence, electron, route, checked_at)
    values (?, ?, ?, ?, ?, ?, ?, ?, ?) on conflict(bundle) do update set name = excluded.name, path = excluded.path,
    category = excluded.category, kind = excluded.kind, confidence = excluded.confidence, electron = excluded.electron,
    route = excluded.route, checked_at = excluded.checked_at`)
  const toAsk = []
  for (const a of found) {
    if (CHAT_APPS.has(a.bundle)) { a.kind = 'chat'; a.confidence = 1; continue }
    const prior = known.get(a.bundle)
    if (prior?.kind && prior.confidence != null) { a.kind = prior.kind; a.confidence = prior.confidence; continue }
    // A declared category is the developer's own word; social networking still needs d1 (chat or feed?).
    if (CATEGORY[a.category]) { a.kind = CATEGORY[a.category]; a.confidence = 1; continue }
    toAsk.push(a)
  }
  if (toAsk.length) {
    const questions = { kind: { type: 'choice', instructions: 'What is this Mac app mainly used for?', criteria: KINDS } }
    const answers = await ask(toAsk.map((a) => ({
      app: a.name, bundle_id: a.bundle, declared_category: a.category.replace('public.app-category.', '') || 'none',
      built_with: a.electron ? 'Electron (a web app in a desktop window)' : 'native',
    })), questions).catch(() => null)
    toAsk.forEach((a, i) => {
      const answer = answers?.[i]?.kind
      a.kind = answer?.choice || null
      a.confidence = answer ? answer.probabilities?.[answer.choice] ?? null : null
    })
  }
  for (const a of found) save.run(a.bundle, a.name, a.path, a.category, a.kind || null, a.confidence ?? null, a.electron ? 1 : 0, a.kind ? route(a.kind, a.bundle, a.confidence) : null, now())
  writeLists(db)
  return { apps: found.length, classified: toAsk.filter((a) => a.kind).length, waiting: toAsk.filter((a) => !a.kind).length }
}

// Kier.app reads these: which windows it may read on screen, and where it must not watch the clipboard.
export function writeLists(db) {
  const rows = db.prepare('select bundle, kind, route from apps').all()
  writeFileSync(resolve(dataDir, 'screen-apps.json'), JSON.stringify(rows.filter((r) => r.route === 'notifications+screen' && permitsItem({ source: 'screen', meta: { app: r.bundle } })).map((r) => r.bundle)))
  writeFileSync(resolve(dataDir, 'quiet-apps.json'), JSON.stringify(rows.filter((r) => r.route === 'never').map((r) => r.bundle)))
}

export const appKinds = (db) => {
  try { return new Map(db.prepare('select bundle, kind, route from apps').all().map((r) => [r.bundle, r])) } catch { return new Map() }
}
