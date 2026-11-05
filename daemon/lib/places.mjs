import { publicText } from './public-fetch.mjs'
import { localAuthorization, readScope } from './authorization.mjs'
// Find previously visited publishing destinations associated with a task. Only matching publication
// phrases qualify; unrelated pages sharing a single word are not completion evidence.
import { config } from './config.mjs'

const STOP = new Set([config.me.toLowerCase(), 'will', 'with', 'from', 'that', 'this', 'about', 'what', 'the', 'and', 'for', 'new', 'update', 'some', 'into'])
const FEED = /\.(json|xml|rss)(\?|$)|\/feed\/?$|\/rss\/?$/i

// Only things you put out somewhere have a place to check. "Investigate the layout width" lives in commits and AI
// sessions, which the done-check already reads; a lone word like "layout" matched Reddit threads.
const PUBLISHING = /\b(release|releases|post|posts|publish|published|write|writes|announce|upload|ship|blog|newsletter|notes|changelog|article|video|episode)\b/i

// The item's key phrases, two words each ("release notes"): one word alone matches too much.
function phrases(summary) {
  const w = String(summary || '').toLowerCase().match(/[a-zčćšžđ]{3,}/g)?.filter((x) => !STOP.has(x) && x !== config.me.toLowerCase()) || []
  return w.slice(1).map((x, i) => `${w[i]} ${x}`)
}

// The pages in your history that carry the item's phrase in their address, most visited first; a phrase counts only
// when its slug ("release-notes") is in the address.
export function homes(db, summary, before, auth = localAuthorization()) {
  db = readScope(db, auth)
  if (!PUBLISHING.test(String(summary || ''))) return null
  for (const p of phrases(summary)) {
    const slug = p.replace(/\s+/g, '-')
    const rows = db.prepare(`select url, text, count(*) n, max(ts) last from items where source = 'browser' and ts < ? and ts > ?
      and lower(url) like ? group by url order by n desc, last desc limit 6`).all(before, before - 120 * 86400, `%${slug}%`)
      .filter((r) => /^https?:\/\//.test(r.url) && !/localhost|127\.0\.0\.1|wp-json|\/wp-admin/.test(r.url))
    if (rows.length) return { phrase: p, pages: rows.sort((a, b) => Number(FEED.test(b.url)) - Number(FEED.test(a.url)) || b.n - a.n) }
  }
  return null
}

const text = (s) => String(s || '').replace(/<[^>]+>/g, ' ').replace(/&#8217;|&rsquo;/g, "'").replace(/&amp;/g, '&').replace(/\s+/g, ' ').trim()
const day = (d) => new Intl.DateTimeFormat('en-GB', { timeZone: config.timezone, weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', hour12: false }).format(d)

// What a page or feed shows right now: a feed's newest entries with their dates, or a page's headings.
async function look(url, since) {
  const body = await publicText(url)
  try {
    const data = JSON.parse(body)
    const list = (Array.isArray(data) ? data : data.items || data.posts || []).slice(0, 5)
    const lines = list.map((p) => {
      const when = new Date(p.date_gmt ? `${p.date_gmt}Z` : p.date || p.date_published || p.published || 0)
      const title = text(p.title?.rendered ?? p.title)
      return `${title} (${isNaN(when) ? 'no date' : day(when)}${!isNaN(when) && when / 1000 > since ? ', after the item' : ''})${p.link || p.url ? ` ${p.link || p.url}` : ''}`
    })
    return `${url}, newest first:\n${lines.map((l) => `  - ${l}`).join('\n')}`
  } catch {
    const heads = [...body.matchAll(/<h[1-3][^>]*>([\s\S]*?)<\/h[1-3]>/gi)].map((m) => text(m[1])).filter(Boolean).slice(0, 6)
    return `${url}, headings now: ${heads.join(' | ') || text(body.match(/<title>([\s\S]*?)<\/title>/i)?.[1]) || 'nothing readable'}`
  }
}

// "Where this goes, and what's there now", for the item brief.
export async function whereItGoes(db, item, auth = localAuthorization()) {
  db = readScope(db, auth)
  const found = homes(db, item.summary, item.ts, auth)
  if (!found) return ''
  const pages = found.pages.slice(0, 3).map((p) => `${p.url} (opened ${p.n} time${p.n === 1 ? '' : 's'}, last ${day(new Date(p.last * 1000))})`)
  // Opening the pages is an online helper; with helpers off, Kier only says where it would look.
  if (!config.online) return `Where "${found.phrase}" usually goes, from ${config.me}'s browsing:\n${pages.map((p) => `- ${p}`).join('\n')}\n\nNot checked: online helpers are off.`
  const checked = await Promise.all(found.pages.slice(0, 2).map((p) => look(p.url, item.ts).catch((e) => `${p.url}: couldn't load (${e.name})`)))
  return `Where "${found.phrase}" usually goes, from ${config.me}'s browsing:\n${pages.map((p) => `- ${p}`).join('\n')}\n\nChecked just now:\n${checked.join('\n')}`
}

// For the done-check: entries that appeared where this kind of thing goes, after the item, as evidence lines. Feeds
// only, since a feed's dates are reliable and a page's headings aren't.
export async function newSince(db, item, auth = localAuthorization()) {
  db = readScope(db, auth)
  const found = homes(db, item.summary, item.ts, auth)
  const feed = found?.pages.find((p) => FEED.test(p.url))
  if (!feed || !config.online) return []
  const data = JSON.parse(await publicText(feed.url))
  return (Array.isArray(data) ? data : data.items || data.posts || []).slice(0, 10).flatMap((p) => {
    const when = new Date(p.date_gmt ? `${p.date_gmt}Z` : p.date || p.date_published || p.published || 0)
    if (isNaN(when) || when / 1000 <= item.ts) return []
    return [{ kind: 'place', ts: Math.floor(when / 1000), url: p.link || p.url || feed.url,
      line: `[new on ${new URL(feed.url).host}'s "${found.phrase}" feed, where these usually go, ${day(when)}] ${text(p.title?.rendered ?? p.title)}` }]
  })
}
