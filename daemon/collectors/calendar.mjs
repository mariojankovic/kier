import { resolve } from 'node:path'
import { config, home } from '../lib/config.mjs'
import { myReminders } from '../lib/settings.mjs'
import { addItems, now } from '../lib/db.mjs'
import { APPLE_EPOCH, snapshot } from './util.mjs'

// Every calendar the Mac syncs (iCloud, Google, Exchange). Events are appointments already, so they skip the tagger.
export const source = 'calendar'
const PATH = resolve(home, 'Library/Group Containers/group.com.apple.calendar/Calendar.sqlitedb')
const AHEAD_DAYS = 60

export function collect(db) {
  const cal = snapshot(PATH, source)
  try {
    const from = now() - config.backfillDays * 86400 - APPLE_EPOCH
    const to = now() + AHEAD_DAYS * 86400 - APPLE_EPOCH
    // A reminder ticked off in Reminders stays in Calendar's copy, marked complete; it isn't something still to do.
    const done = cal.db.prepare("select 1 from pragma_table_info('CalendarItem') where name = 'completion_date'").get() ? 'i.completion_date' : 'null'
    const cols = `i.summary, i.all_day, i.hidden, i.status, ${done} completed, c.title cal, l.title loc`
    const joins = 'left join Calendar c on c.ROWID = i.calendar_id left join Location l on l.ROWID = i.location_id'
    let rows
    try {
      // OccurrenceCache expands repeating events into their single dates.
      rows = cal.db.prepare(`select o.event_id id, coalesce(o.occurrence_start_date, o.occurrence_date) start, ${cols}
        from OccurrenceCache o join CalendarItem i on i.ROWID = o.event_id ${joins}
        where coalesce(o.occurrence_start_date, o.occurrence_date) between ? and ?`).all(from, to)
    } catch {
      rows = cal.db.prepare(`select i.ROWID id, i.start_date start, ${cols} from CalendarItem i ${joins}
        where i.start_date between ? and ?`).all(from, to)
    }
    // Future events can still move or be cancelled, so they are replaced on every run; past ones stay.
    db.prepare('delete from items where source = ? and ts > ?').run(source, now() - 3600)
    // Skip cancelled events and internal bookkeeping. Do not read Kier’s calendar back into
    // itself. Timed reminders can also appear here; when reminder collection is enabled, avoid
    // duplicating those cards or feeding Kier’s own reminders back into the system.
    const cards = new Set(db.prepare('select summary from tags where is_task = 1 and summary is not null').all().map((t) => t.summary))
    const items = rows.filter((r) => r.summary && !r.hidden && r.status !== 3 && r.cal !== 'Kier' && !r.completed
      && !(r.cal === 'Scheduled Reminders' && (myReminders() || cards.has(r.summary)))).map((r) => {
      const ts = Math.floor(r.start + APPLE_EPOCH)
      return {
        id: `${source}:${r.id}:${ts}`, source, thread: r.cal || 'Calendar', sender: r.cal || 'Calendar', fromMe: true, ts,
        text: `${r.summary}${r.loc ? ` @ ${r.loc}` : ''}`, meta: { allDay: !!r.all_day },
      }
    })
    return addItems(db, items)
  } finally {
    cal.close()
  }
}
