// Persist the generation so a collector or another daemon process cannot restore stale facts.
import { existsSync, readFileSync, writeFileSync, rmSync } from 'node:fs'
import { resolve } from 'node:path'
import { dataDir } from './config.mjs'
import { forget, readJson } from './file-cache.mjs'
export const profilePath = resolve(dataDir, 'profile.json')
const statePath = resolve(dataDir, 'profile-state.json')
export function profileState() {
  try { return readJson(statePath) }
  catch { return { generation: 0, stale: true } }
}
export function invalidateProfile() {
  const generation = Number(profileState().generation || 0) + 1
  writeFileSync(statePath, JSON.stringify({ generation, stale: true }), { mode: 0o600 })
  rmSync(profilePath, { force: true })
  forget(statePath); forget(profilePath)
}
export function saveProfile(p, generation) {
  if (profileState().generation !== generation) return false
  writeFileSync(profilePath, JSON.stringify({ ...p, generation, changed: Math.floor(Date.now() / 1000) }, null, 2), { mode: 0o600 })
  writeFileSync(statePath, JSON.stringify({ generation, stale: false }), { mode: 0o600 })
  forget(statePath); forget(profilePath)
  return true
}
export function currentProfile() {
  const state = profileState()
  if (state.stale || !existsSync(profilePath)) return null
  try {
    const p = readJson(profilePath)
    return p.generation === state.generation ? p : null
  } catch { return null }
}
