// The login agent that keeps `kier run` alive. When Kier.app exists the agent starts the app's launcher,
// so macOS attributes file access to Kier; otherwise it falls back to plain Node.
import { execFileSync } from './child-process.mjs'
import { existsSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { dataDir, home } from './config.mjs'
import { AGENT, appPath } from './setup.mjs'

export const plistPath = resolve(home, `Library/LaunchAgents/${AGENT}.plist`)
export const logPath = resolve(dataDir, 'kier.log')
const target = `gui/${process.getuid()}`
const launchctl = (...a) => { try { execFileSync('launchctl', a, { stdio: 'ignore' }); return true } catch { return false } }
export const NODE = process.execPath.includes('.app/Contents/Resources/') ? process.execPath : ['/opt/homebrew/bin/node', '/usr/local/bin/node'].find(existsSync) || process.execPath
const SCRIPT = resolve(new URL('../bin/kier.mjs', import.meta.url).pathname)

export const loaded = () => launchctl('print', `${target}/${AGENT}`)

export function install() {
  const launcher = resolve(appPath, 'Contents/MacOS/Kier')
  const program = existsSync(launcher) ? [launcher, 'run'] : [NODE, '--disable-warning=ExperimentalWarning', SCRIPT, 'run']
  const xml = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;')
  // launchd starts agents with only the system folders on PATH; Homebrew's tools (gh, ollama) live elsewhere.
  const PATH = [...new Set([dirname(NODE), '/opt/homebrew/bin', '/usr/local/bin', '/usr/bin', '/bin', '/usr/sbin', '/sbin'])].join(':')
  writeFileSync(plistPath, `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${AGENT}</string>
  <key>ProgramArguments</key>
  <array>
${program.map((a) => `    <string>${xml(a)}</string>`).join('\n')}
  </array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ProcessType</key><string>Standard</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key><string>${xml(PATH)}</string>
  </dict>
  <key>StandardOutPath</key><string>${xml(logPath)}</string>
  <key>StandardErrorPath</key><string>${xml(logPath)}</string>
</dict>
</plist>
`)
  stop()
  if (!launchctl('bootstrap', target, plistPath)) throw Error('launchctl could not start the Kier agent')
}

// bootout returns before the old process is gone, and bootstrapping too early fails.
function stop() {
  launchctl('bootout', `${target}/${AGENT}`)
  const pause = new Int32Array(new SharedArrayBuffer(4))
  for (let i = 0; i < 50 && loaded(); i++) Atomics.wait(pause, 0, 0, 200)
}

export function uninstall() {
  stop()
  rmSync(plistPath, { force: true })
}
