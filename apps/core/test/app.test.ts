import { describe, expect, it } from 'vitest'
import { loadConfig } from '../src/config.js'
import { buildApp } from '../src/app.js'
import { testDeps } from './helpers.js'

const baseEnv = {
  DATABASE_URL: 'postgres://x',
  OIDC_ISSUER: 'http://issuer.test',
  OIDC_CLIENT_ID: 'c',
  S3_ACCESS_KEY: 'k',
  S3_SECRET_KEY: 's',
}

describe('loadConfig', () => {
  it('lists every missing variable', () => {
    expect(() => loadConfig({})).toThrow(/DATABASE_URL[\s\S]*OIDC_ISSUER/)
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
