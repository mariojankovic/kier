import { newlyWritten } from '../lib/completion-evidence.mjs'
// Local mail only. Bounded pages and body reads run in the collection child.
import { createHash } from 'node:crypto'
import { closeSync, existsSync, openSync, opendirSync, readdirSync, readSync, realpathSync, statSync } from 'node:fs'
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { config, home } from '../lib/config.mjs'
import { addItems, cursor, now, setCursor } from '../lib/db.mjs'
import { isOff } from '../lib/settings.mjs'
import { APPLE_EPOCH, snapshot } from './util.mjs'

export const source = 'mail'
export const PAGE_SIZE = 200
const hash = s => createHash('sha256').update(String(s)).digest('hex')
const columns = (db, table) => new Set(db.prepare(`pragma table_info("${table}")`).all().map(c => c.name))
const field = (cols, alias, names, fallback = 'null') => {
  const name = names.find(n => cols.has(n))
  return name ? `${alias}."${name}"` : fallback
}

// Detection reads paths only, never opens a message or queries its content.
export function mailStores(base = home) {
  const root = resolve(base, 'Library/Mail')
  let versions = []
  try { versions = readdirSync(root).filter(n => /^V\d+$/.test(n)).sort((a, b) => Number(b.slice(1)) - Number(a.slice(1))) } catch {}
  // Old version folders are migration leftovers, not additional accounts.
  const apple = versions.map(v => resolve(root, v, 'MailData/Envelope Index')).find(existsSync)
  const spark = resolve(base, 'Library/Application Support/Spark Mail/core-data/messages.sqlite')
  return [...(apple ? [{ client: 'apple-mail', path: apple, root: dirname(dirname(apple)) }] : []),
    ...(existsSync(spark) ? [{ client: 'spark', path: spark }] : [])]
}

export function mailSetup(stores = mailStores(), disabled = isOff(source)) {
  const clients = stores.map(s => s.client === 'apple-mail' ? 'Apple Mail' : 'Spark')
  return { found: clients.length > 0, enabled: clients.length > 0 && !disabled, detail: disabled ? 'Mail is off in What Kier reads.' : clients.length
    ? `Reads personal mail locally from ${clients.join(' and ')}. Bulk mail and attachments stay out.`
    : 'No local Apple Mail or Spark store found. Open either app and let it download your mail.' }
}

// One bounded page of new arrivals, plus one page of the initial backfill. The
// high-water mark moves only after its entire interval has been drained.
function page(db, state, limit, client, cutoff) {
  const c = columns(db, 'messages')
  const date = client === 'apple-mail' ? field(c, 'messages', ['date_received', 'date_sent'])
    : `coalesce(nullif(${field(c, 'messages', ['receivedDate'])}, 0), ${field(c, 'messages', ['creationDate'])})`
  const numeric = `cast(${date} as real)`
  const stamp = `case when ${numeric} > 1e12 then ${numeric} / 1000 when ${numeric} > 0 and ${numeric} < ${APPLE_EPOCH} then ${numeric} + ${APPLE_EPOCH} else ${numeric} end`
  const time = `case when typeof(${date}) = 'text' and ${date} glob '????-??-??*' then cast(strftime('%s', ${date}) as integer) else ${stamp} end`
  const rows = []
  if (!state) {
    const high = db.prepare('select coalesce(max(rowid), 0) n from messages').get().n
    state = { high, before: high + 1, pending: null }
  } else if (!state.pending) {
    const high = db.prepare('select coalesce(max(rowid), 0) n from messages').get().n
    if (high > state.high) state.pending = { high, before: high + 1 }
  }
  const select = (low, before) => db.prepare(`select rowid pk from messages where rowid > ? and rowid < ? and (${time}) >= ? order by rowid desc limit ?`).all(low, before, cutoff, limit)
  if (state.pending) {
    const found = select(state.high, state.pending.before)
    rows.push(...found)
    if (found.length < limit) { state.high = state.pending.high; state.pending = null }
    else state.pending.before = found.at(-1).pk
  }
  if (state.before !== null) {
    const found = select(0, state.before)
    rows.push(...found)
    state.before = found.length < limit ? null : found.at(-1).pk
  }
  return { ids: rows.map(r => r.pk), state }
}

export function mailDate(value) {
  if (value == null || value === '') return 0
  if (typeof value === 'string' && !/^\d+(?:\.\d+)?$/.test(value)) return Math.floor(Date.parse(value) / 1000) || 0
  let n = Number(value)
  if (n > 1e12) n /= 1000
  if (n > 0 && n < APPLE_EPOCH) n += APPLE_EPOCH
  return Number.isFinite(n) ? Math.floor(n) : 0
}

