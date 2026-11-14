import { editSource, sourceList, sourceSummary } from './mcp-source-config.mjs'
import { sourceJob } from './mcp-sources.mjs'
import { collect as collectMcp } from '../collectors/mcp.mjs'
import { readSecret, verifier, signResponse, openBody, mac } from './http-auth.mjs'
import { capturePolicy } from './app-permissions.mjs'
import { readScope, localAuthorization } from './authorization.mjs'
import { modelSettings, testModelSettings, saveModelSettings } from './model-settings.mjs'
import { callbackContext } from './callback-context.mjs'
import { execFile } from './child-process.mjs'
import { createHash, randomUUID } from 'node:crypto'
import { readFileSync, statSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { resolve } from 'node:path'
import { collectInChild } from './collect.mjs'
import { mergeSame } from './merge.mjs'
import { checkStalled } from './stalled.mjs'
import { resolvePending } from './resolve.mjs'
import { config, dbPath, tmpDir, tokenPath, usesExternalModel } from './config.mjs'
import { addItems, now } from './db.mjs'
import { forget } from './privacy.mjs'
import { evidence } from './resolve.mjs'
import { redact } from './redact.mjs'
import { act, steps } from './setup.mjs'
import { diagnostics } from './diagnostics.mjs'
import { ask, agents, CLAUDE } from './ask.mjs'
import { mailAssist, validateMailAssist, MAIL_ASSIST_MAX_BYTES } from './mail-assist.mjs'
import { auditAssist, AUDIT_ASSIST_MAX_BYTES } from './audit-assist.mjs'
import { mailQuery, MAIL_QUERY_MAX_BYTES } from './mail-query.mjs'
import { eventInfo } from './headsup.mjs'
import { say, speak, speaking, stop } from './speak.mjs'
import { handoff, reopen, start as startSession, warm as warmHandoffs } from './handoff.mjs'
import { build as buildProfile, edit as editProfile, isBuilding as profileBuilding, learn as learnFromChat, profile } from './profile.mjs'
import { burstOf, ollamaUp, sameConversation } from './tagger.mjs'
import { isOff, myReminders, off, SOURCES, setClaudeCheck, setOnline, setSource } from './settings.mjs'
import { markTask, donePage, brief, briefText, dayRange, icsFor, isoDay, plusDays, tasks, today } from './tasks.mjs'
import { phoneItems } from './phone.mjs'
import { syncReminders } from './reminders.mjs'
import { quick as findQuick, understood as findUnderstood, warm as findWarm } from './find.mjs'

const pages = {
  '/api.mjs': new URL('../ui/api.mjs', import.meta.url),
  '/links.mjs': new URL('../ui/links.mjs', import.meta.url),
  '/': new URL('../ui/index.html', import.meta.url), '/setup': new URL('../ui/setup.html', import.meta.url), '/vault': new URL('../ui/vault.html', import.meta.url),
}

// What Kier.app's eyes report: clipboard, app sessions and chat text on screen. Like every /api call it needs the
// request proof (see serve), so other local accounts cannot feed the vault.
const EYES_SOURCES = new Set(['clipboard', 'apps', 'screen'])
export const eyes = { at: 0, accessibility: false, front: '' }

export function ingest(db, body) {
  Object.assign(eyes, { at: now(), ...(body.status || {}) })
  const items = (body.items || []).filter((i) => EYES_SOURCES.has(i.source) && !isOff(i.source) && typeof i.text === 'string').map((i) => {
    const { text, found } = redact(i.text)
    const ts = Number(i.ts) || now()
    const thread = String(i.thread || '').slice(0, 200)
    // Messages read through Accessibility keep their parts (name, heading, time, text), redacted like the text.
    const clean = (s) => redact(String(s || '').slice(0, 1000)).text
    const messages = Array.isArray(i.meta?.messages) ? i.meta.messages.slice(0, 80).map((m) => ({
      name: clean(m.name), heading: clean(m.heading), when: (m.when || []).slice(0, 4).map(clean), text: (m.text || []).slice(0, 20).map(clean),
    })) : null
    return {
      id: `${i.source}:${createHash('sha1').update(`${ts}|${thread}|${text}`).digest('hex').slice(0, 20)}`,
      source: i.source, thread, ts, text,
      // Clipboard and app activity belong to the owner; visible chat text can belong to other senders.
      sender: i.source === 'screen' ? thread.split(':')[0] : config.me, fromMe: i.source !== 'screen',
      meta: { ...(i.meta || {}), ...(messages && { messages }), ...(found.length && { redacted: found }) },
    }
  })
  return addItems(db, items)
}

// Everything Kier keeps, by source and by chat, site or app, plus every time an AI read from it.
function vault(db) {
  const since = now() - 30 * 86400
  const size = (p) => { try { return statSync(p).size } catch { return 0 } }
  const threads = {}
  for (const t of db.prepare(`select source, thread, count(*) n, max(ts) newest from items where ts > ? and thread is not null
    group by source, thread order by n desc`).all(since)) {
    if ((threads[t.source] ||= []).length < 8) threads[t.source].push(t)
  }
  return {
    bytes: size(dbPath) + size(`${dbPath}-wal`),
    sources: db.prepare('select source, count(*) n, sum(ts > ?) recent, min(ts) oldest, max(ts) newest from items group by source order by n desc').all(since),
    threads,
    forgotten: db.prepare('select count(*) n from forgotten').get().n,
    reads: {
      week: db.prepare('select count(*) n from access_log where ts > ?').get(now() - 7 * 86400).n,
      recent: db.prepare('select ts, client, tool, args, rows from access_log order by ts desc limit 12').all(),
    },
  }
}

// The timeline window. Bound to 127.0.0.1 and checks Host, so web pages can't reach it through DNS rebinding.
export function serve(db, { install, port = config.port } = {}) {
  const hosts = new Set([`127.0.0.1:${port}`, `localhost:${port}`])
  // The owner's persistent secret never leaves disk or a MAC/encryption operation.
  const secret = readSecret(tokenPath, true), verify = verifier(secret, () => Date.now(), resolve(tmpDir, 'http-nonces.json'))
  const launch = randomUUID()
  const tickets = new Map(), browserTokens = new Map()
  const authedBrowser = req => {
    const session = browserTokens.get(req.headers['x-kier-token'])
    return session && session.expires > Date.now() && session.origin === `http://${req.headers.host}`
  }
  const issueTicket = (origin) => {
    for (const [key, value] of tickets) if (value.expires <= Date.now()) tickets.delete(key)
    if (tickets.size >= 64) tickets.delete(tickets.keys().next().value)
    const ticket = randomUUID()
    tickets.set(ticket, { origin, expires: Date.now() + 60000 })
    return ticket
  }
  // Keep previous questions but discard answers predating a profile correction.
  const conversation = (key, history) => {
    const kept = typeof key === 'string' && key ? readScope(db, localAuthorization()).prepare('select q, a, ts from chats where key = ? order by ts desc limit 6').all(key).reverse() : null
    const changed = profile()?.changed || 0
    return (kept || (Array.isArray(history) ? history : []).slice(-6))
      .map((h) => ({ q: String(h.q || '').slice(0, 1000), a: h.ts && h.ts < changed ? '' : String(h.a || '').slice(0, 2000) }))
  }
  const json = (res, data, code = 200) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(data)) }
  const rows = (where, params, limit = 1000) => readScope(db, localAuthorization()).prepare(`
    select i.id, i.source, i.thread, i.sender, i.from_me, i.ts, i.text, i.url, t.is_task, t.due, t.amount, t.summary
    from items i left join tags t on t.item_id = i.id where ${where} order by i.ts limit ${limit}`).all(...params)
  const server = createServer(async (req, res) => {
    // Kier's pages are never shown inside another site's frame, where a click could be borrowed.
    res.setHeader('x-frame-options', 'DENY')
    res.setHeader('content-security-policy', "frame-ancestors 'none'")
    res.setHeader('cache-control', 'no-store')
    res.setHeader('referrer-policy', 'no-referrer')
    res.setHeader('x-content-type-options', 'nosniff')
    try {
      // Authenticate the exact wire bytes before any route can read or mutate owner data.
      const chunks = []
      let size = 0
      for await (const chunk of req) {
        size += chunk.length
        if (size > 8 * 1024 * 1024) return json(res, { error: 'body too large' }, 413)
        chunks.push(chunk)
      }
      const wire = Buffer.concat(chunks)
      const signed = req.headers['x-kier-signature'] !== undefined
      const nonce = signed ? verify(req.method, req.url, req.headers, wire) : null
      if (signed && !nonce) return json(res, { error: 'authentication required' }, 401)
      if (nonce) signResponse(res, secret, nonce)
      if (!hosts.has(req.headers.host)) return json(res, { error: 'forbidden' }, 403)
      if (req.headers.origin && req.headers.origin !== `http://${req.headers.host}`) return json(res, { error: 'forbidden origin' }, 403)
      // Native bodies are encrypted too: a port squatter must not receive captured text.
      const url = new URL(req.url, `http://${req.headers.host}`)
      let requestBody
      try { requestBody = nonce && wire.length ? openBody(secret, wire).toString('utf8') : wire.toString('utf8') }
      catch (error) {
        if (['/api/mail-assist', '/api/audit-assist', '/api/mail-query'].includes(url.pathname)) return json(res, { error: 'Invalid encrypted request body.' }, 400)
        throw error
      }
      const q = Object.fromEntries(url.searchParams)
      if (pages[url.pathname]) {
        res.writeHead(200, { 'content-type': url.pathname.endsWith('.mjs') ? 'text/javascript; charset=utf-8' : 'text/html; charset=utf-8' })
        return res.end(readFileSync(pages[url.pathname]))
      }
      if (url.pathname === '/auth/bootstrap') {
        // Browsers supply Origin on this POST; missing/null/cross-port origins fail.
        const key = req.headers['x-kier-bootstrap'], ticket = tickets.get(key)
        if (req.method !== 'POST' || req.headers.origin !== `http://${req.headers.host}` ||
            !ticket || ticket.origin !== req.headers.origin || ticket.expires <= Date.now()) return json(res, { error: 'bootstrap unavailable' }, 403)
        tickets.delete(key)
        const browserToken = mac(secret, ['kier-browser-v1', launch, randomUUID()].join('\n'))
        if (browserTokens.size >= 64) browserTokens.delete(browserTokens.keys().next().value)
        browserTokens.set(browserToken, { origin: ticket.origin, expires: Date.now() + 10 * 60_000 })
        return json(res, { token: browserToken })
      }
      if (url.pathname.startsWith('/api/') && !nonce && !authedBrowser(req)) return json(res, { error: 'authentication required' }, 401)
      if (url.pathname === '/api/mail-assist') {
        if (!nonce) return json(res, { error: 'authentication required' }, 401)
        if (req.method !== 'POST') return json(res, { error: 'Mail assist requires POST.' }, 400)
        if (Buffer.byteLength(requestBody, 'utf8') > MAIL_ASSIST_MAX_BYTES) return json(res, { error: 'Mail assist request is too large.' }, 413)
        let input
        try { input = JSON.parse(requestBody) }
        catch { return json(res, { error: 'Invalid mail assist JSON.' }, 400) }
        const failure = error => {
          const status = [400, 413, 503].includes(error.status) ? error.status : 503
          return { status, error: error.status === status ? error.message : 'Kier\'s model is not ready. Try again shortly.' }
        }
        // "stream": true (summaries and replies): the text as it forms, one signed line each ({text} so far), then
        // {done, ...result}, or {error, status} if the model stops partway. Without it, one JSON reply as before.
        if (input?.stream === true) {
          try { validateMailAssist(input) } catch (error) { const f = failure(error); return json(res, { error: f.error }, f.status) }
          res.streamLines?.()
          res.writeHead(200, { 'content-type': 'application/x-ndjson', 'cache-control': 'no-cache' })
          const send = line => res.write(`${JSON.stringify(line)}\n`)
          try { send({ done: true, ...await mailAssist(db, input, { onText: text => send({ text }) }) }) }
          catch (error) { send(failure(error)) }
          return res.end()
        }
        try { return json(res, await mailAssist(db, input)) }
        catch (error) { const f = failure(error); return json(res, { error: f.error }, f.status) }
      }
      // A search typed into Kier Mail, read into filters (mail-query.mjs). Native and signed only. With nothing to add
      // to Kier Mail's own reading the answer is an empty 204, and Kier Mail keeps its own.
      if (url.pathname === '/api/mail-query') {
        if (!nonce) return json(res, { error: 'authentication required' }, 401)
        if (req.method !== 'POST') return json(res, { error: 'Mail query requires POST.' }, 400)
        if (Buffer.byteLength(requestBody, 'utf8') > MAIL_QUERY_MAX_BYTES) return json(res, { error: 'Mail query request is too large.' }, 413)
        let input
        try { input = JSON.parse(requestBody) }
        catch { return json(res, { error: 'Invalid mail query JSON.' }, 400) }
        try {
          const answer = await mailQuery(db, input)
          if (answer) return json(res, answer)
          res.writeHead(204)
          return res.end()
        } catch (error) {
          const status = [400, 413].includes(error.status) ? error.status : 503
          return json(res, { error: error.status === status ? error.message : 'Kier could not read this search.' }, status)
        }
      }
      // Kier Audit's cleanup advice. Native and signed only, like mail-assist: a browser page never reaches it.
      if (url.pathname === '/api/audit-assist') {
        if (!nonce) return json(res, { error: 'authentication required' }, 401)
        if (req.method !== 'POST') return json(res, { error: 'Audit assist requires POST.' }, 400)
        if (Buffer.byteLength(requestBody, 'utf8') > AUDIT_ASSIST_MAX_BYTES) return json(res, { error: 'Audit assist request is too large.' }, 413)
        let input
        try { input = JSON.parse(requestBody) }
        catch { return json(res, { error: 'Invalid audit assist JSON.' }, 400) }
        try { return json(res, await auditAssist(input)) }
        catch (error) {
          const status = [400, 413, 503].includes(error.status) ? error.status : 503
          return json(res, { error: error.status === status ? error.message : 'Kier\'s model is not ready. Try again shortly.' }, status)
        }
      }
      if (url.pathname === '/api/browser-ticket' && req.method === 'POST' && nonce) return json(res, { ticket: issueTicket(`http://${req.headers.host}`) })
      if (url.pathname === '/api/model-settings' && req.method === 'GET') return json(res, modelSettings())
      if (url.pathname === '/api/mcp-sources' && req.method === 'GET') return json(res, { sources: sourceSummary() })
      if (url.pathname === '/api/setup') return json(res, { steps: await steps(db, eyes) })
      // A report for a bug, from an allow-list only (diagnostics.mjs); Settings shows it whole, nothing sends it.
      if (url.pathname === '/api/diagnostics') return json(res, { text: await diagnostics(db, { steps: await steps(db, eyes) }) })
      // One card by its id, for the panel when it isn't on the lists: one dated weeks ahead that a nudge is about, an
      // older one found in search.
      if (url.pathname === '/api/card') { const t = tasks(db, { days: 365 }).find((x) => x.id === q.id); return t ? json(res, t) : json(res, { error: 'no such card' }, 404) }
      if (url.pathname === '/api/event') { const e = await eventInfo(db, q.id || ''); return e ? json(res, e) : json(res, { error: 'no such event' }, 404) }
      if (url.pathname === '/api/day') {
        const date = /^\d{4}-\d{2}-\d{2}$/.test(q.date || '') ? q.date : today()
        const [from, to] = dayRange(date)
        // Return the latest items in a busy day, still in chronological order.
        return json(res, { date, items: rows('i.ts >= ? and i.ts < ? and i.ts >= coalesce((select ts from items where ts >= ? and ts < ? order by ts desc limit 1 offset 2999), 0)', [from, to, from, to], 3000) })
      }
      if (url.pathname === '/api/search') {
        const like = `%${(q.q || '').replace(/[%_]/g, '')}%`
        return json(res, { items: rows('(i.text like ? or i.sender like ? or i.thread like ?) and i.ts > ?', [like, like, like, now() - 365 * 86400], 300).reverse() })
      }
      // The search bar (⌥⌘Space, lib/find.mjs): as you type, then once Kier has read what you're asking for.
      if (url.pathname === '/api/find') return json(res, { results: await findQuick(db, String(q.q || '').slice(0, 300)) })
      if (url.pathname === '/api/find/ai') return json(res, await findUnderstood(db, String(q.q || '').slice(0, 300)))
      if (url.pathname === '/api/find/warm') return json(res, { ready: await findWarm() })
      // What belongs on the iPhone and Watch, for Kier.app to keep Calendar and Reminders in step with (lib/phone.mjs).
      if (url.pathname === '/api/phone') return json(res, phoneItems(db))
      if (url.pathname === '/api/brief') {
        const b = brief(db)
        return json(res, { ...b, text: briefText(b) })
      }
      if (url.pathname === '/api/done') return json(res, donePage(db, q))
      if (url.pathname === '/api/tasks') return json(res, { tasks: tasks(db, { days: 30 }).map((t) => ({ ...t, day: isoDay(t.ts) })) })
      // "On this Mac": what Kier read today, whether the local model is running, and what went to the cloud, which is
      // only ever what Kier handed to Claude or Codex for you. There's no account and no server of Kier's to send to.
      if (url.pathname === '/api/privacy') {
        const day = dayRange(today())[0]
        const read = db.prepare(`select count(*) n from items where ts >= ? and source in ('whatsapp', 'imessage', 'discord', 'chat', 'social', 'mail', 'notifications')`).get(day).n
        const out = db.prepare('select agent, sum(bytes) bytes from outbound where ts >= ? group by agent').all(day)
        // With your own model server, where it runs: this Mac (a local address) or elsewhere, by host only.
        const server = usesExternalModel ? (() => { try { return new URL(config.externalModel.endpoint).hostname } catch { return '' } })() : null
        const local = !server || server === 'localhost' || server.endsWith('.localhost') || server === '::1' || server === '[::1]' || /^127\./.test(server)
        return json(res, { read, model: config.model, running: await ollamaUp(), sent: out.reduce((n, r) => n + r.bytes, 0), to: out, account: false,
          yours: usesExternalModel, ...(server && { server }), local })
      }
      // What Kier may read, and whether the owner's Claude may double-check stuck cards.
      if (url.pathname === '/api/capture-policy' && req.method === 'GET') return json(res, capturePolicy())
      if (url.pathname === '/api/settings' && req.method === 'GET') {
        const counts = Object.fromEntries(db.prepare('select source, count(*) n from items where ts > ? group by source').all(now() - 30 * 86400).map((r) => [r.source, r.n]))
        return json(res, {
          sources: SOURCES.map((s) => ({ ...s, on: s.id === 'reminders' ? myReminders() : !isOff(s.id), count: counts[s.id] || 0 })),
          claudeCheck: config.claudeCheck === true, claude: !!CLAUDE, online: config.online === true,
        })
      }
      if (url.pathname === '/api/status') {
        return json(res, {
          runs: db.prepare('select * from runs order by source').all(),
          counts: db.prepare('select source, count(*) n from items group by source').all(),
          untagged: db.prepare("select count(*) n from items i left join tags t on t.item_id = i.id where t.item_id is null and i.source in ('whatsapp', 'imessage', 'discord', 'chat', 'social', 'mail') and i.ts > ?").get(now() - config.tagBackfillDays * 86400).n,
        })
      }
      // Writes take JSON only, so a cross site form post can't trigger them.
      const post = req.method === 'POST' && req.headers['content-type'] === 'application/json'
      if (url.pathname.startsWith('/api/mcp-sources') && post) {
        if (requestBody.length > 64000) return json(res, { ok: false, error: 'MCP settings are too large.' }, 400)
        try {
          const input = JSON.parse(requestBody || '{}')
          if (url.pathname === '/api/mcp-sources') return json(res, { ok: true, id: editSource(input), sources: sourceSummary() })
          const source = sourceList().find(s => s.id === input.id)
          if (!source) throw Error('MCP_SOURCE_MISSING')
          if (url.pathname === '/api/mcp-sources/tools') return json(res, { ok: true, ...await sourceJob(source, 'list') })
          if (url.pathname === '/api/mcp-sources/sync') return json(res, { ok: true, added: await collectMcp(db, { force: true, only: source.id }) })
          return json(res, { ok: false }, 404)
        } catch { return json(res, { ok: false, error: 'Could not use this MCP source. Check the command or URL, tool and JSON arguments. Only tools marked read only are offered.' }, 400) }
      }
      if (url.pathname === '/api/ingest' && post) {
        const body = requestBody
        return json(res, { ok: true, added: ingest(db, JSON.parse(body)) })
      }
      if (url.pathname.startsWith('/api/model-settings') && post) {
        const body = requestBody
        if (body.length > 20000) return json(res, { ok: false, error: 'Settings are too long.' }, 400)
        try {
          const candidate = JSON.parse(body || '{}')
          if (url.pathname === '/api/model-settings/test') return json(res, { ok: true, ...await testModelSettings(candidate) })
          if (url.pathname !== '/api/model-settings') return json(res, { ok: false, error: 'Not found.' }, 404)
          const result = await saveModelSettings(candidate)
          json(res, result)
          setTimeout(() => process.exit(0), 1000).unref()
          return
        } catch (error) { return json(res, { ok: false, error: String(error.message || 'Could not connect.').slice(0, 300) }, 400) }
      }
      if (url.pathname === '/api/settings' && post) {
        const body = requestBody
        const { source, on, claudeCheck, online } = JSON.parse(body)
        if (typeof source === 'string') setSource(source, on === true)
        if (typeof claudeCheck === 'boolean') setClaudeCheck(claudeCheck)
        if (typeof online === 'boolean') setOnline(online)
        return json(res, { ok: true, off: off(), claudeCheck: config.claudeCheck === true, online: config.online === true })
      }
      // A note the app put into a Claude session itself (Continue in Claude), counted like the rest.
      if (url.pathname === '/api/sent' && post) {
        const body = requestBody
        const { kind, agent, bytes } = JSON.parse(body)
        if (Number(bytes) > 0) db.prepare('insert into outbound (ts, kind, agent, bytes) values (?, ?, ?, ?)').run(now(), String(kind || 'note').slice(0, 20), String(agent || 'claude').slice(0, 20), Math.floor(Number(bytes)))
        return json(res, { ok: true })
      }
      if (url.pathname.startsWith('/api/setup/') && post) {
        await act(url.pathname.slice('/api/setup/'.length), { install, collect: collectInChild })
        return json(res, { steps: await steps(db, eyes) })
      }
      // Your own reminders, from the app (reminders.mjs): kept as cards; the answer says what to tick off or reopen there.
      if (url.pathname === '/api/reminders' && post) {
        const body = requestBody
        const { reminders = [] } = JSON.parse(body || '{}')
        return json(res, syncReminders(db, Array.isArray(reminders) ? reminders.filter((r) => r && r.id && r.title && /^\d{4}-\d{2}-\d{2}$/.test(r.due || '')) : []))
      }
      // A card renamed by hand on its page ; its chat renames through ask.mjs.
      if (url.pathname === '/api/rename' && post) {
        const body = requestBody
        const { id, title } = JSON.parse(body || '{}')
        const t = String(title || '').trim().slice(0, 200)
        if (!id || t.length < 2) return json(res, { error: 'no title' }, 400)
        return json(res, { ok: db.prepare('update tags set summary = ? where item_id = ?').run(t, id).changes > 0 })
      }
      if (url.pathname === '/api/mark' && post) {
        const body = requestBody
        const { id, status } = JSON.parse(body)
        // "Mine" on a card under Maybe yours: it's yours, so it joins the list and stays there.
        if (status === 'mine') { db.prepare('update tags set confirmed = 1 where item_id = ?').run(id); return json(res, { ok: true }) }
        if (!['done', 'dismissed', 'open', 'snoozed'].includes(status)) return json(res, { error: 'bad status' }, 400)
        markTask(db, id, status)
        return json(res, { ok: true })
      }
      if (url.pathname === '/api/calendar' && post) {
        const body = requestBody
        const task = tasks(db, { days: 60 }).find((t) => t.id === JSON.parse(body).id)
        if (!task) return json(res, { error: 'no such task' }, 404)
        const file = resolve(tmpDir, `kier-${task.id.replace(/\W/g, '')}.ics`)
        writeFileSync(file, icsFor(task))
        execFile('open', [file])
        return json(res, { ok: true })
      }
      if (url.pathname === '/api/speak' && post) return json(res, { ok: true, said: speak(db) })
      if (url.pathname === '/api/speak/stop' && post) return json(res, { ok: true, stopped: stop() })
      if (url.pathname === '/api/say' && post) {
        const body = requestBody
        const { text } = JSON.parse(body)
        if (typeof text === 'string' && text.trim()) say(text.slice(0, 1500))
        return json(res, { ok: true })
      }
      if (url.pathname === '/api/speaking') return json(res, { speaking: speaking() })
      if (url.pathname === '/api/agents') return json(res, agents())
      // A question for Kier, answered by Claude, Codex or the local model; Claude and Codex can take half a minute.
      // The same question, answered as it forms: one JSON line per update ({text} so far, {status}), then {done}.
      if (url.pathname === '/api/ask/stream' && post) {
        const body = requestBody
        const { q, agent, history, item, key } = JSON.parse(body)
        if (!q || typeof q !== 'string') return json(res, { error: 'no question' }, 400)
        const past = conversation(key, history)
        // The app gets each line as it's written, signed on its own (http-auth.mjs), so the answer shows as it forms.
        res.streamLines?.()
        res.writeHead(200, { 'content-type': 'application/x-ndjson', 'cache-control': 'no-cache' })
        const send = (o) => res.write(`${JSON.stringify(o)}\n`)
        const r = await ask(db, q.slice(0, 2000), ['claude', 'codex', 'kier'].includes(agent) ? agent : 'kier', past, typeof item === 'string' ? item : null,
          { text: (t) => send({ text: t }), status: (s) => send({ status: s }) })
        if (typeof key === 'string' && key && r.out) {
          db.prepare('insert into chats (key, ts, q, a, agent, seconds) values (?, ?, ?, ?, ?, ?)').run(key.slice(0, 300), now(), q.slice(0, 2000), r.out, r.agent, r.seconds)
        }
        // The answer is finished (with its buttons) before Kier works out whether you told it something about yourself,
        // which takes the model a few seconds; what it took into your profile follows on its own line. Asking it to
        // change a task isn't about you.
        send({ done: true, ...r })
        const noted = r.out && !r.actions?.length ? await learnFromChat(q).catch(() => null) : null
        if (noted) send({ noted })
        return res.end()
      }
      if (url.pathname === '/api/ask' && post) {
        const body = requestBody
        const { q, agent, history, item, key } = JSON.parse(body)
        if (!q || typeof q !== 'string') return json(res, { error: 'no question' }, 400)
        const past = conversation(key, history)
        const r = await ask(db, q.slice(0, 2000), ['claude', 'codex', 'kier'].includes(agent) ? agent : 'kier', past, typeof item === 'string' ? item : null)
        // Kept, so the conversation is still there after a restart or on another screen.
        if (typeof key === 'string' && key && r.out) {
          db.prepare('insert into chats (key, ts, q, a, agent, seconds) values (?, ?, ?, ?, ?, ?)').run(key.slice(0, 300), now(), q.slice(0, 2000), r.out, r.agent, r.seconds)
        }
        return json(res, r)
      }
      // Check now: everything collected straight away, then every open card looked at again. The done-check decides
      // what's done; this only makes it look now instead of in its own time.
      if (url.pathname === '/api/refresh' && post) {
        const collected = await collectInChild().catch((e) => ({ error: 'REQUEST_FAILED' }))
        const checked = await resolvePending(db, 12, { now: true }).catch((e) => ({ error: 'REQUEST_FAILED' }))
        const merged = await mergeSame(db, 6).catch(() => ({}))
        const stalled = await checkStalled(db, { fresh: true }).catch(() => ({}))
        return json(res, { collected, ...checked, ...merged, ...stalled })
      }
      // Handing a card to an agent: the brief and the note (GET), or a new session started on it (POST).
      if (url.pathname === '/api/handoff') {
        if (post) {
          const body = requestBody
          const { id, agent, branch, open, briefHash } = JSON.parse(body)
          if (open === true) return json(res, await reopen(db, String(id || '')))
          return json(res, await startSession(db, String(id || ''), agent === 'codex' ? 'codex' : 'claude', branch === true, briefHash))
        }
        return json(res, (await handoff(db, String(q.id || ''), { full: q.full === '1' })) || { error: 'not found' })
      }
      // Worked out ahead for the cards on the panel, so the menu is ready by the time you open it.
      if (url.pathname === '/api/handoff/warm' && post) {
        const body = requestBody
        const ids = (JSON.parse(body).ids || []).filter((x) => typeof x === 'string').slice(0, 12)
        warmHandoffs(db, ids).catch(() => {})
        return json(res, { warming: ids.length })
      }
      // Who you are: Kier's draft, your edits, and a rebuild that runs in the background.
      if (url.pathname === '/api/profile' || url.pathname === '/api/profile/rebuild') {
        if (url.pathname === '/api/profile/rebuild' && post) { buildProfile(db).catch(() => {}); return json(res, { building: true }) }
        if (post) {
          const body = requestBody
          return json(res, editProfile(JSON.parse(body)))
        }
        return json(res, { ...(profile() || { about: '', people: [], groups: [], aliases: [] }), building: profileBuilding() })
      }
      // Your conversations with Kier (not the chats about one card), newest first, minus the ones you put away.
      if (url.pathname === '/api/conversations') {
        return json(res, { conversations: db.prepare(`select c.key, max(c.ts) last, count(*) turns,
          (select q from chats x where x.key = c.key order by x.ts desc limit 1) q from chats c
          where (c.key = 'general' or c.key like 'chat:%') and c.key not in (select key from chat_archive)
          group by c.key order by last desc limit 5`).all() })
      }
      if (url.pathname === '/api/chat') {
        if (post) {
          const body = requestBody
          const { key, archive } = JSON.parse(body)
          if (archive) return json(res, { archived: Number(db.prepare('insert or replace into chat_archive (key, at) values (?, ?)').run(String(key || ''), now()).changes) })
          return json(res, { cleared: Number(db.prepare('delete from chats where key = ?').run(String(key || '')).changes) })
        }
        return json(res, { turns: db.prepare('select q, a, agent, seconds from chats where key = ? order by ts').all(String(q.key || '')) })
      }
      if (url.pathname === '/api/vault') return json(res, vault(readScope(db, localAuthorization())))
      // The chat around a card, the whole burst it was read from, and what happened after it.
      if (url.pathname === '/api/context') {
        const scopedDb = readScope(db, localAuthorization())
        const item = scopedDb.prepare('select id, source, thread, sender, from_me, ts, text, url, meta from items where id = ?').get(q.id || '')
        if (!item) return json(res, { error: 'not found' }, 404)
        const tag = scopedDb.prepare(`select t.summary, t.card, t.second, t.when_words, t.due, t.said, s.status, s.reason, s.url from tags t
          left join task_state s on s.item_id = t.item_id where t.item_id = ?`).get(item.id) || null
        const callback = callbackContext(scopedDb, item, tag)
        if (callback) return json(res, callback, callback.error ? 404 : 200)
        // An AI's question has no chat around it in the vault, only the end of its session: what you asked, and its reply.
        const ai = item.source === 'ai' ? (() => { try { return JSON.parse(item.meta || '{}') } catch { return {} } })() : null
        const rows = ai ? [
          ...(ai.request ? [{ id: `${item.id}:request`, sender: config.me, from_me: 1, ts: item.ts, text: ai.request }] : []),
          ...(ai.said ? [{ id: item.id, sender: item.sender, from_me: 0, ts: item.ts, text: ai.said }] : []),
        ] : scopedDb.prepare(`select id, sender, from_me, ts, text from items where source = ? and thread = ?
          and ts between ? and ? order by ts, rowid`).all(item.source, item.thread, item.ts - 12 * 3600, item.ts + 12 * 3600).filter(sameConversation(item))
        const at = Math.max(0, rows.findIndex((r) => r.id === item.id))
        const start = burstOf(scopedDb, item).start.ts
        return json(res, {
          item: { ...item, from_me: !!item.from_me }, tag,
          messages: rows.slice(Math.max(0, at - 8), at + 7).map((r) => ({
            ...r, from_me: !!r.from_me, picked: r.sender === item.sender && r.ts >= start && r.ts <= item.ts,
          })),
          // Activity sharing no meaningful terms is only weak evidence for the owner’s own promise;
          // do not attach unrelated work to another person’s request.
          since: evidence(db, { ...item, summary: tag?.summary, text: tag?.said || item.text })
            .filter((e) => e.kind !== 'chat' && ((e.shared ?? 2) >= 2 || item.from_me)).map((e) => ({ line: e.line, url: e.url || null })),
        })
      }
      if (url.pathname === '/api/forget' && post) {
        const body = requestBody
        const { id, source, thread } = JSON.parse(body)
        if (!id && !source) return json(res, { error: 'nothing to forget' }, 400)
        return json(res, { ok: true, removed: forget(db, id ? { id: String(id) } : { source: String(source), thread: thread == null ? null : String(thread) }) })
      }
      json(res, { error: 'not found' }, 404)
    } catch (e) {
      json(res, { error: 'REQUEST_FAILED' }, 500)
    }
  })
  return new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(port, '127.0.0.1', () => {
      hosts.add(`127.0.0.1:${server.address().port}`)
      hosts.add(`localhost:${server.address().port}`)
      resolve(server)
    })
  })
}
