import { PublicConfig, type SettingKey } from '@yoda/shared'
import { describe, expect, it } from 'vitest'
import { buildApp, type AppDeps } from '../src/app.js'
import type { Db } from '../src/db/client.js'
import { buildPublicConfig, etagMatches, funModeCache, keycloakFromIssuer, keycloakMismatch, setupState } from '../src/routes/public-config.js'
import type { SettingsStore } from '../src/settings/store.js'
import { localJwks, signToken } from './jwt.js'
import { testConfig } from './helpers.js'

// GET /public-config without a database: a fake settings store and a fake fun-mode row. The database-backed
// store is covered in admin-settings.test.ts (saving the portal settings) and settings-store.test.ts.

const SECRETS = { 'smtp.password': 'smtp-password-value-1234', 'gitlab.token': 'glpat-secret-value-5678', 'ai.anthropicApiKey': 'sk-ant-secret-9012' }

function fakeSettings(values: Partial<Record<SettingKey, unknown>>, opts: { env?: SettingKey[]; setupDone?: boolean; recovery?: boolean } = {}) {
  return {
    get: (k: SettingKey) => values[k],
    fromEnv: (k: SettingKey) => (opts.env ?? []).includes(k),
    setupDone: opts.setupDone ?? false,
    recovery: opts.recovery ?? false,
  } as unknown as SettingsStore
}

const funDb = (on: boolean | Error) =>
  ({
    select: () => ({
      from: () => ({
        where: async () => {
          if (on instanceof Error) throw on
          return [{ funMode: on }]
        },
      }),
    }),
  }) as unknown as Db

const KC = 'https://sso.example.org/auth/realms/hospital'

async function app(over: Partial<AppDeps> = {}) {
  const deps = { config: testConfig(), db: funDb(true), jwks: localJwks, bus: {}, storage: {}, ai: {}, jobs: {}, gitlab: null, ...over } as unknown as AppDeps
  return buildApp(deps)
}

describe('public config helpers', () => {
  it('derives the Keycloak url and realm from the issuer', () => {
    expect(keycloakFromIssuer(KC)).toEqual({ url: 'https://sso.example.org/auth', realm: 'hospital' })
    expect(keycloakFromIssuer('http://localhost:8080/realms/yoda/')).toEqual({ url: 'http://localhost:8080', realm: 'yoda' })
    expect(keycloakFromIssuer('https://login.example.org')).toBeNull()
    expect(keycloakFromIssuer(undefined)).toBeNull()
  })

  it('reports setup required only with no finished setup, no env issuer and no dev skip', () => {
    expect(setupState({}, fakeSettings({}))).toBe('required')
    expect(setupState({}, fakeSettings({}, { setupDone: true }))).toBe('done')
    expect(setupState({ oidcIssuer: KC }, fakeSettings({}, { env: ['oidc.issuer'] }))).toBe('done')
    // An issuer saved mid-wizard does not finish setup.
    expect(setupState({ oidcIssuer: KC }, fakeSettings({}))).toBe('required')
    expect(setupState({ devSkipSetup: true }, fakeSettings({}))).toBe('done')
    expect(setupState({}, undefined)).toBe('required')
    expect(setupState({ oidcIssuer: KC }, undefined)).toBe('done')
  })

  it('names the NUXT_PUBLIC_KEYCLOAK_* variables that disagree with the issuer (§6.4)', () => {
    const config = { oidcIssuer: KC, oidcClientId: 'yoda-portal' }
    expect(keycloakMismatch({}, config)).toEqual([])
    expect(keycloakMismatch({ NUXT_PUBLIC_KEYCLOAK_URL: 'https://sso.example.org/auth/', NUXT_PUBLIC_KEYCLOAK_REALM: 'hospital', NUXT_PUBLIC_KEYCLOAK_CLIENT_ID: 'yoda-portal' }, config)).toEqual([])
    expect(keycloakMismatch({ NUXT_PUBLIC_KEYCLOAK_URL: 'http://localhost:8080', NUXT_PUBLIC_KEYCLOAK_REALM: 'yoda', NUXT_PUBLIC_KEYCLOAK_CLIENT_ID: 'other' }, config)).toEqual([
      'NUXT_PUBLIC_KEYCLOAK_URL',
      'NUXT_PUBLIC_KEYCLOAK_REALM',
      'NUXT_PUBLIC_KEYCLOAK_CLIENT_ID',
    ])
    expect(keycloakMismatch({ NUXT_PUBLIC_KEYCLOAK_URL: 'http://localhost:8080' }, { oidcClientId: 'yoda-portal' })).toEqual([])
  })
})

describe('public config caching', () => {
  it('reads fun mode at most once per TTL, and does not cache a failure', async () => {
    let t = 0
    let calls = 0
    let fail = false
    const read = async () => {
      calls++
      if (fail) throw new Error('down')
      return true
    }
    const fun = funModeCache(read, { ttlMs: 5000, now: () => t })
    const db = {} as Db
    expect(await fun(db)).toBe(true)
    t = 4999
    expect(await fun(db)).toBe(true)
    expect(calls).toBe(1)
    t = 5000
    fail = true
    expect(await fun(db)).toBe(false)
    expect(await fun(db)).toBe(false)
    expect(calls).toBe(3)
  })

  it('matches If-None-Match lists, weak tags and *', () => {
    const tag = '"abc"'
    expect(etagMatches('"abc"', tag)).toBe(true)
    expect(etagMatches('W/"abc"', tag)).toBe(true)
    expect(etagMatches('"x", W/"abc" ', tag)).toBe(true)
    expect(etagMatches('*', tag)).toBe(true)
    expect(etagMatches('"abcd"', tag)).toBe(false)
    expect(etagMatches(undefined, tag)).toBe(false)
  })
})

