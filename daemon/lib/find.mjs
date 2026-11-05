import { localAuthorization, readScope } from './authorization.mjs'
import { modelFetch } from './model-provider.mjs'
import { aiProvider } from './ai-provider.mjs'
// Search cards, events, files, messages and assistant sessions with words and semantic similarity.
// A second pass interprets the query to narrow source, person and topic. Results open the
// original item in its application or in Kier.
import { config } from './config.mjs'
import { appLink, sessionRecords } from './handoff.mjs'
import { embed, nearest, person, ready } from './meaning.mjs'
import { pressure } from './memory.mjs'
import { offClause } from './settings.mjs'
import { dayLabel, isoDay, plusDays, tasks, today } from './tasks.mjs'
import { datesOf, plans, shows } from './plans.mjs'

const N = 8
const LABEL = { whatsapp: 'WhatsApp', imessage: 'iMessage', discord: 'Discord', mail: 'Mail', notifications: 'Notification', social: 'Reply', chat: 'Kier chat',
  ai: 'Claude session', downloads: 'Download', browser: 'Web page', calendar: 'Calendar', calls: 'Call' }
const APPS = { whatsapp: 'net.whatsapp.WhatsApp', imessage: 'com.apple.MobileSMS', discord: 'com.hnc.Discord' }
// What the model may say a request is about, and the sources each covers.
const KINDS = {
  ai: ['ai'], chat: ['whatsapp', 'imessage', 'discord', 'notifications', 'social'], mail: ['mail', 'notifications'],
  file: ['downloads'], page: ['browser'], event: ['calendar'], call: ['calls'],
}
const UNDERSTAND = `Turn a search request into JSON: {"kind": one of "ai" (a Claude or Codex session), "chat" (a message in WhatsApp, iMessage, Discord and the like), "mail", "file" (something downloaded), "page" (a web page visited), "event" (a calendar event), "call", "task" (something to do), or "any"; "person": the name of the person or chat it is with, or ""; "topic": what it is about, in a few plain words, without the kind or the person}. Claude and Codex are AI assistants, not people. Reply with only the JSON.`

const clean = (s) => String(s || '').replace(/[⁦-⁩]/g, '').replace(/\s+/g, ' ').trim()
const words = (s) => [...new Set((clean(s).toLowerCase().match(/[\p{L}\p{N}]{3,}/gu) || []))]
  .filter((w) => !['the', 'and', 'that', 'this', 'about', 'what', 'find', 'from', 'with', 'chat', 'when', 'where', 'did', 'was', 'for', 'show'].includes(w)).slice(0, 6)

// One found item as the bar shows it, and where Return takes it.
function result(db, r, cards, score) {
  const meta = (() => { try { return JSON.parse(r.meta || '{}') } catch { return {} } })()
  const when = dayLabel(isoDay(r.ts))
  const card = cards.get(r.id)
  if (card) return { id: r.id, kind: 'card', title: card.summary, detail: `${card.from_me ? 'You promised' : `${clean(r.sender)} asked you`} · ${when}`, open: { card: r.id }, score }
  if (r.source === 'ai') {
    const link = meta.session ? appLink({ ...meta, agent: meta.agent || r.sender, title: r.thread }) : null
    return { id: r.id, kind: 'session', title: clean(r.thread), detail: `${meta.agent || 'AI'} session · ${when}${meta.request ? ` · "${clean(meta.request).slice(0, 70)}"` : ''}`, open: link ? { url: link } : { app: ['codex', 'chatgpt'].includes(aiProvider({ ...meta, agent: meta.agent || r.sender })) ? 'com.openai.codex' : 'com.anthropic.claudefordesktop' }, score }
  }
  if (r.source === 'downloads') return { id: r.id, kind: 'file', title: clean(r.text).replace(/^Downloaded:?\s*/i, ''), detail: `Downloads · ${when}`, open: r.url ? { file: r.url } : {}, score }
  if (r.source === 'browser') return { id: r.id, kind: 'page', title: clean(r.text), detail: `${clean(r.thread)} · ${when}`, open: r.url ? { url: r.url } : {}, score }
  if (r.source === 'calendar') return { id: r.id, kind: 'event', title: clean(r.text), detail: `Calendar · ${when}`, open: { event: r.id }, score }
  const who = r.from_me ? 'You' : clean(r.sender)
  const where = r.thread && clean(r.thread) !== who ? ` in ${clean(r.thread)}` : ''
  // A Claude notice names its session ("session-local_…") and opens that conversation: opening the app did nothing
  // while Claude was already in front. A session since deleted opens the app.
  const session = r.source === 'notifications' && /^session-(local_[\w-]+)$/.exec(meta.conversation || '')?.[1]
  const link = session && sessionRecords().some((x) => x.sessionId === session) ? `claude://claude.ai/epitaxy/${session}` : null
  return { id: r.id, kind: 'message', title: clean(r.text).slice(0, 140), detail: `${who}${where} · ${LABEL[r.source] || r.source} · ${when}`,
    open: link ? { url: link } : r.url ? { url: r.url } : (APPS[r.source] || meta.app) ? { app: APPS[r.source] || meta.app } : {}, score }
}

