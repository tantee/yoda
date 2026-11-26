import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { loadConfig } from '../src/config.js'
import { buildApp } from '../src/app.js'
import { jwksUrl, remoteJwks } from '../src/auth/jwks.js'
import { readiness } from '../src/readiness.js'
import { SettingsStore } from '../src/settings/store.js'
import { resetDb, testDeps } from './helpers.js'
import { signToken, testJwksDocument, TEST_ISSUER } from './jwt.js'

const VERSION = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version as string

const baseEnv = {
  DATABASE_URL: 'postgres://x',
  OIDC_ISSUER: 'http://issuer.test',
  OIDC_CLIENT_ID: 'c',
  S3_ACCESS_KEY: 'k',
  S3_SECRET_KEY: 's',
}

describe('loadConfig', () => {
  it('lists every missing variable', () => {
    expect(() => loadConfig({})).toThrow(/DATABASE_URL[\s\S]*S3_ACCESS_KEY[\s\S]*S3_SECRET_KEY/)
  })
  it('starts without sign-in configured (setup mode): OIDC_ISSUER is optional, the client id defaults', () => {
    const { OIDC_ISSUER: _i, OIDC_CLIENT_ID: _c, ...rest } = baseEnv
    expect(loadConfig(rest)).toMatchObject({ oidcIssuer: undefined, oidcClientId: 'yoda-portal' })
    expect(loadConfig({ ...rest, OIDC_ISSUER: '', OIDC_CLIENT_ID: '', PORTAL_URL: '' })).toMatchObject({ oidcIssuer: undefined, oidcClientId: 'yoda-portal', portalUrl: 'http://localhost:3000' })
    expect(() => loadConfig({ ...rest, OIDC_ISSUER: 'not a url' })).toThrow(/OIDC_ISSUER/)
  })
  it('reads YODA_DEV_SKIP_SETUP', () => {
    expect(loadConfig(baseEnv).devSkipSetup).toBe(false)
    expect(loadConfig({ ...baseEnv, YODA_DEV_SKIP_SETUP: 'true' }).devSkipSetup).toBe(true)
    expect(() => loadConfig({ ...baseEnv, YODA_DEV_SKIP_SETUP: 'yes' })).toThrow(/YODA_DEV_SKIP_SETUP/)
  })
  it('parses bootstrap admins and defaults', () => {
    const c = loadConfig({
      ...baseEnv,
      BOOTSTRAP_ADMINS: 'a, b',
    })
    expect(c.bootstrapAdmins).toEqual(['a', 'b'])
    expect(c.port).toBe(4000)
    expect(c.staffGroup).toBe('/it-dev')
  })
  it('strips trailing slashes from OIDC_ISSUER', () => {
    const c = loadConfig({
      ...baseEnv,
      OIDC_ISSUER: 'http://kc.test/realms/hospital/',
    })
    expect(c.oidcIssuer).toBe('http://kc.test/realms/hospital')
  })
  it('applies AI and S3 defaults', () => {
    const c = loadConfig(baseEnv)
    expect(c.aiModelDraft).toBe('anthropic:claude-opus-5-5')
    expect(c.aiModelFast).toBe('anthropic:claude-haiku-5-5')
    expect(c.aiEmbeddingModel).toBeUndefined()
    expect(c.s3Endpoint).toBe('http://localhost:9000')
    expect(c.s3Region).toBe('us-east-1')
    expect(c.s3Bucket).toBe('yoda')
    expect(c.aiWorkers).toBe(2)
    expect(c.dailyTaskCap).toBe(8)
    expect(loadConfig({ ...baseEnv, DAILY_TASK_CAP: '3' }).dailyTaskCap).toBe(3)
  })
  it('configures GitLab', () => {
    const c = loadConfig(baseEnv)
    expect(c.gitlabUrl).toBeUndefined()
    expect(c.gitlabToken).toBeUndefined()
    expect(c.gitlabWebhookSecret).toBeUndefined()
    expect(c.portalUrl).toBe('http://localhost:3000')
    const g = loadConfig({ ...baseEnv, GITLAB_URL: 'http://gl.test/', GITLAB_TOKEN: 't', GITLAB_WEBHOOK_SECRET: 'x'.repeat(16), PORTAL_URL: 'http://p.test/' })
    expect(g.gitlabUrl).toBe('http://gl.test')
    expect(g.portalUrl).toBe('http://p.test')
    expect(loadConfig({ ...baseEnv, GITLAB_URL: '', GITLAB_WEBHOOK_SECRET: '' }).gitlabUrl).toBeUndefined()
    expect(() => loadConfig({ ...baseEnv, GITLAB_WEBHOOK_SECRET: 'x'.repeat(10) })).toThrow(/GITLAB_WEBHOOK_SECRET/)
  })
  it('configures runners', () => {
    const c = loadConfig(baseEnv)
    expect(c.runnerLeaseSeconds).toBe(600)
    expect(c.mcpEnabled).toBe(true)
    expect(loadConfig({ ...baseEnv, RUNNER_LEASE_SECONDS: '180', MCP_ENABLED: 'false' })).toMatchObject({ runnerLeaseSeconds: 180, mcpEnabled: false })
    // At least 3 minutes, so a heartbeat a minute leaves room for a missed one.
    expect(() => loadConfig({ ...baseEnv, RUNNER_LEASE_SECONDS: '120' })).toThrow(/RUNNER_LEASE_SECONDS/)
    expect(() => loadConfig({ ...baseEnv, MCP_ENABLED: 'yes' })).toThrow(/MCP_ENABLED/)
  })
  it('configures the JWKS URL and migrations on start', () => {
    const c = loadConfig(baseEnv)
    expect(c.oidcJwksUrl).toBeUndefined()
    expect(c.migrateOnStart).toBe(true)
    const p = loadConfig({ ...baseEnv, OIDC_JWKS_URL: 'http://kc.internal.test/certs', MIGRATE_ON_START: 'false' })
    expect(p).toMatchObject({ oidcJwksUrl: 'http://kc.internal.test/certs', migrateOnStart: false })
    expect(loadConfig({ ...baseEnv, OIDC_JWKS_URL: '', MIGRATE_ON_START: '' })).toMatchObject({ oidcJwksUrl: undefined, migrateOnStart: true })
    expect(() => loadConfig({ ...baseEnv, MIGRATE_ON_START: 'yes' })).toThrow(/MIGRATE_ON_START/)
    expect(() => loadConfig({ ...baseEnv, OIDC_JWKS_URL: 'not a url' })).toThrow(/OIDC_JWKS_URL/)
  })
  it('requires S3 credentials', () => {
    const { S3_ACCESS_KEY: _a, S3_SECRET_KEY: _s, ...rest } = baseEnv
    expect(() => loadConfig(rest)).toThrow(/S3_ACCESS_KEY/)
  })
  it('validates provider:model strings', () => {
    expect(() => loadConfig({ ...baseEnv, AI_MODEL_DRAFT: 'claude-opus-5-5' })).toThrow(/AI_MODEL_DRAFT/)
    expect(loadConfig({ ...baseEnv, AI_MODEL_DRAFT: 'anthropic:claude-opus-5-5' }).aiModelDraft).toBe('anthropic:claude-opus-5-5')
    expect(loadConfig({ ...baseEnv, AI_EMBEDDING_MODEL: 'openai:text-embedding-3-small' }).aiEmbeddingModel).toBe('openai:text-embedding-3-small')
    expect(() => loadConfig({ ...baseEnv, AI_MODEL_FAST: 'gemini:x' })).toThrow(/AI_MODEL_FAST/)
  })
})

