import { beforeEach, describe, expect, it, vi } from 'vitest'
import { exchangeProfile, removeProfile, setDefault } from '../src/sw/profiles'
import { getAccess, getRefresh, initSecrets } from '../src/sw/secrets'
import { profiles } from '../src/sw/store'
import { installChrome, type FakeChrome } from './support/chrome'

let c: FakeChrome
const person = { id: '00000000-0000-4000-8000-000000000002', displayName: 'คุณคิวซี', isStaff: true }
const tokens = { accessToken: 'yoda_xt_1', expiresIn: 3600, refreshToken: 'yoda_xr_1', grantId: '00000000-0000-4000-8000-000000000001', person }

beforeEach(async () => {
  c = installChrome()
  vi.restoreAllMocks()
  await initSecrets()
})

describe('profiles', () => {
  it('the stored profile has no code or verifier, and the tokens live in the secret stores', async () => {
    const f = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify(tokens), { status: 200 }))
    const r = await exchangeProfile({ type: 'profile.exchange', origin: 'https://yoda.example.org', code: 'yoda_xc_code', verifier: 'v'.repeat(43), browserLabel: 'Chrome 131' })
    expect(r.ok).toBe(true)
    expect(JSON.parse(String(f.mock.calls[0]![1]!.body))).toEqual({ grantType: 'authorization_code', code: 'yoda_xc_code', codeVerifier: 'v'.repeat(43), extensionId: c.runtime.id })
    const [p] = await profiles()
    expect(p).toMatchObject({ url: 'https://yoda.example.org', isDefault: true, person, needsReconnect: false, grantId: tokens.grantId })
    const stored = JSON.stringify([...c.storage.local.data.entries()].filter(([k]) => k === 'profiles'))
    expect(stored).not.toContain('yoda_xc_code')
    expect(stored).not.toContain('v'.repeat(43))
    expect(stored).not.toContain('yoda_xr_1')
    expect(await getRefresh(p!)).toBe('yoda_xr_1')
    expect((await getAccess(p!.id))!.token).toBe('yoda_xt_1')
  })

  it('refuses a non-https origin', async () => {
    const r = await exchangeProfile({ type: 'profile.exchange', origin: 'http://yoda.example.org', code: 'c', verifier: 'v'.repeat(43), browserLabel: 'x' })
    expect(r).toEqual({ ok: false, error: 'invalid_origin' })
  })

  it('reconnecting the same Yoda keeps one profile and clears needsReconnect', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () => new Response(JSON.stringify(tokens), { status: 200 }))
    const m = { type: 'profile.exchange' as const, origin: 'https://yoda.example.org', code: 'c', verifier: 'v'.repeat(43), browserLabel: 'Chrome' }
    await exchangeProfile(m)
    await exchangeProfile(m)
    expect(await profiles()).toHaveLength(1)
  })

  it('removing a profile revokes and forgets tokens; exactly one default remains', async () => {
    const calls: string[] = []
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      calls.push(String(input))
      return String(input).endsWith('/token') ? new Response(JSON.stringify(tokens), { status: 200 }) : new Response(null, { status: 204 })
    })
    const a = await exchangeProfile({ type: 'profile.exchange', origin: 'https://a.example.org', code: 'c', verifier: 'v'.repeat(43), browserLabel: 'x' })
    const b = await exchangeProfile({ type: 'profile.exchange', origin: 'https://b.example.org', code: 'c', verifier: 'v'.repeat(43), browserLabel: 'x' })
    await setDefault(String(b.profileId))
    expect((await profiles()).filter((p) => p.isDefault).map((p) => p.id)).toEqual([b.profileId])
    await removeProfile(String(b.profileId))
    expect(calls).toContain('https://b.example.org/api/extension/revoke')
    const left = await profiles()
    expect(left.map((p) => [p.id, p.isDefault])).toEqual([[a.profileId, true]])
    expect(await getAccess(String(b.profileId))).toBeNull()
    expect(JSON.stringify([...c.storage.local.data])).not.toContain(`refresh:${b.profileId}`)
  })
})
