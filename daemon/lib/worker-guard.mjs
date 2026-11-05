// A separate small process owns the worker group. fd 3 closes even if the daemon is
// killed with SIGKILL, so cleanup does not depend on JavaScript/Python exit hooks.
import { spawn } from 'node:child_process'
import { createReadStream } from 'node:fs'
const [command, ...args] = process.argv.slice(2)
const worker = spawn(command, args, { env: process.env, stdio: 'inherit', detached: true })
let stopping = false
const killGroup = signal => { try { process.kill(-worker.pid, signal) } catch {} }
function stop(signal = 'SIGTERM') {
  if (stopping) return
  stopping = true
  killGroup('SIGTERM')
  setTimeout(() => {
    killGroup('SIGKILL')
    process.removeAllListeners(signal)
    process.kill(process.pid, signal)
  }, 1000)
}
const owner = createReadStream(null, { fd: 3 })
owner.on('data', () => {})
owner.on('end', () => stop())
owner.on('error', () => stop())
for (const signal of ['SIGTERM', 'SIGINT', 'SIGHUP']) process.on(signal, () => stop(signal))
process.on('exit', () => killGroup('SIGKILL'))
worker.on('error', () => process.exit(1))
worker.on('exit', code => {
  if (!stopping) process.exit(code ?? 1)
  // Keep the grace timer: descendants may still be alive after the leader exits.
})
