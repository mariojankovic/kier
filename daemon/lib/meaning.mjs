import { sidecarFetch } from './sidecar-client.mjs'
import { localAuthorization, readScope } from './authorization.mjs'
// Search messages by semantic similarity using the local embedding runtime. Store 256-dimensional
// vectors as quantized bytes with a scale. Index recent items first in small batches.
import { config } from './config.mjs'
import { MLX, embedReady } from './runtime.mjs'
import { offClause } from './settings.mjs'

export const SOURCES = ['whatsapp', 'imessage', 'mail', 'mcp', 'discord', 'chat', 'notifications', 'ai', 'downloads', 'social']
export const ready = () => embedReady()

export async function embed(texts, { query = false } = {}) {
  const res = await sidecarFetch('embed', '/api/embed', {
    method: 'POST', signal: AbortSignal.timeout(120000),
    body: JSON.stringify({ input: texts, kind: query ? 'query' : 'document', keep_alive: config.keepAlive }),
  })
  if (!res.ok) throw Error(`search model ${res.status}`)
  return (await res.json()).embeddings
}

export function pack(v) {
  const max = Math.max(...v.map(Math.abs)) || 1
  const b = Buffer.alloc(4 + v.length)
  b.writeFloatLE(max / 127, 0)
  v.forEach((x, i) => b.writeInt8(Math.round((x / max) * 127), 4 + i))
  return b
}

// How alike a question and one stored fingerprint are (both unit length, so this is the cosine).
export function similarity(q, stored) {
  // SQLite hands a blob back as a plain Uint8Array; viewed as a Buffer it reads the same bytes, nothing copied.
  const b = Buffer.isBuffer(stored) ? stored : Buffer.from(stored.buffer, stored.byteOffset, stored.byteLength)
  const scale = b.readFloatLE(0)
  let s = 0
  for (let i = 0; i < q.length; i++) s += q[i] * b.readInt8(4 + i)
  return s * scale
}

const marks = SOURCES.map(() => '?').join(', ')
const text = (r) => String(r.text).replace(/\s+/g, ' ').slice(0, 400)

// The next messages without a fingerprint, newest first. Returns how many got one.
export async function indexPending(db, limit = 48) {
  if (!ready()) return 0
  const rows = readScope(db, localAuthorization()).prepare(`select i.id, i.text from items i left join vectors v on v.item_id = i.id
    where v.item_id is null and i.source in (${marks}) and length(i.text) >= 3 ${offClause()} order by i.ts desc limit ?`).all(...SOURCES, limit)
  if (!rows.length) return 0
  const vecs = await embed(rows.map(text))
  const put = db.prepare('insert or replace into vectors (item_id, v) values (?, ?)')
  db.exec('begin')
  try { rows.forEach((r, i) => put.run(r.id, pack(vecs[i]))); db.exec('commit') } catch (e) { db.exec('rollback'); throw e }
  return rows.length
}

// The k messages closest in meaning to the question, optionally within `where` (SQL on items i, with its params).
export async function nearest(db, question, { k = 25, where = '', params = [], auth = localAuthorization() } = {}) {
  db = readScope(db, auth)
  if (!ready()) return []
  const [q] = await embed([question], { query: true })
  const rows = db.prepare(`select v.item_id id, v.v from vectors v join items i on i.id = v.item_id where 1 = 1 ${where} ${offClause()}`).all(...params)
  return rows.map((r) => ({ id: r.id, score: similarity(q, r.v) })).sort((a, b) => b.score - a.score).slice(0, k)
}

// Words of four letters or more, Croatian's last vowel dropped (radionica, radionicu: "radionic").
const words = (s) => [...new Set((String(s).toLowerCase().match(/[\p{L}\p{N}]{4,}/gu) || []).map((w) => (/[aeiou]$/.test(w) ? w.slice(0, -1) : w)))].slice(0, 8)

const COMMON = new Set(['the', 'what', 'when', 'where', 'who', 'why', 'how', 'did', 'does', 'can', 'could', 'would', 'should', 'please', 'are',
  'was', 'were', 'has', 'have', 'had', 'this', 'that', 'there', 'these', 'those', 'kier', 'hey', 'and', 'but', 'any', 'tell', 'find', 'show', 'remind',
  'mark', 'put', 'not', 'one', 'today', 'tomorrow', 'yesterday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday'])

