// A known person's missed calls make one callback episode. Only an actual connected
// call settles it; trying again, a chat reply, or a promise never proves completion.
import { createHash } from 'node:crypto'
import { addItems, cursor, now, setCursor } from './db.mjs'
import { isOff } from './settings.mjs'
import { identityFor, callConnected, normalizePerson } from './contact-identity.mjs'
import { contactFor } from '../collectors/contacts.mjs'

const DAY = 86400
const MAX = 14 * DAY
const metaOf = item => { try { return typeof item.meta === 'string' ? JSON.parse(item.meta || '{}') : item.meta || {} } catch { return {} } }
const hash = value => createHash('sha1').update(value).digest('hex').slice(0, 16)

export const CALLBACKS_SINCE = 'callbacks-since'
export function initializeCallbacks(db, { at = now() } = {}) {
  const saved = Number(cursor(db, CALLBACKS_SINCE, NaN))
  if (Number.isFinite(saved) && saved >= 0) return saved
  const since = Math.floor(at)
  setCursor(db, CALLBACKS_SINCE, since)
  return since
}

function cleanupHistory(db, since) {
  const rows = db.prepare(`select i.id, i.thread, i.sender, i.ts, i.meta, t.summary, t.confirmed, s.status
    from items i join tags t on t.item_id = i.id left join task_state s on s.item_id = i.id
    where i.source = 'calls' and json_extract(i.meta, '$.kind') = 'callback'
    and t.model = 'callback' and i.ts <= ?`).all(since)
  const hide = db.prepare("update tags set is_task = 0, model = 'callback-history' where item_id = ?")
  let suppressed = 0
  for (const row of rows) {
    const meta = metaOf(row)
    // Mine, a renamed card, or any direct owner state is an intentional choice.
    if (row.confirmed || (row.status && row.status !== 'handled')
      || row.summary !== `Call ${meta.contactName || row.thread || row.sender} back`) continue
    const promise = meta.promiseId && db.prepare(`select i.*, t.summary, t.is_task, t.model, s.status promise_status from items i
      join tags t on t.item_id = i.id left join task_state s on s.item_id = i.id where i.id = ?`).get(meta.promiseId)
    // A real owner promise remains owned work, even when its original missed call predates activation.
    if (promise?.from_me && !metaOf(promise).group && callIntent(promise)
      && (!promise.promise_status || ['open', 'snoozed'].includes(promise.promise_status))
      && (promise.is_task === 1 || promise.model === 'callback-promise')) continue
    suppressed += Number(hide.run(row.id).changes)
  }
  return suppressed
}

function identity(item, resolveContact = contactFor) {
  const meta = metaOf(item)
  if (meta.group) {
    if (item.from_me) return { key: '', aliases: [], known: false, name: '' }
    item = { ...item, thread: item.sender, meta: { ...meta, contactName: undefined, contactId: undefined, contactAliases: [] } }
  }
  let info = identityFor(item)
  // Old call rows have a display name but no known-contact flag. Only an exact,
  // unique saved Contacts lookup can grant the same standing as newer metadata.
  if (item.source === 'calls' && meta.contactKnown == null && !info.known) {
    let contact
    try { contact = resolveContact(meta.handle || null, item.thread) } catch {}
    if (contact?.known) info = identityFor({ ...item, meta: { ...meta, contactKnown: true,
      contactId: contact.id, contactName: contact.name, contactAliases: contact.aliases } })
  }
  return info
}

export function callIntent(row) {
  if (!row || !['whatsapp', 'imessage', 'discord', 'chat', 'notifications'].includes(row.source)) return false
  const summary = String(row.summary || '').trim()
  if (/^call (?:the )?(?:api|endpoint|function|method|tool|constructor)\b/i.test(summary)) return false
  return /^(?:call\b|phone\b|ring\b|return\b.{0,45}\bcall\b)/i.test(summary)
}

