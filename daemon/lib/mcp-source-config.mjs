import { randomUUID } from 'node:crypto'
import { config } from './config.mjs'
import { save } from './settings.mjs'
import { publicURL } from './public-fetch.mjs'
import { invalidateProfile } from './profile-state.mjs'

export function mcpURL(value) {
  const url = new URL(value)
  if (url.username || url.password || url.hash) throw Error('MCP_URL_INVALID')
  if (url.protocol === 'http:' && url.hostname === '127.0.0.1') return url
  return publicURL(url)
}
export function commandLine(value) {
  const words = []; let word = '', quote = '', escaped = false, started = false
  for (const c of value) {
    if (escaped) { word += c; escaped = false; started = true }
    else if (c === '\\' && quote !== "'") escaped = true
    else if (quote) { if (c === quote) quote = ''; else word += c }
    else if (c === '"' || c === "'") { quote = c; started = true }
    else if (/\s/.test(c)) { if (started) words.push(word); word = ''; started = false }
    else { word += c; started = true }
  }
  if (quote || escaped) throw Error('MCP_COMMAND_INVALID')
  if (started) words.push(word)
  if (!words.length) throw Error('MCP_COMMAND_INVALID')
  return { command: words[0], args: words.slice(1) }
}
export function validateSource(value) {
  if (!value || typeof value !== 'object' || !/^[a-zA-Z0-9_-]{1,64}$/.test(value.id || '') || typeof value.name !== 'string' || !value.name.trim() || value.name.length > 100) throw Error('MCP_SOURCE_INVALID')
  const base = { id: value.id, name: value.name.trim(), enabled: value.enabled === true }
  if (typeof value.tool === 'string' && value.tool.length <= 128) base.tool = value.tool
  const args = value.arguments ?? {}
  if (!args || typeof args !== 'object' || Array.isArray(args) || JSON.stringify(args).length > 16000) throw Error('MCP_ARGUMENTS_INVALID')
  base.arguments = args
  if (value.url) {
    if (value.command || value.env || value.args) throw Error('MCP_SOURCE_INVALID')
    return { ...base, url: mcpURL(value.url).href }
  }
  if (typeof value.command !== 'string' || !value.command || value.command.length > 1000 || !Array.isArray(value.args ?? []) || !(value.args ?? []).every(s => typeof s === 'string' && s.length <= 4000) || (value.args?.length || 0) > 50) throw Error('MCP_COMMAND_INVALID')
  const env = value.env ?? {}
  if (!env || typeof env !== 'object' || Array.isArray(env) || Object.keys(env).length > 50 || !Object.entries(env).every(([k, v]) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(k) && typeof v === 'string' && v.length <= 8000)) throw Error('MCP_ENV_INVALID')
  return { ...base, command: value.command, args: value.args ?? [], env }
}
export const sourceList = () => (config.mcpSources || []).map(validateSource)
// Only owner HTTP routes call this, never model tools or returned server content.
export function editSource(input) {
  const sources = sourceList()
  if (input.remove) {
    invalidateProfile()
    save({ mcpSources: sources.filter(s => s.id !== input.id) })
    return
  }
  const previous = sources.find(s => s.id === input.id)
  if (!previous && sources.length >= 20) throw Error('MCP_SOURCE_LIMIT')
  let value = previous ? { ...previous, ...input } : { ...input, id: randomUUID(), enabled: false }
  if (input.endpoint) value = { ...value, ...(/^https?:\/\//.test(input.endpoint) ? { url: input.endpoint } : commandLine(input.endpoint)) }
  value = validateSource(value)
  if (value.enabled && !value.tool) throw Error('MCP_TOOL_REQUIRED')
  if (!value.enabled) invalidateProfile()
  save({ mcpSources: [...sources.filter(s => s.id !== value.id), value] })
  return value.id
}
export const sourceSummary = () => sourceList().map(({ id, name, enabled, tool, arguments: args, url }) => ({ id, name, enabled, tool: tool || '', arguments: JSON.stringify(args), destination: url ? new URL(url).origin : 'Local process' }))
