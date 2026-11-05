import { createHash } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { config, configPath } from '../lib/config.mjs'
import { googleFetch, accessToken } from '../lib/google.mjs'
import { addItems, cursor, now, setCursor } from '../lib/db.mjs'
import { addresses, conversation, mailDate } from './mail.mjs'
export const source = 'gmail'
const excluded = ['CATEGORY_PROMOTIONS', 'CATEGORY_SOCIAL', 'CATEGORY_UPDATES', 'CATEGORY_FORUMS', 'TRASH', 'SPAM']
export function gmailItem(message, at = now(), account = config.gmail?.generation || 'unconnected') {
  if (message.labelIds?.some(l => excluded.includes(l))) return null
  const headers = Object.fromEntries((message.payload?.headers || []).map(h => [h.name.toLowerCase(), String(h.value).slice(0, 8000)]))
  const from = addresses(headers.from), to = addresses(headers.to), cc = addresses(headers.cc)
  const fromMe = message.labelIds?.includes('SENT') === true
  const sender = fromMe ? config.me : from[0]?.name || from[0]?.email
  const other = fromMe ? to[0]?.name || to[0]?.email : sender
  const ts = mailDate(headers.date || Number(message.internalDate))
  if (!other || !ts || ts > at + 86400 || ts < at - config.backfillDays * 86400) return null
  const rawID = (headers['message-id'] || '').trim().replace(/^<|>$/g, '')
  const messageId = rawID.includes('@') && !/\s/.test(rawID) ? rawID : null
  const thread = conversation(headers.subject, other)
  if (config.blockedChats.includes(thread)) return null
  return { id: `mail:${createHash('sha256').update(messageId ? `message:${messageId}` : `gmail:${message.id}`).digest('hex')}`,
    source: 'mail', thread, sender, fromMe, ts,
    text: [String(headers.subject || '').slice(0, 500), String(message.snippet || '').slice(0, 2000)].filter(Boolean).join('\n'),
    meta: { subject: String(headers.subject || '').slice(0, 500), body: String(message.snippet || '').slice(0, 2000), bodyKind: 'preview', client: 'gmail', providerMessageId: message.id, account, copyKey: `gmail:${account}:${message.id}`,  ownerSent: fromMe, messageId, from, to, cc, mailbox: fromMe ? 'Sent' : 'Inbox', group: to.length + cc.length > 1 } }
}
const currentPolicy = () => existsSync(configPath) ? JSON.parse(readFileSync(configPath, 'utf8')) : config
export async function collect(db, { request = googleFetch(), getAccessToken = accessToken, policy = currentPolicy, maxPages = 3 } = {}) {
  const initial = policy(), generation = initial.gmail?.generation
  const allowed = () => { const p = policy(); return p.gmail?.connected === true && p.gmail.generation === generation && !p.off?.includes('mail') }
  if (!allowed()) return 0
  const token = await getAccessToken()
  const api = (path, params = {}) => {
    if (!allowed()) throw Error('GMAIL_DISABLED')
    if (token.expiresAt <= Date.now() || token.expiresAt > Date.now() + 3600000) throw Error('GMAIL_ACCESS_TOKEN_EXPIRED')
    const query = new URLSearchParams(params)
    if (params.format === 'metadata') for (const name of ['To', 'Cc', 'Subject', 'Date', 'Message-ID']) query.append('metadataHeaders', name)
    const route = ['gmail', 'v1', 'users', 'me', path].join('/')
    return request(`https://gmail.googleapis.com/${route}?${query}`, { headers: { authorization: `Bearer ${token.accessToken}` } })
  }
  const key = `gmail:${generation}`, saved = cursor(db, key, '')
  let state = saved ? JSON.parse(saved) : null
  if (!state) state = { historyId: (await api('profile')).historyId, backfill: true }
  let added = 0
  for (let page = 0; page < Math.min(3, maxPages); page++) {
    let result
    try {
      result = state.backfill ? await api('messages', { maxResults: '100', q: `newer_than:${Math.max(1, Math.min(365, config.backfillDays))}d -category:promotions -category:social -category:updates -category:forums`, ...(state.pageToken && { pageToken: state.pageToken }) })
        : await api('history', { maxResults: '100', startHistoryId: state.historyId, ...(state.pageToken && { pageToken: state.pageToken }) })
    } catch (e) {
      if (e.status === 404 && !state.backfill) { setCursor(db, key, ''); return added }
      throw e
    }
    const ids = new Set(state.backfill ? (result.messages || []).map(m => m.id)
      : (result.history || []).flatMap(h => [...(h.messagesAdded || []), ...(h.labelsAdded || [])].map(m => m.message?.id)).filter(Boolean))
    const items = []
    for (const id of ids) {
      let message
      try { message = await api(`messages/${encodeURIComponent(id)}`, { format: 'metadata', metadataHeaders: 'From' }) }
      catch (e) { if (e.status === 404) continue; throw e }
      const item = gmailItem(message, now(), generation)
      if (item) items.push(item)
    }
    if (!allowed()) return added
    added += addItems(db, items)
    // Never advance the history high-water mark until every page is stored.
    if (result.nextPageToken) state.pageToken = result.nextPageToken
    else if (state.backfill) state = { historyId: state.historyId, backfill: false }
    else state = { historyId: result.historyId || state.historyId, backfill: false }
    setCursor(db, key, JSON.stringify(state))
    if (!result.nextPageToken) break
  }
  return added
}
