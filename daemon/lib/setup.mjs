import { mailSetup } from '../collectors/mail.mjs'
import { modelFetch } from './model-provider.mjs'
// The setup checklist: each step checks the real state of the Mac, so it turns green the moment
// a permission is granted, and offers the one action that moves it forward.
import { MLX, embedReady, installEmbedder, installing, installProgress, installRuntime, installSecond } from './runtime.mjs'
import { SOURCES as SEARCHED } from './meaning.mjs'
import { execFile } from './child-process.mjs'
import { closeSync, existsSync, openSync } from 'node:fs'
import { resolve } from 'node:path'
import { promisify } from 'node:util'
import { config, home, usesExternalModel, usesMlx } from './config.mjs'
import { TERMS_URL, acceptTerms, myReminders, phoneCalendar, phoneReminders, setSwitch, termsAccepted } from './settings.mjs'
import { now } from './db.mjs'
import { installed as installedSecond } from './second.mjs'

const exec = promisify(execFile)
// Slow checks are logged, since the page polls this every few seconds.
const run = async (cmd, args, opts) => {
  const t = Date.now()
  try { return await exec(cmd, args, opts) } finally { if (Date.now() - t > 3000) console.log(JSON.stringify({ code: 'SETUP_SUBPROCESS_SLOW', milliseconds: Date.now() - t })) }
}
const ok = (cmd, args) => run(cmd, args, { timeout: 15000 }).then(() => true, () => false)
// brew and claude take seconds to answer; remember them for a minute, and forget after any action.
const cache = new Map()
const cached = (key, fn) => {
  const hit = cache.get(key)
  if (hit && Date.now() - hit.at < 60_000) return hit.value
  const value = fn()
  cache.set(key, { at: Date.now(), value })
  return value
}
// The app this daemon belongs to: the one that started it, else wherever Kier.app was put.
export const appPath = process.env.KIER_APP || [resolve(home, 'Applications/Kier.app'), '/Applications/Kier.app'].find(existsSync) || '/Applications/Kier.app'
export const AGENT = 'com.getkier.agent'
const ROOT = resolve(new URL('..', import.meta.url).pathname)
const CLAUDE = [resolve(home, '.local/bin/claude'), '/opt/homebrew/bin/claude'].find(existsSync) || 'claude'
const BREW = ['/opt/homebrew/bin/brew', '/usr/local/bin/brew'].find(existsSync) || 'brew'
// Inside a downloaded Kier.app the daemon and its Node live in the app; a development checkout uses Homebrew's.
const BUNDLED = ROOT.includes('.app/Contents/Resources/')
const OLLAMA_APP = ['/Applications/Ollama.app', resolve(home, 'Applications/Ollama.app')].find(existsSync)

// Full Disk Access can't be queried; trying to open a protected file is the check. It never prompts.
export function fullDiskAccess() {
  try { closeSync(openSync(resolve(home, 'Library/Messages/chat.db'), 'r')); return true } catch { return false }
}

async function ollama() {
  try {
    const tags = await (await modelFetch('/api/tags', { signal: AbortSignal.timeout(2000) })).json()
    return { up: true, model: tags.models.some((m) => m.name === config.model) }
  } catch {
    return { up: false, model: false }
  }
}

// Just the host of your model server, never its full address or key.
const serverName = () => { try { return new URL(config.externalModel.endpoint).host } catch { return 'your model server' } }

const count = (db, source) => db.prepare('select count(*) n from items where source = ? and ts > ?').get(source, now() - 30 * 86400).n
const lastRun = (db, source) => db.prepare('select * from runs where source = ?').get(source)

// Messaging apps Kier knows how to reach, and the best route for each.
const CHAT_APPS = [
  { name: 'WhatsApp', app: 'WhatsApp.app', route: 'every message, read directly' },
  { name: 'Discord', app: 'Discord.app', route: 'notifications, and whole conversations once screen reading is on' },
  { name: 'Slack', app: 'Slack.app', route: 'notifications, and whole conversations once screen reading is on' },
  { name: 'Telegram', app: 'Telegram.app', route: 'notifications, and whole conversations once screen reading is on' },
  { name: 'Signal', app: 'Signal.app', route: 'notifications, and whole conversations once screen reading is on' },
  { name: 'WeChat', app: 'WeChat.app', route: 'notifications, and whole conversations once screen reading is on' },
  { name: 'Microsoft Teams', app: 'Microsoft Teams.app', route: 'notifications, and whole conversations once screen reading is on' },
  { name: 'Viber', app: 'Viber.app', route: 'notifications, and whole conversations once screen reading is on',
    missing: 'Viber chats stay on your phone until you install Viber for Mac, which syncs from it' },
]

