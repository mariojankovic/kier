// A mail app's banner repeats a message Kier also reads from the mailbox itself, where it comes with its conversation
// around it. One mail is one task: the mailbox copy is kept and the banner is folded into it. A banner with no stored
// mail behind it (a sender the mail reader leaves out, a mailbox Kier cannot read) stays as it was.
const APPS = new Set(['com.apple.mail', 'com.readdle.smartemail-macos', 'com.readdle.smartemail-macos-setapp',
  'com.readdle.sparkdesktop', 'com.readdle.sparkdesktop-setapp', 'com.kier.mail'])
// Kier Mail's banners from before it took its present identifier are known by the app's name.
const NAMES = new Set(['kier mail'])
// A banner appears when the app fetches the mail, which after a closed lid can be days after it was sent.
const BEFORE = 3 * 86400
const AFTER = 900

const clean = (s) => String(s || '').normalize('NFKC').replace(/[‎‏‪-‮⁦-⁩]/g, '').replace(/\s+/g, ' ').trim().toLowerCase()
const letters = (s) => clean(s).replace(/[^\p{L}\p{N}]+/gu, '')
const metaOf = (item) => { if (item.meta && typeof item.meta === 'object') return item.meta; try { return JSON.parse(item.meta || '{}') || {} } catch { return {} } }

export function mailBanner(item) {
  if (item.source !== 'notifications' || item.from_me) return false
  return APPS.has(String(metaOf(item).app || '').toLowerCase()) || NAMES.has(clean(item.thread))
}

// The banner's own parts. Mail and Spark write "Sender (Subject): preview"; Kier Mail writes "Sender: Subject preview".
function parts(item) {
  const sender = clean(item.sender)
  const text = clean(item.text)
  return { sender, rest: sender && text.startsWith(sender) ? text.slice(sender.length) : '' }
}

function sameSubject(rest, subject) {
  if (subject.length < 4) return null
  const cut = subject.slice(0, 120)
  for (const lead of [' (', ': ']) {
    if (!rest.startsWith(lead + cut)) continue
    const after = rest.slice(lead.length + cut.length)
    // A longer subject that merely starts the same way is another mail.
    if (subject.length > 120) return after
    if (lead === ' (' ? after.startsWith(')') : (!after || after.startsWith(' '))) return after.replace(/^\)?:?\s*/, '')
  }
  return null
}

function sameSender(banner, row, meta) {
  const names = [row.sender, ...(Array.isArray(meta.from) ? meta.from.flatMap((a) => [a?.name, a?.email]) : [])].map(clean).filter((n) => n.length >= 3)
  return names.some((n) => n === banner || (banner.length >= 3 && (n.includes(banner) || banner.includes(n))))
}

// The stored mail this banner repeats, or null.
export function mailCopy(db, item) {
  if (!mailBanner(item)) return null
  const { sender, rest } = parts(item)
  if (!rest) return null
  const matches = db.prepare("select * from items where source = 'mail' and from_me = 0 and ts between ? and ?")
    .all(item.ts - BEFORE, item.ts + AFTER).filter((row) => {
      const meta = metaOf(row)
      const preview = sameSubject(rest, clean(meta.subject))
      if (preview == null) return false
      // The same subject from someone else is another mail, unless the banner shows this mail's own opening words.
      const opening = letters(preview).slice(0, 30)
      return sameSender(sender, row, meta) || (opening.length >= 12 && letters(meta.body).startsWith(opening))
    })
  return matches.sort((a, b) => Math.abs(a.ts - item.ts) - Math.abs(b.ts - item.ts))[0] || null
}

// Banners that became tasks before their mail was read, or before this rule existed.
const WINDOW = 60 * 86400
export function reconcileMailCopies(db, at = Math.floor(Date.now() / 1000)) {
  let count = 0
  const rows = db.prepare("select i.* from items i join tags t on t.item_id = i.id where i.source = 'notifications' and t.is_task = 1 and i.ts > ?").all(at - WINDOW)
  const clear = db.prepare("update tags set is_task = 0, model = 'mail-copy' where item_id = ?")
  const origin = db.prepare("select 1 from pragma_table_info('task_state') where name = 'completion_origin'").get()
  const state = db.prepare(`insert or ignore into task_state (item_id, status, changed_at, reason, url${origin ? ', completion_origin' : ''})
    select ?, status, changed_at, reason, url${origin ? ', completion_origin' : ''} from task_state where item_id = ?`)
  for (const item of rows) {
    const copy = mailCopy(db, item)
    // Wait until the mail has been read as a task too: a banner is never dropped for a mail that isn't one.
    if (!copy || !db.prepare('select 1 from tags where item_id = ? and is_task = 1').get(copy.id)) continue
    // What the owner, or Kier, already decided on the banner holds for the mail, unless the mail has its own.
    state.run(copy.id, item.id)
    db.prepare('update tags set confirmed = coalesce(confirmed, (select confirmed from tags where item_id = ?)) where item_id = ?').run(item.id, copy.id)
    clear.run(item.id)
    count++
  }
  return count
}