// Words and meaning over `sources` (all when empty), optionally only the chats a person is in. Best first.
async function rank(db, text, { sources = [], who = null, meant = text, extras = true } = {}) {
  db = readScope(db, localAuthorization())
  const src = sources.length ? `and i.source in (${sources.map(() => '?').join(', ')})` : ''
  // Include direct chats and all groups the named person participates in, with messages from
  // every participant so the owner’s side of each conversation is searchable.
  const scope = who ? "and i.thread in (select distinct thread from items where source != 'notifications' and (lower(thread) like ? or lower(sender) like ?))" : ''
  const params = [...sources, ...(who ? [`%${who.toLowerCase()}%`, `%${who.toLowerCase()}%`] : [])]
  const scores = new Map()
  // Semantic similarity is less informative for very short messages, so reduce their weight.
  const near = ready() ? await nearest(db, meant, { k: 100, where: `${src} ${scope}`, params }).catch(() => []) : []
  const texts = new Map(near.length ? db.prepare(`select id, text from items where id in (${near.map(() => '?').join(', ')})`).all(...near.map((r) => r.id)).map((r) => [r.id, r.text]) : [])
  for (const r of near) scores.set(r.id, r.score * Math.min(1, (String(texts.get(r.id) || '').match(/[\p{L}\p{N}]{2,}/gu) || []).length / 3))
  // Prefer exact phrases, then rows matching all words, before partial matches.
  // Do not let common words crowd exact results out of the candidate window.
  const ws = words(text)
  const phrase = ws.length > 1 ? clean(text).toLowerCase() : null
  let rarest = null
  if (ws.length) {
    const has = '(lower(i.text) like ? or lower(i.thread) like ?)'
    const each = ws.flatMap((w) => [`%${w}%`, `%${w}%`])
    const rows = db.prepare(`select i.id, i.source, i.text, i.thread from items i where 1 = 1 ${src} ${scope} and (${ws.map(() => has).join(' or ')}) ${offClause()}
      order by ${phrase ? `${has} desc, ` : ''}(${ws.map(() => has).join(' + ')}) desc, i.ts desc limit 300`)
      .all(...params, ...each, ...(phrase ? [`%${phrase}%`, `%${phrase}%`] : []), ...each)
    const hay = (r) => `${r.text} ${r.thread}`.toLowerCase()
    // When a query names an exact phrase in the vault, downweight rows missing its rarest word.
    const named = phrase && rows.some((r) => hay(r).includes(phrase))
    rarest = named ? ws.map((w) => [w, rows.filter((r) => hay(r).includes(w)).length]).sort((a, b) => a[1] - b[1])[0][0] : null
    for (const r of rows) {
      const h = hay(r)
      // Copying the request to search for it isn't a find.
      if (r.source === 'clipboard' && clean(r.text).toLowerCase() === phrase) continue
      const share = ws.filter((w) => h.includes(w)).length / ws.length
      scores.set(r.id, (scores.get(r.id) || 0.4) + 0.25 * share + (phrase && h.includes(phrase) ? 0.6 : 0))
    }
    if (rarest) {
      const said = new Map([...[...texts].map(([id, t]) => [id, String(t || '').toLowerCase()]), ...rows.map((r) => [r.id, hay(r)])])
      for (const [id, sc] of scores) if (!(said.get(id) || '').includes(rarest)) scores.set(id, sc / 2)
    }
  }
  // Search card titles independently because translated titles may share no words with the
  // original messages. Search plans by their own descriptions too.
  const cards = new Map(tasks(db, { days: 90 }).map((t) => [t.id, t]))
  const lead = []
  if (extras && ws.length) {
    const hit = (s) => { const h = String(s).toLowerCase(); return ws.filter((w) => h.includes(w)).length / ws.length }
    for (const t of cards.values()) {
      if (!['open', 'overdue'].includes(t.state) || (who && !`${t.thread} ${t.sender}`.toLowerCase().includes(who.toLowerCase()))) continue
      const share = hit(t.summary)
      if (share >= 0.5) scores.set(t.id, Math.max(scores.get(t.id) || 0, 0.8 + 0.2 * share))
    }
    if (!who && (!sources.length || sources.includes('calendar'))) {
      for (const p of plans(db).filter(shows)) {
        const share = hit(p.what)
        const day = datesOf(p, today(), plusDays(today(), 28))[0]
        if (share >= 0.5 && day) lead.push({ id: p.id, kind: 'plan', title: p.what, detail: `${p.weekly ? `Every ${dayLabel(day).split(' ')[0]}` : dayLabel(day)}${p.starts ? `, ${p.starts}${p.ends ? ` to ${p.ends}` : ''}` : ''} · from the ${p.thread} chat`, open: { event: p.id }, score: 0.9 + 0.1 * share })
      }
    }
  }
  // Plenty of candidates, as the same page visited 39 times took every place before repeats were merged.
  const top = [...scores].sort((a, b) => b[1] - a[1]).slice(0, 200)
  if (!top.length) return lead.slice(0, N)
  const rows = db.prepare(`select id, source, thread, sender, from_me, ts, text, url, meta from items where id in (${top.map(() => '?').join(', ')})`).all(...top.map(([id]) => id))
  const byId = new Map(rows.map((r) => [r.id, r]))
  const found = []
  const seen = new Set()
  for (const [id, score] of top) {
    const r = byId.get(id)
    if (!r) continue
    const res = result(db, r, cards, score)
    // A session shows once, whichever day of it matched.
    const key = res.kind === 'session' ? `session:${clean(r.thread)}` : `${res.kind}:${res.title}`
    if (seen.has(key)) continue
    seen.add(key)
    found.push(res)
    if (found.length === 4 * N) break
  }
  // A very short message repeating query words is weaker than a substantive answer.
  const echo = (r) => r.kind === 'message' && ws.length > 1 && words(r.title).length < ws.length && words(r.title).every((w) => ws.includes(w))
  for (let i = found.length - 1; i >= 0; i--) if (echo(found[i])) found.splice(i, 1)
  // Limit each result kind to half the list when other kinds also match.
  const out = [...lead]
  const count = {}
  const fits = (r) => (count[r.kind] || 0) < Math.ceil(N / 2)
  for (const r of found) {
    if (out.length === N) break
    if (!fits(r) && found.some((o) => o !== r && !out.includes(o) && fits(o))) continue
    out.push(r)
    count[r.kind] = (count[r.kind] || 0) + 1
  }
  return out
}

