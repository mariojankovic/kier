import { randomBytes } from 'node:crypto'
import { chmodSync, lstatSync, readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { dataDir } from './config.mjs'
export function sidecarToken() {
  const path = resolve(dataDir, 'sidecar-token')
  try { writeFileSync(path, randomBytes(32).toString('hex'), { flag: 'wx', mode: 0o600 }) } catch (e) { if (e.code !== 'EEXIST') throw Error('SIDECAR_TOKEN_FAILED') }
  if (!lstatSync(path).isFile()) throw Error('SIDECAR_TOKEN_FAILED')
  chmodSync(path, 0o600)
  const token = readFileSync(path, 'utf8').trim()
  if (!/^[a-f0-9]{64}$/.test(token)) throw Error('SIDECAR_TOKEN_FAILED')
  return token
}
export const sidecarHeaders = () => ({ 'content-type': 'application/json', 'x-kier-token': sidecarToken() })
