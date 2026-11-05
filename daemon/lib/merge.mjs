// Two nearby cards may describe the same problem and its fix with different wording.
// Compare their subjects, retain the stronger card and merge the details. The other card
// is marked Merged into and remains recoverable from Done.
import { config } from './config.mjs'
import { now } from './db.mjs'
import { ask } from './resolve.mjs'
import { ollamaUp, sameConversation } from './tagger.mjs'
import { tasks } from './tasks.mjs'

const N = config.me
const HOUR = 3600
const SAME = `You see two tasks from the same chat in ${N}'s vault, a few minutes apart. Decide whether they are the same piece of work. First say what problem each one is about, from the chat. They are the same when they are about the same problem: one reports it and the other suggests how to fix it, adds a detail, follows up or says it again. Two different jobs that happen to be in the same chat are not the same. If they are the same, write one task covering both, made only from Task A's and Task B's own lines (the chat is there to understand them, not to add from): at most 24 words, specific, in English, the extra detail folded in (in parentheses is fine). Reply with only JSON: {"a_problem": "...", "b_problem": "...", "same": true or false, "task": "the merged task, or empty"}`

const clock = (ts) => new Intl.DateTimeFormat('en-GB', { timeZone: config.timezone, hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date(ts * 1000))
const said = (t) => String(t.text || '').replace(/\s+/g, ' ').slice(0, 400)

export async function mergeSame(db, limit = 2) {
  const open = tasks(db, { days: 7 }).filter((t) => (t.state === 'open' || t.state === 'overdue') && !t.status)
  const asked = db.prepare('select 1 from merge_checked where a = ? and b = ?')
  const pairs = []
  for (const a of open) {
    for (const b of open) {
      if (a.id >= b.id || ['stalled', 'callback'].includes(a.card) || ['stalled', 'callback'].includes(b.card) || a.source !== b.source || a.thread !== b.thread || Math.abs(a.ts - b.ts) > HOUR) continue
      if (!asked.get(a.id, b.id)) pairs.push([a, b])
    }
  }
  if (!pairs.length || !(await ollamaUp())) return {}
  const mark = db.prepare('insert or ignore into merge_checked (a, b, at) values (?, ?, ?)')
  const around = db.prepare('select sender, from_me, ts, text from items where source = ? and thread = ? and ts between ? and ? order by ts limit 60')
  const rename = db.prepare('update tags set summary = ? where item_id = ?')
  const fold = db.prepare(`insert into task_state (item_id, status, changed_at, reason) values (?, 'handled', ?, ?)
    on conflict(item_id) do nothing`)
  let merged = 0
  const gone = new Set()
  for (const [a, b] of pairs.slice(0, limit)) {
    if (gone.has(a.id) || gone.has(b.id)) continue
    // Include intervening context so short acknowledgments can be associated with the request.
    const [first, last] = a.ts <= b.ts ? [a, b] : [b, a]
    const chat = around.all(a.source, a.thread, first.ts - 600, last.ts + 120).filter(sameConversation(a))
      .map((m) => `[${clock(m.ts)}] ${m.from_me ? N : m.sender}: ${String(m.text || '').replace(/\s+/g, ' ').slice(0, 200)}`)
    // In the order they were said: with the later card first, the 9B called a bug and its suggested fix two jobs.
    const out = await ask(SAME, `The chat:\n${chat.join('\n')}\n\nTask A (${first.from_me ? `${N} said` : `${first.sender} said`}): ${first.summary}\nThe message: "${said(first)}"\n\nTask B (${last.from_me ? `${N} said` : `${last.sender} said`}): ${last.summary}\nThe message: "${said(last)}"`).catch(() => null)
    mark.run(a.id, b.id, now())
    const task = String(out?.task || '').trim()
    if (out?.same !== true || task.length < 8) continue
    // The one the second opinion trusts more stays; on a tie, the earlier one.
    const [keep, drop] = (b.maybe ? 0 : b.second ?? 1) > (a.maybe ? 0 : a.second ?? 1) ? [b, a] : [a, b]
    rename.run(task.slice(0, 240), keep.id)
    fold.run(drop.id, now(), `Merged into: ${task}`.slice(0, 300))
    gone.add(drop.id)
    merged++
  }
  return { merged, compared: Math.min(pairs.length, limit) }
}
