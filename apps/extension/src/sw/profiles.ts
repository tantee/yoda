import { ExtensionTokenResponse, PublicConfig } from '@yoda/shared'
import type { Msg } from './messages'
import { setAccess, setRefresh } from './secrets'
import { deleteProfile, getProfile, profiles, saveProfile, updateProfile, type Profile } from './store'
import { normaliseYodaUrl } from '../connect/connect'
import { yodaFetch } from './api'
import { deleteDraftsOf } from '../drafts/db'
import { forgetYodaRules } from './rules'

const COLOURS = ['#1F5FBF', '#1D6B3A', '#7A4F00', '#4A3FA0', '#B3261E']

/** Exchanges an approved code for tokens and stores the profile (one per Yoda origin; reconnecting reuses it). */
export async function exchangeProfile(m: Extract<Msg, { type: 'profile.exchange' }>): Promise<{ ok: boolean; profileId?: string; error?: string }> {
  const n = normaliseYodaUrl(m.origin)
  if (!n.ok || n.origin !== m.origin) return { ok: false, error: 'invalid_origin' }
  const res = await fetch(`${m.origin}/api/extension/token`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ grantType: 'authorization_code', code: m.code, codeVerifier: m.verifier, extensionId: chrome.runtime.id }),
    signal: AbortSignal.timeout(15_000),
  })
  if (!res.ok) return { ok: false, error: 'exchange_failed' }
  const t = ExtensionTokenResponse.parse(await res.json())
  const list = await profiles()
  const existing = list.find((p) => p.url === m.origin)
  let name = new URL(m.origin).host
  try {
    const cfg = PublicConfig.safeParse(await (await fetch(`${m.origin}/api/public-config`, { signal: AbortSignal.timeout(10_000) })).json())
    const org = cfg.success ? (cfg.data.org.name ?? cfg.data.org.nameEn) : null
    if (org) name = org.slice(0, 120)
  } catch {
    // the host is a fine name
  }
  const profile: Profile = {
    id: existing?.id ?? crypto.randomUUID(),
    name: existing?.name ?? name,
    colour: existing?.colour ?? COLOURS[list.length % COLOURS.length]!,
    url: m.origin,
    isDefault: existing?.isDefault ?? list.length === 0,
    managed: existing?.managed ?? false,
    sessionOnly: existing?.sessionOnly ?? false,
    grantId: t.grantId,
    person: t.person,
    needsReconnect: false,
  }
  await saveProfile(profile)
  await setRefresh(profile, t.refreshToken)
  await setAccess(profile.id, { token: t.accessToken, expiresAt: Date.now() + t.expiresIn * 1000 })
  return { ok: true, profileId: profile.id }
}

/** Revokes the grant on Yoda (best effort), then forgets the profile and its tokens. */
export async function removeProfile(id: string): Promise<void> {
  const p = await getProfile(id)
  if (!p) return
  try {
    await yodaFetch(id, '/api/extension/revoke', { method: 'POST' })
  } catch {
    // Offline: the grant ends by itself (idle expiry), or in Connected browsers.
  }
  await setRefresh(p, null)
  await setAccess(id, null)
  await deleteProfile(id)
  // Its drafts (captures not yet sent) go with it.
  await deleteDraftsOf(id).catch(() => 0)
  await forgetYodaRules(id)
  // No other profile uses this origin (one per origin): its host permission goes too.
  await chrome.permissions.remove({ origins: [`${p.url}/*`] }).catch(() => false)
}

export async function setDefault(id: string): Promise<void> {
  await updateProfile(id, { isDefault: true })
}