function contactsIndex(rows, resolveContact) {
  const people = new Map(), aliases = new Map()
  for (const row of rows) {
    const info = identity(row, resolveContact)
    if (!info.known || !info.key) continue
    let person = people.get(info.key)
    if (!person) { person = { ...info, aliases: new Set() }; people.set(info.key, person) }
    for (const alias of info.aliases) {
      person.aliases.add(alias)
      if (!aliases.has(alias)) aliases.set(alias, new Set())
      aliases.get(alias).add(info.key)
    }
  }
  return { people, aliases }
}
function personKey(row, index, resolveContact) {
  if (metaOf(row).contactKnown === false) return null
  const info = identity(row, resolveContact)
  if (info.known && info.key.startsWith('contact:')) return index.people.has(info.key) ? info.key : null
  if (info.known && index.people.has(info.key)) return info.key
  const possible = new Set()
  for (const alias of info.aliases) {
    const keys = index.aliases.get(alias)
    if (keys?.size === 1) possible.add([...keys][0])
    else if (keys?.size > 1) return null
  }
  return possible.size === 1 ? [...possible][0] : null
}
function targetFits(row, key, index) {
  const person = index.people.get(key)
  if (!person) return false
  const title = normalizePerson(row.summary)
  const target = title.replace(/^(?:call|phone|ring)(?: back)? |^return /, '')
  const startsWithName = name => target === name || [' ', "'", '’', ','].some(boundary => target.startsWith(name + boundary))
  if ([...person.aliases].some(alias => alias && startsWithName(alias))) return true
  // A shortened first name is safe only when unique among these known contacts.
  const first = normalizePerson(person.name).split(' ')[0]
  if (first?.length > 1 && startsWithName(first)
    && [...index.people.values()].filter(p => normalizePerson(p.name).split(' ')[0] === first).length === 1) return true
  // No named third party: a direct-chat promise/request to call back, or simply call tomorrow.
  return /^(?:call|phone|ring)(?:\s+(?:back|me|you|today|tomorrow|tonight|on|at|after|before|this|next|in|once)\b|$)|^return (?:the |my |your )?call\b/.test(title)
}

const incoming = row => {
  const meta = metaOf(row)
  return !row.from_me && !['outgoing', 'outbound'].includes(String(meta.direction || '').toLowerCase())
}
const missed = row => incoming(row) && !callConnected(row)
const label = row => metaOf(row).contactName || row.thread || row.sender

// Used by task rendering for an already tagged, explicit call promise. The same
// canonical contact and successful-call evidence rules apply as for callback cards.
export function callbackCompletion(db, task, { at = now(), resolveContact = contactFor } = {}) {
  if (isOff('calls') || (!callIntent(task) && metaOf(task).kind !== 'callback')) return null
  const promiseId = metaOf(task).promiseId
  const promiseAt = promiseId ? db.prepare('select ts from items where id = ?').get(promiseId)?.ts || 0 : 0
  const state = db.prepare('select status, changed_at from task_state where item_id = ?').get(task.id)
  if (state?.status === 'open') return null
  const start = Math.max(task.ts, promiseAt, state?.status === 'snoozed' ? state.changed_at : 0, at - MAX)
  const calls = db.prepare("select i.*, i.rowid ordinal from items i where source = 'calls' and ts >= ? and ts <= ? and coalesce(json_extract(meta, '$.kind'), '') != 'callback' order by ts, rowid").all(start, at)
  const index = contactsIndex(calls, resolveContact)
  const key = metaOf(task).contactKey || personKey(task, index, resolveContact)
  if (!key || (metaOf(task).kind !== 'callback' && !targetFits(task, key, index))) return null
  const firstId = metaOf(task).firstCall || task.id
  const ordinal = db.prepare('select rowid ordinal from items where id = ?').get(firstId)?.ordinal ?? Number.MAX_SAFE_INTEGER
  const proof = calls.find(call => (call.ts > start || call.ts === start && start === task.ts
    && (call.ordinal > ordinal || metaOf(task).kind === 'callback' && call.id === firstId)) && callConnected(call) && identity(call, resolveContact).known && personKey(call, index, resolveContact) === key)
  return proof ? { ...proof, seconds: Number(metaOf(proof).seconds) || 0, talked: true } : null
}

