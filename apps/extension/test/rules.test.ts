import { beforeEach, describe, expect, it, vi } from 'vitest'
import { exchangeProfile } from '../src/sw/profiles'
import { allRules, MINE_KEY, resolveUrl, validateRuleInput, yodaRules } from '../src/sw/rules'
import { initSecrets } from '../src/sw/secrets'
import { profiles } from '../src/sw/store'
import { installChrome, type FakeChrome } from './support/chrome'

let c: FakeChrome
const P1 = '00000000-0000-4000-8000-000000000011'
const P2 = '00000000-0000-4000-8000-000000000012'
const person = { id: '00000000-0000-4000-8000-000000000002', displayName: 'คุณคิวซี', isStaff: true }
const tokens = { accessToken: 'yoda_xt_1', expiresIn: 3600, refreshToken: 'yoda_xr_1', grantId: '00000000-0000-4000-8000-000000000001', person }
const session = {
  apiVersion: 1,
  instance: { name: 'Yoda', publicUrl: 'https://yoda.example.org', version: '1.2.0' },
  latestExtension: null,
  person,
  projects: [
    { id: P1, name: 'OPD', noAi: false, kinds: ['defect'], repos: ['his/opd'] },
    { id: P2, name: 'Lab', noAi: false, kinds: ['defect'], repos: ['his/lab'] },
  ],
  limits: { maxFileBytes: 1, maxReportBytes: 1, maxFiles: 10, perRole: {} },
}
let mappings: unknown[] = []
let mappingCalls = 0

async function connect(): Promise<string> {
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
    const url = String(input)
    if (url.endsWith('/api/extension/token')) return new Response(JSON.stringify(tokens), { status: 200 })
    if (url.endsWith('/api/extension/mappings')) {
      mappingCalls++
      return new Response(JSON.stringify({ rules: mappings, ttlSeconds: 600 }), { status: 200 })
    }
    if (url.endsWith('/api/extension/session')) return new Response(JSON.stringify(session), { status: 200 })
    return new Response('{}', { status: 404 })
  })
  await exchangeProfile({ type: 'profile.exchange', origin: 'https://yoda.example.org', code: 'c', verifier: 'v'.repeat(43), browserLabel: 'x' })
  return (await profiles())[0]!.id
}

const yodaRule = (pattern: string, projectId: string, production = false) => ({ pattern, projectId, environment: null, production, source: 'app_url', build: null })

beforeEach(async () => {
  c = installChrome()
  vi.restoreAllMocks()
  mappings = []
  mappingCalls = 0
  await initSecrets()
})

describe('sw rules', () => {
  it("Yoda rules carry their own profile, and are cached for the ttl unless refreshed", async () => {
    const id = await connect()
    mappings = [yodaRule('https://app.example.org/*', P1)]
    const now = Date.now()
    const first = await yodaRules(id, { now })
    expect(first[0]).toMatchObject({ profileId: id, source: 'yoda', projectId: P1 })
    await yodaRules(id, { now: now + 60_000 })
    expect(mappingCalls).toBe(1)
    await yodaRules(id, { now: now + 601_000 })
    expect(mappingCalls).toBe(2)
    await yodaRules(id, { now: now + 602_000, refresh: true })
    expect(mappingCalls).toBe(3)
  })

  it('offline: the last known rules still apply', async () => {
    const id = await connect()
    mappings = [yodaRule('https://app.example.org/*', P1, true)]
    await yodaRules(id)
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new TypeError('offline'))
    expect((await yodaRules(id, { refresh: true }))[0]!.production).toBe(true)
  })

  it('a mine rule for a removed profile maps nothing', async () => {
    const id = await connect()
    await chrome.storage.local.set({ [MINE_KEY]: [{ id: 'm1', pattern: 'http://localhost/*', profileId: 'gone', projectId: P1, environment: null, production: false, source: 'mine', order: 0 }, { id: 'm2', pattern: 'http://localhost/*', profileId: id, projectId: P2, environment: null, production: false, source: 'mine', order: 1 }] })
    expect((await allRules()).map((r) => r.id)).toEqual(['m2'])
  })

  it('resolveUrl: a Yoda rule picks the project; production comes with it', async () => {
    const id = await connect()
    mappings = [yodaRule('https://app.example.org/*', P2, true)]
    const r = await resolveUrl('https://app.example.org/opd')
    expect(r).toMatchObject({ profileId: id, projectId: P2, via: 'rule', production: true })
  })

  it('resolveUrl: a rule naming a project outside its profile picks the profile but no project', async () => {
    await connect()
    mappings = [yodaRule('https://app.example.org/*', '00000000-0000-4000-8000-0000000000ff')]
    expect(await resolveUrl('https://app.example.org/')).toMatchObject({ projectId: null, via: null })
  })

  it("resolveUrl: no rule, the page's repo maps into the default profile", async () => {
    const id = await connect()
    const r = await resolveUrl('https://other.example.org/', { readBuild: async () => ({ repo: 'his/lab' }) })
    expect(r).toMatchObject({ profileId: id, projectId: P2, via: 'repo', production: false })
    expect(await resolveUrl('https://other.example.org/', { readBuild: async () => ({ repo: 'his/x' }) })).toMatchObject({ profileId: null, via: null })
  })

  it('validateRuleInput', () => {
    expect(validateRuleInput({ pattern: 'http://localhost:3000/*', profileId: 'a', projectId: null }, ['a'])).toEqual([])
    expect(validateRuleInput({ pattern: 'localhost', profileId: 'a', projectId: null }, ['a'])).toEqual(['pattern_invalid'])
    expect(validateRuleInput({ pattern: 'https://*/*', profileId: 'a', projectId: null }, ['a'])).toEqual(['too_broad'])
    expect(validateRuleInput({ pattern: 'https://app.example.org/*', profileId: 'b', projectId: null }, ['a'])).toEqual(['profile_unknown'])
  })
})
