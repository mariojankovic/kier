// Discord notifications wrap the same message in a sender header and Unicode direction marks.
// Prefer the full conversation capture, without letting an unrelated channel swallow a task.
const clean = s => String(s || '').normalize('NFKC').replace(/[\u200e\u200f\u202a-\u202e\u2066-\u2069]/g, '').replace(/\s+/g, ' ').trim()
export function discordMessage(item) {
  if (item.source !== 'discord' && !(item.source === 'notifications' && item.thread === 'Discord')) return null
  const header = clean(item.sender)
  const channel = item.source === 'discord' ? clean(item.thread).split(' | ')[0] : header.match(/\((#[^,)]+)/)?.[1]
  const sender = item.source === 'discord' ? header : header.replace(/\s*\(.*$/, '')
  let text = clean(item.text)
  if (item.source === 'notifications' && text.startsWith(`${header}:`)) text = text.slice(header.length + 1).trim()
  return { channel, sender, text }
}
export function discordCopy(db, item) {
  if (item.source !== 'notifications' || item.thread !== 'Discord' || item.from_me) return null
  const a = discordMessage(item)
  if (!a.channel || a.text.length < 4) return null
  const matches = db.prepare("select * from items where source = 'discord' and from_me = 0 and ts between ? and ?")
    .all(item.ts - 120, item.ts + 120).filter(r => {
      const b = discordMessage(r)
      return a.channel === b.channel && a.sender === b.sender && a.text === b.text
    })
  // A notification omits the server: don't guess if two servers have identical messages.
  if (new Set(matches.map(r => r.thread)).size !== 1) return null
  return matches.sort((a, b) => Math.abs(a.ts - item.ts) - Math.abs(b.ts - item.ts))[0] || null
}
export function reconcileDiscordCopies(db) {
  let count = 0
  const rows = db.prepare("select i.* from items i join tags t on t.item_id = i.id where i.source = 'notifications' and i.thread = 'Discord' and t.is_task = 1").all()
  const clear = db.prepare("update tags set is_task = 0, model = 'discord-copy' where item_id = ?")
  const state = db.prepare(`insert or ignore into task_state (item_id, status, changed_at, reason, url)
    select ?, status, changed_at, reason, url from task_state where item_id = ?`)
  for (const item of rows) {
    const copy = discordCopy(db, item)
    if (!copy || !db.prepare('select 1 from tags where item_id = ? and is_task = 1').get(copy.id)) continue
    // Preserve a user's completed/dismissed choice when the richer capture arrives later.
    state.run(copy.id, item.id)
    db.prepare("update tags set confirmed = coalesce(confirmed, (select confirmed from tags where item_id = ?)) where item_id = ?").run(item.id, copy.id)
    clear.run(item.id)
    count++
  }
  return count
}