export function syncCallbacks(db, { at = now(), resolveContact = contactFor } = {}) {
  const result = { created: 0, promoted: 0, closed: 0, folded: 0 }
  // The cursor records first feature activation, even while Calls is switched off.
  const since = initializeCallbacks(db, { at })
  if (isOff('calls')) return result
  const suppressed = cleanupHistory(db, since)
  if (suppressed) result.suppressed = suppressed
  const raw = db.prepare("select i.*, i.rowid ordinal from items i where source = 'calls' and ts >= ? and ts > ? and ts <= ? and coalesce(json_extract(meta, '$.kind'), '') != 'callback' order by ts, rowid").all(at - MAX, since, at)
  const existing = db.prepare(`select i.*, t.quiet, t.confirmed, s.status, s.changed_at, s.reason, s.url evidence_url
    from items i left join tags t on t.item_id = i.id left join task_state s on s.item_id = i.id
    where i.source = 'calls' and json_extract(i.meta, '$.kind') = 'callback' and i.ts <= ?
    and coalesce(t.model, '') != 'callback-history'
    and (i.ts >= ? or s.item_id is null or s.status in ('open', 'snoozed'))`).all(at, at - MAX)
    .filter(row => row.ts > since || !row.status || ['open', 'snoozed'].includes(row.status))
  const index = contactsIndex(raw, resolveContact)
  // A contact can still be recognized when its first raw call has left the window.
  const existingIndex = contactsIndex(existing, resolveContact)
  for (const [key, person] of existingIndex.people) {
    if (!index.people.has(key)) index.people.set(key, person)
    for (const alias of person.aliases) {
      if (!index.aliases.has(alias)) index.aliases.set(alias, new Set())
      index.aliases.get(alias).add(key)
    }
  }
  const oldByFirst = new Map(existing.map(item => [metaOf(item).firstCall, item]))
  const groups = new Map()
  const addEvent = (key, event) => {
    if (!key) return
    if (!groups.has(key)) groups.set(key, [])
    groups.get(key).push(event)
  }
  const rawIds = new Set(raw.map(row => row.id))
  for (const row of raw) {
    const info = identity(row, resolveContact)
    // A raw unknown number must not gain known status just by resembling a name.
    if (!info.known) continue
    addEvent(info.key, { type: 'call', ts: row.ts, order: row.ordinal, row })
  }
  for (const row of existing) {
    const meta = metaOf(row), key = meta.contactKey || personKey(row, index, resolveContact)
    if (!rawIds.has(meta.firstCall)) addEvent(key, { type: 'seed', ts: row.ts, order: -1, row })
    if (row.status && !['open', 'snoozed'].includes(row.status)) {
      addEvent(key, { type: 'state', ts: row.changed_at, order: Number.MAX_SAFE_INTEGER, row })
    }
  }
  const promiseFields = `select i.*, t.summary, t.due, t.when_words, t.said, t.confirmed, t.model,
      t.is_task, s.status from items i join tags t on t.item_id = i.id left join task_state s on s.item_id = i.id`
  const promises = db.prepare(`${promiseFields}
    where i.from_me = 1 and i.source in ('whatsapp', 'imessage') and i.ts >= ? and i.ts <= ?
    and (t.is_task = 1 or t.model = 'callback-promise') order by i.ts, i.rowid`).all(at - MAX, at)
  const promiseIds = new Set(promises.map(row => row.id))
  // Retain an active episode's actual promise and schedule without scanning old chats.
  for (const anchor of existing) {
    if (anchor.status && !['open', 'snoozed'].includes(anchor.status)) continue
    const id = metaOf(anchor).promiseId
    if (!id || promiseIds.has(id)) continue
    const row = db.prepare(`${promiseFields} where i.id = ? and i.from_me = 1 and i.ts <= ?
      and i.source in ('whatsapp', 'imessage') and (t.is_task = 1 or t.model = 'callback-promise')`).get(id, at)
    if (row) { promises.push(row); promiseIds.add(id) }
  }
  const matchedPromises = new Map()
  for (const row of promises) {
    if (isOff(row.source) || metaOf(row).group || !callIntent(row) || (row.status && !['open', 'snoozed'].includes(row.status))) continue
    const key = personKey(row, index, resolveContact)
    if (key && targetFits(row, key, index)) {
      matchedPromises.set(row.id, row)
      addEvent(key, { type: 'promise', ts: row.ts, order: Number.MAX_SAFE_INTEGER - 1, row })
    }
  }
  const updateItem = db.prepare('update items set thread = ?, sender = ?, text = ?, meta = ? where id = ?')
  const tag = db.prepare(`insert into tags (item_id, is_task, due, when_words, amount, urgency, summary, model, tagged_at, second, card, quiet, said)
    values (?, ?, ?, ?, '', 1, ?, 'callback', ?, 1, 'callback', ?, ?)
    on conflict(item_id) do update set is_task = excluded.is_task, due = excluded.due, when_words = excluded.when_words,
      quiet = excluded.quiet, said = excluded.said where tags.model = 'callback'`)
  const fold = db.prepare(`update tags set is_task = 0, model = 'callback-promise' where item_id = ? and is_task = 1 and confirmed is null
    and not exists (select 1 from task_state s where s.item_id = tags.item_id)`)
  const complete = db.prepare(`insert into task_state (item_id, status, changed_at, reason, url)
    values (?, 'handled', ?, ?, ?) on conflict(item_id) do update set status = excluded.status,
      changed_at = excluded.changed_at, reason = excluded.reason, url = excluded.url
      where task_state.status = 'snoozed' and excluded.changed_at > task_state.changed_at`)

  function persist(episode) {
    const person = index.people.get(episode.key)
    if (!person) return false
    const old = episode.old
    const promise = episode.promise
    const meta = { kind: 'callback', contactKnown: true, contactKey: episode.key,
      contactId: episode.contactId || episode.key, contactName: episode.name,
      contactAliases: [...person.aliases], aliases: [...person.aliases],
      firstCall: episode.first.id, lastMissed: episode.last.ts, lastMissedId: episode.last.id, count: episode.count,
      ...(promise && { promiseId: promise.id, promiseTs: promise.ts }), ...(episode.connected && { connectedCall: episode.connected.id }) }
    const text = `${episode.count === 1 ? 'Missed call' : `${episode.count} missed calls`} from ${episode.name}`
    const already = !!db.prepare('select 1 from items where id = ?').get(episode.id)
    if (!already) {
      addItems(db, [{ id: episode.id, source: 'calls', thread: episode.name, sender: episode.name,
        fromMe: false, ts: episode.first.ts, text, meta }])
      if (!db.prepare('select 1 from items where id = ?').get(episode.id)) return false
      result.created++
    }
    updateItem.run(episode.name, episode.name, text, JSON.stringify(meta), episode.id)
    const quiet = promise || old?.confirmed ? null : 1
    const chosenPromise = promise && (promise.confirmed || ['open', 'snoozed'].includes(promise.status))
    const chosenCallback = old?.confirmed || ['open', 'snoozed'].includes(old?.status)
    // Keep an explicitly claimed promise visible; the automatic callback remains an
    // anchor rather than becoming a duplicate task. Never override a claimed callback.
    tag.run(episode.id, chosenPromise && !chosenCallback ? 0 : 1, promise?.due || '', promise?.when_words || '', `Call ${episode.name} back`, at, quiet, promise ? promise.said || promise.text : null)
    if (promise && !metaOf(old || {}).promiseId) result.promoted++
    for (const matched of episode.promises || []) result.folded += Number(fold.run(matched.id).changes)
    if (episode.connected) {
      const proof = episode.connected
      const reason = `Connected call with ${episode.name}${metaOf(proof).seconds > 0 ? ` (${Math.round(metaOf(proof).seconds)} seconds)` : ' (answered on another device)'}`
      result.closed += Number(complete.run(episode.id, proof.ts, reason, proof.url || null).changes)
    }
    return true
  }

  for (const [key, events] of groups) {
    events.sort((a, b) => a.ts - b.ts || a.order - b.order)
    let active
    for (const event of events) {
      const row = event.row
      if (event.type === 'state') {
        if (active?.id === row.id) { persist(active); active = null }
        continue
      }
      if (event.type === 'promise') {
        if (active && row.ts >= active.first.ts) { active.promise = row; active.promises.push(row) }
        continue
      }
      if (event.type === 'call' && active?.seedThrough && row.ts <= active.seedThrough) continue
      if (event.type === 'call' && callConnected(row)) {
        // CallHistory can first expose a ringing row as zero seconds, then refresh
        // that exact ID at its original timestamp after the conversation connects.
        // Revisit its existing suggestion instead of requiring a second call row.
        const refreshed = !active && oldByFirst.get(row.id)
        if (refreshed) {
          const person = index.people.get(key)
          active = { key, id: refreshed.id, old: refreshed, first: { id: row.id, ts: row.ts },
            last: row, count: 1, promises: [], promise: matchedPromises.get(metaOf(refreshed).promiseId),
            name: person?.name || label(row), contactId: metaOf(row).contactId }
        }
        if (active && active.old?.status !== 'open' && row.ts >= Math.max(active.first.ts, active.promise?.ts || 0)
          && !(active.old?.status === 'snoozed' && row.ts <= active.old.changed_at)) {
          active.connected = row; persist(active); active = null
        }
        continue
      }
      if (event.type !== 'seed' && !missed(row)) continue
      if (!active) {
        const firstId = event.type === 'seed' ? metaOf(row).firstCall : row.id
        const old = oldByFirst.get(firstId)
        if (!old && row.ts <= since) continue
        const person = index.people.get(key)
        active = { key, id: old?.id || `callback:${hash(key)}:${firstId}`, old,
          first: { id: firstId, ts: row.ts }, last: { id: firstId, ts: row.ts }, count: 0, promises: [],
          name: person?.name || label(row), contactId: metaOf(row).contactId }
      }
      if (event.type === 'seed') {
        active.count = metaOf(row).count || 1
        active.last = { id: metaOf(row).lastMissedId || active.first.id, ts: Number(metaOf(row).lastMissed) || row.ts }
        active.seedThrough = active.last.ts
      } else { active.count++; active.last = row }
    }
    if (active) persist(active)
  }
  return result
}

export { callbackCompletion as callCompletion }
