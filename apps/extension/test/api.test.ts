import { beforeEach, describe, expect, it, vi } from 'vitest'
import { checkVersion, refreshOnce, yodaFetch } from '../src/sw/api'
import { getAccess, getRefresh, initSecrets, setAccess, setRefresh } from '../src/sw/secrets'
import { deleteProfile, getProfile, saveProfile, type Profile } from '../src/sw/store'
import { installChrome } from './support/chrome'

const profile: Profile = {
  id: 'p1',
  name: 'Yoda',
  colour: '#1F5FBF',
  url: 'https://yoda.example.org',
  isDefault: true,
  managed: false,
  sessionOnly: false,
  grantId: '00000000-0000-4000-8000-000000000001',
  person: { id: '00000000-0000-4000-8000-000000000002', displayName: 'QC', isStaff: true },
  needsReconnect: false,
}
const tokens = (n: number) => ({ accessToken: `yoda_xt_${n}`, expiresIn: 3600, refreshToken: `yoda_xr_${n}`, grantId: profile.grantId, person: profile.person })

beforeEach(async () => {
  installChrome()
  vi.restoreAllMocks()
  await initSecrets()
  await saveProfile(profile)
  await setRefresh(profile, 'yoda_xr_0')
  await setAccess('p1', { token: 'yoda_xt_0', expiresAt: Date.now() + 3600_000 })
})

describe('yodaFetch and refresh', () => {
  it('adds the bearer and calls the Yoda origin', async () => {
    const f = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('{}', { status: 200 }))
    await yodaFetch('p1', '/api/extension/session')
    expect(f.mock.calls[0]![0]).toBe('https://yoda.example.org/api/extension/session')
    expect(new Headers(f.mock.calls[0]![1]!.headers).get('authorization')).toBe('Bearer yoda_xt_0')
  })

  it('three concurrent 401s cause one refresh', async () => {
    let refreshes = 0
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const url = String(input)
      if (url.endsWith('/api/extension/token')) {
        refreshes++
        await new Promise((r) => setTimeout(r, 20))
        return new Response(JSON.stringify(tokens(1)), { status: 200 })
      }
      const auth = new Headers(init?.headers).get('authorization')
      return new Response('{}', { status: auth === 'Bearer yoda_xt_1' ? 200 : 401 })
    })
    const res = await Promise.all([1, 2, 3].map(() => yodaFetch('p1', '/api/extension/session')))
    expect(res.map((r) => r.status)).toEqual([200, 200, 200])
    expect(refreshes).toBe(1)
    expect(await getRefresh(profile)).toBe('yoda_xr_1')
    expect((await getAccess('p1'))!.token).toBe('yoda_xt_1')
  })

  it('a revoked refresh sets needsReconnect, clears the tokens, keeps drafts, and does not retry', async () => {
    await chrome.storage.local.set({ 'draft-index': ['d1'] })
    const f = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      if (String(input).endsWith('/api/extension/token')) return new Response(JSON.stringify({ error: 'unauthorized', reason: 'revoked' }), { status: 401 })
      return new Response('{}', { status: 401 })
    })
    const res = await yodaFetch('p1', '/api/extension/session')
    expect(res.status).toBe(401)
    expect(f).toHaveBeenCalledTimes(2)
    expect((await getProfile('p1'))!.needsReconnect).toBe(true)
    expect(await getRefresh(profile)).toBeNull()
    expect(await getAccess('p1')).toBeNull()
    expect((await chrome.storage.local.get('draft-index'))['draft-index']).toEqual(['d1'])
    // No refresh token left: no further refresh attempt.
    expect(await refreshOnce('p1')).toBe(false)
    expect(f).toHaveBeenCalledTimes(2)
  })

  it('a profile removed while its refresh runs is not brought back, and its new tokens are not stored', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      if (String(input).endsWith('/api/extension/token')) {
        await deleteProfile('p1')
        return new Response(JSON.stringify(tokens(1)), { status: 200 })
      }
      return new Response('{}', { status: 401 })
    })
    expect(await refreshOnce('p1')).toBe(false)
    expect(await getProfile('p1')).toBeNull()
    expect(await getRefresh(profile)).toBe('yoda_xr_0')
  })

  it('with no token to be had, yodaFetch answers 401 without an unauthenticated request', async () => {
    await setAccess('p1', null)
    await setRefresh(profile, null)
    const f = vi.spyOn(globalThis, 'fetch')
    expect((await yodaFetch('p1', '/api/extension/session')).status).toBe(401)
    expect(f).not.toHaveBeenCalled()
  })

  it('a network failure during refresh keeps the tokens (the next call tries again)', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      if (String(input).endsWith('/api/extension/token')) throw new TypeError('offline')
      return new Response('{}', { status: 401 })
    })
    await expect(yodaFetch('p1', '/api/extension/session')).rejects.toThrow()
    expect(await getRefresh(profile)).toBe('yoda_xr_0')
    expect((await getProfile('p1'))!.needsReconnect).toBe(false)
  })
})

describe('checkVersion', () => {
  const s = (apiVersion: number, latest: string | null) => ({ apiVersion, latestExtension: latest ? { version: latest, zipUrl: 'x', crxUrl: null } : null })
  it('compares manifestVersion versions', () => {
    expect(checkVersion(s(1, '1.2.0'), '1.2.0')).toBe('ok')
    expect(checkVersion(s(1, '1.3.0'), '1.2.0')).toBe('update_available')
    expect(checkVersion(s(1, '1.2.0'), '1.2.0-rc.3')).toBe('update_available')
    expect(checkVersion(s(1, '1.2.0-rc.2'), '1.2.0')).toBe('ok')
    expect(checkVersion(s(1, null), '1.2.0')).toBe('ok')
  })
  it('refuses a four-part version (it wants version_name)', () => {
    expect(() => checkVersion(s(1, '1.2.0'), '1.2.0.1000')).toThrow()
  })
  it('apiVersion 2 gives api_too_new', () => {
    expect(checkVersion(s(2, '1.2.0'), '1.2.0')).toBe('api_too_new')
  })
})
