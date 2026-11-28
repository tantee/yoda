import { beforeEach, describe, expect, it, vi } from 'vitest'
import { refreshOnce } from '../src/sw/api'
import { updateProfileSettings } from '../src/sw/profiles'
import { deleteMineRule, mineRules, saveMineRule, validateRuleInput } from '../src/sw/rules'
import { getRefresh, initSecrets, setRefresh } from '../src/sw/secrets'
import { getProfile, saveProfile, type Profile } from '../src/sw/store'
import { installChrome } from './support/chrome'

const P = '00000000-0000-4000-8000-000000000001'
const profile = (o: Partial<Profile> = {}): Profile => ({
  id: 'p1', name: 'Yoda', colour: '#1f5fbf', url: 'https://yoda.example.org', isDefault: true, managed: false, sessionOnly: false, grantId: null, person: null, needsReconnect: false, ...o,
})

beforeEach(async () => {
  installChrome()
  await initSecrets()
  await saveProfile(profile())
})

describe('options: my rules', () => {
  it('validateRuleInput: a valid pattern, a known profile, never a bare * host', () => {
    expect(validateRuleInput({ pattern: 'http://localhost:3000/*', profileId: 'p1', projectId: P }, ['p1'])).toEqual([])
    expect(validateRuleInput({ pattern: 'HTTPS://App.Example.org/*', profileId: 'p1', projectId: null }, ['p1'])).toEqual([])
    expect(validateRuleInput({ pattern: 'app.example.org', profileId: 'p1', projectId: null }, ['p1'])).toContain('pattern_invalid')
    expect(validateRuleInput({ pattern: '*://*/*', profileId: 'p1', projectId: null }, ['p1'])).toContain('too_broad')
    expect(validateRuleInput({ pattern: 'https://a.example.org/*', profileId: 'zz', projectId: null }, ['p1'])).toContain('profile_unknown')
  })

  it('saves, edits and deletes my rules; the pattern is normalised and the order kept', async () => {
    const a = await saveMineRule({ pattern: 'HTTP://LocalHost:3000/*', profileId: 'p1', projectId: P, environment: 'dev' })
    expect(a).toMatchObject({ ok: true })
    const b = await saveMineRule({ pattern: 'https://app.example.org/*', profileId: 'p1', projectId: null, environment: null })
    let list = await mineRules()
    expect(list.map((r) => r.pattern)).toEqual(['http://localhost:3000/*', 'https://app.example.org/*'])
    expect(list.map((r) => r.order)).toEqual([0, 1])
    expect(list.every((r) => r.source === 'mine' && r.production === false)).toBe(true)
    const id = (a as { rule: { id: string } }).rule.id
    await saveMineRule({ id, pattern: 'http://localhost:5173/*', profileId: 'p1', projectId: P, environment: 'dev' })
    list = await mineRules()
    expect(list[0]).toMatchObject({ id, pattern: 'http://localhost:5173/*', order: 0 })
    expect(await deleteMineRule((b as { rule: { id: string } }).rule.id)).toEqual({ ok: true })
    expect((await mineRules()).map((r) => r.id)).toEqual([id])
  })

  it('refuses an invalid rule', async () => {
    expect(await saveMineRule({ pattern: 'https://*/*', profileId: 'p1', projectId: null, environment: null })).toEqual({ ok: false, errors: ['too_broad'] })
  })

  it('locked rules cannot be edited or deleted through the store API', async () => {
    for (const id of ['yoda:p1:0', 'policy:0']) {
      expect(await saveMineRule({ id, pattern: 'https://app.example.org/*', profileId: 'p1', projectId: null, environment: null })).toEqual({ ok: false, errors: ['locked'] })
      expect(await deleteMineRule(id)).toEqual({ ok: false, error: 'locked' })
    }
    expect(await mineRules()).toEqual([])
  })

  it('removing an origin also removes rules that need it for capture: none in C (a no-op)', async () => {
    await saveMineRule({ pattern: 'http://localhost:3000/*', profileId: 'p1', projectId: P, environment: null })
    await chrome.permissions.remove({ origins: ['http://localhost/*'] })
    expect(await mineRules()).toHaveLength(1)
  })
})

describe('options: profile settings', () => {
  it('colour and default are saved; a managed profile keeps its policy', async () => {
    await saveProfile(profile({ id: 'p2', isDefault: false, url: 'https://yoda-test.example.org' }))
    await updateProfileSettings('p2', { colour: '#b3261e', isDefault: true })
    expect(await getProfile('p2')).toMatchObject({ colour: '#b3261e', isDefault: true })
    expect((await getProfile('p1'))!.isDefault).toBe(false)
    await saveProfile(profile({ id: 'p3', managed: true, isDefault: false, url: 'https://yoda-managed.example.org' }))
    expect(await updateProfileSettings('p3', { sessionOnly: true })).toEqual({ ok: false, error: 'managed' })
  })

  it('"sign out when the browser closes" moves the refresh token to session storage, and back', async () => {
    await setRefresh(profile(), 'yoda_xr_1')
    await updateProfileSettings('p1', { sessionOnly: true })
    const p = (await getProfile('p1'))!
    expect(p.sessionOnly).toBe(true)
    expect(await getRefresh(p)).toBe('yoda_xr_1')
    expect(JSON.stringify([...(chrome.storage.local as unknown as { data: Map<string, unknown> }).data.entries()])).not.toContain('yoda_xr_1')
    await updateProfileSettings('p1', { sessionOnly: false })
    expect(await getRefresh((await getProfile('p1'))!)).toBe('yoda_xr_1')
  })

  it('an invalid colour is refused', async () => {
    expect(await updateProfileSettings('p1', { colour: 'red; background:url(x)' })).toEqual({ ok: false, error: 'invalid' })
  })

  it('switching sign-out-on-close while a refresh runs keeps the rotated token, in the new area only', async () => {
    await setRefresh(profile(), 'yoda_xr_old')
    let answer!: (r: Response) => void
    vi.spyOn(globalThis, 'fetch').mockImplementation(() => new Promise<Response>((r) => (answer = r)))
    const refreshing = refreshOnce('p1')
    await new Promise((r) => setTimeout(r, 0))
    const moving = updateProfileSettings('p1', { sessionOnly: true })
    answer(new Response(JSON.stringify({ accessToken: 'yoda_xt_2', expiresIn: 3600, refreshToken: 'yoda_xr_new', grantId: '00000000-0000-4000-8000-000000000009', person: { id: P, displayName: 'x', isStaff: true } }), { status: 200 }))
    expect(await refreshing).toBe(true)
    await moving
    const p = (await getProfile('p1'))!
    expect(p.sessionOnly).toBe(true)
    expect(await getRefresh(p)).toBe('yoda_xr_new')
    expect(JSON.stringify([...(chrome.storage.local as unknown as { data: Map<string, unknown> }).data.entries()])).not.toContain('yoda_xr_')
    vi.restoreAllMocks()
  })
})
