// A read context travels with the database through nested evidence and summary readers.
// SQL views filter before joins, ordering and limits, including helpers unaware of scopes.
import { off } from './settings.mjs'

export function authorization(allowedSources, disabledSources = off()) {
  if (allowedSources !== null && !Array.isArray(allowedSources)) throw Error('INVALID_AUTHORIZATION')
  if (!Array.isArray(disabledSources)) throw Error('INVALID_AUTHORIZATION')
  const valid = (s) => typeof s === 'string' && /^[a-z][a-z0-9_-]*$/.test(s)
  if (![...(allowedSources || []), ...disabledSources].every(valid)) throw Error('INVALID_AUTHORIZATION')
  return Object.freeze({ allowedSources: allowedSources === null ? null : Object.freeze([...allowedSources]), disabledSources: Object.freeze([...disabledSources]) })
}
export const localAuthorization = () => authorization(null)
export const permits = (auth, source) => !auth.disabledSources.includes(source) && (auth.allowedSources === null || auth.allowedSources.includes(source))
const scoped = new WeakMap()
// The rows a scope may read, worked out once and kept until anything in the database changes. Every
// statement used to re-run the per-row origin and forget checks over the whole vault (seconds per brief).
// Any write (new messages, Forget, a state change) moves total_changes(), so the next read recomputes;
// a changed off-list is a different filter. Older tables are kept briefly for readers still using them.
const permittedCache = new WeakMap()
let permittedSeq = 0
function permittedRows(db, filter) {
  try {
    const changes = () => db.prepare('select total_changes() n').get().n
    const cache = permittedCache.get(db) || { tables: [] }
    const hit = cache.tables.find((t) => t.filter === filter && t.changes === changes())
    if (hit) return hit.name
    const name = `kier_scope_${++permittedSeq}`
    db.exec(`create temp table ${name} (id integer primary key, item text not null unique)`)
    db.prepare(`insert into temp.${name} select rowid, id from main.items where ${filter}`).run()
    cache.tables.push({ name, filter, changes: changes() })
    while (cache.tables.length > 4) db.exec(`drop table if exists temp.${cache.tables.shift().name}`)
    permittedCache.set(db, cache)
    return name
  } catch {
    // Read-only or unusual connections fall back to filtering inside every statement.
    return null
  }
}
export function readScope(db, auth) {
  if (scoped.has(db)) return db // Nested readers cannot widen their caller's view.
  if (!auth) throw Error('AUTHORIZATION_REQUIRED')
  auth = authorization(auth.allowedSources, auth.disabledSources)
  const restricted = auth.allowedSources !== null || auth.disabledSources.length > 0
  const list = (xs) => xs.map((s) => `'${s}'`).join(',') || "''"
  const condition = `${auth.allowedSources === null ? '1' : `source in (${list(auth.allowedSources)})`} and source not in (${list(auth.disabledSources)})`
  const filter = `${condition} and kier_origin_permitted(source, thread, meta, '${JSON.stringify(auth.disabledSources)}') and not exists (select 1 from main.forgotten where key = kier_forget_key('item', id) or key = kier_forget_key('thread', source, coalesce(thread, '')))`
  const permitted = permittedRows(db, filter)
  const views = [permitted ? `items as (select rowid, * from main.items where rowid in (select id from temp.${permitted}))`
    : `items as (select rowid, * from main.items where ${filter})`]
  // Cached summaries can have been produced using other sources. Without provenance,
  // expose the source text and recompute evidence, never a globally derived explanation.
  for (const table of ['tags', 'task_state', 'chats', 'heads_up']) {
    const columns = db.prepare(`pragma table_info(${table})`).all().map((c) => c.name)
    if (!columns.length) continue
    const masks = restricted ? (table === 'tags' ? { summary: '(select text from items where id = item_id)', said: 'null', hint: 'null', hint_url: 'null', due: "case when card = 'callback' then '' else due end", when_words: "case when card = 'callback' then '' else when_words end" }
      : table === 'task_state' ? { reason: 'null', url: 'null' } : {}) : {}
    const fields = columns.map((c) => `${masks[c] || `"${c}"`} as "${c}"`).join(',')
    // Checked against the cached list directly, so the items view stays a single reference SQLite can inline.
    const allowed = permitted ? `select item from temp.${permitted}` : 'select id from items'
    const where = ['tags', 'task_state'].includes(table) ? `item_id in (${allowed})${restricted && table === 'task_state' ? " and status != 'handled'" : ''}`
      : restricted ? '0' : '1'
    views.push(`${table} as (select ${fields} from main.${table} where ${where})`)
  }
  const view = { prepare(sql) {
    if (!/^\s*select\b/i.test(sql) || /\bmain\s*\./i.test(sql)) throw Error('SCOPED_READ_ONLY')
    return db.prepare(`with ${views.join(',')} ${sql}`)
  } }
  scoped.set(view, auth)
  return view
}
