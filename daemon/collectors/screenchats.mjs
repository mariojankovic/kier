import { createHash } from 'node:crypto'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { config, dataDir } from '../lib/config.mjs'
import { addItems, cursor, setCursor } from '../lib/db.mjs'
import { redact } from '../lib/redact.mjs'

// Convert Accessibility captures into messages with author, time and conversation, including
// outgoing messages absent from notifications. Carry the last speaker across small captures.
export const source = 'screenchats'
// Discord keeps its own source (and switch in Setup); every other chat app's messages come in as "chat".
const APPS = { Discord: 'discord' }
// Headings combine a display name, optional server badge and timestamp.
const HEADER = /^(.{1,40}?)(?: Server Tag: \S+)? (?:(\d{1,2})\/(\d{1,2})\/(\d{2,4}),? )?(\d{1,2}):(\d{2})\s?([AP]M)$/
// Exclude chat chrome, image-viewer controls and the edit hint from message text.
const NOISE = /^(\d{1,2}:\d{2}\s?[AP]M|\w+day, \w+ \d{1,2}, \d{4} at .+|\d+ new messages? since .+|Send GIF|(.+ )?is typing\.\.\.|(several )?people are typing\.\.\.|Copy Message ID|Copy Link|Copy Text|Mark Unread|Bookmark Message|Pin Message|Create Thread|Click to react|Add Reaction|Reply|Forward|Edit|More|Delete|Apps|Edited|\(edited\)|:[\w+-]+:|Zoom (?:In|Out)|Save Image|Copy Image|Open in Browser|Open original|Close|Download|Click to remove|(?:Modify|Remove) Attachment|Spoiler|View Reactions|Click to (?:dis|en)able pinging the original author\.?|(?:escape|esc) to cancel\s*[•·]\s*enter to save)$/i
// Older messages show their date on a line of its own, under the name: "twenty" then "10/27/26, 8:18 PM".
const STAMP = /^(\d{1,2})\/(\d{1,2})\/(\d{2,4}),? (\d{1,2}):(\d{2})\s?([AP]M)$/
const DATE = /^\d{1,2}\/\d{1,2}\/\d{2,4},?$/
// A line with no name of its own belongs to the last speaker only if it's this close in time.
const CARRY = 15 * 60
const HANDLES = resolve(dataDir, 'handles.json')

// Learn the owner’s display name in a direct chat by excluding the named remote participant.
export const handles = () => { try { return JSON.parse(readFileSync(HANDLES, 'utf8')) } catch { return {} } }
function learn(app, name) {
  const h = handles()
  const mine = new Set(h[app] || [])
  if (mine.has(name)) return
  mine.add(name)
  writeFileSync(HANDLES, JSON.stringify({ ...h, [app]: [...mine] }, null, 2))
}

const owner = (app, name) => [config.me, ...(handles()[app] || [])].some((n) => n.toLowerCase() === String(name).toLowerCase())

// Distinguish a direct-chat title from a channel and server title.
function place(app, title) {
  const t = title.replace(new RegExp(`\\s+-\\s+${app}$`), '').trim()
  if (t.startsWith('@')) return { thread: t.slice(1), group: false, dm: t.slice(1) }
  return { thread: t, group: true, dm: null }
}

function when(capture, h) {
  const at = new Date(capture * 1000)
  if (h[2]) at.setFullYear(Number(h[4]) < 100 ? 2000 + Number(h[4]) : Number(h[4]), Number(h[2]) - 1, Number(h[3]))
  at.setHours((Number(h[5]) % 12) + (h[7] === 'PM' ? 12 : 0), Number(h[6]), 0, 0)
  return Math.floor(at.getTime() / 1000)
}

// Extract the time suffix from a heading or accessible name.
const TIME = /(?:(today|yesterday)\s+at\s+)?(\d{1,2})[:.](\d{2})\s?([AP]M)?$/i
// Strip the optional date along with the time; leaving it attached would change sender identity
// and create duplicate messages.
const TIME_TAIL = /\s+(?:(?:today|yesterday)\s+at\s+|\d{1,2}[./]\d{1,2}[./]\d{2,4},?\s+)?\d{1,2}[:.]\d{2}\s?(?:[AP]M)?$/i
const DATE_TAIL = /\s+\d{1,2}[./]\d{1,2}[./]\d{2,4},?$/

