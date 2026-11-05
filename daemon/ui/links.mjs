// Vault URLs are untrusted. Escaping HTML alone does not make a script URL safe.
const SCHEMES = new Set(['https:', 'http:', 'whatsapp:', 'imessage:'])
export function safeLink(value) {
  if (typeof value !== 'string' || /[\u0000-\u0020\u007f]/.test(value)) return null
  try {
    const url = new URL(value)
    return SCHEMES.has(url.protocol) && !url.username && !url.password ? url.href : null
  } catch { return null }
}
