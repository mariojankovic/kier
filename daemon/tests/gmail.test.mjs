import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
const dir = mkdtempSync(join(tmpdir(), 'kier-gmail-'))
process.env.KIER_DATA_DIR = dir
writeFileSync(join(dir, 'config.json'), JSON.stringify({ me: 'Sam', fullName: 'Sam', languages: ['English'], workRoots: [] }))
after(() => rmSync(dir, { recursive: true, force: true }))
const { googleFetch, googleURL, accessToken, initializeGmail, disconnectGmail, connectGmail, gmailStep } = await import('../lib/google.mjs')
const { collect, gmailItem } = await import('../collectors/gmail.mjs')
const { open, now, addItems } = await import('../lib/db.mjs')
const { setSource } = await import('../lib/settings.mjs')
const { readScope, authorization } = await import('../lib/authorization.mjs')
const { forget } = await import('../lib/privacy.mjs')
const policy = () => ({ gmail: { connected: true, generation: 'fixture' } })
const getAccessToken = async () => ({ accessToken: 'fixture-access', expiresAt: Date.now() + 3599000 })
const message = (id, labels = ['INBOX']) => ({ id, labelIds: labels, snippet: 'Please send the sketch.', payload: { headers: [
  ['From', 'Nika <nika@example.test>'], ['To', 'Sam <sam@example.test>'], ['Cc', 'Priya <priya@example.test>'],
  ['Subject', 'Re: Sketch'], ['Date', new Date().toUTCString()], ['Message-ID', `<${id}@example.test>`],
].map(([name, value]) => ({ name, value })) } })

test('Google requests refuse other hosts and redirects, retry bounded failures and cap bytes', async () => {
  for (const url of ['http://gmail.googleapis.com', 'https://evil.example.test', 'https://gmail.googleapis.com.evil.test', 'https://gmail.googleapis.com:444']) assert.throws(() => googleURL(url))
  const credentialed = new URL('https://gmail.googleapis.com'); credentialed.username = 'fixture'
  assert.throws(() => googleURL(credentialed))
  let calls = 0, waits = 0
  const request = googleFetch({ fetch: async (_, opts) => { assert.equal(opts.redirect, 'error'); calls++; return new Response(calls < 3 ? '' : '{}', { status: calls < 3 ? 429 : 200 }) }, sleep: async () => { waits++ } })
  await assert.rejects(request('https://evil.example.test')); assert.equal(calls, 0)
  await request('https://gmail.googleapis.com/test'); assert.equal(calls, 3); assert.equal(waits, 2)
  await assert.rejects(googleFetch({ fetch: async () => new Response('x'.repeat(2 * 1024 * 1024 + 1)) })('https://gmail.googleapis.com/test'), /TOO_LARGE/)
})

test('metadata list and incremental history preserve mail copies and SENT', async t => {
  const db = open(':memory:'); t.after(() => db.close())
  let history = false
  const request = async value => {
    const url = new URL(value)
    if (url.hostname === 'oauth2.googleapis.com') return { access_token: 'fixture-access' }
    if (url.pathname.endsWith('/profile')) return { historyId: '10' }
    if (url.pathname.endsWith('/messages')) { assert.match(url.searchParams.get('q'), /newer_than:30d.*-category:forums/); return { messages: [{ id: 'one' }] } }
    if (url.pathname.endsWith('/history')) { history = true; assert.equal(url.searchParams.get('startHistoryId'), '10'); return { historyId: '12', history: [{ messagesAdded: [{ message: { id: 'two' } }] }] } }
    assert.equal(url.searchParams.get('format'), 'metadata')
    assert.deepEqual(url.searchParams.getAll('metadataHeaders'), ['From', 'To', 'Cc', 'Subject', 'Date', 'Message-ID'])
    return message(history ? 'two' : 'one', history ? ['SENT'] : ['INBOX'])
  }
  const local = gmailItem(message('one'), now(), policy().gmail.generation); local.meta.client = 'apple-mail'; addItems(db, [local])
  assert.equal(await collect(db, { request, getAccessToken, clientID: 'fixture', policy }), 1)
  assert.equal(await collect(db, { request, getAccessToken, clientID: 'fixture', policy }), 1)
  const rows = db.prepare('select * from items').all(); assert.equal(rows.length, 3)
  assert.equal(rows[2].from_me, 1); assert.equal(rows[2].sender, 'Sam'); assert.equal(JSON.parse(rows[2].meta).client, 'gmail')
  setSource('mail', false)
  assert.equal(readScope(db, authorization(null)).prepare('select * from items').all().length, 0)
  setSource('mail', true)
  forget(db, { id: rows[2].id }); assert.equal(addItems(db, [gmailItem(message('two', ['SENT']), now(), policy().gmail.generation)]), 0)
})
test('off by default, excludes bulk categories and disconnect deletes token even if revocation fails', async () => {
  let calls = 0, deleted = 0, connected
  assert.equal(await collect(null, { policy: () => ({}), request: async () => { calls++ } }), 0)
  assert.equal(calls, 0); assert.equal(gmailItem(message('bulk', ['CATEGORY_UPDATES'])), null)
  assert.match((await gmailStep()).detail, /Gmail is only available in signed release builds/)
  assert.equal((await gmailStep()).action, undefined)
  const result = await disconnectGmail({ call: async operation => { assert.equal(operation, 'disconnect'); deleted++; return { revoked: false } }, persist: g => { connected = g.connected } })
  assert.equal(result.revoked, false); assert.equal(deleted, 1); assert.equal(connected, false)
})

