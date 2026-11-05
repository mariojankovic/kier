// The brief, read out loud. Ming 3.0 (0.5B, local, MIT) when it's installed; macOS's own voice otherwise, which
// works on any Mac with nothing to download. The brief is rendered ahead of time, so pressing play is instant.
import { managedSpawn as spawn } from './child-process.mjs'
import { existsSync } from 'node:fs'
import { opendir, rm } from 'node:fs/promises'
import { resolve } from 'node:path'
import { config, dataDir, tmpDir } from './config.mjs'
import { brief, timeLabel } from './tasks.mjs'

// Use the selected bundled voice. Invoke the TTS module directly with Python so relocating
// the data directory does not leave a launcher with a stale absolute interpreter path.
const TTS = {
  voice: 'UK_Charlotte',
  ...config.tts,
  // Never from config.json, which would choose what runs with Kier's Full Disk Access.
  python: resolve(dataDir, 'tts/bin/python'),
  model: resolve(dataDir, 'models/ming-tts-8bit'),
}
let voice = null, utterance = 0, sequence = 0
let rendering = null, ready = null
const activeFiles = new Set()
const cleanup = async path => {
  try { await rm(path, { force: true }) } catch {}
  finally { activeFiles.delete(path) }
}

// Run once after acquiring the daemon listener. Asynchronous iteration and unlink
// keep a large cache sweep off the daemon's event loop. Old fixed-name caches go too.
export async function sweepSpeechFiles() {
  try {
    for await (const entry of await opendir(tmpDir)) {
      if (/^kier-(?:say(?:-[\w-]+)?|brief(?:-[\w-]+)?)\.(?:wav|txt)$/.test(entry.name)) {
        const path = resolve(tmpDir, entry.name)
        if (!activeFiles.has(path)) await cleanup(path)
      }
    }
  } catch {}
}

const list = (items) => (items.length < 2 ? items.join('') : `${items.slice(0, -1).join('; ')}; and ${items.at(-1)}`)
const said = (t) => t.summary.replace(/\.$/, '')

export function speech(b) {
  const hour = new Date().getHours()
  const out = [`Good ${hour >= 4 && hour < 12 ? 'morning' : hour >= 12 && hour < 18 ? 'afternoon' : 'evening'}, ${config.me}.`]
  const events = b.today.events.map((e) => (e.allDay ? e.text : `at ${timeLabel(e.ts)}, ${e.text}`))
  if (events.length) out.push(`On your calendar today: ${list(events.slice(0, 4))}.`)
  if (b.today.tasks.length) out.push(`Due today: ${list(b.today.tasks.slice(0, 4).map(said))}.`)
  if (b.forgotten.length) out.push(`You may have forgotten: ${list(b.forgotten.slice(0, 3).map(said))}.`)
  if (b.open.length) out.push(`Still waiting on you: ${list(b.open.slice(0, 3).map(said))}.`)
  const rest = (b.more?.open || 0) + Math.max(0, b.open.length - 3)
  if (rest) out.push(`Plus ${rest} more in Kier.`)
  if (out.length === 1) out.push('Nothing is waiting on you. Enjoy your day.')
  return out.join(' ')
}

// Ming reads digits poorly, so small numbers are written out; times like 14:30 stay as they are.
const ONES = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten', 'eleven', 'twelve', 'thirteen',
  'fourteen', 'fifteen', 'sixteen', 'seventeen', 'eighteen', 'nineteen']
const TENS = ['', '', 'twenty', 'thirty', 'forty', 'fifty', 'sixty', 'seventy', 'eighty', 'ninety']
const words = (n) => (n < 20 ? ONES[n] : `${TENS[Math.floor(n / 10)]}${n % 10 ? `-${ONES[n % 10]}` : ''}`)
export const spoken = (text) => text.replace(/(?<![\d:.,-])\b(\d{1,2})\b(?![\d:.,-])/g, (_, n) => words(Number(n)))

const ming = () => existsSync(TTS.python) && existsSync(TTS.model)

export function render(text, prefix) {
  const child = spawn(TTS.python, ['-I', '-E', '-m', 'mlx_audio.tts.generate', '--model', TTS.model, '--voice', TTS.voice, '--output_path', tmpDir,
    '--file_prefix', prefix, '--join_audio', '--audio_format', 'wav'], { stdio: ['pipe', 'ignore', 'ignore'], env: { HF_HUB_OFFLINE: '1' } })
  child.stdin.on('error', () => {})
  child.stdin.end(spoken(text))
  return child
}

// Renders the current brief in the background whenever it changes, so "Read it to me" plays at once.
export function prerender(db) {
  if (!ming() || rendering) return false
  const text = speech(brief(db))
  if (ready?.text === text) return false
  const prefix = `kier-brief-${process.pid}-${++sequence}`, path = resolve(tmpDir, `${prefix}.wav`)
  activeFiles.add(path)
  let child
  try { child = render(text, prefix) } catch { void cleanup(path); return false }
  rendering = child
  child.once('error', () => { if (rendering === child) rendering = null; void cleanup(path) })
  child.once('exit', (code, signal) => {
    if (rendering !== child || code !== 0 || signal) { void cleanup(path) }
    else {
      if (ready) void cleanup(ready.path)
      ready = { text, path }
    }
    if (rendering === child) rendering = null
  })
  return true
}

function play(path) {
  try {
    const player = track(spawn('afplay', [path], { stdio: 'ignore' }))
    player.once('exit', () => { void cleanup(path) })
    player.once('error', () => { void cleanup(path) })
    return player
  } catch { void cleanup(path); return null }
}

// Says any text, for the companion's answers and nudges; the same voice as the brief.
export function say(text) {
  stop()
  if (!ming()) return track(mac(text))
  const request = utterance
  const prefix = `kier-say-${process.pid}-${request}`, path = resolve(tmpDir, `${prefix}.wav`)
  activeFiles.add(path)
  let gen
  try { gen = track(render(text, prefix)) } catch { void cleanup(path); return null }
  gen.once('error', () => { void cleanup(path) })
  gen.once('exit', (code, signal) => {
    // Unlink only after the worker stops: a canceled renderer may write a late WAV.
    if (signal || request !== utterance || (voice !== gen && voice !== null)) { void cleanup(path); return }
    if (code === 0) play(path)
    else { void cleanup(path); track(mac(text)) }
  })
  return gen
}

// Starting a new brief stops the one still talking.
export function speak(db) {
  const text = speech(brief(db))
  const cached = ming() && ready?.text === text ? ready : null
  if (cached) ready = null
  stop()
  if (cached) {
    play(cached.path)
  } else say(text)
  return text
}

export function stop() {
  utterance++
  const was = !!voice
  voice?.kill()
  voice = null
  rendering?.kill()
  rendering = null
  if (ready) { void cleanup(ready.path); ready = null }
  return was
}

export const speaking = () => !!voice

function track(p) {
  voice = p
  p.on('exit', () => { if (voice === p) voice = null })
  p.on('error', () => { if (voice === p) voice = null })
  return p
}

function mac(text) {
  const process = spawn('say', config.voice ? ['-v', config.voice] : [], { stdio: ['pipe', 'ignore', 'ignore'] })
  // Answer text is data, even when it starts with a speech command option.
  process.stdin.on('error', () => {}) // Stopping speech can close the pipe early.
  process.stdin.end(String(text))
  return process
}
