// The owner pipe closes even on daemon SIGKILL. This supervisor owns cleanup,
// including new-session descendants, without blocking the daemon thread.
import { spawn } from 'node:child_process'
import { Socket } from 'node:net'
import { randomUUID } from 'node:crypto'
import { WorkerTree } from './worker-tree.mjs'
const [command, ...args] = process.argv.slice(2)
const tag = randomUUID()
const worker = spawn(command, args, { env: { ...process.env, KIER_WORKER_TAG: tag }, stdio: 'inherit', detached: true })
const tree = new WorkerTree(worker.pid, tag)
let stopping = false, scanning = false, terminationSignal = null
const poll = setInterval(async () => {
  if (scanning || stopping) return
  scanning = true
  try { await tree.scan() } catch {} finally { scanning = false }
}, 250)
async function stop(code = 0, signal = null) {
  // A cancellation arriving during normal-exit cleanup still wins over success.
  terminationSignal ??= signal
  if (stopping) return
  stopping = true
  clearInterval(poll)
  await tree.signal('SIGTERM')
  await new Promise(r => setTimeout(r, 1000))
  // Rescan during escalation to catch children started while handling SIGTERM.
  for (let i = 0; i < 3; i++) {
    await tree.signal('SIGKILL')
    await new Promise(r => setTimeout(r, 50))
  }
  if (terminationSignal) {
    process.removeAllListeners(terminationSignal)
    process.kill(process.pid, terminationSignal)
    return
  }
  process.exit(code)
}
// A socket, not fs.createReadStream: a file stream parks a threadpool thread in a blocking read on the pipe, and
// process.exit then never returns, so a worker that exited normally left its guard behind and was never restarted.
const owner = new Socket({ fd: 3, readable: true, writable: false })
owner.on('data', () => {})
owner.on('end', () => { void stop(1, 'SIGTERM') })
owner.on('error', () => { void stop(1, 'SIGTERM') })
for (const signal of ['SIGTERM', 'SIGINT', 'SIGHUP']) process.on(signal, () => { void stop(1, signal) })
process.on('exit', () => { try { process.kill(-worker.pid, 'SIGKILL') } catch {} })
worker.on('error', () => { void stop(1) })
// Normal leader exit also cleans up detached children before the guard exits.
worker.on('exit', (code, signal) => { void stop(code ?? 1, signal) })