describe('buildPublicConfig', () => {
  it('serves the org, links, sign-in and setup state from the settings', async () => {
    const settings = fakeSettings(
      { 'org.name': 'โรงพยาบาลตัวอย่าง', 'org.nameEn': 'Example hospital', 'org.line': 'IT department', 'org.defaultLocale': 'en', 'org.runnerDocsUrl': 'https://docs.example.org/runners', 'line.addFriendUrl': 'https://line.example.org/add', ...SECRETS },
      { env: ['oidc.issuer'], recovery: true },
    )
    const pc = await buildPublicConfig({ config: { ...testConfig(), oidcIssuer: KC, oidcClientId: 'yoda-portal' }, settings, db: funDb(true) })
    expect(pc).toEqual({
      oidc: { url: 'https://sso.example.org/auth', realm: 'hospital', clientId: 'yoda-portal' },
      org: { name: 'โรงพยาบาลตัวอย่าง', nameEn: 'Example hospital', line: 'IT department', defaultLocale: 'en' },
      runnerDocsUrl: 'https://docs.example.org/runners',
      line: { addFriendUrl: 'https://line.example.org/add' },
      funMode: true,
      setup: 'done',
      recovery: true,
      recoveryForced: false,
      version: '1.0.0',
    })
  })

  it('falls back to the registry defaults without a store, and to fun mode off when the database fails', async () => {
    const { oidcIssuer: _i, ...config } = testConfig()
    const pc = await buildPublicConfig({ config: { ...config, devSkipSetup: false }, settings: undefined, db: funDb(new Error('down')) })
    expect(pc).toMatchObject({
      oidc: null,
      org: { name: null, nameEn: null, line: null, defaultLocale: 'th' },
      runnerDocsUrl: 'https://github.com/tantee/yoda#runners',
      line: { addFriendUrl: null },
      funMode: false,
      setup: 'required',
      recovery: false,
    })
  })
})

describe('GET /public-config', () => {
  it('is public, carries no secret, and revalidates with an ETag', async () => {
    const settings = fakeSettings({ 'org.name': 'Example hospital', ...SECRETS }, { setupDone: true })
    const a = await app({ settings, config: { ...testConfig(), oidcIssuer: KC, gitlabToken: SECRETS['gitlab.token'], smtpPassword: SECRETS['smtp.password'], anthropicApiKey: SECRETS['ai.anthropicApiKey'] } })
    const res = await a.inject({ url: '/public-config' })
    expect(res.statusCode).toBe(200)
    expect(res.headers['cache-control']).toBe('no-cache')
    const body = PublicConfig.parse(res.json())
    expect(body).toMatchObject({ setup: 'done', org: { name: 'Example hospital' }, oidc: { realm: 'hospital' } })
    for (const v of [...Object.values(SECRETS), testConfig().s3SecretKey, testConfig().databaseUrl]) expect(res.body).not.toContain(v)
    const again = await a.inject({ url: '/public-config', headers: { 'if-none-match': `"other", W/${String(res.headers.etag)}` } })
    expect(again.statusCode).toBe(304)
    expect(again.body).toBe('')
    await a.close()
  })
})

describe('setup mode: no OIDC issuer', () => {
  it('answers 503 setup_required for every portal route, while health, readiness and public config answer', async () => {
    const { oidcIssuer: _i, ...config } = testConfig()
    const a = await app({ config: { ...config, devSkipSetup: false } as AppDeps['config'] })
    const token = await signToken({ sub: 'u1', preferred_username: 'somchai' })
    for (const url of ['/me', '/projects', '/admin/settings', '/notifications', '/recovery/status', '/webhooks/gitlab']) {
      const res = await a.inject({ url, headers: { authorization: `Bearer ${token}` } })
      expect(res.statusCode, url).toBe(503)
      expect(res.json(), url).toEqual({ error: 'setup_required' })
    }
    expect((await a.inject({ url: '/me' })).json()).toEqual({ error: 'setup_required' })
    expect((await a.inject({ url: '/health' })).statusCode).toBe(200)
    const pc = await a.inject({ url: '/public-config' })
    expect(pc.json()).toMatchObject({ oidc: null, setup: 'required' })
    await a.close()
  })

  it('with setup done but no issuer (dev skip), refuses every bearer token with 503 not_configured', async () => {
    const { oidcIssuer: _i, ...config } = testConfig()
    const a = await app({ config: config as AppDeps['config'] })
    const token = await signToken({ sub: 'u1', preferred_username: 'somchai' })
    const me = await a.inject({ url: '/me', headers: { authorization: `Bearer ${token}` } })
    expect(me.statusCode).toBe(503)
    expect(me.json()).toEqual({ error: 'not_configured' })
    await a.close()
  })

  it('a set-up install answers 404 on every /setup route (nothing to probe)', async () => {
    const a = await app({ settings: fakeSettings({}, { setupDone: true }), config: { ...testConfig(), devSkipSetup: false } })
    for (const [method, url] of [['GET', '/setup/status'], ['POST', '/setup/session'], ['GET', '/setup/session'], ['POST', '/setup/admin'], ['POST', '/setup/totp']] as const) {
      const res = await a.inject({ method, url, payload: method === 'POST' ? {} : undefined })
      expect(res.statusCode, url).toBe(404)
    }
    await a.close()
  })
})
