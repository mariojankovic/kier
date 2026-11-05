import { discordMessage } from './discord-copies.mjs'
const clean = s => String(s || '').normalize('NFKC').replace(/[\u200e\u200f\u2066-\u2069]/g, '').trim()
// Sender and transport metadata are not evidence of where the work belongs.
export function groundedTitle(summary, item, context = []) {
  const discord = discordMessage(item)
  const body = [discord?.text ?? item.text, ...context.map(c => c.text)].map(clean).join('\n').toLowerCase()
  const sender = discord?.sender ?? clean(item.sender)
  const platform = { discord: 'Discord', whatsapp: 'WhatsApp', imessage: 'iMessage', notifications: item.thread }[item.source]
  let title = String(summary || '')
  for (const name of [sender, platform]) {
    if (!name || body.includes(clean(name).toLowerCase())) continue
    const literal = clean(name).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    title = title.replace(new RegExp(`\\s+(?:in|on|at)\\s+${literal}(?=[.!?]?$)`, 'i'), '')
  }
  return title.trim()
}
