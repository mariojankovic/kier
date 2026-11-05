import { evidenceTrust, ownerAuthored, EVIDENCE_RULE } from './evidence-trust.mjs'
import { childDiagnostics } from './errors.mjs'
import { sidecarFetch, sockets } from './sidecar-client.mjs'
import { sidecarToken } from './sidecar-auth.mjs'
// Second opinion: d1-2B double-checks the messages Qwen marked as tasks. When both agree, the task goes in the brief;
// when d1 doubts it, it becomes a "maybe". The threshold controls which tasks wait for confirmation.
import { managedSpawn as spawn } from './child-process.mjs'
import { existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { config, dataDir } from './config.mjs'
import { actionCard, replyQuestion } from './owner-action.mjs'

export const SECOND = {
  // Below this, d1 thinks the message probably is not the owner’s to act on.
  threshold: 0.15,
  // Seconds without a question before d1 unloads itself, giving back its memory. Checks come in bursts while messages
  // arrive, minutes apart: 5 minutes keeps it through a burst and frees it in the gaps.
  idle: 300,
  ...config.secondOpinion,
  // What runs is never taken from config.json: anything there would run with Kier's Full Disk Access.
  socket: sockets.decision,
  python: resolve(dataDir, 'py/bin/python'),
  model: resolve(dataDir, 'models/d1-2B'),
}
const SCRIPT = resolve(new URL('../sidecar/d1_server.py', import.meta.url).pathname)
let child = null
let log = () => {}
let hooked = false

export const installed = () => existsSync(SECOND.python) && existsSync(resolve(SECOND.model, 'model.safetensors'))

export async function up() {
  try { return (await sidecarFetch('decision', '/health', { signal: AbortSignal.timeout(1500) })).ok } catch { return false }
}

// Where the sidecar's lines go. It isn't loaded until there is something to check (see ready()).
export const logTo = (fn) => { log = fn }

// Stopped with the daemon, or by itself once idle; ready() starts it again.
function start() {
  if (child || !installed()) return
  child = spawn(SECOND.python, ['-I', '-E', SCRIPT, SECOND.model, SECOND.socket], {
    env: {
      KIER_SIDECAR_TOKEN: sidecarToken(), HF_HUB_OFFLINE: '1', TRANSFORMERS_OFFLINE: '1', TOKENIZERS_PARALLELISM: 'false', KIER_IDLE: String(SECOND.idle),
      KIER_OWNER: config.me, KIER_PRONOUN: config.pronoun, ...(config.decisionAbout && { KIER_DECISION_ABOUT: config.decisionAbout }),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  childDiagnostics(child, log)
  child.on('exit', (code) => { log(`second opinion stopped (${code})`); child = null })
  if (hooked) return
  hooked = true
  process.once('exit', () => child?.kill())
  process.once('SIGTERM', () => { child?.kill(); process.exit(0) })
}

// Up already, or loaded now (15 to 60 seconds, slower when memory is tight); false when it isn't installed or doesn't come up.
async function ready() {
  if (await up()) return true
  start()
  for (const end = Date.now() + 180000; child && Date.now() < end;) {
    await new Promise((r) => setTimeout(r, 1000))
    if (await up()) return true
  }
  return false
}

const label = { whatsapp: 'WhatsApp', imessage: 'iMessage', mail: 'Email', notifications: 'Notification' }
const sent = (ts) => {
  const p = new Intl.DateTimeFormat('en-GB', { timeZone: config.timezone, weekday: 'short', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false })
    .formatToParts(new Date(ts * 1000)).reduce((o, x) => ({ ...o, [x.type]: x.value }), {})
  return `${p.weekday} ${p.year}-${p.month}-${p.day} ${p.hour}:${p.minute}`
}

// Any typed questions over any states, for judgements beyond "is this a task" (card types, what an app is for).
export async function ask(states, questions) {
  if (!states.length || !(await ready())) return null
  const out = []
  for (let i = 0; i < states.length; i += 16) {
    const res = await sidecarFetch('decision', '/ask', { method: 'POST', body: JSON.stringify({ states: states.slice(i, i + 16), questions }), signal: AbortSignal.timeout(120000) })
    if (!res.ok) return null
    out.push(...(await res.json()).answers)
  }
  return out
}

export function decisionMessage(i) {
  let meta = {}
  try { meta = typeof i.meta === 'string' ? JSON.parse(i.meta || '{}') : i.meta || {} } catch {}
  const where = i.source === 'mail' ? `to ${meta.to || 'me'}` : i.source === 'notifications' ? `notification from the ${i.thread} app`
    // Group names are labels, not topics; see prompt() in tagger.mjs.
    : meta.group ? 'a group chat' : `chat with ${i.thread}`
  const context = (Array.isArray(i.context) ? i.context : []).slice(-8).map(c => ({
    trust: c.trust || evidenceTrust({ source: i.source }), time: String(c.time || ''), from: String(c.from || ''), text: String(c.text || '').slice(0, 300),
  })).filter(c => c.text)
  return { trust: evidenceTrust(i), source: label[i.source] || i.source, where, sent: sent(i.ts), from: i.sender, from_me: ownerAuthored(i), text: i.text,
    ...(context.length && { context }) }
}

// What kind of card a task is. Payments and promises are plain facts; d1 tells the rest apart.
const CARD = { card: { type: 'choice', instructions: `${EVIDENCE_RULE} What does ${config.me} have to do because of the message to judge?`, criteria: {
  appointment: 'Be somewhere, or join a call or meeting, at a set time',
  reply: 'Answer a question or give a decision someone is waiting for',
  todo: 'Do, send, fix, check or buy something',
} } }

export async function cards(items) {
  // a direct answer or permission question does not need a model vote.
  const replies = new Set(items.filter(i => replyQuestion(i)).map(i => i.id))
  const open = items.filter((i) => !i.from_me && !i.amount && !replies.has(i.id))
  const answers = open.length ? await ask(open.map((i) => {
    const m = decisionMessage(i)
    return { source: m.source, chat: m.where, sent: m.sent, ...(m.context && { earlier_messages: m.context }),
      message_to_judge: { trust: m.trust, from: m.from, text: m.text } }
  }), CARD) : []
  if (open.length && !answers) return null
  const picked = new Map(open.map((i, n) => [i.id, answers[n]?.card?.choice || 'todo']))
  return items.map((i) => actionCard(i.from_me ? 'promise' : i.amount ? 'payment' : replies.has(i.id) ? 'reply' : picked.get(i.id), i))
}

// Probabilities that each item is the owner's to act on, or null when the second opinion isn't available.
export async function decide(items) {
  if (!items.length || !(await ready())) return null
  const messages = items.map(decisionMessage)
  const res = await sidecarFetch('decision', '/decide', { method: 'POST', body: JSON.stringify({ messages }), signal: AbortSignal.timeout(120000) })
  return res.ok ? (await res.json()).p_task : null
}
