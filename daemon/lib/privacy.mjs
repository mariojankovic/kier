import { invalidateProfile } from './profile-state.mjs'
import { createHash } from 'node:crypto'
import { readdirSync, rmSync } from 'node:fs'
import { resolve } from 'node:path'
import { dataDir, tmpDir } from './config.mjs'

// Adult sites and searches are never kept, whichever app they come through. Private and incognito windows
// keep no history of their own, and Kier.app skips what is copied in them.
const ADULT_SITES = [
  'pornhub.com', 'xvideos.com', 'xnxx.com', 'xhamster.com', 'redtube.com', 'youporn.com', 'tube8.com', 'spankbang.com',
  'eporner.com', 'beeg.com', 'tnaflix.com', 'empflix.com', 'drtuber.com', 'nuvid.com', 'upornia.com', 'txxx.com', 'hclips.com',
  'thumbzilla.com', 'youjizz.com', 'motherless.com', 'heavy-r.com', 'daftsex.com', 'hqporner.com', 'porntrex.com', '4tube.com',
  'chaturbate.com', 'stripchat.com', 'bongacams.com', 'cam4.com', 'livejasmin.com', 'myfreecams.com', 'camsoda.com',
  'onlyfans.com', 'fansly.com', 'manyvids.com', 'clips4sale.com', 'brazzers.com', 'realitykings.com', 'bangbros.com',
  'naughtyamerica.com', 'mofos.com', 'digitalplayground.com', 'vixen.com', 'tushy.com', 'blacked.com', 'nhentai.net',
  'hanime.tv', 'e621.net', 'gelbooru.com', 'danbooru.donmai.us', 'imagefap.com', 'literotica.com', 'f95zone.to', 'erome.com',
  'redgifs.com', 'fapello.com', 'coomer.su', 'adultfriendfinder.com',
]
const ADULT_TLDS = new Set(['xxx', 'porn', 'sex', 'adult', 'sexy'])
// Parts of a host name, split on dots and dashes: "free-porn-tube.net" has "porn".
const ADULT_LABEL = /porn|xxx|hentai|nsfw|^(sex|sexy|sexcam|nude|nudes|milf|fap|camgirls?|escorts?|erotic|erotica|erotik|rule34)$/
// Search queries, page titles and file names. English and Croatian.
const ADULT_WORDS = /(^|[^\p{L}\d])(porn\p{L}*|porno|pornić|xxx|nsfw|hentai|xvideos|xnxx|xhamster|onlyfans|chaturbate|nudes?|milfs?|camgirls?|rule ?34|blowjob|creampie|gangbang|sex|sexy|sexting|sextape|seks|jebanje|drkanje)(?=$|[^\p{L}\d])/iu
// Words decide only for what the owner looked at or saved; in messages from people they are too often jokes.
const WORD_SOURCES = new Set(['browser', 'downloads', 'clipboard'])

export function adultHost(host) {
  const h = String(host || '').toLowerCase().replace(/^www\./, '')
  if (!h) return false
  if (ADULT_SITES.some((d) => h === d || h.endsWith(`.${d}`))) return true
  const labels = h.split('.')
  if (ADULT_TLDS.has(labels.at(-1))) return true
  return labels.slice(0, -1).flatMap((l) => l.split('-')).some((l) => ADULT_LABEL.test(l))
}

export const adultWords = (text) => ADULT_WORDS.test(String(text || ''))

function hosts(item) {
  const found = []
  for (const s of [item.url, ...(String(item.text || '').match(/https?:\/\/[^\s<>"')]+/g) || [])]) {
    try { if (s) found.push(new URL(s).hostname) } catch {}
  }
  if (item.source === 'browser') found.push(item.thread)
  return found
}

export function adult(item) {
  if (hosts(item).some(adultHost)) return true
  return WORD_SOURCES.has(item.source) && (adultWords(item.text) || adultWords(item.thread))
}

// Forgotten things are remembered only as a one-way hash, so the vault never says what was forgotten.
// Every scoped read checks each row against the forgotten list, so a row's key is computed once and remembered.
const forgetKeys = new Map()
export const forgetKey = (kind, ...parts) => {
  const input = [kind, ...parts].join('\n')
  let key = forgetKeys.get(input)
  if (key === undefined) {
    key = createHash('sha256').update(input).digest('hex')
    if (forgetKeys.size >= 200_000) forgetKeys.clear()
    forgetKeys.set(input, key)
  }
  return key
}

export function forgotten(db) {
  return new Set(db.prepare('select key from forgotten').all().map((r) => r.key))
}

export function keep(item, gone) {
  if (adult(item)) return false
  return !gone.has(forgetKey('item', item.id)) && !gone.has(forgetKey('thread', item.source, item.thread ?? ''))
}

function remove(db, where, params) {
  const ids = `select id from items where ${where}`
  db.prepare(`delete from tags where item_id in (${ids})`).run(...params)
  db.prepare(`delete from vectors where item_id in (${ids})`).run(...params)
  db.prepare(`delete from plans where item_id in (${ids})`).run(...params)
  db.prepare(`delete from task_state where item_id in (${ids})`).run(...params)
  db.prepare(`delete from chats where key in (${ids})`).run(...params)
  db.prepare(`delete from chat_archive where key in (${ids})`).run(...params)
  db.prepare(`delete from heads_up where substr(key, 1, instr(key, '@') - 1) in (${ids})`).run(...params)
  return Number(db.prepare(`delete from items where ${where}`).run(...params).changes)
}

// One memory, or a whole chat, website or app; either way Kier also stops keeping it from now on.
export function forget(db, { id, source, thread }) {
  invalidateProfile()
  const at = Math.floor(Date.now() / 1000)
  const add = db.prepare('insert or ignore into forgotten (key, kind, at) values (?, ?, ?)')
  db.exec('begin')
  try {
    let removed
    if (id) {
      add.run(forgetKey('item', id), 'item', at)
      removed = remove(db, 'id = ?', [id])
    } else {
      add.run(forgetKey('thread', source, thread ?? ''), 'thread', at)
      removed = remove(db, 'source = ? and coalesce(thread, \'\') = ?', [source, thread ?? ''])
    }
    db.exec('commit')
    // Gone from the files as well: secure_delete (db.mjs) zeroes the freed pages, the checkpoint empties the WAL, and
    // what was written out around the vault (briefs, hand-off notes, Codex's answers) goes too.
    db.exec('pragma wal_checkpoint(TRUNCATE)')
    wipeAround()
    return removed
  } catch (e) {
    db.exec('rollback')
    throw e
  }
}

function wipeAround() {
  const sweep = (dir, match) => { try { for (const f of readdirSync(dir)) if (match.test(f)) rmSync(resolve(dir, f), { force: true }) } catch {} }
  sweep(resolve(dataDir, 'briefs'), /\.txt$/)
  sweep(tmpDir, /^(handoff-|open-|kier-codex-)/)
}

// Clears adult items saved before the filter existed, or before a site joined the list.
export function purgeAdult(db) {
  const bad = db.prepare('select id, source, thread, text, url from items').all().filter(adult).map((r) => r.id)
  db.exec('begin')
  try {
    for (const id of bad) remove(db, 'id = ?', [id])
    db.exec('commit')
  } catch (e) {
    db.exec('rollback')
    throw e
  }
  return bad.length
}
