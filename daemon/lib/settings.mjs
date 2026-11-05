// What the owner switches on and off in Setup, kept in config.json with the rest and applied straight away: a source
// switched off is no longer read or stored, its cards leave the brief, and no AI can read it through Kier.
import { existsSync, readFileSync, writeFileSync, renameSync, rmSync } from 'node:fs'
import { config, configPath } from './config.mjs'
import { invalidateProfile } from './profile-state.mjs'
import { now } from './db.mjs'

export const SOURCES = [
  { id: 'whatsapp', label: 'WhatsApp' },
  { id: 'mcp', label: 'MCP sources', detail: 'Only servers and read tools you explicitly enable' },
  { id: 'mail', label: 'Mail', detail: 'Personal mail from Apple Mail, Spark and connected Gmail' },
  { id: 'imessage', label: 'Messages', detail: 'iMessage and SMS' },
  { id: 'discord', label: 'Discord', detail: 'Read from its window through Accessibility, in front or not' },
  { id: 'notifications', label: 'Notifications', detail: 'Mail and other apps, from Notification Center' },
  { id: 'calendar', label: 'Calendar' },
  { id: 'reminders', label: 'Your reminders', detail: 'Your own reminders with a date, from Reminders. Kier ticks one off there once it sees it done' },
  { id: 'calls', label: 'Calls' },
  { id: 'ai', label: 'Claude and Codex sessions' },
  { id: 'git', label: 'Your commits' },
  { id: 'browser', label: 'Web history' },
  { id: 'downloads', label: 'Downloads' },
  { id: 'clipboard', label: 'Clipboard', detail: 'Never what a password manager marks as secret' },
  { id: 'apps', label: 'Apps you use' },
  { id: 'screen', label: 'Other chat apps', detail: 'Slack, Teams, Telegram and the like, read through Accessibility. Never text fields, so drafts and passwords stay out' },
]

export const off = () => config.off || []
export const isOff = (source) => off().includes(source)
// For SQL: `and i.source not in (...)`, or nothing when everything is on.
export const offClause = (column = 'i.source') => (off().length ? `and ${column} not in (${off().map((s) => `'${s.replace(/'/g, '')}'`).join(', ')})` : '')

// Writes only what changed into config.json, keeping everything else the owner set there.
export function save(patch) {
  const file = existsSync(configPath) ? JSON.parse(readFileSync(configPath, 'utf8')) : {}
  const temporary = `${configPath}.${process.pid}.tmp`
  try {
    writeFileSync(temporary, JSON.stringify({ ...file, ...patch }, null, 2), { mode: 0o600 })
    renameSync(temporary, configPath)
  } finally { rmSync(temporary, { force: true }) }
  Object.assign(config, patch)
}

export function setSource(id, on) {
  if (!SOURCES.some((s) => s.id === id)) return false
  const now = new Set(existsSync(configPath) ? JSON.parse(readFileSync(configPath, 'utf8')).off || [] : off())
  if (!on) invalidateProfile()
  if (on) now.delete(id)
  else now.add(id)
  // Your reminders are read only while their switch is on (Setup's "Your reminders" is the same switch).
  save({ off: [...now], ...(id === 'reminders' && { myReminders: on === true }) })
  return true
}

// The terms of use the owner agreed to in Setup, by version, so changed terms are asked for again.
export const TERMS_VERSION = '2026-11-05'
export const TERMS_URL = 'https://getkier.com/terms/'
export const termsAccepted = () => config.terms?.version === TERMS_VERSION
export const acceptTerms = () => save({ terms: { version: TERMS_VERSION, at: now() } })

export const setClaudeCheck = (on) => save({ claudeCheck: on === true })
export const setOnline = (on) => save({ online: on === true })
// Three opt-in controls govern Calendar and Reminders: plans, dated tasks and reading existing
// reminders. The legacy phone switch remains a fallback for the first two.
export const phoneCalendar = () => config.phoneCalendar ?? config.phone === true
export const phoneReminders = () => config.phoneReminders ?? config.phone === true
export const myReminders = () => config.myReminders === true
export function setSwitch(key, on) {
  // "Your reminders" in Setup and in What Kier reads are one switch: off, Kier stops reading them and their cards go.
  if (key !== 'myReminders') return save({ [key]: on === true })
  const now = new Set(existsSync(configPath) ? JSON.parse(readFileSync(configPath, 'utf8')).off || [] : off())
  if (!on) invalidateProfile()
  if (on) now.delete('reminders')
  else now.add('reminders')
  save({ myReminders: on === true, off: [...now] })
}

// Everything Kier itself hands to Claude or Codex, counted for "On this Mac": chats with them, hand-offs, the Claude
// double-check and what they read through Kier. Only sizes are kept, never the text.
export function sent(db, kind, agent, text) {
  const bytes = Buffer.byteLength(String(text || ''))
  if (bytes) db.prepare('insert into outbound (ts, kind, agent, bytes) values (?, ?, ?, ?)').run(now(), kind, agent, bytes)
}
