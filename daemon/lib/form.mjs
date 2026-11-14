// A form filled in by Kier's own model instead of a reply to parse (sidecar/form.py). Choice fields come back as one
// of the listed options, with how likely the model held each. Only Kier's built-in runtime can do this: with the
// owner's own model server there are no forms, callers get null and do what they did before.
import { config, usesMlx } from './config.mjs'
import { sidecarFetch } from './sidecar-client.mjs'

export const formsAvailable = () => usesMlx && config.runtime !== 'external'

export async function fillForm({ system, user, fields, asked = true, keepAlive = config.chatKeepAlive, timeout = 30000 }) {
  if (!formsAvailable()) return null
  const res = await sidecarFetch('llm', '/api/form', {
    method: 'POST', signal: AbortSignal.timeout(timeout),
    body: JSON.stringify({ asked, keep_alive: keepAlive, fields, messages: [{ role: 'system', content: system }, { role: 'user', content: user }] }),
  })
  if (!res.ok) {
    const kind = await res.json().then((e) => e?.kind, () => null)
    const key = `${res.status}${typeof kind === 'string' && /^\w{1,40}$/.test(kind) ? ` ${kind}` : ''}`
    formFailures[key] = (formFailures[key] || 0) + 1
    return null
  }
  const out = await res.json()
  return out?.values && out.confidence ? out : null
}
// How often a form came back failed since the daemon started, by HTTP status and kind of error. Callers carry on
// without it either way; this is for telling a rare slip from a broken build.
export const formFailures = {}

// The same pick-one question asked of many prompts at once, for reading in the background (sidecar/sweep.py). Each
// prompt ends where the model's answer would begin; `lead` is how every answer starts, and what comes back is how
// likely each of `choices` was to come next. With the model not in memory it is never loaded: the batch goes through
// it a layer at a time. null when there are no forms here, the batch failed, or it gave way to a question.
// `more` asks some of the prompts a second thing in the same pass: { lead, choices, for: [which prompts] }, where its
// lead carries the answer on from the first one. Their results come back with a `more` of their own. With `leads`
// (one per prompt in `for`) in place of `lead`, the same prompt sent once per way its first answer could go has the
// second question read after each of them: both answers, exactly as the model would have written them, in one pass.
// `share: 'all'` says the prompts are one text asked several ways, so what they have in common is read once.
export async function sweepChoices({ prompts, lead, choices, more, share, asked = false, timeout = 115000 }) {
  if (!formsAvailable() || !prompts.length) return null
  const res = await sidecarFetch('llm', '/api/sweep', {
    method: 'POST', signal: AbortSignal.timeout(timeout), body: JSON.stringify({ asked, prompts, lead, choices, ...(more?.for?.length && { more }), ...(share && { share }) }),
  })
  if (!res.ok) {
    const kind = await res.json().then((e) => e?.kind, () => null)
    const key = `sweep ${res.status}${typeof kind === 'string' && /^\w{1,40}$/.test(kind) ? ` ${kind}` : ''}`
    formFailures[key] = (formFailures[key] || 0) + 1
    return null
  }
  const out = await res.json()
  return Array.isArray(out?.results) && out.results.length === prompts.length ? out : null
}

// A choice field's options, likeliest first, as [option, probability].
export const ranked = (confidence) => Object.entries(confidence?.options || {}).sort((a, b) => b[1] - a[1])
