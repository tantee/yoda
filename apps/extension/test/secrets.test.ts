import { beforeEach, describe, expect, it } from 'vitest'
import { getAccess, getRefresh, initSecrets, setAccess, setRefresh } from '../src/sw/secrets'
import { installChrome, type FakeChrome } from './support/chrome'

let c: FakeChrome
beforeEach(() => {
  c = installChrome()
})

describe('secrets', () => {
  it('sessionOnly keeps the refresh token in storage.session; otherwise in storage.local, readable by extension pages only', async () => {
    await initSecrets()
    expect(c.storage.local.accessLevel).toBe('TRUSTED_CONTEXTS')
    expect(c.storage.session.accessLevel).toBe('TRUSTED_CONTEXTS')
    await setRefresh({ id: 'p1', sessionOnly: false }, 'yoda_xr_one')
    await setRefresh({ id: 'p2', sessionOnly: true }, 'yoda_xr_two')
    expect(JSON.stringify([...c.storage.local.data])).toContain('yoda_xr_one')
    expect(JSON.stringify([...c.storage.local.data])).not.toContain('yoda_xr_two')
    expect(JSON.stringify([...c.storage.session.data])).toContain('yoda_xr_two')
    expect(await getRefresh({ id: 'p1', sessionOnly: false })).toBe('yoda_xr_one')
    expect(await getRefresh({ id: 'p2', sessionOnly: true })).toBe('yoda_xr_two')
    await setRefresh({ id: 'p1', sessionOnly: false }, null)
    expect(await getRefresh({ id: 'p1', sessionOnly: false })).toBeNull()
  })

  it('access tokens live in storage.session only, with their expiry', async () => {
    await setAccess('p1', { token: 'yoda_xt_a', expiresAt: 1000 })
    expect(await getAccess('p1')).toEqual({ token: 'yoda_xt_a', expiresAt: 1000 })
    expect(JSON.stringify([...c.storage.local.data])).not.toContain('yoda_xt_a')
    await setAccess('p1', null)
    expect(await getAccess('p1')).toBeNull()
  })
})