export function addresses(value) {
  if (!value) return []
  if (Buffer.isBuffer(value)) value = value.toString('utf8')
  if (typeof value === 'string' && /^[\[{]/.test(value.trim())) {
    try { return addresses(JSON.parse(value)) } catch { return [] }
  }
  if (Array.isArray(value)) return value.flatMap(addresses)
  if (typeof value === 'object') {
    const email = value.email || value.address || value.emailAddress
    if (typeof email !== 'string') return []
    return [{ email: email.trim().toLowerCase(), name: String(value.name || value.displayName || '') }]
  }
  return [...String(value).matchAll(/(?:"?([^<>,"]+?)"?\s*<)?([\w.!#$%&'*+/=?^`{|}~-]+@[\w.-]+)>?/g)]
    .map(m => ({ email: m[2].toLowerCase(), name: (m[1] || '').trim() }))
}
const display = a => a?.name || a?.email || ''
export const conversation = (subject, other) => String(subject || '').replace(/^(?:(?:re|fw|fwd)\s*:\s*)+/i, '').trim() || other
const sentBox = s => /(?:^|[\/\s.])(?:sent(?: messages| mail| items)?|sentmail|poslano|poslane|gesendet)(?:$|[\/\s.])/i.test(String(s || ''))
const automated = (from, subject, snippet, list) => !!list || /(?:^|[._-])(?:no[._-]?reply|do[._-]?not[._-]?reply|mailer[._-]?daemon|newsletter|notifications?)(?:[._@-]|$)/i.test(from)
  || /\b(?:newsletter|unsubscribe|payment receipt|order confirmation|your receipt|your invoice|shipping confirmation)\b/i.test(`${subject}\n${snippet}`)
const messageID = value => {
  const id = String(value || '').trim().replace(/^<|>$/g, '')
  return id.includes('@') && !/\s/.test(id) ? id : null
}

// Read at most 64 KiB, even if the message contains a large attachment. Only a
// text/plain MIME part without a filename or attachment disposition is retained.
export function plainMail(raw, depth = 0) {
  if (depth > 6) return { headers: {}, snippet: '' }
  raw = String(raw).replace(/^\d+\r?\n/, '')
  const split = raw.search(/\r?\n\r?\n/)
  if (split < 0) return { headers: {}, snippet: '' }
  const headers = {}
  for (const line of raw.slice(0, split).replace(/\r?\n[ \t]+/g, ' ').split(/\r?\n/)) {
    const at = line.indexOf(':')
    if (at > 0) headers[line.slice(0, at).toLowerCase()] = line.slice(at + 1).trim()
  }
  const body = raw.slice(split).replace(/^\r?\n\r?\n/, '')
  const type = headers['content-type'] || 'text/plain'
  if (/attachment|filename\s*=/i.test(headers['content-disposition'] || '') || /(?:^|;)\s*name\s*=/i.test(type)) return { headers, snippet: '' }
  if (/^multipart\//i.test(type)) {
    const boundary = type.match(/boundary\s*=\s*(?:"([^"]+)"|([^;\s]+))/i)
    const delimiter = boundary?.[1] || boundary?.[2]
    const parts = delimiter ? body.split(`--${delimiter}`).slice(1, 20) : []
    const snippet = parts.map(part => plainMail(part.replace(/^\r?\n/, ''), depth + 1).snippet).find(Boolean) || ''
    return { headers, snippet }
  }
  if (!/^text\/plain(?:;|$)/i.test(type)) return { headers, snippet: '' }
  let decoded = body
  if (/^base64$/i.test(headers['content-transfer-encoding'] || '')) decoded = Buffer.from(body.replace(/\s/g, ''), 'base64').toString('utf8')
  if (/^quoted-printable$/i.test(headers['content-transfer-encoding'] || '')) {
    decoded = Buffer.from(body.replace(/=\r?\n/g, '').replace(/=([\da-f]{2})/gi, (_, hex) => String.fromCharCode(parseInt(hex, 16))), 'latin1').toString('utf8')
  }
  // Quoted history and signatures are not the sender's new evidence.
  const snippet = newlyWritten(decoded).slice(0, 2000)
  return { headers, snippet }
}

function readMail(path) {
  let fd
  try {
    fd = openSync(path, 'r')
    const buffer = Buffer.alloc(65536)
    const length = readSync(fd, buffer, 0, buffer.length, 0)
    const raw = buffer.subarray(0, length).toString('utf8')
    // An emlx length prefix excludes the trailing Apple plist from the body.
    const prefix = raw.match(/^(\d+)\r?\n/)
    return plainMail(prefix ? buffer.subarray(Buffer.byteLength(prefix[0]), Math.min(length, Buffer.byteLength(prefix[0]) + Number(prefix[1]))).toString('utf8') : raw)
  } catch { return { headers: {}, snippet: '' } } finally { if (fd !== undefined) closeSync(fd) }
}

// Look only inside the selected mailbox. A shared budget bounds all directory
// visits in a pass; missing or expensive bodies simply have no snippet.
function bodyFinder(root) {
  const cache = new Map()
  let budget = 1500
  let accounts = []
  try { accounts = readdirSync(root, { withFileTypes: true }).filter(e => e.isDirectory() && e.name !== 'MailData').slice(0, 64).map(e => resolve(root, e.name)) } catch {}
  const filesIn = path => {
    if (cache.has(path)) return cache.get(path)
    const files = new Map(), todo = [path]
    while (todo.length && budget > 0) {
      let dir
      try {
        dir = opendirSync(todo.shift())
        let entry
        while (budget-- > 0 && (entry = dir.readSync())) {
          if (entry.isDirectory()) todo.push(resolve(dir.path, entry.name))
          else if (entry.isFile() && /^\d+\.emlx$/.test(entry.name)) files.set(Number(entry.name.split('.')[0]), resolve(dir.path, entry.name))
        }
      } catch {} finally { dir?.closeSync() }
    }
    cache.set(path, files)
    return files
  }
  return (mailbox, pk) => {
    let paths
    try {
      if (String(mailbox).startsWith('file:')) paths = [fileURLToPath(mailbox)]
      else if (/^[a-z]+:\/\//i.test(String(mailbox))) {
        const parts = decodeURIComponent(new URL(mailbox).pathname).split('/').filter(Boolean).map(p => p.endsWith('.mbox') ? p : `${p}.mbox`)
        paths = accounts.map(account => resolve(account, ...parts))
      } else paths = [mailbox]
    } catch { return null }
    for (let path of paths) {
      if (!path || !isAbsolute(path)) continue
      try {
        path = realpathSync(path)
        const rel = relative(realpathSync(root), path)
        if (rel.startsWith(`..${sep}`) || rel === '..' || isAbsolute(rel)) continue
      } catch { continue }
      const found = filesIn(path).get(pk)
      if (found) return found
    }
    return null
  }
}

function appleRows(db, ids, root) {
  if (!ids.length) return []
  const m = columns(db, 'messages'), a = columns(db, 'addresses'), boxes = columns(db, 'mailboxes')
  const mids = columns(db, 'message_ids')
  const linkedID = field(mids, 'mid', ['message_id', 'value'])
  const idJoin = linkedID === 'null' ? '' : `left join message_ids mid on mid.rowid = m.message_id`
  const mailbox = field(boxes, 'b', ['url', 'path', 'name'])
  const rows = db.prepare(`select m.rowid pk, s.subject, a.address senderAddress,
    ${field(a, 'a', ['comment', 'name'], "''")} senderName,
    coalesce(nullif(${field(m, 'm', ['date_sent'])}, 0), ${field(m, 'm', ['date_received'])}) date,
    -- Apple Mail keeps some ids as 64-bit integers, past what a JavaScript number holds: read them as text.
    cast(coalesce(${linkedID}, ${field(m, 'm', ['message_id', 'messageId'])}) as text) messageId,
    ${mailbox} mailbox, ${field(boxes, 'b', ['role', 'name'], "''")} role
    from messages m left join subjects s on s.rowid = m.subject
    left join addresses a on a.rowid = m.sender left join mailboxes b on b.rowid = m.mailbox ${idJoin}
    where m.rowid in (${ids.map(() => '?').join(',')}) order by m.rowid desc`).all(...ids)
  const rc = columns(db, 'recipients')
  const recipients = db.prepare(`select a.address, ${field(a, 'a', ['comment', 'name'], "''")} name,
    ${field(rc, 'r', ['type'], '0')} type from recipients r join addresses a on a.rowid = ${field(rc, 'r', ['address_id', 'address'])}
    where ${field(rc, 'r', ['message_id', 'message'])} = ? limit 100`)
  const findBody = bodyFinder(root)
  return rows.map(r => {
    const path = findBody(r.mailbox, r.pk)
    const { headers, snippet } = path ? readMail(path) : { headers: {}, snippet: '' }
    const people = recipients.all(r.pk)
    return { ...r, from: [{ email: String(r.senderAddress || '').toLowerCase(), name: r.senderName || '' }],
      to: people.filter(a => Number(a.type) === 0).map(a => ({ email: a.address.toLowerCase(), name: a.name })),
      cc: people.filter(a => Number(a.type) === 1).map(a => ({ email: a.address.toLowerCase(), name: a.name })),
      sent: sentBox(`${String(r.mailbox || '').replace(/%20/gi, ' ')} ${r.role}`), snippet,
      messageId: headers['message-id'] || r.messageId, list: headers['list-unsubscribe'] || headers['list-id'] }
  })
}

function sparkRows(db, ids) {
  if (!ids.length) return []
  const c = columns(db, 'messages')
  return db.prepare(`select rowid pk, subject, shortBody snippet, messageFrom, messageTo, messageCc,
    inSent sent, coalesce(nullif(${field(c, 'messages', ['receivedDate'])}, 0), ${field(c, 'messages', ['creationDate'])}) date,
    conversationPk, messageId, ${field(c, 'messages', ['mailbox', 'folder'], "''")} mailbox,
    ${field(c, 'messages', ['listUnsubscribe', 'list_unsubscribe'], "''")} list
    from messages where rowid in (${ids.map(() => '?').join(',')}) order by rowid desc`).all(...ids)
    .map(r => ({ ...r, from: addresses(r.messageFrom), to: addresses(r.messageTo), cc: addresses(r.messageCc) }))
}

export function collect(db, { stores = mailStores(), limit = PAGE_SIZE, at = now() } = {}) {
  if (isOff(source)) return 0
  limit = Math.max(1, Math.min(PAGE_SIZE, Math.trunc(limit) || PAGE_SIZE))
  let added = 0, failures = 0
  for (const store of stores) {
    const key = `mail:${store.client}:${hash(store.path).slice(0, 16)}`
    let copy
    try {
      const previous = cursor(db, key, null)
      const saved = previous ? JSON.parse(previous) : null
      const stamp = ['', '-wal'].map(suffix => {
        try { const st = statSync(store.path + suffix); return `${st.ino}:${st.size}:${st.mtimeMs}` } catch { return '' }
      }).join('|')
      if (saved?.before === null && !saved.pending && saved.stamp === stamp) continue
      copy = snapshot(store.path, `${key.replaceAll(':', '-')}-${process.pid}`)
      copy.db.exec('pragma query_only = on')
      const { ids, state } = page(copy.db, saved, limit, store.client, at - config.backfillDays * 86400)
      const rows = store.client === 'apple-mail' ? appleRows(copy.db, ids, store.root) : sparkRows(copy.db, ids)
      // Only Sent is authoritative for learning an account address. An incoming
      // message's display name, To header or body can never claim owner authority.
      const ownerKey = `${key}:owner-addresses`
      const owners = new Set([...addresses(config.mailAddresses || []), ...addresses(JSON.parse(cursor(db, ownerKey, '[]')))]
        .map(a => a.email))
      for (const row of rows) if (row.sent === true || Number(row.sent) === 1) for (const a of row.from) if (a.email) owners.add(a.email)
      const items = []
      for (const row of rows) {
        const ts = mailDate(row.date)
        if (ts < at - config.backfillDays * 86400 || ts > at + 86400) continue
        const fromMe = row.sent === true || Number(row.sent) === 1
        const from = row.from[0]
        if (!from?.email || !fromMe && automated(from.email, row.subject, row.snippet, row.list)) continue
        const other = fromMe ? display(row.to.find(a => !owners.has(a.email))) : display(from)
        if (!other) continue
        const thread = conversation(row.subject, other)
        if (config.blockedChats.includes(thread)) continue
        const mid = messageID(row.messageId)
        // Message-ID is only a correlation hint. The store also keys each local copy.
        const id = `mail:${hash(mid ? `message:${mid}` : `${key}:${row.pk}`)}`
        items.push({ id, source, thread, sender: fromMe ? config.me : display(from), fromMe, ts,
          text: [String(row.subject || '').slice(0, 500), String(row.snippet || '').slice(0, 2000)].filter(Boolean).join('\n'),
          meta: { subject: String(row.subject || '').slice(0, 500), body: String(row.snippet || '').slice(0, 2000), bodyKind: store.client === 'apple-mail' ? 'plain' : 'preview', client: store.client, copyKey: `${key}:${row.pk}`, account: key, ownerSent: fromMe, messageId: mid, to: row.to, cc: row.cc, mailbox: row.mailbox || '',
            from: row.from, group: row.to.length + row.cc.length > 1, ...(row.conversationPk != null && { conversationPk: row.conversationPk }) } })
      }
      added += addItems(db, items)
      setCursor(db, ownerKey, JSON.stringify([...owners]))
      // Arrivals beyond a draining interval still need a pass even if the files
      // stop changing before that interval finishes.
      const caughtUp = state.high === copy.db.prepare('select coalesce(max(rowid), 0) n from messages').get().n
      setCursor(db, key, JSON.stringify({ ...state, stamp: caughtUp ? stamp : null }))
    } catch { failures++ } finally { copy?.close() }
  }
  // Other clients still get a pass if one schema or store cannot be read.
  if (failures) throw Error('MAIL_STORE_UNAVAILABLE')
  return added
}