describe('app', () => {
  it('GET /health', async () => {
    const app = await buildApp(await testDeps())
    const res = await app.inject({ url: '/health' })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({ status: 'ok', version: VERSION })
    expect(VERSION).toBe('1.0.0')
    await app.close()
  })
  it('GET /health shows the master key state when the settings store is open', async () => {
    const deps = await testDeps()
    await resetDb(deps.db)
    const settings = await SettingsStore.open({ db: deps.db, env: {}, masterKey: { status: 'missing', reason: 'not set' }, log: { warn() {}, info() {} } })
    const app = await buildApp({ ...deps, settings })
    const res = await app.inject({ url: '/health' })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({ status: 'ok', version: VERSION, settings: { secrets: 'missing', recovery: false } })
    await app.close()
  })
  it('unexpected errors return a generic 500', async () => {
    const app = await buildApp(await testDeps())
    app.get('/boom', { config: { public: true } }, async () => {
      throw new Error('relation "secret_table" does not exist')
    })
    const res = await app.inject({ url: '/boom' })
    expect(res.statusCode).toBe(500)
    expect(res.json()).toEqual({ error: 'internal' })
    await app.close()
  })
})

describe('readiness', () => {
  it('GET /ready is public and 200 when the database, storage and queue are up', async () => {
    const app = await buildApp(await testDeps())
    const res = await app.inject({ url: '/ready' })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({ status: 'ok', checks: { db: 'ok', storage: 'ok', queue: 'ok' } })
    await app.close()
  })
  it('is 503 when storage is down, without echoing the error', async () => {
    const deps = await testDeps()
    const storage = { ...deps.storage, ping: async () => { throw new Error('connect ECONNREFUSED 10.1.2.3:9000 secret-bucket') } }
    const app = await buildApp({ ...deps, storage })
    const res = await app.inject({ url: '/ready' })
    expect(res.statusCode).toBe(503)
    expect(res.json()).toEqual({ status: 'unavailable', checks: { db: 'ok', storage: 'fail', queue: 'ok' } })
    expect(res.body).not.toMatch(/ECONNREFUSED|10\.1\.2\.3|secret-bucket/)
    await app.close()
  })
  it('a check that hangs fails after its timeout; a stopped queue fails', async () => {
    const deps = await testDeps()
    const started = Date.now()
    const r = await readiness(
      { ...deps, storage: { ...deps.storage, ping: () => new Promise(() => {}) }, jobs: { ...deps.jobs, started: () => false } },
      { timeoutMs: 50 },
    )
    expect(r).toEqual({ ok: false, checks: { db: 'ok', storage: 'fail', queue: 'fail' } })
    expect(Date.now() - started).toBeLessThan(1000)
  })
})