// When a marked message was sent: the app's full date when it gives one ("Friday, October 30, 2026 at 10:25 AM"), else
// the time beside it on the day of the capture (or the day before, for "Yesterday at").
export function sentAt(capture, m) {
  for (const w of m.when || []) {
    const d = Date.parse(String(w).replace(/^[A-Za-z]+,\s*/, '').replace(/\s+at\s+/i, ' '))
    if (!Number.isNaN(d) && /\d{4}/.test(w)) return Math.floor(d / 1000)
  }
  const s = [...(m.when || []), String(m.name || '').split(' , ').at(-1)].map((x) => String(x || '').trim()).find((x) => TIME.test(x))
  if (!s) return capture
  const t = s.match(TIME)
  const at = new Date(capture * 1000)
  if (t[1]?.toLowerCase() === 'yesterday') at.setDate(at.getDate() - 1)
  const pm = t[4]?.toUpperCase() === 'PM'
  at.setHours(t[4] ? (Number(t[2]) % 12) + (pm ? 12 : 0) : Number(t[2]), Number(t[3]), 0, 0)
  return Math.floor(at.getTime() / 1000)
}

// An accessible heading identifies the author. A message without one continues that author’s group.
export function marked(capture, messages, cur) {
  const out = []
  for (const m of messages) {
    const sender = String(m.heading || '').replace(TIME_TAIL, '').replace(DATE_TAIL, '').replace(/ Server Tag: \S+$/, '').trim()
    const ts = sentAt(capture, m)
    if (sender) cur = { sender, ts }
    else if (!cur || Math.abs(ts - cur.ts) > CARRY) continue
    const text = ownWords(m, (m.text || []).map((l) => String(l).trim()).filter((l) => l && !NOISE.test(l))).join(' ').trim()
    if (text) out.push({ sender: cur.sender, ts, text })
  }
  return { out, cur }
}

// A reply includes quoted context above its own words. Use its accessible reply label to keep
// only the new content, so the quoted invitation is not attributed to the responder.
export function ownWords(m, lines) {
  const parts = String(m.name || '').split(' , ')
  if (parts.length < 3 || !/ replying to /.test(parts[0])) return lines
  const said = parts.slice(1, -1).join(' , ')
  const flat = (s) => s.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '')
  if (!flat(said)) return []
  for (let i = lines.length - 1; i >= 0; i--) if (flat(lines.slice(i).join(' ')) === flat(said)) return lines.slice(i)
  return [said]
}

// Replies kept before ownWords carry the message they answer: their text goes back to their own words, and they're read
// again, as the cards made from the quote were someone else's words. Once.
function repairReplies(db) {
  // Lines that are only Discord's own words, kept before they were known as such, go too.
  if (!cursor(db, 'screenchats-noise', null)) {
    for (const r of db.prepare("select id, text from items where source in ('discord', 'chat')").all()) {
      if (!NOISE.test(String(r.text || '').trim())) continue
      db.prepare('delete from tags where item_id = ?').run(r.id)
      db.prepare('delete from items where id = ? and not exists (select 1 from task_state where item_id = ?)').run(r.id, r.id)
    }
    setCursor(db, 'screenchats-noise', 1)
  }
  if (cursor(db, 'screenchats-replies', null)) return
  const fix = db.prepare("update items set text = ? where source in ('discord', 'chat') and thread = ? and sender = ? and text = ?")
  const read = db.prepare("delete from tags where item_id in (select id from items where source in ('discord', 'chat') and thread = ? and sender = ? and text = ?) and item_id not in (select item_id from task_state)")
  for (const c of db.prepare("select ts, thread, meta from items where source = 'screen' and meta like '% replying to %'").all()) {
    const app = String(c.thread || '').split(':')[0]
    const where = place(app, String(c.thread).slice(app.length + 1).trim())
    let meta
    try { meta = JSON.parse(c.meta) } catch { continue }
    for (const m of meta.messages || []) {
      const lines = (m.text || []).map((l) => String(l).trim()).filter((l) => l && !NOISE.test(l))
      const sender = String(m.heading || '').replace(TIME_TAIL, '').replace(DATE_TAIL, '').replace(/ Server Tag: \S+$/, '').trim()
      const before = redact(lines.join(' ').trim()).text
      const after = redact(ownWords(m, lines).join(' ').trim()).text
      if (!sender || !after || before === after) continue
      read.run(where.thread, sender, before)
      fix.run(after, where.thread, sender, before)
    }
  }
  setCursor(db, 'screenchats-replies', 1)
}

