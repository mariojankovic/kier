import { readFileSync, existsSync } from 'node:fs'
import { config, configPath } from '../lib/config.mjs'
import { addItems, cursor, now, setCursor } from '../lib/db.mjs'
import { validateSource } from '../lib/mcp-source-config.mjs'
import { sourceJob, sourceItems } from '../lib/mcp-sources.mjs'
export const source = 'mcp'
const policy = () => existsSync(configPath) ? JSON.parse(readFileSync(configPath, 'utf8')) : config
export async function collect(db, { run = sourceJob, force = false, only, at = now() } = {}) {
  const initial = policy()
  if (initial.off?.includes('mcp')) return 0
  let added = 0, failures = 0
  for (const raw of (initial.mcpSources || []).slice(0, 20)) {
    if (!raw.enabled || !raw.tool || only && raw.id !== only) continue
    const key = `mcp:${raw.id}:last`
    if (!force && at - Number(cursor(db, key, 0)) < 600) continue
    try {
      const selected = validateSource(raw)
      // Rate-limit failures as well as successes. On-demand calls bypass this mark.
      setCursor(db, key, at)
      const result = await run(selected)
      const current = policy()
      const same = current.mcpSources?.find(s => s.id === selected.id)
      if (current.off?.includes('mcp') || !same?.enabled || JSON.stringify(validateSource(same)) !== JSON.stringify(selected)) continue
      added += addItems(db, sourceItems(selected, result, at))
    } catch { failures++ }
  }
  if (failures) throw Error('MCP_SOURCE_FAILED')
  return added
}
