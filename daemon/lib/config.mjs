import { execFileSync } from './child-process.mjs'
import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync } from 'node:fs'
import { homedir, userInfo } from 'node:os'
import { resolve } from 'node:path'

export const home = homedir()
export const dataDir = process.env.KIER_DATA_DIR || resolve(home, 'Library/Application Support/Kier')
export const tmpDir = resolve(dataDir, 'tmp')
process.umask(0o077)
mkdirSync(dataDir, { recursive: true, mode: 0o700 })
for (const path of [dataDir, tmpDir]) {
  if (existsSync(path)) {
    const info = lstatSync(path)
    if (!info.isDirectory() || info.uid !== process.getuid()) throw Error('PRIVATE_DIRECTORY_REQUIRED')
  }
}
mkdirSync(tmpDir, { recursive: true, mode: 0o700 })
chmodSync(tmpDir, 0o700)
// The vault holds what macOS keeps behind Full Disk Access, so only its owner may open the folder, and what Kier writes
// there is the owner’s alone, including legacy files and temporary copies.
chmodSync(dataDir, 0o700)
export const dbPath = resolve(dataDir, 'kier.db')
export const configPath = resolve(dataDir, 'config.json')
// Shared HTTP signing secret, read locally by owner clients and never sent over TCP.
export const tokenPath = resolve(dataDir, 'token')

// Whoever's Mac this is: name from the account, languages from System Settings, timezone from the clock.
// Anything personal on top of that (who they are, extra blocked sites) lives in their own config.json.
const sh = (cmd, args) => { try { return execFileSync(cmd, args, { encoding: 'utf8', timeout: 3000, stdio: ['ignore', 'pipe', 'ignore'] }).trim() } catch { return '' } }
const fullName = sh('id', ['-F']) || userInfo().username
const languageName = new Intl.DisplayNames(['en'], { type: 'language' })
const languages = [...new Set((sh('defaults', ['read', '-g', 'AppleLanguages']).match(/"?([a-z]{2,3})[-_"]/gi) || ['en"'])
  .map((m) => languageName.of(m.replace(/[^a-z]/gi, '').toLowerCase())))]
const first = fullName.split(/\s+/)[0]

const defaults = {
  me: first,
  fullName,
  pronoun: 'they',
  about: '',
  languages: languages.map((l) => `${l} (often casual)`),
  exampleEmail: `${first.toLowerCase().normalize('NFD').replace(/[^a-z]/g, '')}@example.com`,
  timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
  // How far back collectors read on their first run.
  backfillDays: 30,
  // Older messages are stored but not tagged, so the first run doesn't keep the GPU busy for hours.
  tagBackfillDays: 2,
  model: 'qwen3.5:9b',
  // Unload after short background bursts to release memory. Interactive chat keeps the model
  // ready longer for follow-up questions.
  keepAlive: '1m',
  chatKeepAlive: '5m',
  // Use the managed MLX runtime when installed. Other model servers must be explicitly
  // selected in Setup; there is no implicit TCP inference fallback.
  runtime: 'auto',
  // Optional owner-supplied inference server. Never selected until confirmed in Setup.
  externalModel: null,
  ollama: 'http://127.0.0.1:11434',
  port: 4777,
  briefTimes: ['08:00', '20:00'],
  // Optional network lookups for pull request state, publishing destinations and cloud reviews.
  // Disabled by default; configured model servers and explicit agent handoffs have separate controls.
  online: false,
  // A card Kier can't settle gets one look from the owner's Claude Code (doublecheck.mjs). It sends that card's chat
  // to Claude, so it stays off until the owner turns it on in Setup, and only runs with online helpers on.
  claudeCheck: false,
  // Sources the owner switched off in Setup (settings.mjs).
  off: [],
  // Source restrictions also apply to nested evidence and derived summaries.
  // What each AI may read through Kier: the conversations, calendar and work the tasks come from, and every read is
  // logged. Not the clipboard, which apps you used, your browsing or your downloads; an owner who
  // wants those shared adds them to scopes in config.json.
  scopes: Object.fromEntries(['claude', 'codex', 'kier'].map((c) => [c, ['whatsapp', 'imessage', 'mail', 'calls', 'calendar', 'notifications', 'screen', 'discord', 'ai', 'git']])),
  blockedChats: [],
  blockedDomains: ['1password.com', 'bitwarden.com', 'lastpass.com', 'dashlane.com', 'accounts.google.com', 'appleid.apple.com', 'revolut.com', 'paypal.com', 'wise.com', 'stripe.com', 'n26.com'],
}

export const config = { ...defaults, ...(existsSync(configPath) ? JSON.parse(readFileSync(configPath, 'utf8')) : {}) }
// Kier's own runtime answers the Ollama-shaped API on a verified private Unix socket.
// It counts as installed once its model is complete (runtime.mjs writes the mark last).
export const mlxReady = () => existsSync(resolve(dataDir, 'llm/bin/python')) && existsSync(resolve(dataDir, 'models/qwen3.5-9b-4bit/.kier-ready'))
export const usesExternalModel = config.runtime === 'external' && !!config.externalModel
export const usesMlx = !usesExternalModel && (config.runtime === 'mlx' || (config.runtime === 'auto' && mlxReady()))
if (usesExternalModel) config.model = config.externalModel.model


// Authorization is read from disk for each MCP invocation, never from request data
// or the process's cached settings. Missing or malformed policy refuses the call.
export function readMcpPolicy(client, maximumRole = 'read-only') {
  try {
    const saved = JSON.parse(readFileSync(configPath, 'utf8'))
    if (!saved || Array.isArray(saved) || typeof saved !== 'object') throw Error()
    const scopes = 'scopes' in saved ? saved.scopes : defaults.scopes
    const disabled = 'off' in saved ? saved.off : []
    const role = 'mcpRole' in saved ? saved.mcpRole : maximumRole
    const validSources = xs => Array.isArray(xs) && xs.every(s => typeof s === 'string' && /^[a-z][a-z0-9_-]*$/.test(s))
    if (!scopes || Array.isArray(scopes) || typeof scopes !== 'object' || !Object.values(scopes).every(validSources) ||
        !validSources(disabled) || !['read-only', 'read-write'].includes(role) ||
        !['read-only', 'read-write'].includes(maximumRole)) throw Error()
    return { scopes: scopes[client] || [], off: disabled, role: maximumRole === 'read-only' ? 'read-only' : role }
  } catch { throw Error('MCP_POLICY_UNAVAILABLE') }
}