function chatApps() {
  const lines = []
  for (const a of CHAT_APPS) {
    const here = ['/Applications', resolve(home, 'Applications')].some((d) => existsSync(resolve(d, a.app)))
    if (here) lines.push(`${a.name}: ${a.route}.`)
    else if (a.missing) lines.push(`${a.missing}.`)
  }
  // No Mac app exists for these, so the browser is the way in: its notifications reach Kier like any app's.
  lines.push('Messenger and Instagram: open them in your browser and allow notifications when asked; iPhone-only apps can\'t reach your Mac in the EU, because Apple blocks iPhone notifications on Mac there.')
  return lines.join(' ')
}

export async function steps(db, eyes = {}) {
  const fda = fullDiskAccess()
  const watching = eyes.at > now() - 30
  const [model, agent, claude, ollamaService] = await Promise.all([
    ollama(),
    ok('launchctl', ['print', `gui/${process.getuid()}/${AGENT}`]),
    cached('claude', () => ok(CLAUDE, ['mcp', 'get', 'kier'])),
    // Ollama.app starts itself at login; Homebrew's needs its service on.
    cached('ollama', () => OLLAMA_APP ? true : run(BREW, ['services', 'info', 'ollama', '--json'], { timeout: 15000 }).then(({ stdout }) => JSON.parse(stdout)[0]?.running === true, () => false)),
  ])
  const viber = existsSync('/Applications/Viber.app')
  const secondInstalled = installedSecond()
  // A switch over Calendar or Reminders: off, on but waiting for macOS's say-so, or on.
  const apple = (id, title, on, allowed, what, off, done) => !on
    ? step(id, title, false, off, { id, label: 'Turn on' }, true)
    : allowed !== true
      ? step(id, title, false, `Kier needs to use ${what}: allow it when macOS asks, or in System Settings, Privacy & Security.`, { id, label: 'Allow' }, true)
      : step(id, title, true, done, { id: `${id}off`, label: 'Turn off' }, true)
  // 'later' is not built yet; 'optional' has an action but doesn't count as unfinished setup.
  const step = (id, title, done, detail, action, optional = false, link = null) => ({
    id, title, detail, ...(link && { link }),
    status: done ? 'done' : action === 'later' ? 'later' : optional ? 'optional' : 'todo',
    ...(action && action !== 'later' && !done && { action }),
  })
  // Managed inference uses private sockets; other endpoints require an explicit Model selection.
  const mlxStep = (model, ollamaUp) => {
    const title = 'Local model for tasks'
    if (usesMlx) return step('model', title, model.up, model.up ? `${config.model} runs inside Kier on this Mac.` : 'Kier\'s local model is starting.', null)
    if (installing.phase) {
      const doing = { python: 'Getting Python ready.', packages: 'Installing what the model runs on.', model: `Downloading the model: ${installProgress() ?? 0}%.` }
      return step('model', title, false, `${doing[installing.phase]} It carries on in the background.`, null)
    }
    return installing.error
      ? step('model', title, false, `The download stopped (${installing.error}). Trying again picks up where it left off.`, { id: 'mlx', label: 'Try again' })
      : step('model', title, false, `Download Kier's own model once (about 6 GB). It reads your messages on this Mac, so nothing leaves it, and needs no other app.`, { id: 'mlx', label: 'Download' })
  }
  // Search by meaning (meaning.mjs): one more download, for a Kier that runs its own model.
  const searchStep = () => {
    const title = 'Search by meaning'
    if (embedReady()) {
      const marks = SEARCHED.map(() => '?').join(', ')
      const total = db.prepare(`select count(*) n from items where source in (${marks}) and length(text) >= 3`).get(...SEARCHED).n
      const done = db.prepare('select count(*) n from vectors').get().n
      return step('search', title, true, `Kier finds messages by what they mean, in any language${total ? `: ${Math.min(done, total).toLocaleString()} of ${total.toLocaleString()} indexed` : ''}. Ask it "what did I tell Nika about the puzzle club?"`, null)
    }
    if (installing.phase === 'embed') return step('search', title, false, `Downloading: ${installProgress() ?? 0}%. Kier keeps only the 185 MB it needs.`, null, true)
    return step('search', title, false, 'Find any message by what it means, in any language, and ask Kier things like "what did I tell Nika about the puzzle club?". One download of 1.1 GB, of which Kier keeps 185 MB; it runs on this Mac.', { id: 'embed', label: installing.error ? 'Try again' : 'Download' }, true)
  }
  const agreed = termsAccepted()
  const mail = mailSetup()
  return [
    // Free and as is: the owner agrees to the terms of use once, and again when they change.
    step('terms', 'Terms of use', agreed,
      agreed ? 'You agreed to the terms of use. Kier is free and comes as is.'
        : 'Kier is free and comes as is, with no warranty. Your data stays on your Mac and keeping it safe is up to you; the author isn\'t liable for data loss, exposure or any other damage. Choose Agree to accept the terms of use.',
      { id: 'terms', label: 'Agree' }, false, { label: 'Read the terms', url: TERMS_URL }),
    // One switch instead of a prompt per folder: until it's on, Kier reads nothing.
    step('fda', 'Full Disk Access', fda,
      fda ? 'Kier can read WhatsApp, Messages, calls, contacts, calendar and Downloads.'
        : 'macOS keeps WhatsApp, Messages, calls, calendar and Downloads behind this one switch, and Kier reads nothing until it\'s on. Open the settings and turn on Kier (if it isn\'t listed, drag it in from the Finder window that opens).',
      { id: 'fda', label: 'Open settings' }),
    step('agent', 'Run Kier in the background', agent,
      agent ? 'Starts at login and checks your sources every 5 minutes.' : 'Kier needs to run at login to keep your timeline current.',
      { id: 'agent', label: 'Turn on' }),
    // Your own model server (Setup, System, Model): Kier's download isn't needed while it answers.
    usesExternalModel ? step('model', 'Model for tasks', model.up,
      model.up ? `${config.model} on ${serverName()} reads your messages.` : `${serverName()} isn't answering. Check that it's running, or switch back to Kier's own model in System.`, null)
      : usesMlx || config.runtime !== 'ollama' ? mlxStep(model, ollamaService)
      : step('model', 'Choose your model server', false,
        'Select your Ollama server in Setup, System, Model before Kier sends it messages.', null),
    ...(usesMlx || (usesExternalModel && existsSync(MLX.python)) ? [searchStep()] : []),
    secondInstalled ? step('second', 'Second opinion', true, 'd1-2B double-checks every task the local model finds; doubtful ones wait under "Maybe yours".', null)
      : installing.phase?.startsWith('second') ? step('second', 'Second opinion', false, installing.phase === 'second' ? `Downloading d1-2B: ${installProgress() ?? 0}%. It carries on in the background.` : 'Installing what it runs on.', null, true)
      // Offer installation whenever the optional runtime is missing, including on a fresh machine.
      : step('second', 'Second opinion', false, installing.secondError
        ? `The download stopped (${installing.secondError}). Trying again picks up where it left off.`
        : 'A second, smaller model double-checks every task the local model finds, and doubtful ones wait under "Maybe yours" instead of your list. One download of about 4 GB; it runs on this Mac, holds up to 4 GB of memory while it checks, and lets go after a few quiet minutes or when the Mac is short of memory.',
      { id: 'second', label: installing.secondError ? 'Try again' : 'Download' }, true),
    step('claude', 'Connect to Claude', claude,
      claude ? 'Claude Code can ask Kier about your day. Every read is logged.' : 'Lets Claude Code read your vault through Kier, within the sources you allow.',
      { id: 'claude', label: 'Connect' }),
    step('imessage', 'iMessage and SMS from your iPhone', fda && count(db, 'imessage') > 0,
      !fda ? 'Needs Full Disk Access first.' : count(db, 'imessage') ? `${count(db, 'imessage')} messages in the last 30 days.`
        : 'On your iPhone: Settings > your name > iCloud > Messages in iCloud. On this Mac: Messages > Settings > iMessage > Enable Messages in iCloud.'),
    step('calls', 'Calls from your iPhone', fda && count(db, 'calls') > 0,
      !fda ? 'Needs Full Disk Access first.' : count(db, 'calls') ? `${count(db, 'calls')} calls in the last 30 days. WhatsApp calls come from the WhatsApp app on this Mac.`
        : 'On your iPhone: Settings > Apps > Phone > Calls on Other Devices, and allow this Mac. This is how Kier knows you called someone back.'),
    step('calendar', 'Calendar', fda && lastRun(db, 'calendar')?.ok === 1,
      !fda ? 'Needs Full Disk Access first.' : 'Every calendar this Mac syncs, including Google and iCloud.'),
    // Calendar and Reminders access is the app's to ask for (EventKit); it reports it with what its eyes see. Three
    // switches, each off until turned on. An app from before the split reports both as one ("phone").
    apple('phonecal', 'Plans in your calendar', phoneCalendar(), eyes.events ?? eyes.phone, 'Calendars',
      'Plans agreed in your chats go in a Kier calendar with an alert, so your iPhone and Watch ring for them. Delete one there and Kier leaves it.',
      'Plans from your chats are in the Kier calendar, with an alert.'),
    apple('phonerem', 'Tasks in Reminders', phoneReminders(), eyes.reminders ?? eyes.phone, 'Reminders',
      'Tasks with a date go in a Kier list in Reminders, due that day, so your iPhone and Watch remind you. Tick one off there and it\'s done here too.',
      'Tasks with a date are in the Kier list in Reminders. Tick one off there and it\'s done here too.'),
    apple('myrem', 'Your reminders', myReminders(), eyes.reminders ?? eyes.phone, 'Reminders',
      'Kier reads your own reminders that have a date, from every list, and ticks one off when it sees it done in your chats or work, or when you mark it done here. Tick one off in Reminders and it\'s done here too.',
      'Your reminders with a date are cards in Kier, ticked off in Reminders once they\'re done.'),
    step('whatsapp', 'WhatsApp', lastRun(db, 'whatsapp')?.ok === 1,
      lastRun(db, 'whatsapp')?.ok ? `${count(db, 'whatsapp').toLocaleString()} messages in the last 30 days.` : 'Install WhatsApp for Mac and link it to your phone.'),
    step('notifications', 'Notifications from any app', fda && count(db, 'notifications') > 0,
      !fda ? 'Needs Full Disk Access first.'
        : `Whatever any app shows in Notification Center, read every 30 seconds before you dismiss it${count(db, 'notifications') ? ` (${count(db, 'notifications')} so far)` : ''}. This covers apps that keep nothing readable on the Mac.`),
    step('eyes', 'Clipboard and apps you use', watching,
      watching ? 'What you copy (never what a password manager marks as secret) and which app you spend time in.'
        : 'Starts with Kier in the background; open Kier once if this stays grey.'),
    step('screen', 'Read chat apps on screen', !!eyes.accessibility,
      eyes.accessibility ? 'Kier reads the conversation text in chat app windows while they\'re in front. Never text fields, so drafts and passwords stay out.'
        : 'Lets Kier read conversations in apps like Discord while you have them open. Open the settings and turn on Kier under Accessibility.',
      { id: 'accessibility', label: 'Open settings' }, true),
    step('chatapps', 'Your messaging apps', false, chatApps(), viber ? null : { id: 'viber', label: 'Get Viber for Mac' }, true),
    step('mail', 'Mail', mail.enabled && lastRun(db, 'mail')?.ok === 1, mail.detail, null, true),
  ]
}

