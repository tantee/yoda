import { describe, expect, it } from 'vitest'
import { loadConfig } from '../src/config.js'
import { buildApp } from '../src/app.js'
import { testDeps } from './helpers.js'

describe('loadConfig', () => {
  it('lists every missing variable', () => {
    expect(() => loadConfig({})).toThrow(/DATABASE_URL[\s\S]*OIDC_ISSUER/)
  })
  it('parses bootstrap admins and defaults', () => {
    const c = loadConfig({
      DATABASE_URL: 'postgres://x',
      OIDC_ISSUER: 'http://issuer.test',
      OIDC_CLIENT_ID: 'c',
      BOOTSTRAP_ADMINS: 'a, b',
    })
    expect(c.bootstrapAdmins).toEqual(['a', 'b'])
    expect(c.port).toBe(4000)
    expect(c.staffGroup).toBe('/it-dev')
  })
  it('strips trailing slashes from OIDC_ISSUER', () => {
    const c = loadConfig({
      DATABASE_URL: 'postgres://x',
      OIDC_ISSUER: 'http://kc.test/realms/hospital/',
      OIDC_CLIENT_ID: 'c',
    })
    expect(c.oidcIssuer).toBe('http://kc.test/realms/hospital')
  })
})

describe('app', () => {
  it('GET /health', async () => {
    const app = await buildApp(await testDeps())
    const res = await app.inject({ url: '/health' })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({ status: 'ok' })
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
