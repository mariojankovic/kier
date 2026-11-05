// One origin policy for storage, SQL reads and native capture. Keys are case insensitive.
import { existsSync, readFileSync, statSync } from 'node:fs'
import { config, configPath } from './config.mjs'
const identities = {
  mail: ['com.apple.mail', 'com.readdle.smartemail-macos', 'com.readdle.smartemail-macos-setapp', 'com.readdle.sparkdesktop', 'mail', 'apple mail', 'spark', 'spark mail', 'spark desktop'],
  whatsapp: ['net.whatsapp.whatsapp', 'whatsapp'],
  imessage: ['com.apple.mobilesms', 'messages', 'imessage'],
  discord: ['com.hnc.discord', 'com.hnc.discordptb', 'com.hnc.discordcanary', 'discord', 'discord ptb', 'discord canary'],
  calendar: ['com.apple.ical', 'calendar'],
  reminders: ['com.apple.reminders', 'reminders'],
  calls: ['com.apple.facetime', 'facetime', 'com.apple.phone', 'phone'],
  ai: ['com.anthropic.claudefordesktop', 'com.openai.codex', 'com.openai.chat', 'claude', 'claude code', 'codex', 'chatgpt'],
  browser: ['com.apple.safari', 'com.google.chrome', 'org.chromium.chromium', 'company.thebrowser.browser', 'company.thebrowser.dia', 'com.brave.browser', 'com.microsoft.edgemac', 'com.vivaldi.vivaldi', 'com.operasoftware.opera', 'org.mozilla.firefox', 'net.imput.helium', 'safari', 'chrome', 'google chrome', 'chromium', 'arc', 'dia', 'brave', 'brave browser', 'edge', 'microsoft edge', 'vivaldi', 'opera', 'firefox', 'helium'],
  screen: ['com.tencent.xinwechat', 'ru.keepcoder.telegram', 'org.whispersystems.signal-desktop', 'com.viber.osx', 'com.facebook.archon.developerid', 'com.tinyspeck.slackmacgap', 'com.microsoft.teams', 'com.microsoft.teams2', 'wechat', 'telegram', 'signal', 'viber', 'messenger', 'slack', 'teams', 'microsoft teams'],
}
export const appSources = Object.fromEntries(Object.entries(identities).flatMap(([source, names]) => names.map(name => [name, source])))
// Read again whenever config.json changes, never more often: callers may ask once per row.
let cached = { stamp: null, disabled: null }
export function capturePolicy() {
  const stamp = existsSync(configPath) ? (() => { const s = statSync(configPath); return `${s.mtimeMs}:${s.size}:${s.ino}` })() : 'none'
  const disabled = stamp === cached.stamp ? cached.disabled
    : existsSync(configPath) ? JSON.parse(readFileSync(configPath, 'utf8')).off ?? [] : config.off
  if (!Array.isArray(disabled) || !disabled.every(s => typeof s === 'string')) throw Error('CAPTURE_POLICY_UNAVAILABLE')
  cached = { stamp, disabled }
  return { disabled, appSources }
}
// The names that could tie a row to a switched-off app, per off-list; most off-lists name no app at all.
const offNames = new Map()
function namesFor(disabled) {
  const id = disabled.join('\n')
  let names = offNames.get(id)
  if (!names) {
    names = Object.keys(appSources).filter((name) => disabled.includes(appSources[name]))
    if (offNames.size > 32) offNames.clear()
    offNames.set(id, names)
  }
  return names
}
export function permitsItem(item, disabled = capturePolicy().disabled) {
  if (disabled.includes(item.source)) return false
  const names = namesFor(disabled)
  if (!names.length) return true
  // Only rows that mention one of those names can be from a switched-off app; the rest need no parsing.
  const text = `${typeof item.meta === 'string' ? item.meta : JSON.stringify(item.meta || {})}\n${item.thread || ''}`.toLowerCase()
  const wellFormed = typeof item.meta !== 'string' || /^\s*\{[\s\S]*\}\s*$/.test(item.meta)
  if (wellFormed && !names.some((name) => text.includes(name))) return true
  let meta = item.meta || {}
  if (typeof meta === 'string') { try { meta = JSON.parse(meta) } catch { return false } }
  const fields = [meta?.app, meta?.bundle, meta?.bundleId, meta?.bundle_id, meta?.appName]
  // Legacy captures sometimes have only a display name, or "App: window title".
  if (['screen', 'notifications', 'clipboard', 'apps', 'chat'].includes(item.source)) fields.push(String(item.thread || '').split(':')[0])
  return !fields.some(name => disabled.includes(appSources[String(name || '').trim().toLowerCase()]))
}
