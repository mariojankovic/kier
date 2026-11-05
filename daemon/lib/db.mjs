import { mailIdentity } from './mail-identity.mjs'
import { createHash } from 'node:crypto'
import { externalSender, ownerAuthored, evidenceMeta } from './evidence-trust.mjs'
import { mcpThread } from './mcp-identity.mjs'
import { redact } from './redact.mjs'
import { invalidateProfile } from './profile-state.mjs'
import { permitsItem } from './app-permissions.mjs'
import { DatabaseSync } from 'node:sqlite'
import { chmodSync, existsSync } from 'node:fs'
import { config, dbPath } from './config.mjs'
import { forgotten, keep, forgetKey } from './privacy.mjs'

export function open(path = dbPath, { readOnly = false } = {}) {
  const db = new DatabaseSync(path, { readOnly })
  db.exec('pragma busy_timeout = 5000')
  let lastOff, lastDisabled
  db.function('kier_origin_permitted', (source, thread, meta, disabled, sourceId) => {
    if (disabled !== lastOff) { lastDisabled = JSON.parse(disabled); lastOff = disabled }
    return Number(permitsItem({ source, thread, meta, sourceId }, lastDisabled))
  })
  db.function('kier_forget_key', { varargs: true }, (...parts) => forgetKey(...parts))
  if (readOnly) return db
  if (path !== ':memory:') for (const suffix of ['', '-wal', '-shm']) {
    if (existsSync(path + suffix)) chmodSync(path + suffix, 0o600)
  }
  // Deleted rows are overwritten, not just unlinked, so a forgotten message isn't left in the file.
  db.exec(`
    pragma secure_delete = on;
    pragma journal_mode = wal;
    create table if not exists items (
      id text primary key,
      source text not null,
      thread text,
      sender text,
      from_me integer not null default 0,
      ts integer not null,
      text text,
      url text,
      meta text
    );
    create index if not exists items_ts on items(ts);
    create index if not exists items_thread on items(source, thread, ts);
    create table if not exists tags (
      item_id text primary key references items(id),
      is_task integer not null,
      due text,
      when_words text,
      amount text,
      urgency integer,
      summary text,
      model text,
      tagged_at integer not null
    );
    create index if not exists tags_task on tags(is_task, due);
    create table if not exists task_state (
      item_id text primary key references items(id),
      status text not null,
      changed_at integer not null,
      reason text
    );
    create table if not exists cursors (source text primary key, value text not null);
    create table if not exists runs (source text primary key, ok integer not null, at integer not null, added integer, error text);
    create table if not exists access_log (ts integer not null, client text, tool text, args text, rows integer);
    create table if not exists forgotten (key text primary key, kind text not null, at integer not null);
    -- Conversations with Kier: "general", or an item's id for the chat about that item. Kept so they survive a restart.
    create table if not exists chats (key text not null, ts integer not null, q text not null, a text not null, agent text, seconds integer);
    create index if not exists chats_key on chats (key, ts);
    -- Conversations put away from the panel's list; still kept, like a closed card.
    create table if not exists chat_archive (key text primary key, at integer not null);
    -- Pairs of cards already asked about (are they the same work?), so each pair is asked once.
    create table if not exists merge_checked (a text not null, b text not null, at integer not null, primary key (a, b));
    -- What Kier handed to Claude or Codex, by size only, for the "On this Mac" panel (settings.mjs).
    create table if not exists outbound (ts integer not null, kind text not null, agent text, bytes integer not null);
    -- Tomorrow's events and dated tasks, each asked once whether it's worth a heads-up the day before (headsup.mjs).
    create table if not exists heads_up (key text primary key, important integer not null, label text, at integer not null);
    create table if not exists vectors (item_id text primary key, v blob not null);
    -- Each chat message read for a plan (plans.mjs): most aren't one; one that is says what, which day and when.
    create table if not exists plans (item_id text primary key, is_plan integer not null, what text, day text, starts text, ends text,
      weekly integer, cancelled integer, read_at integer not null);
  `)
  // what the chats say around a heads-up, and the words that found them.
  for (const col of ['words', 'context']) if (!db.prepare("select 1 from pragma_table_info('heads_up') where name = ?").get(col)) db.exec(`alter table heads_up add column ${col} text`)
  // a card the owner said is theirs ("Mine"), which never waits under "Maybe yours" again.
  if (!db.prepare("select 1 from pragma_table_info('tags') where name = 'confirmed'").get()) db.exec('alter table tags add column confirmed integer')
  // a request read in a quiet group, which waits under "Maybe yours" (tagger.mjs).
  if (!db.prepare("select 1 from pragma_table_info('tags') where name = 'quiet'").get()) db.exec('alter table tags add column quiet integer')
  // which way of asking for search words made the row (headsup.mjs ASKED).
  if (!db.prepare("select 1 from pragma_table_info('heads_up') where name = 'asked'").get()) db.exec('alter table heads_up add column asked integer')
  // the second opinion's probability that a task is really the owner’s.
  if (!db.prepare("select 1 from pragma_table_info('tags') where name = 'second'").get()) db.exec('alter table tags add column second real')
  // which card a task shows as (payment, appointment, reply, promise, todo).
  if (!db.prepare("select 1 from pragma_table_info('tags') where name = 'card'").get()) db.exec('alter table tags add column card text')
  // the whole burst a task was read from, when it was typed as several quick messages.
  if (!db.prepare("select 1 from pragma_table_info('tags') where name = 'said'").get()) db.exec('alter table tags add column said text')
  // when "did it get done?" last looked at a task, and the link to what showed it was done.
  if (!db.prepare("select 1 from pragma_table_info('tags') where name = 'checked_at'").get()) db.exec('alter table tags add column checked_at integer')
  if (!db.prepare("select 1 from pragma_table_info('task_state') where name = 'url'").get()) db.exec('alter table task_state add column url text')
  // Only recorded owner authority may complete an original Apple reminder.
  if (!db.prepare("select 1 from pragma_table_info('task_state') where name = 'completion_origin'").get()) {
    db.exec(`alter table task_state add column completion_origin text;
      update task_state set completion_origin = 'owner' where status = 'done' and reason = 'marked in the timeline';
      update task_state set completion_origin = 'reminders' where status = 'done' and reason = 'ticked off in Reminders'`)
  }
  // when the owner's Claude last double-checked a card Kier couldn't settle (doublecheck.mjs).
  if (!db.prepare("select 1 from pragma_table_info('tags') where name = 'deep_at'").get()) db.exec('alter table tags add column deep_at integer')
  // a commit that may have kept a promise, shown on the card for one-click confirmation.
  if (!db.prepare("select 1 from pragma_table_info('tags') where name = 'hint'").get()) db.exec('alter table tags add column hint text; alter table tags add column hint_url text')
  if (!db.prepare("select 1 from pragma_table_info('items') where name = 'source_id'").get()) db.exec('alter table items add column source_id text')
  db.exec('create index if not exists items_source_id on items(source, source_id)')
  repairText(db)
  repairMailProvenance(db)
  repairCompletionProvenance(db)
  repairMcpThreads(db)
  repairImportedAuthorship(db)
  keepEarlierClosures(db)
  return db
}

