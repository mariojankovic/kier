// Tab storage is origin-isolated (including the port); cookies are never used.
// The launcher sends a short-lived one-use ticket, never a bearer in the URL.
export async function browserAPI({ location, history, sessionStorage, fetch: send }) {
  const origin = location.origin
  const key = 'kier-api-token'
  let token = sessionStorage.getItem(key)
  const ticket = new URLSearchParams(location.hash.slice(1)).get('bootstrap')
  if (ticket) {
    history.replaceState(null, '', location.pathname + location.search)
    const response = await send('/auth/bootstrap', { method: 'POST', credentials: 'omit', redirect: 'error',
      headers: { 'content-type': 'application/json', 'x-kier-bootstrap': ticket } })
    if (!response.ok) throw Error('Open Kier again to connect this page.')
    token = (await response.json()).token
    sessionStorage.setItem(key, token)
  }
  return (path, options = {}) => {
    const url = new URL(path, origin)
    if (url.origin !== origin || !url.pathname.startsWith('/api/')) throw Error('Kier API requests must stay on this origin.')
    const headers = new Headers(options.headers)
    if (token) headers.set('x-kier-token', token)
    return send(url.href, { ...options, headers, credentials: 'omit', redirect: 'error' }).then(response => {
      if (response.status === 401) {
        sessionStorage.removeItem(key)
        throw Error('Open Kier again to reconnect this page.')
      }
      return response
    })
  }
}
