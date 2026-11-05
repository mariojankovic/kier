import { modelFetch } from './model-provider.mjs'
// Learn owner aliases, relationships and group purpose from the vault. Group titles are labels,
// not necessarily literal topics. Draft on first run and refresh weekly, preserving owner edits.
// Model inference uses the selected provider; cloud questions include relevant profile context.
import { currentProfile, profileState, saveProfile } from './profile-state.mjs'
import { readScope, localAuthorization } from './authorization.mjs'
import { config } from './config.mjs'
import { now } from './db.mjs'
import { P } from './lang.mjs'

const WEEK = 7 * 86400
const N = config.me
const PEOPLE = 12
const GROUPS = 6
let building = null

export const profile = currentProfile

const save = (p, generation = profileState().generation) => saveProfile(p, generation)

// The owner's edits: the about text and any person or group line they changed or added.
export function edit(changes) {
  const p = profile() || { about: '', people: [], groups: [], aliases: [] }
  if (typeof changes.about === 'string') { p.about = changes.about.trim(); p.aboutEdited = true }
  for (const kind of ['people', 'groups']) {
    for (const e of changes[kind] || []) {
      const name = String(e.name || '').trim()
      if (!name) continue
      const old = p[kind].find((x) => x.name === name)
      if (old) Object.assign(old, { text: String(e.text || '').trim(), edited: true })
      else p[kind].push({ name, text: String(e.text || '').trim(), edited: true })
    }
  }
  save(p)
  return p
}

// The profile as a few lines for a prompt; only the people and groups asked for, when it's about one chat.
export function profileText({ people, group } = {}) {
  const p = profile()
  if (!p) return ''
  const who = p.people.filter((x) => x.text && (!people || people.some((n) => sameName(n, x.name))))
  const groups = p.groups.filter((x) => x.text && (!group || x.name === group))
  return [
    `${N}${p.aliases?.length ? ` (also ${p.aliases.join(', ')})` : ''}: ${p.about || config.about || ''}`.trim(),
    who.length ? `People:\n${who.map((x) => `- ${x.name}: ${x.text}`).join('\n')}` : '',
    groups.length ? `Group chats (the name is a label, this is what it's for):\n${groups.map((x) => `- ${x.name}: ${x.text}`).join('\n')}` : '',
  ].filter(Boolean).join('\n\n')
}

// Only what helps read one chat, for the tagger and the done-check: who the people in it are to the owner, and what
// the group is for, without its name (names mislead; see prompt() in tagger.mjs).
export function slice({ people = [], group } = {}) {
  const p = profile()
  if (!p) return ''
  const who = p.people.filter((x) => x.text && people.some((n) => sameName(n, x.name)))
  const g = group ? p.groups.find((x) => x.name === group && x.text) : null
  return [
    who.length ? `Who's who, from ${N}'s profile (background, to see who is asking whom and about what):\n${who.map((x) => `- ${x.name.split(/\s+/)[0]}: ${x.text}`).join('\n')}` : '',
    g ? `What this group is for: ${g.text}` : '',
  ].filter(Boolean).join('\n')
}

// Every name the owner answers to in a mention: their first name and the others the profile found.
export const names = () => [...new Set([N, ...(profile()?.aliases || []).map((a) => a.split(/\s+/)[0])])]

// Match a first-name group sender to the same person’s full name in a direct chat.
const first = (s) => String(s || '').replace(/[‎‏⁦-⁩]/g, '').trim().split(/\s+/)[0].toLowerCase()
const sameName = (a, b) => first(a) && first(a) === first(b)

// Owner-supplied identity and mentions from permitted messages only.
function aliases(db) {
  const names = new Set([config.fullName].filter(Boolean))
  const mentioned = db.prepare(`select text from items where source = 'whatsapp' and from_me = 0 and text like '%@%' and ts > ? limit 400`).all(now() - 60 * 86400)
  for (const r of mentioned) for (const m of String(r.text).matchAll(/@([A-ZČĆŠŽĐ][\p{L}]+)/gu)) if (first(m[1]) === first(N)) names.add(m[1])
  return [...names].filter((n) => n && n !== N)
}