export const now = () => Math.floor(Date.now() / 1000)

export function cursor(db, source, fallback) {
  const row = db.prepare('select value from cursors where source = ?').get(source)
  return row ? row.value : fallback
}

export function setCursor(db, source, value) {
  db.prepare('insert into cursors (source, value) values (?, ?) on conflict(source) do update set value = excluded.value').run(source, String(value))
}

// Collectors hand over plain objects; existing ids keep their tags on a re-read.
// Every source passes through here, so this is where adult content and forgotten things are dropped.
export function addItems(db, all) {
  const gone = forgotten(db)
  const trusted = all.map(i => ({ ...i, fromMe: ownerAuthored(i), ...(i.source === 'mcp' && { sender: externalSender(i.sender) }) }))
  const migrated = []
  // Forget records keys from the stored, redacted row. An incoming item is checked in both forms: as it
  // arrives and exactly as it would be stored, so the comparison never depends on how redaction rewrote it.
  const items = trusted.filter(i => permitsItem(i)).map(i => {
    if (i.source !== 'mail') return i
    const { current, aliases } = mailIdentity(i)
    const stored = mailIdentity(redactItem({ ...i, id: current }))
    if ([...aliases, ...stored.aliases].some(id => gone.has(forgetKey('item', id)))) {
      migrated.push(current)
      return null
    }
    return { ...i, id: current }
  }).filter(i => i && keep(i, gone) && keep(redactItem(i), gone)).map(redactItem)
  const insert = db.prepare(`insert or ignore into items (id, source, thread, sender, from_me, ts, text, url, meta, source_id)
    values (:id, :source, :thread, :sender, :from_me, :ts, :text, :url, :meta, :source_id)`)
  // Copies are immutable. Message-ID and matching From headers never authorize enrichment.
  let added = 0
  db.exec('begin')
  try {
    const tombstone = db.prepare("insert or ignore into forgotten (key, kind, at) values (?, 'item', ?)")
    for (const id of migrated) tombstone.run(forgetKey('item', id), now())
    for (const i of items) {
      const inserted = Number(insert.run({
        id: i.id, source: i.source, source_id: i.sourceId ?? null, thread: i.thread ?? null, sender: i.sender ?? null, from_me: i.fromMe ? 1 : 0,
        ts: i.ts, text: i.text ?? null, url: i.url ?? null, meta: i.meta ? JSON.stringify(i.meta) : null,
      }).changes)
      added += inserted

    }
    db.exec('commit')
  } catch (e) {
    db.exec('rollback')
    throw e
  }
  return added
}

