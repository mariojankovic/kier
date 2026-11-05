// When enabled, write plans and dated tasks to Apple Calendar and Reminders. Account sync
// can carry them to other devices. Keep completion and deletion state in step.
import { myReminders, phoneCalendar, phoneReminders } from './settings.mjs'
import { now } from './db.mjs'
import { installed as decisionInstalled } from './second.mjs'
import { clockOf, events, plusDays, tasks, today } from './tasks.mjs'

const DAYS = 14
const SOURCE = { whatsapp: 'WhatsApp', imessage: 'iMessage', mail: 'email', discord: 'Discord', notifications: 'a notification', social: 'a reply', ai: 'an AI session' }

// When installed, the second opinion checks incoming guesses before anything is written to Reminders.
export function phoneItems(db, { decisionAvailable = decisionInstalled() } = {}) {
  const t0 = today()
  const until = plusDays(t0, DAYS)
  // Plans only: the calendar's own events are on the phone already.
  const plans = events(db, t0, until).filter((e) => e.plan && !e.allDay && e.ts > now()).map((e) => ({
    id: `${e.id}@${e.day}`, kind: 'event', title: e.what, start: e.ts, end: e.ends && e.ends > e.ts ? e.ends : e.ts + 3600,
    notes: `From the ${e.thread} chat${e.weekly ? ', every week' : ''}. Added by Kier.`,
  }))
  // Include future dated tasks and recently completed ones, so completion reaches Reminders.
  // Dismissed tasks are removed.
  const seen = new Set()
  const finished = (t) => (t.state === 'done' || t.state === 'handled') && (t.done_at || t.ts) > now() - 3 * 86400
  // Your own reminders are cards too ("Your reminders", reminders.mjs); they're in Reminders already.
  const canWrite = (t) => t.from_me || t.confirmed === 1 || ['open', 'snoozed', 'done'].includes(t.status)
    || t.second != null || !decisionAvailable
  const eligible = (t) => {
    if (t.source === 'reminders') return false
    const open = ['open', 'overdue'].includes(t.state) && !t.maybe
    if (t.source === 'kier') return open || finished(t)
    return t.due && t.due <= until && ((open && t.due >= t0) || (finished(t) && t.due >= plusDays(t0, -1)))
  }
  const dated = tasks(db).filter(canWrite).filter(eligible)
    .filter((t) => !seen.has(t.summary) && seen.add(t.summary)).map((t) => ({
      id: t.id, kind: 'reminder', title: t.summary, due: t.due || null, time: clockOf(t), ...(finished(t) && { done: true }),
      notes: `${t.source === 'kier' ? 'You asked Kier to remind you' : t.from_me ? 'You promised' : `${t.sender} asked you`}${SOURCE[t.source] ? `, on ${SOURCE[t.source]}` : ''}. Added by Kier.`,
    }))
  const calendar = phoneCalendar(), reminders = phoneReminders()
  // `on` is for an app from before the three switches, which knew only one.
  return { on: calendar || reminders, calendar, reminders, mine: myReminders(), items: [...(calendar ? plans : []), ...(reminders ? dated : [])] }
}
