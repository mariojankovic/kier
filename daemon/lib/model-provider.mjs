import { sidecarFetch } from './sidecar-client.mjs'
// Keep Kier's Ollama-shaped callers working with an explicitly selected model server.
// The default path stays unchanged; an external server's errors never select another model.
import { config, usesMlx } from './config.mjs'
import { isIP } from 'node:net'

let usage = () => {}
export function configureModelUsage(callback) { usage = typeof callback === 'function' ? callback : () => {} }
const json = (data, status = 200) => new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json' } })
const fail = message => new Error(message)
const bareHost = host => host.replace(/^\[|\]$/g, '').toLowerCase()
const loopback = host => {
  const h = bareHost(host)
  return h === 'localhost' || h === '::1' || (isIP(h) === 4 && h.startsWith('127.'))
}
// Only literal private addresses bypass TLS. A DNS name that resolves to the LAN today
// could point elsewhere tomorrow; it must use HTTPS. Redirects are never followed.
export function localModelHost(host) {
  const h = bareHost(host)
  if (loopback(h)) return true
  if (isIP(h) === 4) {
    const [a, b] = h.split('.').map(Number)
    return a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168)
  }
  return isIP(h) === 6 && /^(fc|fd)[0-9a-f]{2}:/.test(h)
}
export function requireModelTLS(endpoint) {
  if (endpoint.protocol === 'http:' && !localModelHost(endpoint.hostname)) {
    throw fail('Model servers outside localhost or a private LAN address must use HTTPS.')
  }
}

export function validateModelConfig(candidate, { requireModel = true } = {}) {
  if (!candidate || !['ollama', 'openai'].includes(candidate.protocol)) throw fail('Choose Ollama or an OpenAI-compatible server.')
  let endpoint
  try { endpoint = new URL(String(candidate.endpoint || '').trim()) } catch { throw fail('Enter a valid model server URL.') }
  if (!['http:', 'https:'].includes(endpoint.protocol) || endpoint.username || endpoint.password || endpoint.search || endpoint.hash) {
    throw fail('Use an HTTP or HTTPS base URL without credentials, query parameters, or a fragment.')
  }
  requireModelTLS(endpoint)
  const model = String(candidate.model || '').trim()
  if ((requireModel && !model) || model.length > 300 || /[\r\n\0]/.test(model)) throw fail('Choose a valid model name.')
  const apiKey = String(candidate.apiKey || '').trim()
  if (/[\r\n\0]/.test(apiKey)) throw fail('The API key contains an invalid character.')
  let path = endpoint.pathname.replace(/\/+$/, '')
  if (candidate.protocol === 'openai' && !/\/v1$/.test(path)) path += '/v1'
  endpoint.pathname = path
  return { protocol: candidate.protocol, endpoint: endpoint.href.replace(/\/+$/, ''), model, ...(apiKey && { apiKey }) }
}

function requestBody(body) {
  if (body == null) return {}
  try { return typeof body === 'string' ? JSON.parse(body) : JSON.parse(new TextDecoder().decode(body)) }
  catch { throw fail('The model request was not valid JSON.') }
}
function headersFor(options, candidate) {
  const headers = new Headers(options.headers)
  headers.set('content-type', 'application/json')
  // A key belongs only to the chosen server; never inherit another provider's Authorization.
  headers.delete('authorization')
  if (candidate.apiKey) headers.set('authorization', `Bearer ${candidate.apiKey}`)
  return headers
}
async function externalFetch(candidate, route, options, { inference = false } = {}) {
  if (inference && !loopback(new URL(candidate.endpoint).hostname)) {
    // Count sent bytes, never the key, address, prompt, response or other vault content.
    try { usage({ protocol: candidate.protocol, bytes: Buffer.byteLength(options.body || '') }) } catch {}
  }
  try { return await fetch(`${candidate.endpoint}${route}`, { ...options, headers: headersFor(options, candidate), redirect: 'error' }) }
  catch (error) {
    if (options.signal?.aborted) throw options.signal.reason || new DOMException('The model request was cancelled.', 'AbortError')
    throw fail('Could not reach the model server. Check its address and that it is running.')
  }
}
const httpError = response => json({ error: `Model server returned HTTP ${response.status}. Check its configuration and credentials.` }, response.status)
const textContent = content => typeof content === 'string' ? content : Array.isArray(content) ? content.filter(p => p.type === 'text').map(p => p.text || '').join('') : null

