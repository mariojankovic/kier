import { createHash } from 'node:crypto'
import { evidenceMeta, ownerAuthored } from './evidence-trust.mjs'

// Forgetting is about the message, not the credentials or a collector's copy key.
// Store only hashes. Participants keep a reused Message-ID in another conversation
// from hiding unrelated mail, and never confer ownership or completion authority.
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex')
export function stableMailIdentity(item) {
  const meta = evidenceMeta(item)
  const participants = [...new Set([...(meta.from || []), ...(meta.to || []), ...(meta.cc || [])]
    .map(p => String(typeof p === 'string' ? p : p.email || p.name || '').trim().toLowerCase()).filter(Boolean))].sort()
  if (!participants.length) participants.push(String(item.sender || '').trim().toLowerCase())
  const messageId = String(meta.messageId || '').trim().replace(/^<|>$/g, '').toLowerCase()
  const identities = []
  if (messageId) identities.push(['message', messageId, participants])
  if (meta.client === 'gmail' && meta.providerMessageId) identities.push(['gmail', String(meta.providerMessageId), participants])
  // Local stores sometimes lack Message-ID. Their immutable headers/content still
  // survive a store move or rebuild, including older Gmail rows without a provider
  // id. Do not use account, copy key or database row id.
  if (!messageId) identities.push(['content', participants, item.ts, meta.subject || item.thread || '', meta.body ?? item.text ?? ''])
  return identities.map(value => `mail-stable:${hash(value)}`)
}

// Tombstones outlive identity versions. Never infer authorship from Message-ID;
// these aliases are used only to refuse recollection of forgotten content.
export function mailIdentity(item) {
  const meta = evidenceMeta(item)
  const base = item.id.replace(/:copy:(?:sent|received)(?::.*)?$/, '')
  const canonical = meta.messageId ? `mail:${createHash('sha256').update(`message:${meta.messageId}`).digest('hex')}` : base
  const previous = `${base}:copy:${ownerAuthored(item) ? 'sent' : 'received'}`
  const current = previous + (meta.copyKey ? ':' + createHash('sha256').update(JSON.stringify([
    meta.client, meta.copyKey, meta.account, meta.from, item.sender, item.thread, item.ts,
  ])).digest('hex') : '')
  // Old provenance repairs could change the sent/received classification. Both
  // historical partitions must refuse recollection; their tombstones carry no
  // recoverable metadata with which to distinguish the former classification.
  const stable = stableMailIdentity(item)
  return { current, stable, aliases: [...new Set([...stable, item.id, base, canonical,
    `${base}:copy:sent`, `${base}:copy:received`, current])] }
}
