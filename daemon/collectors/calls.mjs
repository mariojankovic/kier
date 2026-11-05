import { resolve } from 'node:path'
import { config, home } from '../lib/config.mjs'
import { addItems, cursor, now, setCursor } from '../lib/db.mjs'
import { contactFor, nameFor } from './contacts.mjs'
import { forgotten, keep } from '../lib/privacy.mjs'
import { APPLE_EPOCH, minutes, snapshot } from './util.mjs'

// The iPhone's phone and FaceTime recents sync to the Mac when "Calls on Other Devices" is on; WhatsApp
// calls don't. This is what tells Kier a call actually happened.
export const source = 'calls'
const PATH = resolve(home, 'Library/Application Support/CallHistoryDB/CallHistory.storedata')
const APPS = { 'com.apple.Telephony': 'phone', 'com.apple.FaceTime': 'FaceTime', 'net.whatsapp.WhatsApp': 'WhatsApp', 'com.viber': 'Viber' }

export function collect(db) {
  const ch = snapshot(PATH, source)
  try {
    const since = Number(cursor(db, source, 0))
    const cutoff = now() - config.backfillDays * 86400 - APPLE_EPOCH
    const fields = 'Z_PK id, ZDATE date, ZDURATION dur, ZADDRESS addr, ZNAME name, ZORIGINATED out, ZANSWERED answered, ZSERVICE_PROVIDER provider'
    const fresh = ch.db.prepare(`select ${fields} from ZCALLRECORD where Z_PK > ? and ZDATE > ? order by Z_PK`).all(since, cutoff)
    // CallHistory can fill duration/answer state after a row was first collected. Revisit a
    // bounded day of existing records as well as new IDs so that update can settle a callback.
    const recent = ch.db.prepare(`select ${fields} from ZCALLRECORD where Z_PK <= ? and ZDATE > ? order by ZDATE desc limit 256`)
      .all(since, Math.max(cutoff, now() - 86400 - APPLE_EPOCH))
    const rows = [...recent, ...fresh]
    const items = rows.map((r) => {
      const addr = r.addr == null ? '' : Buffer.isBuffer(r.addr) || r.addr instanceof Uint8Array ? Buffer.from(r.addr).toString('utf8') : String(r.addr)
      const person = contactFor(addr, r.name)
      const who = r.name || person.name || nameFor(addr)
      const app = APPS[r.provider] || r.provider || 'phone'
      // Zero seconds means nobody talked: a missed or declined call, or one you made that wasn't picked up.
      const talked = r.dur > 0
      const text = r.out
        ? talked ? `Called ${who} on ${app} (${minutes(r.dur)})` : `Tried to call ${who} on ${app}, no answer`
        : talked ? `${who} called on ${app} (${minutes(r.dur)})` : `Missed ${app} call from ${who}`
      return { id: `${source}:${r.id}`, source, thread: who, sender: r.out ? config.me : who, fromMe: r.out === 1, ts: Math.floor(r.date + APPLE_EPOCH), text, meta: { app, seconds: r.dur, answered: !!r.answered, out: r.out === 1, handle: addr, contactKnown: person.known, contactId: person.id, contactName: person.name, contactAliases: person.aliases } }
    })
    const result = refreshCallItems(db, items)
    if (fresh.length) setCursor(db, source, fresh.at(-1).id)
    return result.added + result.updated
  } finally {
    ch.close()
  }
}

// New rows still go through the normal privacy filter; refresh only changes an existing
// raw call and never its tags or the owner's task state.
export function refreshCallItems(db, items) {
  const gone = forgotten(db)
  const allowed = items.filter(item => item.source === source && /^calls:\d+$/.test(item.id) && keep(item, gone))
  const added = addItems(db, allowed)
  const get = db.prepare("select thread, sender, from_me, ts, text, meta from items where id = ? and source = 'calls' and coalesce(json_extract(meta, '$.kind'), '') != 'callback'")
  const update = db.prepare("update items set thread = ?, sender = ?, from_me = ?, ts = ?, text = ?, meta = ? where id = ? and source = 'calls' and coalesce(json_extract(meta, '$.kind'), '') != 'callback'")
  let updated = 0
  for (const item of allowed) {
    const old = get.get(item.id)
    if (!old) continue
    const values = [item.thread ?? null, item.sender ?? null, item.fromMe ? 1 : 0, item.ts, item.text ?? null, item.meta ? JSON.stringify(item.meta) : null]
    if ([old.thread, old.sender, old.from_me, old.ts, old.text, old.meta].every((value, i) => value === values[i])) continue
    updated += Number(update.run(...values, item.id).changes)
  }
  return { added, updated }
}
