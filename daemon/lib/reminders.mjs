// Original Apple reminders stay open until the owner confirms in Kier or Reminders.
// Imported messages and model verdicts remain suggestions, even with owner authorship.
import { addItems, now } from './db.mjs'
import { plusDays, today } from './tasks.mjs'

// The window the app reads: due from a month back to two months ahead, and those ticked off in the last three days.
export const WINDOW = { back: 30, ahead: 60 }

// list: [{ id, title, due: 'YYYY-MM-DD', time: 'HH:MM' | null, list, created, done, completed }]. Returns what the app
// should change in Reminders: `close`, open there but done here; `reopen`, ticked off there but put back here since.
export function syncReminders(db, list) {
  const id = (r) => `reminders:${r.id}`
  // A reminder is yours, made when you made it: the done-check reads what came after that.
  addItems(db, list.map((r) => ({ id: id(r), source: 'reminders', thread: r.list, sender: r.list, fromMe: true,
    ts: Math.floor(r.created || now()), text: r.title, meta: { due: r.due, time: r.time || null } })))
  const text = db.prepare('update items set text = ?, thread = ?, sender = ? where id = ?')
  const tag = db.prepare(`insert into tags (item_id, is_task, due, when_words, summary, card, model, tagged_at) values (?, 1, ?, ?, ?, 'todo', 'reminders', ?)
    on conflict(item_id) do update set due = excluded.due, when_words = excluded.when_words, summary = excluded.summary`)
  const state = db.prepare('select status, changed_at, completion_origin from task_state where item_id = ?')
  const set = db.prepare(`insert into task_state (item_id, status, changed_at, reason, completion_origin) values (?, ?, ?, ?, 'reminders')
    on conflict(item_id) do update set status = excluded.status, changed_at = excluded.changed_at, reason = excluded.reason, completion_origin = excluded.completion_origin`)
  for (const r of list) {
    text.run(r.title, r.list, r.list, id(r))
    tag.run(id(r), r.due, r.time || null, r.title, now())
    // Ticked off there, and not put back here since: done. Put back after it was ticked off: it opens there again.
    const s = state.get(id(r))
    if (r.done && s?.status !== 'dismissed'
        && !(['done', 'handled'].includes(s?.status) && ['owner', 'reminders'].includes(s?.completion_origin)) && !(s?.status === 'open' && s.changed_at >= (r.completed || 0))) {
      set.run(id(r), 'done', now(), 'ticked off in Reminders')
    }
  }
  // Open here, due inside the window, and not in Reminders any more: deleted there. An empty read is more likely a read
  // that failed than every reminder deleted, so it deletes nothing.
  const seen = new Set(list.map(id))
  const from = plusDays(today(), -WINDOW.back), to = plusDays(today(), WINDOW.ahead)
  if (list.length) for (const r of db.prepare(`select t.item_id id from tags t left join task_state s on s.item_id = t.item_id
      where t.item_id like 'reminders:%' and s.item_id is null and t.due between ? and ?`).all(from, to)) {
    if (!seen.has(r.id)) set.run(r.id, 'dismissed', now(), 'deleted in Reminders')
  }
  const open = new Set(list.filter((r) => !r.done).map(id))
  const close = db.prepare("select item_id from task_state where item_id like 'reminders:%' and status in ('done', 'handled') and completion_origin in ('owner', 'reminders')").all()
    .map((r) => r.item_id).filter((x) => open.has(x))
  const putBack = db.prepare("select item_id, changed_at from task_state where item_id like 'reminders:%' and status = 'open'").all()
  const reopen = putBack.filter((p) => list.some((r) => r.done && id(r) === p.item_id && p.changed_at >= (r.completed || 0))).map((p) => p.item_id)
  const bare = (x) => x.slice('reminders:'.length)
  return { close: close.map(bare), reopen: reopen.map(bare), completionPolicy: 'owner-verified' }
}