async function local(system, user) {
  const res = await modelFetch('/api/chat', {
    method: 'POST', signal: AbortSignal.timeout(180000),
    body: JSON.stringify({ model: config.model, stream: false, think: false, keep_alive: config.keepAlive, options: { temperature: 0.2, num_ctx: 8192 },
      messages: [{ role: 'system', content: system }, { role: 'user', content: user }] }),
  })
  if (!res.ok) throw Error(`ollama ${res.status}`)
  return (await res.json()).message.content.trim().replace(/^["']|["']$/g, '')
}

const line = (r) => `${r.from_me ? N : r.sender}: ${String(r.text || '').replace(/\s+/g, ' ').slice(0, 220)}`
// Describe supported facts neutrally. Jokes and banter are not biography, and sensitive
// inferences require explicit support in the conversation.
const ONLY = `Only what the messages plainly show; never guess, and treat jokes and banter as jokes, not facts. Neutral and kind: leave out anything legal, medical, sexual, political or about money troubles unless it is plainly what they talk about. Write in the third person, never "you". No em dashes. Plain text, no lists, no quotes.`

// Drafts the profile: the owner, then each person and group. Edited lines are kept as they are.
export async function build(db, infer = local) {
  if (building) return building
  const generation = profileState().generation
  db = readScope(db, localAuthorization())
  // Stop at each model boundary as well as at the final write.
  const permittedInference = async (...args) => {
    if (profileState().generation !== generation) throw Error('PROFILE_INVALIDATED')
    const result = await infer(...args)
    if (profileState().generation !== generation) throw Error('PROFILE_INVALIDATED')
    return result
  }
  building = (async () => {
    const old = profile() || { people: [], groups: [] }
    const since = now() - 30 * 86400
    const chats = "source in ('whatsapp', 'imessage', 'discord', 'chat')"

    const mine = db.prepare(`select from_me, sender, text from items where ${chats} and from_me = 1 and ts > ? and length(text) between 25 and 400 order by random() limit 70`).all(since)
    const repos = db.prepare(`select thread, count(*) n from items where source = 'git' and ts > ? group by thread order by n desc limit 8`).all(since).map((r) => r.thread)
    const sites = db.prepare(`select url from items where source = 'browser' and ts > ? limit 20000`).all(since)
      .reduce((m, r) => { try { const h = new URL(r.url).host.replace(/^www\./, ''); m.set(h, (m.get(h) || 0) + 1) } catch {} return m }, new Map())
    const top = [...sites].sort((a, b) => b[1] - a[1]).slice(0, 12).map(([h]) => h)
    const chatNames = db.prepare(`select thread from items where ${chats} and ts > ? group by thread order by count(*) desc limit 15`).all(since).map((r) => r.thread)
    // The owner's own line from their config leads, then the draft; all of it one text they can edit on Setup.
    const about = old.aboutEdited ? old.about : [config.about, await permittedInference(
      `You describe ${N}, the owner of this Mac, for ${P.his} own assistant. ${ONLY} 3 or 4 short sentences: what ${N} does and works on, the projects and companies, and the languages ${N} writes in. Leave out where ${N} lives: a trip to a city reads like an address, and ${N} can add it.`,
      `Code projects ${N} commits to: ${repos.join(', ') || 'none'}\nSites ${N} uses most: ${top.join(', ')}\nChats ${N} is in: ${chatNames.join(', ')}\n\nMessages ${N} wrote:\n${mine.map(line).join('\n')}`)].filter(Boolean).join(' ')

    // The people: most messages exchanged, one to one chats and group senders alike, merged by first name.
    const counts = new Map()
    for (const r of db.prepare(`select thread, sender, from_me, json_extract(meta, '$.group') grp, count(*) n from items where ${chats} and ts > ? group by thread, sender, from_me`).all(since)) {
      const name = r.grp ? (r.from_me ? null : r.sender) : r.thread
      if (!name || sameName(name, N) || /^someone$/i.test(name)) continue
      const key = first(name)
      const c = counts.get(key) || { name, n: 0 }
      if (!r.grp) c.name = name
      c.n += r.n
      counts.set(key, c)
    }
    const people = []
    for (const { name } of [...counts.values()].sort((a, b) => b.n - a.n).slice(0, PEOPLE)) {
      const kept = old.people.find((x) => sameName(x.name, name) && x.edited)
      if (kept) { people.push(kept); continue }
      const rows = db.prepare(`select from_me, sender, thread, text, json_extract(meta, '$.group') grp from items where ${chats} and ts > ? and length(text) > 8
        and (thread = ? or sender like ?) order by ts desc limit 40`).all(since, name, `${name.split(/\s+/)[0]}%`)
      const groups = [...new Set(rows.filter((r) => r.grp).map((r) => r.thread))]
      const text = await permittedInference(
        `You tell ${N}'s assistant who someone is to ${N}. ${ONLY} One line of at most 20 words: who they are to ${N} (family, friend, partner, co-founder, colleague, client, landlord...) and what they deal with together.`,
        `${name}${groups.length ? ` (also in ${N}'s groups: ${groups.join(', ')})` : ''}\n\nRecent messages:\n${rows.reverse().map(line).join('\n')}`).catch(() => '')
      people.push({ name, text })
    }

    // The groups: what each is for, from what's said in it, whatever it's called.
    const groups = []
    for (const g of db.prepare(`select thread, count(*) n from items where ${chats} and json_extract(meta, '$.group') = 1 and ts > ? group by thread order by n desc limit ?`).all(since, GROUPS)) {
      const kept = old.groups.find((x) => x.name === g.thread && x.edited)
      if (kept) { groups.push(kept); continue }
      const rows = db.prepare(`select from_me, sender, text from items where ${chats} and thread = ? and ts > ? and length(text) > 12 order by random() limit 45`).all(g.thread, since)
      const text = await permittedInference(
        `You tell ${N}'s assistant what a group chat is really for. ${ONLY} The group's name is only a label and may be a joke or an old topic; go by what's said. One line of at most 20 words: what it's for and who talks in it.`,
        `Group "${g.thread}". Messages:\n${rows.map(line).join('\n')}`).catch(() => '')
      groups.push({ name: g.thread, text })
    }

    const p = { about, aboutEdited: !!old.aboutEdited, aliases: aliases(db), people, groups, updated: now() }
    return save(p, generation) ? p : null
  })().finally(() => { building = null })
  return building
}

export const isBuilding = () => !!building
// First run, and once a week after.
export const due = () => { const p = profile(); return !p || now() - (p.updated || 0) > WEEK }

// An explicit lasting fact or correction from the owner updates the editable profile.
// Questions, requests and conversational remarks do not.
const LEARN = `${N} is talking to Kier, an assistant that keeps a profile of ${N}. Decide whether ${N}'s message states a lasting fact or a correction about ${N} (work, role, where ${N} lives, what ${N} no longer does) or about someone ${N} knows. A question, a request, a task or small talk is not one. If it is, rewrite the affected part of the profile with it taken in, keeping everything else as it was. Third person, no em dashes. Reply with only JSON: {"about": "the whole updated description of ${N}, or empty if it doesn't change", "person": {"name": "their name as in the profile", "text": "the whole updated line"} or null, "noted": "what you took in, at most 10 words, or empty"}`

export async function learn(q) {
  const said = String(q || '').trim()
  const p = profile()
  if (!p || said.length < 8 || /\?\s*$/.test(said)) return null
  const generation = profileState().generation
  const raw = await local(LEARN, `The profile now:\n${profileText()}\n\n${N} just said: "${said}"`)
  if (profileState().generation !== generation) return null
  const out = JSON.parse(raw.match(/\{[\s\S]*\}/)?.[0] ?? 'null')
  if (!out?.noted) return null
  const about = String(out.about || '').trim()
  const person = out.person?.name && out.person?.text ? [{ name: String(out.person.name), text: String(out.person.text) }] : []
  if ((!about || about === p.about) && !person.length) return null
  edit({ ...(about && about !== p.about && { about }), people: person })
  return String(out.noted).trim()
}
