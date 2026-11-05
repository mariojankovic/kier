// Keep the product identity separate from model names such as Sol, Astra, or GPT.
export function aiProvider(session = {}) {
  if (['claude', 'codex', 'chatgpt'].includes(session.provider)) return session.provider
  const agent = String(session.agent || session.sender || '')
  if (/^(?:codex|sol|astra|gpt)(?:\b|-)/i.test(agent)) return 'codex'
  if (/^chatgpt\b/i.test(agent)) return 'chatgpt'
  if (/^claude\b/i.test(agent)) return 'claude'
  return null
}
export function codexLink(session) {
  const id = session.session || session.id
  return typeof id === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)
    ? `codex://threads/${id}` : null
}
