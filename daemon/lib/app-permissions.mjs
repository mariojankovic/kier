// One origin policy for storage, SQL reads and native capture. Keys are case insensitive.
import { existsSync, readFileSync } from 'node:fs'
import { config, configPath } from './config.mjs'
const identities = {
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
export function capturePolicy() {
  const disabled = existsSync(configPath) ? JSON.parse(readFileSync(configPath, 'utf8')).off ?? [] : config.off
  if (!Array.isArray(disabled) || !disabled.every(s => typeof s === 'string')) throw Error('CAPTURE_POLICY_UNAVAILABLE')
  return { disabled, appSources }
}
export function permitsItem(item, disabled = capturePolicy().disabled) {
  if (disabled.includes(item.source)) return false
  let meta = item.meta || {}
  if (typeof meta === 'string') { try { meta = JSON.parse(meta) } catch { return false } }
  const names = [meta?.app, meta?.bundle, meta?.bundleId, meta?.bundle_id, meta?.appName]
  // Legacy captures sometimes have only a display name, or "App: window title".
  if (['screen', 'notifications', 'clipboard', 'apps', 'chat'].includes(item.source)) names.push(String(item.thread || '').split(':')[0])
  return !names.some(name => disabled.includes(appSources[String(name || '').trim().toLowerCase()]))
}
