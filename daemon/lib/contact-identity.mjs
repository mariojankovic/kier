// Shared, side-effect-free identity rules for calls and direct chats.
const metaOf = item => {
  if (item?.meta && typeof item.meta === 'object') return item.meta
  try { return JSON.parse(item?.meta || '{}') } catch { return {} }
}

export function normalizePerson(value) {
  let text = String(value || '').normalize('NFKC').replace(/[\u200e\u200f\u202a-\u202e\u2066-\u2069]/g, '').trim().toLowerCase()
  text = text.replace(/^(?:tel|mailto):/i, '')
  if (/^\+?[\d ()+.-]+@(?:s\.whatsapp\.net|c\.us)$/.test(text)) text = text.split('@')[0]
  if (/^[\d ()+.-]+$/.test(text) && text.replace(/\D/g, '').length >= 6) return text.replace(/\D/g, '')
  return text.replace(/\s+/g, ' ')
}

export function identityFor(item) {
  const meta = metaOf(item)
  const name = meta.contactName || item?.thread || (item?.from_me ? '' : item?.sender) || ''
  const aliases = [...new Set([name, meta.handle, ...(Array.isArray(meta.contactAliases) ? meta.contactAliases : [])]
    .map(normalizePerson).filter(Boolean))]
  const id = String(meta.contactId || '')
  return {
    key: id ? (id.startsWith('contact:') ? id : `contact:${id}`) : aliases[0] || '',
    aliases, known: meta.contactKnown === true, name,
  }
}

// Answered may mean a zero-second event. Only speech duration or an explicit other-device answer settles a callback.
export function callConnected(item) {
  const meta = metaOf(item)
  return Number(meta.seconds) > 0 || meta.talked === true || ['elsewhere', 'answered_elsewhere'].includes(meta.outcome)
}

// Exact contact IDs take precedence over names, including two different saved people with the same display name.
export function identitiesMatch(a, b) {
  const left = identityFor(a), right = identityFor(b)
  if (!left.known || !right.known) return false
  const leftCanonical = left.key.startsWith('contact:'), rightCanonical = right.key.startsWith('contact:')
  if (leftCanonical && rightCanonical) return left.key === right.key
  return left.aliases.some(alias => right.aliases.includes(alias))
}
