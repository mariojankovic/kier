import { resolve } from 'node:path'
import { config, home } from '../lib/config.mjs'
import { addItems, cursor, now, setCursor } from '../lib/db.mjs'
import { redact } from '../lib/redact.mjs'
import { contactFor, nameFor } from './contacts.mjs'
import { APPLE_EPOCH, snapshot } from './util.mjs'

// iMessage and SMS from the iPhone arrive here through Messages in iCloud.
export const source = 'imessage'
const PATH = resolve(home, 'Library/Messages/chat.db')

// Newer macOS versions keep the text only inside attributedBody, an NSArchiver blob.
export function bodyText(blob) {
  if (!blob) return null
  const b = Buffer.from(blob)
  const at = b.indexOf('NSString')
  if (at < 0) return null
  const p = b.indexOf(0x2b, at)
  if (p < 0) return null
  let len = b[p + 1]
  let start = p + 2
  if (len === 0x81) { len = b.readUInt16LE(p + 2); start = p + 4 }
  else if (len === 0x82) { len = b.readUIntLE(p + 2, 3); start = p + 5 }
  return b.subarray(start, start + len).toString('utf8')
}

export function collect(db) {
  const im = snapshot(PATH, source)
  try {
    const since = Number(cursor(db, source, 0))
    const cutoff = (now() - config.backfillDays * 86400 - APPLE_EPOCH) * 1e9
    // associated_message_type 0 drops tapbacks; item_type 0 drops group renames and other events. Dates are nanoseconds
    // since 2001, past what a JavaScript number holds exactly (beyond exact JavaScript integer precision), so SQLite turns
    // them into seconds.
    const rows = im.db.prepare(`
      select m.ROWID id, m.text, m.attributedBody body, m.is_from_me me, case when m.date > 1e9000 then m.date / 1e9 else m.date end date, m.service, h.id handle,
        c.display_name chat_name, c.chat_identifier chat_id, c.style
      from message m
      left join handle h on h.ROWID = m.handle_id
      left join chat_message_join j on j.message_id = m.ROWID
      left join chat c on c.ROWID = j.chat_id
      where m.ROWID > ? and m.date > ? and m.associated_message_type = 0 and m.item_type = 0
      order by m.ROWID`).all(since, cutoff)
    const items = []
    for (const r of rows) {
      const raw = (r.text || bodyText(r.body) || '').replace(/￼/g, '').trim()
      if (!raw) continue
      const group = r.style === 43
      const thread = r.chat_name || nameFor(r.chat_id || r.handle)
      const person = group ? { known: false, aliases: [] } : contactFor(r.chat_id || r.handle, thread)
      if (config.blockedChats.includes(thread)) continue
      const { text, found } = redact(raw)
      items.push({
        id: `${source}:${r.id}`, source, thread, fromMe: r.me === 1,
        sender: r.me ? config.me : nameFor(r.handle),
        ts: Math.floor(r.date + APPLE_EPOCH), text,
        url: !group && r.handle ? `imessage://${r.handle}` : null,
        meta: { group, service: r.service, handle: r.chat_id || r.handle, contactKnown: person.known, contactId: person.id, contactName: person.name, contactAliases: person.aliases, ...(found.length && { redacted: found }) },
      })
    }
    const added = addItems(db, items)
    if (rows.length) setCursor(db, source, rows.at(-1).id)
    return added
  } finally {
    im.close()
  }
}
