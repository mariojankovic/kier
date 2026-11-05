// A callback's source is call history, but its timing may come from a later chat.
// Keep that actual evidence together instead of showing nearby, unrelated work.
import { now } from './db.mjs'
import { isOff } from './settings.mjs'
import { callConnected, identityFor } from './contact-identity.mjs'
import { contactFor } from '../collectors/contacts.mjs'

const metaOf = item => { try { return typeof item?.meta === 'string' ? JSON.parse(item.meta || '{}') : item?.meta || {} } catch { return {} } }
const rawCall = row => row?.source === 'calls' && metaOf(row).kind !== 'callback'

export function callbackContext(db, item, tag = null, { resolveContact = contactFor } = {}) {
  const meta = metaOf(item)
  if (item?.source !== 'calls' || meta.kind !== 'callback') return null
  if (isOff('calls')) return { error: 'source off' }
  const get = db.prepare('select id, source, thread, sender, from_me, ts, text, url, meta from items where id = ?')
  const first = get.get(meta.firstCall || '')
  const latest = get.get(meta.lastMissedId || '')
  const connected = get.get(meta.connectedCall || '')
  const sameContact = row => {
    let contact = identityFor(row)
    const details = metaOf(row)
    if (!contact.known && details.contactKnown == null && !details.group) {
      let saved
      try { saved = resolveContact(details.handle || null, row.thread) } catch {}
      if (saved?.known) contact = identityFor({ ...row, meta: { ...details, contactKnown: true, contactId: saved.id, contactName: saved.name, contactAliases: saved.aliases } })
    }
    const expected = meta.contactKey || identityFor(item).key
    // Explicit anchors can be old rows without contact metadata. A connected call
    // needs the same canonical saved contact, so names alone cannot become proof.
    return !!expected && contact.known && contact.key === expected
  }
  const starts = Math.max(first?.ts || item.ts, Number(meta.promiseTs) || 0)
  const proof = rawCall(connected) && connected.ts >= starts && callConnected(connected) && sameContact(connected) ? connected : null
  const settled = db.prepare("select changed_at from task_state where item_id = ? and status not in ('open', 'snoozed')").get(item.id)
  const until = proof?.ts || settled?.changed_at || now()
  const rows = new Map()
  const add = row => { if (row && row.id !== proof?.id) rows.set(row.id, row) }
  if (rawCall(first)) add(first)
  if (rawCall(latest)) add(latest)
  // Include recent failed attempts too. They remain evidence of trying, never of completion.
  if (meta.contactId) {
    for (const row of db.prepare(`select id, source, thread, sender, from_me, ts, text, url, meta from items
      where source = 'calls' and json_extract(meta, '$.contactId') = ? and ts between ? and ?
      and coalesce(json_extract(meta, '$.kind'), '') != 'callback' order by ts desc, rowid desc limit 8`)
      .all(meta.contactId, first?.ts || item.ts, until)) add(row)
  }
  const promise = get.get(meta.promiseId || '')
  const showPromise = promise && ['whatsapp', 'imessage'].includes(promise.source)
    && !isOff(promise.source) && promise.from_me && !metaOf(promise).group
  if (showPromise) {
    // A few direct-chat neighbours explain terse promises such as "after lunch".
    const fields = 'id, source, thread, sender, from_me, ts, text, url, meta'
    const before = db.prepare(`select ${fields} from items where source = ? and thread = ?
      and ts >= ? and ts <= ? and id != ? order by ts desc, rowid desc limit 3`)
      .all(promise.source, promise.thread, promise.ts - 1800, promise.ts, promise.id)
    const after = db.prepare(`select ${fields} from items where source = ? and thread = ?
      and ts > ? and ts <= ? order by ts, rowid limit 3`)
      .all(promise.source, promise.thread, promise.ts, promise.ts + 1800)
    for (const row of [...before, promise, ...after]) if (!metaOf(row).group) add(row)
  }
  const picked = new Set([first?.id, latest?.id, showPromise ? promise.id : null])
  const cleanTag = meta.promiseId && !showPromise && tag ? { ...tag, said: null, due: '', when_words: '' } : tag
  return {
    item: { ...item, from_me: !!item.from_me }, tag: cleanTag,
    messages: [...rows.values()].sort((a, b) => a.ts - b.ts || a.id.localeCompare(b.id)).map(row => ({
      id: row.id, sender: row.sender, from_me: !!row.from_me, ts: row.ts, text: row.text, picked: picked.has(row.id),
    })),
    since: proof ? [{ line: proof.text, url: proof.url || null }] : [],
  }
}