export async function act(id, { install, collect } = {}) {
  cache.clear()
  switch (id) {
    case 'terms': return acceptTerms()
    // The app asks for Calendars and Reminders first, then turns it on here; off, it removes the Kier calendar and list.
    case 'phonecal': return setSwitch('phoneCalendar', true)
    case 'phonecaloff': return setSwitch('phoneCalendar', false)
    case 'phonerem': return setSwitch('phoneReminders', true)
    case 'phoneremoff': return setSwitch('phoneReminders', false)
    case 'myrem': return setSwitch('myReminders', true)
    case 'myremoff': return setSwitch('myReminders', false)
    case 'agent': return install()
    case 'ollama': return OLLAMA_APP ? run('open', ['-a', OLLAMA_APP]) : run(BREW, ['services', 'start', 'ollama'], { timeout: 60000 })
    case 'getollama': return run('open', ['https://ollama.com/download/mac'])
    case 'mlx':
      // Runs in the background; the step shows how far it is, and Kier restarts on it when it's done.
      installRuntime()
      return
    case 'embed':
      // In the background too; the runtime loads it on the first search, nothing restarts.
      installEmbedder()
      return
    case 'second':
      // In the background; the daemon starts d1 the first time there's a task to check.
      installSecond()
      return
    case 'pull':
      // Runs in the background; the step turns green when the download finishes.
      modelFetch('/api/pull', { method: 'POST', body: JSON.stringify({ model: config.model, stream: false }) }).catch(() => {})
      return
    case 'fda':
      await run('open', ['x-apple.systempreferences:com.apple.preference.security?Privacy_AllFiles'])
      if (existsSync(appPath)) await run('open', ['-R', appPath])
      return
    case 'claude': {
      // The app's own Node when downloaded; in a checkout the Homebrew symlink, not the versioned Cellar path, so a
      // Node upgrade doesn't break the connection.
      const node = BUNDLED ? process.execPath : ['/opt/homebrew/bin/node', '/usr/local/bin/node'].find(existsSync) || process.execPath
      return run(CLAUDE, ['mcp', 'add', '-s', 'user', 'kier', '--', node, '--disable-warning=ExperimentalWarning', resolve(ROOT, 'bin/mcp.mjs')], { timeout: 30000 })
    }
    case 'accessibility':
      await run('open', ['x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility'])
      if (existsSync(appPath)) await run('open', ['-R', appPath])
      return
    case 'viber': return run('open', ['https://www.viber.com/en/download/'])
    case 'collect': return collect()
    default: throw Error(`unknown setup action ${id}`)
  }
}