// A person or chat the question names ("what did I tell Nika"): its messages are where to look. A capitalised word that
// is a chat's name, or a sender's, or their first name.
export function person(db, question, auth = localAuthorization()) {
  db = readScope(db, auth)
  const known = db.prepare(`select 1 from items where source in (${marks}) and (lower(thread) = ? or lower(thread) like ? or lower(sender) = ? or lower(sender) like ?) limit 1`)
  for (const n of String(question).match(/\p{Lu}[\p{L}'-]{2,}/gu) || []) {
    const l = n.toLowerCase()
    // A capital that only starts the sentence ("The", "What", "Can") isn't a name.
    if (COMMON.has(l)) continue
    if (known.get(...SOURCES, l, `${l} %`, l, `${l} %`)) return n
  }
  // Recognize a person’s first name or a full chat title even in lowercase. Exclude app names,
  // which identify notification sources rather than people.
  const chat = db.prepare(`select 1 from items where source in (${marks}) and source != 'notifications' and (lower(thread) = ? or lower(sender) = ? or lower(sender) like ?) limit 1`)
  for (const w of new Set(String(question).toLowerCase().match(/[\p{L}'-]{4,}/gu) || [])) {
    if (COMMON.has(w) || STOP.has(w)) continue
    if (chat.get(...SOURCES, w, w, `${w} %`)) return w[0].toUpperCase() + w.slice(1)
  }
  return null
}

// The question's own scaffolding matches half the vault ("what", "tell", "about"), so it doesn't count as words to find.
const STOP = new Set(['what', 'whats', 'tell', 'told', 'about', 'when', 'where', 'which', 'said', 'says', 'does', 'have', 'with', 'that',
  'this', 'from', 'they', 'them', 'there', 'their', 'would', 'could', 'should', 'been', 'were', 'your', 'mine', 'anything', 'something', 'last', 'time',
  'marked', 'mark', 'thing', 'back', 'mistake', 'please', 'revert', 'undo', 'again', 'done', 'just'])

// Combine word and meaning matches in conversational order. A named person narrows chats,
// including groups and the owner’s messages. Semantic neighbours cover varying display names.
// A follow-up can inherit the previous query’s participants and topic; extra terms come from ask.mjs.
export async function search(db, question, { k = 20, days = 365, step = () => {}, context = '', extra = [], auth = localAuthorization() } = {}) {
  db = readScope(db, auth)
  const named = person(db, question) || (context ? person(db, context) : null)
  const meant = context ? `${context}\n${question}` : question
  const who = named?.toLowerCase()
  const since = Math.floor(Date.now() / 1000) - days * 86400
  // Notifications are named after their app, not the chat, so there only the person's own count.
  const scope = who ? ` and ((i.source != 'notifications' and i.thread in (select distinct thread from items where source in (${marks}) and source != 'notifications'
    and (lower(thread) like ? or lower(sender) like ?))) or (i.source = 'notifications' and lower(i.sender) like ?))` : ''
  const scopeParams = who ? [...SOURCES, `%${who}%`, `%${who}%`, `%${who}%`] : []
  const ws = [...new Set([...words(question), ...words(extra.join(' '))])].filter((w) => !STOP.has(w) && (!who || !who.startsWith(w)))
  const topic = (String(question).toLowerCase().match(/[\p{L}\p{N}]{4,}/gu) || []).filter((w) => !STOP.has(w) && w !== who).slice(0, 3).join(' ')
  step(`Searching ${named ? `your chats with ${named}` : 'your messages'}${topic ? ` for "${topic}"` : ''}`)
  const byWords = ws.length
    ? db.prepare(`select i.id, i.text from items i where i.source in (${marks}) and i.ts > ? ${scope} and (${ws.map(() => 'lower(i.text) like ?').join(' or ')}) ${offClause()} order by i.ts desc limit 400`)
      .all(...SOURCES, since, ...scopeParams, ...ws.map((w) => `%${w}%`))
      .map((r) => ({ id: r.id, score: ws.reduce((n, w) => n + (String(r.text).toLowerCase().includes(w) ? w.length : 0), 0) }))
      .sort((a, b) => b.score - a.score).slice(0, k)
    : []
  const close = (where, params, n) => nearest(db, meant, { k: n, where: `and i.source in (${marks}) and i.ts > ? ${where}`, params: [...SOURCES, since, ...params] }).catch(() => [])
  const byMeaning = await close(scope, scopeParams, k)
  const anywhere = who ? await close('', [], 10) : []
  const ids = [...new Set([...byMeaning, ...byWords, ...anywhere].map((r) => r.id))]
  if (!ids.length) return []
  const found = db.prepare(`select * from items where id in (${ids.map(() => '?').join(', ')}) order by ts`).all(...ids)
  // Summarize which conversations supply most results for the activity indicator.
  const where = Object.entries(found.reduce((n, m) => ({ ...n, [m.thread || m.source]: (n[m.thread || m.source] || 0) + 1 }), {}))
    .sort((a, b) => b[1] - a[1]).slice(0, 2).map(([t]) => t)
  step(`Reading ${found.length} ${found.length === 1 ? 'message' : 'messages'}${where.length ? ` from ${where.join(' and ')}` : ''}`)
  return found
}
