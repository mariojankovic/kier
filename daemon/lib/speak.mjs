// The brief, read out loud. Ming 3.0 (0.5B, local, MIT) when it's installed; macOS's own voice otherwise, which
// works on any Mac with nothing to download. The brief is rendered ahead of time, so pressing play is instant.
import { managedSpawn as spawn } from './child-process.mjs'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
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
const READY = resolve(tmpDir, 'kier-brief')
let voice = null
let rendering = null

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
const readyText = () => { try { return readFileSync(`${READY}.txt`, 'utf8') } catch { return null } }

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
  if (readyText() === text) return false
  rendering = render(text, 'kier-brief-next')
  rendering.on('exit', (code) => {
    rendering = null
    if (code !== 0) return
    try {
      writeFileSync(`${READY}.wav`, readFileSync(resolve(tmpDir, 'kier-brief-next.wav')))
      writeFileSync(`${READY}.txt`, text)
    } catch {}
  })
  return true
}

// Says any text, for the companion's answers and nudges; the same voice as the brief.
export function say(text) {
  stop()
  if (!ming()) return track(mac(text))
  const prefix = `kier-say-${process.pid}`
  const gen = track(render(text, prefix))
  gen.on('exit', (code, signal) => {
    // Stopped while it was still rendering: stay quiet, don't fall back to the Mac voice.
    if (signal || (voice !== gen && voice !== null)) return
    track(code === 0 ? spawn('afplay', [resolve(tmpDir, `${prefix}.wav`)], { stdio: 'ignore' }) : mac(text))
  })
  return gen
}

// Starting a new brief stops the one still talking.
export function speak(db) {
  const text = speech(brief(db))
  stop()
  if (ming() && readyText() === text) track(spawn('afplay', [`${READY}.wav`], { stdio: 'ignore' }))
  else say(text)
  return text
}

export function stop() {
  const was = !!voice
  voice?.kill()
  voice = null
  return was
}

export const speaking = () => !!voice

function track(p) {
  voice = p
  p.on('exit', () => { if (voice === p) voice = null })
  return p
}

function mac(text) {
  const process = spawn('say', config.voice ? ['-v', config.voice] : [], { stdio: ['pipe', 'ignore', 'ignore'] })
  // Answer text is data, even when it starts with a speech command option.
  process.stdin.on('error', () => {}) // Stopping speech can close the pipe early.
  process.stdin.end(String(text))
  return process
}
