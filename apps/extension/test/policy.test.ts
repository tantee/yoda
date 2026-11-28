import { readFileSync } from 'node:fs'
import { beforeEach, describe, expect, it } from 'vitest'
import { applyPolicy, Policy, readPolicy } from '../src/sw/policy'
import { policyRules } from '../src/sw/rules'
import { getRefresh, initSecrets, setRefresh } from '../src/sw/secrets'
import { getProfile, profiles, saveProfile, type Profile } from '../src/sw/store'
import { buildManifest } from '../src/manifest'
import { startClip } from '../src/sw/offscreen'
import { resolveUrl } from '../src/sw/rules'
import { updateProfileSettings } from '../src/sw/profiles'
import { installChrome } from './support/chrome'

const P = '00000000-0000-4000-8000-000000000001'
let managed: Record<string, unknown> = {}
const setManaged = (v: Record<string, unknown>) => {
  managed = v
}

beforeEach(async () => {
  installChrome()
  managed = {}
  ;(globalThis as unknown as { chrome: { storage: Record<string, unknown> } }).chrome.storage.managed = {
    get: async (k?: string | string[] | null) => (typeof k === 'string' ? (k in managed ? { [k]: managed[k] } : {}) : { ...managed }),
  }
  await initSecrets()
})

const own = (o: Partial<Profile> = {}): Profile => ({
  id: 'p1', name: 'Yoda', colour: '#1f5fbf', url: 'https://yoda.example.org', isDefault: true, managed: false, sessionOnly: false, grantId: null, person: null, needsReconnect: false, ...o,
})

describe('managed policy', () => {
  it('the schema file parses and matches the zod Policy', () => {
    const schema = JSON.parse(readFileSync(new URL('../public/managed-schema.json', import.meta.url), 'utf8')) as { type: string; properties: Record<string, { type: string; items?: { properties: Record<string, unknown> } }> }
    expect(schema.type).toBe('object')
    const shape = Policy.innerType().shape
    expect(Object.keys(schema.properties).sort()).toEqual(Object.keys(shape).sort())
    expect(Object.keys(schema.properties.instances!.items!.properties).sort()).toEqual(['default', 'name', 'url'])
    expect(Object.keys(schema.properties.rules!.items!.properties).sort()).toEqual(['environment', 'instance', 'pattern', 'production', 'projectId'])
    expect(schema.properties.allowVideo!.type).toBe('boolean')
    // The manifest points at it.
    expect((buildManifest({ yodaVersion: '1.2.0', publicKey: null, target: 'release' }) as { storage?: { managed_schema?: string } }).storage?.managed_schema).toBe('managed-schema.json')
  })

  it('defaults: video and buffer allowed, tokens kept across restarts, nothing pre-seeded', async () => {
    expect(await readPolicy()).toEqual({ policy: { instances: [], rules: [], allowVideo: true, allowBuffer: true, sessionOnly: false }, notice: null })
  })

  it('invalid policy is ignored with a notice', async () => {
    setManaged({ instances: [{ name: 'Yoda', url: 'ftp://yoda.example.org' }], allowVideo: 'no' })
    const r = await readPolicy()
    expect(r.policy).toEqual({ instances: [], rules: [], allowVideo: true, allowBuffer: true, sessionOnly: false })
    expect(r.notice).toBe('invalid_policy')
  })

  it('policy instances are locked and pre-seeded but still need Approve (no token from policy)', async () => {
    setManaged({ instances: [{ name: 'Yoda โรงพยาบาล', url: 'https://yoda.example.org/', default: true }] })
    await applyPolicy((await readPolicy()).policy)
    const [p] = await profiles()
    expect(p).toMatchObject({ name: 'Yoda โรงพยาบาล', url: 'https://yoda.example.org', managed: true, isDefault: true, needsReconnect: true, grantId: null })
    expect(await getRefresh(p!)).toBeNull()
    // Applying again keeps the one profile.
    await applyPolicy((await readPolicy()).policy)
    expect(await profiles()).toHaveLength(1)
  })

  it('an instance the tester already connected becomes managed and keeps its connection; one dropped from policy is unlocked', async () => {
    await saveProfile(own())
    await setRefresh(own(), 'yoda_xr_1')
    setManaged({ instances: [{ name: 'Yoda', url: 'https://yoda.example.org' }] })
    await applyPolicy((await readPolicy()).policy)
    expect(await getProfile('p1')).toMatchObject({ managed: true, needsReconnect: false })
    expect(await getRefresh((await getProfile('p1'))!)).toBe('yoda_xr_1')
    setManaged({})
    await applyPolicy((await readPolicy()).policy)
    expect((await getProfile('p1'))!.managed).toBe(false)
  })

  it('sessionOnly moves the refresh token to storage.session', async () => {
    await saveProfile(own())
    await setRefresh(own(), 'yoda_xr_1')
    setManaged({ sessionOnly: true })
    await applyPolicy((await readPolicy()).policy)
    const p = (await getProfile('p1'))!
    expect(p.sessionOnly).toBe(true)
    expect(await getRefresh(p)).toBe('yoda_xr_1')
    expect(JSON.stringify([...(chrome.storage.local as unknown as { data: Map<string, unknown> }).data.entries()])).not.toContain('yoda_xr_1')
  })

  it('policy rules become source policy, naming their instance by name or URL', async () => {
    await saveProfile(own())
    setManaged({
      instances: [{ name: 'Yoda', url: 'https://yoda.example.org' }],
      rules: [
        { pattern: 'https://his.example.org/*', instance: 'Yoda', projectId: P, production: true },
        { pattern: 'https://lis.example.org/*', instance: 'https://yoda.example.org', environment: 'uat' },
        { pattern: 'https://ris.example.org/*', instance: 'Unknown Yoda', production: true },
      ],
    })
    const rules = await policyRules()
    expect(rules.map((r) => [r.pattern, r.profileId, r.source, r.production])).toEqual([
      ['https://his.example.org/*', 'p1', 'policy', true],
      ['https://lis.example.org/*', 'p1', 'policy', false],
      // Its instance is not connected: it maps nothing, but its production mark still counts.
      ['https://ris.example.org/*', '', 'policy', true],
    ])
  })

  it('allowVideo false: no Record in the popup, and the worker refuses a clip', async () => {
    setManaged({ allowVideo: false })
    expect(await startClip({ tabId: 1, profileId: 'p1', maxSeconds: 30 })).toEqual({ ok: false, error: 'policy' })
    expect((await resolveUrl('https://uat.example.org/')).videoAllowed).toBe(false)
  })

  it('a forced sessionOnly cannot be switched off by the tester', async () => {
    await saveProfile(own({ sessionOnly: true }))
    setManaged({ sessionOnly: true })
    expect(await updateProfileSettings('p1', { sessionOnly: false })).toEqual({ ok: false, error: 'managed' })
  })
})
