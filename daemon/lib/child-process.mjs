// Never resolve a child from an inherited PATH or pass interpreter startup hooks.
import * as child from 'node:child_process'
import { existsSync } from 'node:fs'
import { isAbsolute, join } from 'node:path'
import { userInfo } from 'node:os'
import { promisify } from 'node:util'
const directories = ['/usr/bin', '/bin', '/usr/sbin', '/sbin', '/opt/homebrew/bin', '/usr/local/bin']
const inheritedKeys = ['KIER_DATA_DIR', 'KIER_APP', 'KIER_CLIENT', 'KIER_MCP_ROLE', 'KIER_GOOGLE_CLIENT_ID', 'KIER_WORKER_TAG']
export function childEnv(explicit = {}) {
  const env = { HOME: userInfo().homedir, PATH: directories.join(':'), LANG: 'en_US.UTF-8', TMPDIR: '/tmp' }
  for (const key of inheritedKeys) if (process.env[key] !== undefined) env[key] = process.env[key]
  // Explicit per-child settings only, never an ambient environment spread.
  for (const [key, value] of Object.entries(explicit)) {
    if (key === 'KIER_WORKER_TAG' || key === 'PATH' || /^(NODE_|PYTHON|DYLD_|LD_)/.test(key)) continue
    env[key] = value
  }
  return env
}
export function executable(command) {
  if (isAbsolute(command)) return command
  if (!/^[a-zA-Z0-9_.-]+$/.test(command)) throw Error('CHILD_EXECUTABLE_INVALID')
  const path = directories.map(dir => join(dir, command)).find(existsSync)
  if (!path) throw Error('CHILD_EXECUTABLE_MISSING')
  return path
}
const options = opts => ({ ...opts, shell: false, env: childEnv(opts?.env) })
export const spawn = (command, args, opts = {}) => child.spawn(executable(command), args, options(opts))
// The private pipe belongs only to this process and its guard, never the worker.
export function managedSpawn(command, args, opts = {}) {
  const guard = new URL('./worker-guard.mjs', import.meta.url).pathname
  const stdio = typeof opts.stdio === 'string' ? Array(3).fill(opts.stdio) : (opts.stdio || ['ignore', 'pipe', 'pipe'])
  return child.spawn(process.execPath, [guard, executable(command), ...args], options({ ...opts,
    stdio: [...stdio, 'pipe'],
  }))
}
export const execFileSync = (command, args, opts = {}) => child.execFileSync(executable(command), args, options(opts))
export function execFile(command, args, opts, callback) {
  if (typeof opts === 'function') { callback = opts; opts = {} }
  return child.execFile(executable(command), args, options(opts), callback)
}
execFile[promisify.custom] = (command, args, opts) => new Promise((resolve, reject) => {
  execFile(command, args, opts, (error, stdout, stderr) => error ? reject(error) : resolve({ stdout, stderr }))
})
