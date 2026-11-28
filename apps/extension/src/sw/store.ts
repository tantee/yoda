import type { ExtensionPerson } from '@yoda/shared'

/** One connected Yoda. Kept in storage.local (extension pages only); no tokens here (secrets.ts). */
export type Profile = {
  id: string
  name: string
  colour: string
  /** The Yoda origin, e.g. https://yoda.example.org. */
  url: string
  isDefault: boolean
  /** Set by policy (managed storage, phase 3): not removable by the tester. */
  managed: boolean
  /** "Sign out when the browser closes": the refresh token lives in storage.session. */
  sessionOnly: boolean
  grantId: string | null
  person: ExtensionPerson | null
  /** The grant ended (revoked, reused, expired or re-auth needed): the popup offers Reconnect. */
  needsReconnect: boolean
}

const KEY = 'profiles'

export async function profiles(): Promise<Profile[]> {
  const v = (await chrome.storage.local.get(KEY))[KEY]
  return Array.isArray(v) ? (v as Profile[]) : []
}

export async function getProfile(id: string): Promise<Profile | null> {
  return (await profiles()).find((p) => p.id === id) ?? null
}

/** Profile writes run one at a time (read-modify-write of one storage key). */
let queue: Promise<unknown> = Promise.resolve()
function serial<T>(fn: () => Promise<T>): Promise<T> {
  const next = queue.then(fn, fn)
  queue = next.catch(() => {})
  return next
}

/** Adds or replaces a profile; when it is the default, every other one stops being the default. */
export function saveProfile(p: Profile): Promise<void> {
  return serial(() => writeProfile(p))
}

async function writeProfile(p: Profile): Promise<void> {
  const list = (await profiles()).filter((x) => x.id !== p.id).map((x) => (p.isDefault ? { ...x, isDefault: false } : x))
  list.push(p)
  if (!list.some((x) => x.isDefault)) list[0]!.isDefault = true
  await chrome.storage.local.set({ [KEY]: list })
}

/** Patches a profile that still exists (a removed one is never brought back). */
export function updateProfile(id: string, patch: Partial<Profile>): Promise<Profile | null> {
  return serial(async () => {
    const p = await getProfile(id)
    if (!p) return null
    const next = { ...p, ...patch }
    await writeProfile(next)
    return next
  })
}

/** Removes a profile; exactly one default remains while any profile is left. */
export function deleteProfile(id: string): Promise<void> {
  return serial(async () => {
    const list = (await profiles()).filter((x) => x.id !== id)
    if (list.length && !list.some((x) => x.isDefault)) list[0] = { ...list[0]!, isDefault: true }
    await chrome.storage.local.set({ [KEY]: list })
  })
}