export function recordRun(db, source, { ok, added = 0, error = null }) {
  db.prepare(`insert into runs (source, ok, at, added, error) values (?, ?, ?, ?, ?)
    on conflict(source) do update set ok = excluded.ok, at = excluded.at, added = excluded.added, error = excluded.error`)
    .run(source, ok ? 1 : 0, now(), added, error)
}

// Content fields are scrubbed together, including nested titles and locations in metadata.
export function redactValue(value) {
  if (typeof value === 'string') return redact(value).text
  if (Array.isArray(value)) return value.map(redactValue)
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, v]) => [key, redactValue(v)]))
  return value
}
function redactMeta(value) {
  if (typeof value !== 'string') return redactValue(value)
  try { return redactValue(JSON.parse(value)) } catch { return redact(value).text }
}
function redactItem(item) {
  return { ...item, thread: redactValue(item.thread), sender: redactValue(item.sender),
    text: redactValue(item.text), url: redactValue(item.url), meta: redactMeta(item.meta) }
}

const TEXT_REPAIR = 'redact-persisted-content-v1'
function repairText(db) {
  db.exec('create table if not exists migrations (id text primary key, at integer not null)')
  if (db.prepare('select 1 from migrations where id = ?').get(TEXT_REPAIR)) return
  // Repair derived text too, so a cached summary cannot reintroduce an old credential.
  const fields = {
    items: ['thread', 'sender', 'text', 'url', 'meta'],
    tags: ['summary', 'said', 'hint', 'hint_url', 'when_words', 'amount'],
    chats: ['q', 'a'], task_state: ['reason', 'url'],
    plans: ['what'], heads_up: ['label', 'words', 'context'], runs: ['error'],
  }
  db.exec('begin')
  try {
    let changed = false
    // Only a real redaction counts as a change: metadata is compared as data, so re-serialising it never does.
    const metaValue = (raw) => {
      if (raw == null) return raw
      let parsed
      try { parsed = JSON.parse(raw) } catch { return redact(raw).text }
      const clean = redactValue(parsed)
      return JSON.stringify(clean) === JSON.stringify(parsed) ? raw : JSON.stringify(clean)
    }
    const stale = []
    for (const [table, columns] of Object.entries(fields)) {
      const update = db.prepare(`update ${table} set ${columns.map(c => `${c} = ?`).join(',')} where rowid = ?`)
      const key = table === 'items' ? ', id as repair_item' : ''
      for (const row of db.prepare(`select rowid as repair_id${key}, ${columns.join(',')} from ${table}`).all()) {
        const values = columns.map(c => c === 'meta' ? metaValue(row[c]) : redactValue(row[c]))
        if (values.some((v, i) => v !== row[columns[i]])) {
          update.run(...values, row.repair_id)
          changed = true
          // Search fingerprints come from the message itself; only the messages that changed are indexed again.
          if (table === 'items' && ['thread', 'sender', 'text'].some(c => values[columns.indexOf(c)] !== row[c])) stale.push(row.repair_item)
        }
      }
    }
    const drop = db.prepare('delete from vectors where item_id = ?')
    for (const id of stale) drop.run(id)
    if (changed) invalidateProfile()
    db.prepare('insert into migrations values (?, ?)').run(TEXT_REPAIR, now())
    db.exec('commit')
    db.exec('pragma wal_checkpoint(TRUNCATE)')
  } catch (e) { db.exec('rollback'); throw e }
}

// Old merged rows have no recoverable copy provenance. Recollect instead of trusting their text.
function repairMailProvenance(db) {
  const version = 'mail-copy-provenance-v2'
  if (db.prepare('select 1 from migrations where id = ?').get(version)) return
  db.exec('begin')
  try {
    const gone = forgotten(db)
    const tombstone = db.prepare("insert or ignore into forgotten (key, kind, at) values (?, 'item', ?)")
    for (const row of db.prepare("select * from items where source = 'mail'").all()) {
      const { current, aliases } = mailIdentity(row)
      if (aliases.some(id => gone.has(forgetKey('item', id)))) tombstone.run(forgetKey('item', current), now())
    }
    const ids = "select id from items where source = 'mail'"
    if (db.prepare("select 1 from items where source = 'mail' limit 1").get()) invalidateProfile()
    for (const table of ['tags', 'vectors', 'plans', 'task_state']) db.exec(`delete from ${table} where item_id in (${ids})`)
    for (const table of ['chats', 'chat_archive']) db.exec(`delete from ${table} where key in (${ids})`)
    db.exec(`delete from heads_up where substr(key, 1, instr(key, '@') - 1) in (${ids})`)
    db.exec("delete from items where source = 'mail'; delete from cursors where source like 'mail:%' or source like 'gmail:%'")
    db.prepare('insert into migrations values (?, ?)').run(version, now())
    db.exec('commit')
  } catch (e) { db.exec('rollback'); throw e }
}