describe('OIDC_JWKS_URL', () => {
  it('defaults to the issuer certs endpoint', async () => {
    expect(jwksUrl({ oidcIssuer: 'http://kc.test/realms/r' })?.href).toBe('http://kc.test/realms/r/protocol/openid-connect/certs')
    expect(jwksUrl({ oidcIssuer: 'http://kc.test/realms/r', oidcJwksUrl: 'http://kc.internal.test/certs' })?.href).toBe('http://kc.internal.test/certs')
    // Setup mode: no issuer, no key source; every lookup fails.
    expect(jwksUrl({})).toBeNull()
    await expect(remoteJwks({})({ alg: 'RS256' }, {} as never)).rejects.toThrow(/not configured/)
  })
  it('keys come from the JWKS URL while the issuer is still checked against OIDC_ISSUER', async () => {
    const doc = JSON.stringify(await testJwksDocument())
    let fetched = 0
    const server = createServer((_req, res) => {
      fetched++
      res.setHeader('content-type', 'application/json')
      res.end(doc)
    })
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/certs`
    const deps = await testDeps()
    const config = { ...deps.config, oidcJwksUrl: url }
    const app = await buildApp({ ...deps, config, jwks: remoteJwks(config) })
    try {
      const ok = await app.inject({ url: '/me', headers: { authorization: `Bearer ${await signToken({ sub: 'jwks-user', preferred_username: 'jwksuser' })}` } })
      expect(ok.statusCode).toBe(200)
      expect(fetched).toBeGreaterThan(0)
      expect(TEST_ISSUER).not.toBe(url)
      const wrongIss = await app.inject({ url: '/me', headers: { authorization: `Bearer ${await signToken({ sub: 'jwks-user', preferred_username: 'jwksuser', iss: url })}` } })
      expect(wrongIss.statusCode).toBe(401)
    } finally {
      await app.close()
      await new Promise((r) => server.close(r))
    }
  })
})
