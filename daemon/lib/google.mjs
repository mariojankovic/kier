import { vaultCall } from './native-vault.mjs'
// Google credentials never cross this allowlist, including redirects.
import { promisify } from 'node:util'
import { execFile } from './child-process.mjs'
import { config } from './config.mjs'
import { save } from './settings.mjs'

const exec = promisify(execFile)
export const GMAIL_SCOPE = 'https://www.googleapis.com/auth/gmail.readonly'
export const GMAIL_NOTICE = 'Kier fetches your Gmail from Google straight to this Mac, read only. Nothing goes to any Kier server. The refresh token stays in the signed app and its own Keychain item. The daemon holds only a read-only access token in memory, expiring within about an hour. A process running as you could at most obtain that short-lived access token.'
export async function googleClientID() {
  if (process.env.KIER_GOOGLE_CLIENT_ID) return process.env.KIER_GOOGLE_CLIENT_ID.trim()
  if (!process.env.KIER_APP) return ''
  try {
    return (await exec('/usr/libexec/PlistBuddy', ['-c', 'Print :KierGoogleClientID', `${process.env.KIER_APP}/Contents/Info.plist`], { timeout: 2000 })).stdout.trim()
  } catch { return '' }
}
export function googleURL(value) {
  const url = new URL(value)
  if (url.protocol !== 'https:' || !['gmail.googleapis.com', 'oauth2.googleapis.com'].includes(url.hostname) || url.port || url.username || url.password || url.hash) throw Error('GOOGLE_HOST_REFUSED')
  return url
}
export function googleFetch({ fetch: request = globalThis.fetch, sleep = ms => new Promise(r => setTimeout(r, ms)) } = {}) {
  return async (value, options = {}) => {
    const url = googleURL(value)
    for (let attempt = 0; attempt < 4; attempt++) {
      const res = await request(url, { ...options, redirect: 'error', signal: AbortSignal.timeout(10000) })
      if ((res.status === 429 || res.status >= 500) && attempt < 3) {
        await res.body?.cancel()
        await sleep(Math.min(8000, Math.max(250 * 2 ** attempt, (Number(res.headers.get('retry-after')) || 0) * 1000)))
        continue
      }
      if (!res.ok) { await res.body?.cancel(); const e = Error('GOOGLE_REQUEST_FAILED'); e.status = res.status; throw e }
      const reader = res.body?.getReader(); let bytes = 0; const chunks = []
      if (reader) for (;;) {
        const { done, value: chunk } = await reader.read(); if (done) break
        bytes += chunk.length
        if (bytes > 2 * 1024 * 1024) { await reader.cancel(); throw Error('GOOGLE_RESPONSE_TOO_LARGE') }
        chunks.push(Buffer.from(chunk))
      }
      const body = Buffer.concat(chunks).toString('utf8')
      return body ? JSON.parse(body) : {}
    }
  }
}
// Only native operations cross the inherited channel. No refresh credential API exists.
let lastError = '', pending = false, epoch = 0
export async function initializeGmail({ call = vaultCall, persist = gmail => save({ gmail }) } = {}) {
  const state = await call('status')
  persist(state)
  return state
}
export async function connectGmail({ call = vaultCall, persist = gmail => save({ gmail }) } = {}) {
  if (pending) return
  const attempt = ++epoch
  pending = true
  try {
    const state = await call('connect')
    if (attempt !== epoch) throw Error('GMAIL_CANCELLED')
    persist(state)
    lastError = ''
    return state
  } finally { if (attempt === epoch) pending = false }
}
export async function disconnectGmail({ call = vaultCall, persist = gmail => save({ gmail }) } = {}) {
  epoch++; pending = false
  persist({ connected: false })
  const result = await call('disconnect')
  lastError = result.revoked ? '' : 'Disconnected on this Mac. Google could not confirm revocation. Remove Kier in your Google Account connections too.'
  return result
}
export async function accessToken({ call = vaultCall, at = Date.now() } = {}) {
  const value = await call('access')
  if (!value || typeof value.accessToken !== 'string' || !value.accessToken ||
      !Number.isFinite(value.expiresAt) || value.expiresAt <= at || value.expiresAt > at + 3600000) throw Error('GMAIL_ACCESS_TOKEN_INVALID')
  return value
}
export async function gmailStep() {
  if (process.env.KIER_NATIVE_VAULT !== '1') return { id: 'gmail', title: 'Gmail', status: 'optional', detail: 'Gmail is only available in signed release builds' }
  const available = !!await googleClientID(), connected = config.gmail?.connected === true
  return { id: 'gmail', title: 'Gmail', status: connected ? 'done' : 'optional',
    detail: `${GMAIL_NOTICE} ${lastError || (connected ? 'Connected. The Mail switch also controls Gmail.' : !available ? 'Unavailable: this build has no Google client ID.' : 'Off until you choose Connect.')}`,
    ...((connected || available) && { action: { id: connected || pending ? 'gmailoff' : 'gmail', label: connected || pending ? 'Disconnect' : 'Connect' } }) }
}
