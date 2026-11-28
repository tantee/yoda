/**
 * Tokens. Refresh tokens: storage.local, or storage.session for a "sign out when the browser closes" profile.
 * Access tokens: storage.session. Both areas are limited to extension pages (TRUSTED_CONTEXTS, spike finding 7),
 * so injected scripts in web pages can never read them. Nothing here is ever sent to a page.
 */
const refreshKey = (id: string) => `refresh:${id}`
const accessKey = (id: string) => `access:${id}`

/** storage.local is limited to extension pages; until known, assume not (refresh tokens then go to the session). */
let localProtected = false

/**
 * Called first thing in the service worker (and on browser start), awaited before anything is read or written.
 * Where this Chrome cannot limit storage.local, refresh tokens live in storage.session instead: the tester then
 * reconnects after a browser restart, but no token is ever readable by a page script.
 */
export async function initSecrets(): Promise<boolean> {
  try {
    await chrome.storage.session.setAccessLevel?.({ accessLevel: 'TRUSTED_CONTEXTS' })
    if (typeof chrome.storage.local.setAccessLevel !== 'function') return (localProtected = false)
    await chrome.storage.local.setAccessLevel({ accessLevel: 'TRUSTED_CONTEXTS' })
    return (localProtected = true)
  } catch {
    return (localProtected = false)
  }
}

type Where = { id: string; sessionOnly: boolean }
const areaOf = (p: Where) => (p.sessionOnly || !localProtected ? chrome.storage.session : chrome.storage.local)

export async function getRefresh(p: Where): Promise<string | null> {
  const v = (await areaOf(p).get(refreshKey(p.id)))[refreshKey(p.id)]
  return typeof v === 'string' ? v : null
}

export async function setRefresh(p: Where, token: string | null): Promise<void> {
  // A profile may switch areas: never leave a copy in the other one.
  const other = areaOf(p) === chrome.storage.session ? chrome.storage.local : chrome.storage.session
  await other.remove(refreshKey(p.id))
  if (token) await areaOf(p).set({ [refreshKey(p.id)]: token })
  else await areaOf(p).remove(refreshKey(p.id))
}

export type Access = { token: string; expiresAt: number }

export async function getAccess(id: string): Promise<Access | null> {
  const v = (await chrome.storage.session.get(accessKey(id)))[accessKey(id)] as Access | undefined
  return v && typeof v.token === 'string' ? v : null
}

export async function setAccess(id: string, a: Access | null): Promise<void> {
  if (a) await chrome.storage.session.set({ [accessKey(id)]: a })
  else await chrome.storage.session.remove(accessKey(id))
}
