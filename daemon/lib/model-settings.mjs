import { existsSync, readFileSync, writeFileSync, renameSync } from 'node:fs'
import { config, configPath, mlxReady } from './config.mjs'
import { testModelConnection } from './model-provider.mjs'

const stored = () => existsSync(configPath) ? JSON.parse(readFileSync(configPath, 'utf8')) : {}
export function modelSettings() {
  const custom = stored().externalModel || {}
  return { mode: config.runtime === 'external' ? 'custom' : 'builtin', protocol: custom.protocol || 'ollama',
    endpoint: custom.endpoint || 'http://127.0.0.1:11434', model: custom.model || '', hasKey: !!custom.apiKey,
    activeModel: config.model, managedReady: mlxReady() }
}

// An omitted secret preserves the current one; an explicit clear is needed to remove it.
export function modelCandidate(body) {
  const previous = stored().externalModel || {}
  const sameServer = body.protocol === previous.protocol && body.endpoint?.replace(/\/+$/, '') === previous.endpoint?.replace(/\/+$/, '')
  return { protocol: body.protocol, endpoint: body.endpoint, model: String(body.model || '').trim(),
    apiKey: body.clearKey === true ? '' : typeof body.apiKey === 'string' && body.apiKey.length ? body.apiKey : sameServer ? previous.apiKey || '' : '' }
}

export async function testModelSettings(body) {
  return testModelConnection(modelCandidate(body))
}

export async function saveModelSettings(body) {
  let patch
  if (body.mode === 'builtin') patch = { runtime: 'auto', model: 'qwen3.5:9b' }
  else if (body.mode === 'custom') {
    const candidate = modelCandidate(body)
    if (!candidate.model) throw Error('Choose a model first.')
    await testModelConnection(candidate)
    patch = { runtime: 'external', externalModel: candidate }
  } else throw Error('Choose Kier’s model or your model.')
  const next = { ...stored(), ...patch }
  const temporary = configPath + '.next'
  writeFileSync(temporary, JSON.stringify(next, null, 2), { mode: 0o600 })
  renameSync(temporary, configPath)
  return { ok: true, restarting: true }
}