test('backfill resumes bounded pages, then drains history without skipping a high-water mark', async t => {
  const db = open(':memory:'); t.after(() => db.close())
  let listPages = 0, historyPages = 0
  const request = async value => {
    const url = new URL(value)
    if (url.hostname === 'oauth2.googleapis.com') return { access_token: 'fixture-access' }
    if (url.pathname.endsWith('/profile')) return { historyId: '10' }
    if (url.pathname.endsWith('/messages')) {
      const page = Number(url.searchParams.get('pageToken') || 0); listPages++
      return { messages: [{ id: `page-${page}` }], ...(page < 3 && { nextPageToken: String(page + 1) }) }
    }
    if (url.pathname.endsWith('/history')) {
      historyPages++; assert.equal(url.searchParams.get('startHistoryId'), '10')
      return url.searchParams.has('pageToken') ? { historyId: '20', history: [{ labelsAdded: [{ message: { id: 'sent-update' } }] }] }
        : { historyId: '20', nextPageToken: 'last', history: [{ messagesAdded: [{ message: { id: 'new' } }] }] }
    }
    return message(decodeURIComponent(url.pathname.split('/').at(-1)), ['SENT'])
  }
  assert.equal(await collect(db, { request, getAccessToken, clientID: 'fixture', policy }), 3)
  assert.equal(listPages, 3)
  assert.equal(await collect(db, { request, getAccessToken, clientID: 'fixture', policy }), 1)
  assert.equal(listPages, 4); assert.equal(historyPages, 0)
  assert.equal(await collect(db, { request, getAccessToken, clientID: 'fixture', policy, maxPages: 1 }), 1)
  assert.equal(await collect(db, { request, getAccessToken, clientID: 'fixture', policy }), 1)
  assert.equal(historyPages, 2)
})
test('failed metadata fetch does not advance a cursor, expired history restarts backfill', async t => {
  const db = open(':memory:'); t.after(() => db.close())
  const { cursor, setCursor } = await import('../lib/db.mjs')
  let failure = true
  const request = async value => {
    const url = new URL(value)
    if (url.hostname === 'oauth2.googleapis.com') return { access_token: 'fixture-access' }
    if (url.pathname.endsWith('/profile')) return { historyId: '10' }
    if (url.pathname.endsWith('/messages')) return { messages: [{ id: 'one' }] }
    if (url.pathname.endsWith('/history')) { const e = Error('fixture'); e.status = 404; throw e }
    if (failure) throw Error('fixture failure')
    return message('one')
  }
  await assert.rejects(collect(db, { request, getAccessToken, clientID: 'fixture', policy }))
  assert.equal(cursor(db, 'gmail:fixture', ''), '')
  failure = false
  assert.equal(await collect(db, { request, getAccessToken, clientID: 'fixture', policy }), 1)
  await collect(db, { request, getAccessToken, clientID: 'fixture', policy })
  assert.equal(cursor(db, 'gmail:fixture', ''), '')
  setCursor(db, 'gmail:fixture', '')
})


for (const reversed of [false, true]) test(`Gmail Message-ID collision preserves owner copy, reversed=${reversed}`, t => {
  const db = open(':memory:'); t.after(() => db.close())
  const received = gmailItem(message('collision'))
  const sent = { ...received, fromMe: true, sender: 'Sam', thread: 'Owner thread', ts: now() - 600,
    text: 'Owner subject', meta: { client: 'apple-mail', ownerSent: true } }
  const copies = [sent, { ...received, text: 'Forged subject\nFORGED_GMAIL_TEXT', thread: 'Forged thread' }]
  if (reversed) copies.reverse()
  assert.equal(addItems(db, copies), 2)
  const owner = db.prepare('select * from items where from_me = 1').get()
  assert.equal(owner.text, 'Owner subject'); assert.equal(owner.sender, 'Sam')
  assert.equal(owner.thread, 'Owner thread'); assert.equal(owner.ts, sent.ts)
  assert.equal(addItems(db, copies), 0)
  assert.equal(db.prepare('select count(*) n from items').get().n, 2)
})