// Earlier owner-message verdicts could include inherited subjects or quotations.
// Preserve explicit owner marks, but require confirmation for old inferred proof.
function repairCompletionProvenance(db) {
  const version = 'authored-completion-v3'
  if (db.prepare('select 1 from migrations where id = ?').get(version)) return
  db.exec('begin')
  try {
    db.exec("update task_state set status = 'looks_done', completion_origin = null where completion_origin = 'owner-message'")
    db.prepare('insert into migrations values (?, ?)').run(version, now())
    db.exec('commit')
  } catch (e) { db.exec('rollback'); throw e }
}

// Updates must not reopen what the owner had stopped seeing. Before 0.7.7 a reply of the owner's in the same chat
// closed most cards; stricter rules now leave some open. Cards older than two days that the owner answered in that
// chat within a day stay closed, and Reminders deletions from before origins were recorded count as the owner's.
// Nothing here reaches Apple Reminders: no completion origin is claimed for them.
function keepEarlierClosures(db) {
  const version = 'keep-earlier-closures-v1'
  if (db.prepare('select 1 from migrations where id = ?').get(version)) return
  db.exec('begin')
  try {
    db.exec("update task_state set completion_origin = 'reminders' where reason = 'deleted in Reminders' and completion_origin is null")
    const cutoff = now() - 2 * 86400
    db.prepare(`insert or ignore into task_state (item_id, status, changed_at, reason)
      select t.item_id, 'handled', ?, 'closed by an earlier version of Kier' from tags t join items i on i.id = t.item_id
      left join task_state s on s.item_id = t.item_id
      where t.is_task = 1 and s.item_id is null and i.from_me = 0 and i.ts < ? and i.source not in ('kier', 'reminders', 'ai')
        and exists (select 1 from items o where o.source = i.source and o.thread = i.thread and o.from_me = 1
          and o.ts > i.ts and o.ts <= i.ts + 86400)`).run(now(), cutoff)
    db.prepare('insert into migrations values (?, ?)').run(version, now())
    db.exec('commit')
  } catch (e) { db.exec('rollback'); throw e }
}

function repairMcpThreads(db) {
  const version = 'mcp-thread-identity-v1'
  if (db.prepare('select 1 from migrations where id = ?').get(version)) return
  db.exec('begin')
  try {
    const update = db.prepare('update items set thread = ?, meta = ? where id = ?')
    for (const row of db.prepare("select * from items where source = 'mcp'").all()) {
      let meta = {}; try { meta = JSON.parse(row.meta || '{}') } catch {}
      const channel = meta.threadVersion === 1 ? meta.channel : row.thread || ''
      const server = (config.mcpSources || []).find(s => s.id === row.source_id)
      update.run(mcpThread(row.source_id, channel), JSON.stringify({ ...meta, channel, threadVersion: 1, mcpServer: server?.name || 'Removed server' }), row.id)
      db.prepare('delete from vectors where item_id = ?').run(row.id)
      for (const table of ['chats', 'chat_archive']) db.prepare(`delete from ${table} where key = ?`).run(row.id)
    }
    db.prepare('insert into migrations values (?, ?)').run(version, now())
    db.exec('commit')
  } catch (e) { db.exec('rollback'); throw e }
}

function repairImportedAuthorship(db) {
  const version = 'imported-authorship-v1'
  if (db.prepare('select 1 from migrations where id = ?').get(version)) return
  db.exec('begin')
  try {
    for (const row of db.prepare("select id, sender from items where source = 'mcp'").all()) {
      db.prepare('update items set from_me = 0, sender = ? where id = ?').run(externalSender(row.sender), row.id)
    }
    db.exec("update items set from_me = 0 where source = 'mail' and json_valid(meta) and json_extract(meta, '$.client') = 'gmail' and coalesce(json_extract(meta, '$.ownerSent'), 0) != 1")
    db.prepare('insert into migrations values (?, ?)').run(version, now())
    db.exec('commit')
  } catch (e) { db.exec('rollback'); throw e }
}