export function collect(db) {
  repairReplies(db)
  const since = Number(cursor(db, source, 0))
  const captures = db.prepare("select rowid, ts, thread, text, meta from items where source = 'screen' and rowid > ? order by rowid").all(since)
  const last = new Map()
  const items = []
  const known = db.prepare('select 1 from items where source = ? and thread = ? and sender = ? and ts between ? and ? and substr(text, 1, 40) = substr(?, 1, 40) limit 1')
  for (const c of captures) {
    const app = String(c.thread || '').split(':')[0]
    const meta = (() => { try { return JSON.parse(c.meta || '{}') } catch { return {} } })()
    if (Array.isArray(meta.messages) && meta.messages.length) {
      const src = APPS[app] || 'chat'
      const where = place(app, String(c.thread).slice(app.length + 1).trim())
      const { out, cur } = marked(c.ts, meta.messages, last.get(where.thread))
      if (cur) last.set(where.thread, cur)
      for (const m of out) {
        // Already kept, from a capture before this one or before Kier read messages by their marks.
        if (known.get(src, where.thread, m.sender, m.ts - 60, m.ts + 60, m.text)) continue
        if (where.dm && m.sender !== where.dm && m.sender !== config.me) learn(app, m.sender)
        const { text } = redact(m.text)
        const id = `${src}:${createHash('sha1').update(`${where.thread}|${m.sender}|${m.ts}|${text}`).digest('hex').slice(0, 20)}`
        items.push({ id, source: src, thread: where.thread, sender: m.sender, fromMe: false, ts: m.ts, text, meta: { group: where.group, app } })
      }
      continue
    }
    const src = APPS[app]
    if (!src) continue
    const where = place(app, String(c.thread).slice(app.length + 1).trim())
    let cur = last.get(where.thread) || db.prepare('select sender, ts from items where source = ? and thread = ? order by ts desc limit 1').get(src, where.thread)
    // Lines under a name in this capture are that person's; lines before any name carry over from the last capture.
    let carried = true
    const mine = []
    for (const raw of String(c.text || '').split('\n')) {
      const line = raw.trim()
      if (!line || NOISE.test(line)) continue
      // A date on its own line names the line before it as the speaker.
      const stamp = line.match(STAMP)
      if (stamp) {
        // Only a known person's name: Discord also shows a time beside any message you hover.
        const prev = mine.at(-1)
        const name = prev?.capture === c.rowid && (prev.text === where.dm || owner(app, prev.text)) ? mine.pop().text : cur?.sender
        if (name) { cur = { sender: name, ts: when(c.ts, [null, null, stamp[1], stamp[2], stamp[3], stamp[4], stamp[5], stamp[6]]) }; carried = false }
        continue
      }
      const h = line.match(HEADER)
      if (h && !DATE.test(h[1].trim())) { cur = { sender: h[1].trim(), ts: when(c.ts, h) }; carried = false; continue }
      // A typing indicator can leave a bare participant name; preserve names that may be actual messages.
      if (line === where.dm) continue
      if (!cur || (carried && c.ts - cur.ts > CARRY)) continue
      if (where.dm && cur.sender !== where.dm && cur.sender !== config.me && !DATE.test(cur.sender)) learn(app, cur.sender)
      const { text } = redact(line)
      const id = `${src}:${createHash('sha1').update(`${where.thread}|${cur.sender}|${cur.ts}|${text}`).digest('hex').slice(0, 20)}`
      mine.push({ id, source: src, thread: where.thread, sender: cur.sender, fromMe: false, ts: cur.ts, text, capture: c.rowid,
        meta: { group: where.group, app } })
    }
    if (cur) last.set(where.thread, cur)
    items.push(...mine.map(({ capture, ...i }) => i))
  }
  // Whose lines are whose is settled last, once this round's DMs have taught Kier the owner's name.
  for (const i of items) i.fromMe = owner(i.meta.app, i.sender)
  const added = addItems(db, items)
  if (captures.length) setCursor(db, source, captures.at(-1).rowid)
  return added
}