function streamAsOllama(response, signal) {
  const reader = response.body?.getReader()
  if (!reader) throw fail('The model server returned an empty stream.')
  const decoder = new TextDecoder()
  const encoder = new TextEncoder()
  let buffer = '', data = [], finished = false, stopped = false
  let abort
  const body = new ReadableStream({
    start(controller) {
      const emit = (content, done = false) => controller.enqueue(encoder.encode(`${JSON.stringify({ message: { role: 'assistant', content }, done })}\n`))
      const finish = () => { if (!finished) { finished = true; emit('', true) } }
      const event = () => {
        if (!data.length) return false
        const raw = data.join('\n'); data = []
        if (raw.trim() === '[DONE]') { finish(); return true }
        let chunk
        try { chunk = JSON.parse(raw) } catch { throw fail('The model server returned an invalid stream.') }
        if (chunk.error) throw fail('The model server reported a streaming error.')
        const choice = chunk.choices?.find(c => c.index === 0) ?? chunk.choices?.[0]
        const content = textContent(choice?.delta?.content)
        if (!finished && content) emit(content)
        if (choice?.finish_reason != null) finish()
        return false
      }
      const line = value => {
        if (value === '') return event()
        if (value.startsWith('data:')) data.push(value.slice(5).replace(/^ /, ''))
        return false
      }
      abort = () => {
        if (stopped) return
        stopped = true
        void reader.cancel().catch(() => {})
        controller.error(signal.reason || new DOMException('The model request was cancelled.', 'AbortError'))
      }
      if (signal?.aborted) { abort(); return }
      signal?.addEventListener('abort', abort, { once: true })
      void (async () => {
        try {
          while (!stopped) {
            const { value, done } = await reader.read()
            if (stopped) return
            buffer += done ? decoder.decode() : decoder.decode(value, { stream: true })
            let index, ended = false
            while ((index = buffer.indexOf('\n')) >= 0) {
              const value = buffer.slice(0, index).replace(/\r$/, '')
              buffer = buffer.slice(index + 1)
              if (line(value)) { ended = true; break }
            }
            if (ended) { await reader.cancel(); break }
            if (done) {
              if (buffer) line(buffer.replace(/\r$/, ''))
              event()
              if (!finished) throw fail('The model stream ended before the response was complete.')
              break
            }
          }
          if (!stopped) { stopped = true; controller.close() }
        } catch (error) {
          if (!stopped) {
            stopped = true
            controller.error(signal?.aborted ? signal.reason : fail(error.message?.startsWith('The model ') ? error.message : 'The model stream was interrupted.'))
          }
        } finally { signal?.removeEventListener('abort', abort); reader.releaseLock() }
      })()
    },
    cancel() { stopped = true; signal?.removeEventListener('abort', abort); return reader.cancel() },
  })
  return new Response(body, { headers: { 'content-type': 'application/x-ndjson' } })
}

async function externalModelFetch(candidate, path, options = {}) {
  if (!['/api/chat', '/api/version', '/api/tags'].includes(path)) throw fail('This model server does not support that operation.')
  if (candidate.protocol === 'ollama') {
    const inference = path === '/api/chat'
    const body = inference ? JSON.stringify({ ...requestBody(options.body), model: candidate.model }) : options.body
    const response = await externalFetch(candidate, path, { ...options, ...(body != null && { body }) }, { inference })
    return response.ok ? response : httpError(response)
  }
  if (path !== '/api/chat') {
    const response = await externalFetch(candidate, '/models', { ...options, method: 'GET', body: undefined })
    if (!response.ok) return httpError(response)
    let result
    try { result = await response.json() } catch { throw fail('The model server returned an invalid model list.') }
    if (!Array.isArray(result.data)) throw fail('The model server returned an invalid model list.')
    const models = result.data.filter(m => typeof m.id === 'string').map(m => ({ name: m.id, model: m.id }))
    return json(path === '/api/version' ? { version: 'openai-compatible' } : { models })
  }
  const input = requestBody(options.body)
  const body = { model: candidate.model, messages: input.messages || [], stream: input.stream === true }
  if (Number.isFinite(input.options?.temperature)) body.temperature = input.options.temperature
  if (Number.isInteger(input.options?.num_predict) && input.options.num_predict > 0) body.max_tokens = input.options.num_predict
  if (input.format === 'json') body.response_format = { type: 'json_object' }
  const response = await externalFetch(candidate, '/chat/completions', { ...options, method: 'POST', body: JSON.stringify(body) }, { inference: true })
  if (!response.ok) return httpError(response)
  if (body.stream) return streamAsOllama(response, options.signal)
  let output
  try { output = await response.json() } catch { throw fail('The model server returned an invalid response.') }
  if (output.error) throw fail('The model server reported an inference error.')
  const content = textContent(output.choices?.[0]?.message?.content)
  if (content == null) throw fail('The model server returned no text response.')
  return json({ model: candidate.model, message: { role: 'assistant', content }, done: true })
}

export function modelFetch(path, options = {}) {
  if (config.runtime !== 'external') {
    if (!usesMlx) throw fail('Choose your model server in Setup or install Kier’s local model.')
    return sidecarFetch('llm', path, options)
  }
  return externalModelFetch(validateModelConfig(config.externalModel), path, options)
}

// Only synthetic text is sent here. Listing models works before a model is selected;
// choosing one additionally verifies a small JSON response, using the same adapter.
export async function testModelConnection(candidate, { signal } = {}) {
  const selected = validateModelConfig(candidate, { requireModel: false })
  const options = { signal: signal || AbortSignal.timeout(30000) }
  const response = await externalModelFetch(selected, '/api/tags', options)
  if (!response.ok) throw fail(`Model server returned HTTP ${response.status}. Check its configuration and credentials.`)
  let result
  try { result = await response.json() } catch { throw fail('The model server returned an invalid model list.') }
  if (!Array.isArray(result.models)) throw fail('The model server returned an invalid model list.')
  const models = result.models.map(m => m.name || m.model).filter(m => typeof m === 'string')
  if (selected.model) {
    const probe = await externalModelFetch(selected, '/api/chat', { ...options, method: 'POST', body: JSON.stringify({
      model: selected.model, stream: false, think: false, format: 'json', options: { temperature: 0, num_predict: 32 },
      messages: [{ role: 'user', content: 'Reply with exactly this JSON object: {"ok":true}' }],
    }) })
    if (!probe.ok) throw fail(`Model server returned HTTP ${probe.status}. Check the selected model and credentials.`)
    try {
      const data = await probe.json()
      if (JSON.parse(data.message?.content || '').ok !== true) throw Error()
    } catch { throw fail('The selected model did not return the JSON response Kier needs.') }
  }
  return { models, ...(selected.model && { model: selected.model, checked: true }) }
}
