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
export function readScope(db, auth) {
  if (scoped.has(db)) return db // Nested readers cannot widen their caller's view.
  if (!auth) throw Error('AUTHORIZATION_REQUIRED')
  auth = authorization(auth.allowedSources, auth.disabledSources)
  const restricted = auth.allowedSources !== null || auth.disabledSources.length > 0
  const list = (xs) => xs.map((s) => `'${s}'`).join(',') || "''"
  const condition = `${auth.allowedSources === null ? '1' : `source in (${list(auth.allowedSources)})`} and source not in (${list(auth.disabledSources)})`
  const views = [`items as (select rowid, * from main.items where ${condition} and kier_origin_permitted(source, thread, meta, '${JSON.stringify(auth.disabledSources)}') and not exists (select 1 from main.forgotten where key = kier_forget_key('item', id) or key = kier_forget_key('thread', source, coalesce(thread, ''))))`]
  // Cached summaries can have been produced using other sources. Without provenance,
  // expose the source text and recompute evidence, never a globally derived explanation.
  for (const table of ['tags', 'task_state', 'chats', 'heads_up']) {
    const columns = db.prepare(`pragma table_info(${table})`).all().map((c) => c.name)
    if (!columns.length) continue
    const masks = restricted ? (table === 'tags' ? { summary: '(select text from items where id = item_id)', said: 'null', hint: 'null', hint_url: 'null', due: "case when card = 'callback' then '' else due end", when_words: "case when card = 'callback' then '' else when_words end" }
      : table === 'task_state' ? { reason: 'null', url: 'null' } : {}) : {}
    const fields = columns.map((c) => `${masks[c] || `"${c}"`} as "${c}"`).join(',')
    const where = ['tags', 'task_state'].includes(table) ? `item_id in (select id from items)${restricted && table === 'task_state' ? " and status != 'handled'" : ''}`
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