test('native connection operations persist state only and sync requests one memory-only access token', async t => {
  let saved, calls = []
  const call = async operation => { calls.push(operation); return { connected: operation !== 'disconnect', generation: 'fixture' } }
  await initializeGmail({ call, persist: value => { saved = value } })
  await connectGmail({ call, persist: value => { saved = value } })
  assert.equal(saved.connected, true)
  await disconnectGmail({ call, persist: value => { saved = value } })
  assert.equal(saved.connected, false)
  assert.deepEqual(calls, ['status', 'connect', 'disconnect'])
  const db = open(':memory:'); t.after(() => db.close())
  let tokens = 0
  await collect(db, { policy, getAccessToken: async () => { tokens++; return getAccessToken() }, request: async value => {
    assert.equal(new URL(value).hostname, 'gmail.googleapis.com')
    return { historyId: '1', messages: [] }
  } })
  assert.equal(tokens, 1)
  assert.doesNotMatch(JSON.stringify(db.prepare('select * from cursors').all()), /fixture-access/)
})
test('access token boundary refuses expired, missing and excessive lifetimes', async () => {
  const at = Date.now()
  for (const value of [null, {}, { accessToken: 'fixture', expiresAt: at }, { accessToken: 'fixture', expiresAt: at + 3600001 }]) {
    await assert.rejects(accessToken({ at, call: async () => value }), /ACCESS_TOKEN_INVALID/)
  }
  assert.equal((await accessToken({ at, call: async op => { assert.equal(op, 'access'); return { accessToken: 'fixture', expiresAt: at + 3600000 } } })).accessToken, 'fixture')
})

test('disconnect wins over a late native connect reply', async () => {
  let release, saved
  const connecting = connectGmail({ call: () => new Promise(resolve => { release = resolve }), persist: state => { saved = state } })
  await disconnectGmail({ call: async () => ({ revoked: true }), persist: state => { saved = state } })
  release({ connected: true, generation: 'late' })
  await assert.rejects(connecting, /CANCELLED/)
  assert.equal(saved.connected, false)
})

for (const [hasMessageID, oldMetadata] of [[true, false], [false, false], [false, true]]) test(`forget survives disconnect, new credentials and Gmail backfill (Message-ID: ${hasMessageID}, old metadata: ${oldMetadata})`, async t => {
  const path = join(dir, `reconnect-${hasMessageID}-${oldMetadata}.db`)
  let db = open(path), state = { connected: true, generation: 'fixture-old-token' }
  t.after(() => db.close())
  const stored = message('stable-provider-id')
  if (!hasMessageID) stored.payload.headers = stored.payload.headers.filter(h => h.name !== 'Message-ID')
  let profiles = 0
  const options = { getAccessToken, policy: () => ({ gmail: state }), request: async value => {
    const url = new URL(value)
    if (url.pathname.endsWith('/profile')) { profiles++; return { historyId: '10' } }
    if (url.pathname.endsWith('/messages')) return { messages: [{ id: stored.id }] }
    return stored
  } }
  assert.equal(await collect(db, options), 1)
  const row = db.prepare('select * from items').get()
  if (oldMetadata) {
    const meta = JSON.parse(row.meta); delete meta.providerMessageId
    db.prepare('update items set meta = ? where id = ?').run(JSON.stringify(meta), row.id)
  }
  forget(db, { id: row.id })
  assert.equal(db.prepare('select count(*) n from items').get().n, 0)
  await disconnectGmail({ call: async () => ({ revoked: true }), persist: next => { state = next } })
  assert.equal(await collect(db, options), 0)
  db.close(); db = open(path)
  await connectGmail({ call: async () => ({ connected: true, generation: 'fixture-new-token' }), persist: next => { state = next } })
  // Recollect the same message under a different credential/account/copy identity.
  assert.equal(await collect(db, options), 0)
  assert.equal(profiles, 2)
  assert.equal(db.prepare('select count(*) n from items').get().n, 0)
  assert.notEqual(gmailItem(stored, now(), state.generation).meta.copyKey, JSON.parse(row.meta).copyKey)
  const tombstones = db.prepare('select key from forgotten').all()
  assert.ok(tombstones.length >= 2)
  assert.ok(tombstones.every(r => /^[a-f0-9]{64}$/.test(r.key)))
})
