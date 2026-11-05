import { createHash } from 'node:crypto'
export const mcpThread = (id, channel) => `mcp:${id}:${createHash('sha256').update(String(channel || '')).digest('hex')}`