// As you type: everything, words and meaning.
export const quick = (db, q) => rank(db, q)

// The bar asks again at each pause in typing, so only the newest request goes to the model: one typed past by the time
// its turn comes is dropped, and the request you stopped on waits for one other at most.
let newest = 0
let line = Promise.resolve()

// A moment later: what the request is for, then the search within that.
export async function understood(db, q) {
  // Short queries already express a topic; avoid model latency for a redundant interpretation.
  if (words(q).length + (q.match(/\b(what|who|when|where|that|find)\b/gi) || []).length < 4) return { results: await quick(db, q), understood: null }
  const mine = ++newest
  const asked = line.then(() => (mine === newest ? modelFetch('/api/chat', {
    method: 'POST', signal: AbortSignal.timeout(30000),
    body: JSON.stringify({ model: config.model, asked: true, stream: false, think: false, keep_alive: config.keepAlive, options: { temperature: 0, num_predict: 60 },
      messages: [{ role: 'system', content: UNDERSTAND }, { role: 'user', content: q }] }),
  }).then(async (r) => (r.ok ? (await r.json()).message?.content : null)) : undefined))
  line = asked.catch(() => {})
  const answer = await asked.catch(() => null)
  if (answer === undefined) return { results: [], understood: null, superseded: true }
  if (answer == null) return { results: await quick(db, q), understood: null }
  const read = JSON.parse(String(answer).match(/\{[\s\S]*\}/)?.[0] ?? 'null') || {}
  const kind = KINDS[read.kind] ? read.kind : read.kind === 'task' ? 'task' : 'any'
  // A person only counts when the vault knows them: "Claude" is the assistant, not someone in your chats.
  const who = read.person && !/^(claude|codex|chatgpt|kier)$/i.test(read.person) && person(db, read.person.replace(/^\p{Ll}/u, (c) => c.toUpperCase())) ? read.person : null
  const topic = clean(read.topic) || q
  // Use the full request for meaning so a short substring cannot displace the intended topic.
  let results = await rank(db, topic, { sources: KINDS[kind] || [], who, meant: q })
  if (kind === 'task') results = results.filter((r) => r.kind === 'card')
  // Too narrow is worse than too wide: with nothing found, what the quick pass had.
  if (!results.length) results = await quick(db, q)
  return { results, understood: { kind, person: who, topic } }
}

// Opening the bar loads the search model, so the first letters already search by meaning, the model that reads what you
// ask for (2.5 s to load, which a first search paid; not on a Mac short of memory, which wants it gone), and the Claude
// app's session records, for the links.
export function warm() {
  sessionRecords()
  if (pressure() === 1) modelFetch('/api/chat', {
    method: 'POST', signal: AbortSignal.timeout(30000),
    body: JSON.stringify({ model: config.model, asked: true, stream: false, think: false, keep_alive: config.keepAlive, options: { num_predict: 1 },
      messages: [{ role: 'user', content: 'hi' }] }),
  }).catch(() => {})
  return ready() ? embed(['warm'], { query: true }).then(() => true, () => false) : Promise.resolve(false)
}
