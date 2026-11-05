import { resolve } from 'node:path'
import { config, home } from '../lib/config.mjs'
import { addItems, cursor, now, setCursor } from '../lib/db.mjs'
import { redact } from '../lib/redact.mjs'
import { contactFor } from './contacts.mjs'
import { isOff } from '../lib/settings.mjs'
import { APPLE_EPOCH, minutes, snapshot } from './util.mjs'

export const source = 'whatsapp'
const PATH = resolve(home, 'Library/Group Containers/group.net.whatsapp.WhatsApp.shared/ChatStorage.sqlite')

export function collect(db) {
  const wa = snapshot(PATH, source)
  try {
    const since = Number(cursor(db, source, 0))
    const cutoff = now() - config.backfillDays * 86400 - APPLE_EPOCH
    // Type 0 is a text message; system notices, receipts and media without captions are skipped.
    const rows = wa.db.prepare(`
      select m.Z_PK pk, c.ZPARTNERNAME chat, c.ZCONTACTJID jid, m.ZISFROMME me, m.ZMESSAGEDATE date, m.ZTEXT text,
        (select p.ZPUSHNAME from ZWAGROUPMEMBER g join ZWAPROFILEPUSHNAME p on p.ZJID = g.ZMEMBERJID where g.Z_PK = m.ZGROUPMEMBER) push
      from ZWAMESSAGE m join ZWACHATSESSION c on c.Z_PK = m.ZCHATSESSION
      where m.Z_PK > ? and m.ZMESSAGEDATE > ? and m.ZMESSAGETYPE = 0 and m.ZTEXT is not null
      order by m.Z_PK`).all(since, cutoff)
    // Resolve numeric mention identifiers with WhatsApp profile names so the reader and tagger
    // can identify the recipient.
    const names = new Map(wa.db.prepare('select ZJID jid, ZPUSHNAME name from ZWAPROFILEPUSHNAME where ZPUSHNAME is not null').all()
      .map((p) => [String(p.jid).split('@')[0], p.name]))
    const items = []
    for (const r of rows) {
      const chat = (r.chat || '').replace(/[‪‬]/g, '').trim()
      if (config.blockedChats.includes(chat)) continue
      const group = (r.jid || '').endsWith('@g.us')
      const person = group ? { known: false, aliases: [] } : contactFor(r.jid, chat)
      const { text, found } = redact(mentions(r.text.trim(), names))
      items.push({
        id: `${source}:${r.pk}`, source, thread: chat, fromMe: r.me === 1,
        sender: r.me ? config.me : group ? r.push || 'someone' : chat,
        ts: Math.floor(r.date + APPLE_EPOCH), text,
        url: !group && r.jid ? `whatsapp://send?phone=${r.jid.split('@')[0]}` : null,
        meta: { group, ...(!group && { handle: r.jid, contactKnown: person.known, contactId: person.id, contactName: person.name, contactAliases: person.aliases }), ...(found.length && { redacted: found }) },
      })
    }
    const added = addItems(db, items)
    if (rows.length) setCursor(db, source, rows.at(-1).pk)
    return added + (isOff('calls') ? 0 : calls(db, wa.db, cutoff))
  } finally {
    wa.close()
  }
}

// Read WhatsApp calls from its own call log; system call history does not include them.
// A chat entry of type 59 identifies the call, outcome and duration. Answered elsewhere
// counts as contact even when no duration is recorded.
const OUTCOME = { 0: 'connected', 1: 'missed', 2: 'failed', 3: 'declined', 4: 'elsewhere', 5: 'ongoing', 6: 'silenced', 7: 'silenced' }
const CALLS = 'whatsapp-calls'

function calls(db, wa, cutoff) {
  const rows = wa.prepare(`
    select m.Z_PK pk, c.ZPARTNERNAME chat, c.ZCONTACTJID jid, m.ZISFROMME me, m.ZMESSAGEDATE date, i.ZMETADATA record
    from ZWAMESSAGE m join ZWACHATSESSION c on c.Z_PK = m.ZCHATSESSION left join ZWAMEDIAITEM i on i.Z_PK = m.ZMEDIAITEM
    where m.Z_PK > ? and m.ZMESSAGEDATE > ? and m.ZMESSAGETYPE = 59 order by m.Z_PK`).all(Number(cursor(db, CALLS, 0)), cutoff)
  const items = []
  let last = null
  for (const r of rows) {
    const call = r.record && callRecord(Buffer.from(r.record))
    // A call still going is read again once it has ended and has a length.
    if (call?.outcome === 'ongoing') break
    last = r.pk
    const chat = (r.chat || '').replace(/[‪‬]/g, '').trim()
    if (!call || config.blockedChats.includes(chat)) continue
    const group = (r.jid || '').endsWith('@g.us')
    const person = group ? { known: false, aliases: [] } : contactFor(r.jid, chat)
    const app = call.video ? 'WhatsApp video' : 'WhatsApp'
    const talked = call.outcome === 'elsewhere' || (call.outcome === 'connected' && call.seconds > 0)
    const text = r.me
      ? talked ? `Called ${chat} on ${app} (${minutes(call.seconds)})` : `Tried to call ${chat} on ${app}, no answer`
      : call.outcome === 'elsewhere' ? `${chat} called on ${app}, answered on another device`
        : talked ? `${chat} called on ${app} (${minutes(call.seconds)})` : `Missed ${app} call from ${chat}`
    items.push({ id: `calls:whatsapp:${r.pk}`, source: 'calls', thread: chat, sender: r.me ? config.me : chat, fromMe: r.me === 1,
      ts: Math.floor(r.date + APPLE_EPOCH), text, meta: { app, group, seconds: call.seconds, answered: talked, talked, outcome: call.outcome, out: r.me === 1, handle: r.jid, contactKnown: person.known, contactId: person.id, contactName: person.name, contactAliases: person.aliases } })
  }
  const added = addItems(db, items)
  if (last) setCursor(db, CALLS, last)
  return added
}

// The record is a protobuf: field 87 holds the call log, whose field 1 is { 1: video, 2: outcome, 3: seconds }.
export function callRecord(buf) {
  const log = field(buf, 87)
  const call = log && field(log, 1)
  if (!call) return null
  const f = fields(call)
  return { video: f.get(1) === 1, outcome: OUTCOME[f.get(2) ?? 0] || 'unknown', seconds: f.get(3) || 0 }
}

// Just enough protobuf: varints and length-delimited fields, the first of each number.
function fields(buf) {
  const out = new Map()
  let i = 0
  const varint = () => { let v = 0, s = 0, b; do { b = buf[i++]; v += (b & 0x7f) * 2 ** s; s += 7 } while (b & 0x80 && i < buf.length); return v }
  while (i < buf.length) {
    const tag = varint(), n = Math.floor(tag / 8), wire = tag % 8
    let value
    if (wire === 0) value = varint()
    else if (wire === 2) { const len = varint(); value = buf.subarray(i, i + len); i += len }
    else if (wire === 1) { i += 8; continue } else if (wire === 5) { i += 4; continue } else break
    if (!out.has(n)) out.set(n, value)
  }
  return out
}
const field = (buf, n) => { const v = fields(buf).get(n); return Buffer.isBuffer(v) ? v : null }

export const mentions = (text, names) => text.replace(/@(\d{6,})\b/g, (m, id) => (names.get(id) ? `@${names.get(id)}` : m))
