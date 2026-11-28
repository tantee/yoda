import { randomUUID } from 'node:crypto'
import type { ExtensionMappings, ExtensionTokenResponse, Repo } from '@yoda/shared'
import type { FastifyInstance } from 'fastify'
import { eq } from 'drizzle-orm'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { deployEnvironments, projects } from '../src/db/schema.js'
import { productionRulesForPerson } from '../src/extension/mappings.js'
import { GitLabClient } from '../src/gitlab/client.js'
import { externalUrlPattern, syncEnvironments } from '../src/gitlab/environments.js'
import { handleWebhook, hookTime } from '../src/gitlab/webhook.js'
import { InlineJobQueue } from '../src/jobs/queue.js'
import { connectExtension, defectBody, makeProject, sampleReport, webm } from './defect-fixtures.js'
import { FakeGitLab, startFakeGitLab } from './fake-gitlab.js'
import { resetDb, testDb } from './helpers.js'
import { auth, login, makeApp, type Who } from './support.js'

let app: FastifyInstance
let fake: FakeGitLab
let jobs: InlineJobQueue
let admin: Who
let pm: Who
let qc: Who
let projectId: string
let repo: Repo

const SHA = 'a'.repeat(40)
const SHA2 = 'b'.repeat(40)

const deployment = (o: Record<string, unknown> = {}) => ({
  object_kind: 'deployment',
  status: 'success',
  status_changed_at: '2026-11-28 10:00:00 +0700',
  deployment_id: 15,
  environment: 'review/opd-12',
  environment_tier: 'development',
  environment_external_url: 'https://review-12.example.org/opd',
  project: { id: 11 },
  ref: 'feature/opd',
  short_sha: SHA.slice(0, 8),
  commit_url: `https://gitlab.example.org/dept/opd-web/-/commit/${SHA}`,
  ...o,
})

beforeEach(async () => {
  await resetDb(await testDb())
  fake = await startFakeGitLab()
  fake.addProject('dept/opd-web', 11)
  fake.environments.set(11, [
    {
      id: 1,
      name: 'production',
      external_url: 'https://opd.example.org',
      tier: 'production',
      last_deployment: { ref: 'main', sha: SHA2, status: 'success', created_at: '2026-11-27T01:00:00Z', updated_at: '2026-11-27T01:06:00Z', deployable: { finished_at: '2026-11-27T01:05:00Z' } },
    },
    { id: 2, name: 'review/opd-12', external_url: 'https://review-12.example.org/opd', tier: 'development', last_deployment: null },
    { id: 3, name: 'no-url', external_url: null, tier: 'testing', last_deployment: null },
  ])
  jobs = new InlineJobQueue({ ignore: ['draft-task', 'secretary-chat', 'secretary-event', 'discussion-brief', 'gitlab-issue-sync', 'gitlab-mr-effect', 'gitlab-mr-reconcile'] })
  app = await makeApp({ jobs, gitlab: new GitLabClient({ baseUrl: fake.url, token: 'fake-test-token', retryBaseMs: 1 }) })
  admin = await login(app, 'boss', { staff: true })
  pm = await login(app, 'pm', { staff: true })
  qc = await login(app, 'qc', { staff: true })
  projectId = await makeProject(app, admin, 'OPD', [
    [pm, ['PM']],
    [qc, ['QC']],
  ])
  const linked = await app.inject({ method: 'POST', url: `/projects/${projectId}/repos`, headers: auth(pm), payload: { path: 'dept/opd-web' } })
  expect(linked.statusCode, linked.body).toBe(201)
  repo = linked.json()
})
afterEach(async () => {
  await jobs.drain()
  await app.close()
  await fake.stop()
})

const envRows = async () => (await (await testDb()).select().from(deployEnvironments)).sort((a, b) => a.name.localeCompare(b.name))

describe('helpers', () => {
  it('externalUrlPattern', () => {
    expect(externalUrlPattern('https://review-12.example.org/app')).toBe('https://review-12.example.org/*')
    expect(externalUrlPattern('http://localhost:3000')).toBe('http://localhost:3000/*')
    expect(externalUrlPattern('HTTPS://OPD.Example.org/x?y')).toBe('https://opd.example.org/*')
    expect(externalUrlPattern('ftp://x.example.org')).toBeNull()
    expect(externalUrlPattern('https://user:pw@x.example.org')).toBeNull()
    expect(externalUrlPattern('not a url')).toBeNull()
    expect(externalUrlPattern(null)).toBeNull()
  })

  it('hookTime reads GitLab hook timestamps', () => {
    expect(hookTime('2026-11-28 10:00:00 +0700')?.toISOString()).toBe('2026-11-28T03:00:00.000Z')
    expect(hookTime('2026-11-28 03:00:00 UTC')?.toISOString()).toBe('2026-11-28T03:00:00.000Z')
    expect(hookTime('2026-11-28T03:00:00Z')?.toISOString()).toBe('2026-11-28T03:00:00.000Z')
    expect(hookTime('nope')).toBeNull()
  })
})

describe('environments', () => {
  it('a deployment webhook upserts the environment and ignores an older event', async () => {
    await jobs.drain()
    await (await testDb()).delete(deployEnvironments)
    expect(await handleWebhook(app.deps, randomUUID(), deployment(), null)).toEqual({ ok: true })
    let [row] = (await envRows()).filter((r) => r.name === 'review/opd-12')
    expect(row).toMatchObject({ repoId: repo.id, externalUrl: 'https://review-12.example.org/opd', tier: 'development', ref: 'feature/opd', sha: SHA, status: 'success' })
    expect(row!.deployedAt?.toISOString()).toBe('2026-11-28T03:00:00.000Z')

    // An older delivery arriving late changes nothing.
    await handleWebhook(app.deps, randomUUID(), deployment({ status_changed_at: '2026-11-27 10:00:00 +0700', ref: 'old', commit_url: null, short_sha: 'deadbeef' }), null)
    ;[row] = (await envRows()).filter((r) => r.name === 'review/opd-12')
    expect(row).toMatchObject({ ref: 'feature/opd', sha: SHA })

    // A newer one wins.
    await handleWebhook(app.deps, randomUUID(), deployment({ status_changed_at: '2026-11-29 10:00:00 +0700', ref: 'feature/opd-2', commit_url: null, short_sha: 'cafebabe' }), null)
    ;[row] = (await envRows()).filter((r) => r.name === 'review/opd-12')
    expect(row).toMatchObject({ ref: 'feature/opd-2', sha: 'cafebabe' })

    // Failed or running deployments, and unknown projects, are ignored.
    expect(await handleWebhook(app.deps, randomUUID(), deployment({ status: 'failed', environment: 'x' }), null)).toEqual({ ok: true, ignored: true })
    expect(await handleWebhook(app.deps, randomUUID(), deployment({ project: { id: 999 }, environment: 'y' }), null)).toEqual({ ok: true, ignored: true })
    expect((await envRows()).map((r) => r.name)).toEqual(['review/opd-12'])
  })

  it('sync reads environments and their last deployment from the fake GitLab (also on repo link)', async () => {
    // Linking the repo queued the sync.
    await jobs.drain()
    const rows = await envRows()
    expect(rows.map((r) => [r.name, r.externalUrl, r.tier, r.sha])).toEqual([
      ['no-url', null, 'testing', null],
      ['production', 'https://opd.example.org', 'production', SHA2],
      ['review/opd-12', 'https://review-12.example.org/opd', 'development', null],
    ])
    expect(rows.find((r) => r.name === 'production')!.deployedAt?.toISOString()).toBe('2026-11-27T01:05:00.000Z')
    // A second sync is idempotent.
    expect(await syncEnvironments(app.deps, repo.id)).toBe(3)
    expect(await envRows()).toHaveLength(3)
  })

  it('a sync never moves a deployment back, but takes the current URL; stopped environments are pruned', async () => {
    await jobs.drain()
    // A newer webhook than the API's last deployment for production.
    await handleWebhook(app.deps, randomUUID(), deployment({ environment: 'production', environment_tier: 'production', environment_external_url: 'https://opd.example.org', status_changed_at: '2026-11-28 10:00:00 +0700' }), null)
    // GitLab: the production URL changed (no new deployment), and review/opd-12 was stopped.
    fake.environments.set(11, [{ ...fake.environments.get(11)![0]!, external_url: 'https://opd2.example.org' }, fake.environments.get(11)![2]!])
    await syncEnvironments(app.deps, repo.id)
    const rows = await envRows()
    expect(rows.map((r) => r.name)).toEqual(['no-url', 'production'])
    expect(rows[1]).toMatchObject({ sha: SHA, externalUrl: 'https://opd2.example.org' })
  })

  it('reads every page of environments', async () => {
    await jobs.drain()
    fake.environments.set(11, Array.from({ length: 230 }, (_, i) => ({ id: 100 + i, name: `review/${i}`, external_url: `https://r${i}.example.org`, tier: 'development', last_deployment: null })))
    expect(await syncEnvironments(app.deps, repo.id)).toBe(230)
    expect(await envRows()).toHaveLength(230)
  })

  it('the nightly job syncs every linked repo', async () => {
    await jobs.drain()
    await (await testDb()).delete(deployEnvironments)
    await jobs.runScheduled('gitlab-env-sync')
    expect(await envRows()).toHaveLength(3)
  })
})

describe('GET /extension/mappings', () => {
  let tokens: ExtensionTokenResponse
  beforeEach(async () => {
    await jobs.drain()
    tokens = await connectExtension(app, qc)
  })
  const mappings = (t: ExtensionTokenResponse) => app.inject({ url: '/extension/mappings', headers: { authorization: `Bearer ${t.accessToken}` } })

  it('returns app URL and GitLab rules only for member projects, with production from the tier', async () => {
    await app.inject({ method: 'PUT', url: `/projects/${projectId}/app-urls`, headers: auth(pm), payload: { urls: [{ pattern: 'http://localhost:3000/*', environment: 'local', production: false }] } })
    const other = await makeProject(app, admin, 'Lab', [[pm, ['PM']]])
    await app.inject({ method: 'PUT', url: `/projects/${other}/app-urls`, headers: auth(pm), payload: { urls: [{ pattern: 'https://lab.example.org/*', production: true }] } })

    const res = await mappings(tokens)
    expect(res.statusCode, res.body).toBe(200)
    const body = res.json() as ExtensionMappings
    expect(body.ttlSeconds).toBe(600)
    expect(body.rules).toEqual([
      { pattern: 'http://localhost:3000/*', projectId, environment: 'local', production: false, source: 'app_url', build: null },
      {
        pattern: 'https://opd.example.org/*',
        projectId,
        environment: 'production',
        production: true,
        source: 'gitlab',
        build: { repo: 'dept/opd-web', ref: 'main', sha: SHA2, deployedAt: '2026-11-27T01:05:00.000Z' },
      },
      {
        pattern: 'https://review-12.example.org/*',
        projectId,
        environment: 'review/opd-12',
        production: false,
        source: 'gitlab',
        build: { repo: 'dept/opd-web', ref: null, sha: null, deployedAt: null },
      },
    ])
    // The PM is a member of both projects: the Lab rule is theirs, never QC's.
    const pmBody = (await mappings(await connectExtension(app, pm))).json() as ExtensionMappings
    expect(pmBody.rules.map((r) => r.pattern)).toContain('https://lab.example.org/*')
  })

  it('leaves out archived projects and other projects\' environments', async () => {
    const other = await makeProject(app, admin, 'Lab', [[pm, ['PM']]])
    fake.addProject('dept/lab-web', 12)
    fake.environments.set(12, [{ id: 9, name: 'production', external_url: 'https://lab.example.org', tier: 'production', last_deployment: null }])
    expect((await app.inject({ method: 'POST', url: `/projects/${other}/repos`, headers: auth(pm), payload: { path: 'dept/lab-web' } })).statusCode).toBe(201)
    await jobs.drain()
    expect(((await mappings(tokens)).json() as ExtensionMappings).rules.map((r) => r.pattern)).not.toContain('https://lab.example.org/*')
    const pmTokens = await connectExtension(app, pm)
    expect(((await mappings(pmTokens)).json() as ExtensionMappings).rules.map((r) => r.pattern)).toContain('https://lab.example.org/*')
    await (await testDb()).update(projects).set({ status: 'archived' }).where(eq(projects.id, other))
    expect(((await mappings(pmTokens)).json() as ExtensionMappings).rules.map((r) => r.pattern)).not.toContain('https://lab.example.org/*')
  })

  it('needs an extension token', async () => {
    expect((await app.inject({ url: '/extension/mappings', headers: auth(qc) })).statusCode).toBe(401)
  })

  it('productionRulesForPerson includes production-tier GitLab environments', async () => {
    expect(await productionRulesForPerson(await testDb(), qc.id)).toEqual(['https://opd.example.org/*'])
  })

  it('a production GitLab environment makes POST /extension/defects refuse video', async () => {
    const clip = { part: 'file1', name: 'clip.webm', type: 'video/webm', data: webm(100) }
    const report = sampleReport(projectId, {
      page: { url: 'https://opd.example.org/ward?bed=3', title: 'Ward' },
      attachments: [{ part: 'file1', role: 'video', name: 'clip.webm', type: 'video/webm', sizeBytes: 100 }],
    })
    const body = await defectBody(report, [clip])
    const res = await app.inject({
      method: 'POST',
      url: '/extension/defects',
      headers: { ...body.headers, authorization: `Bearer ${tokens.accessToken}`, 'idempotency-key': randomUUID() },
      payload: body.payload,
    })
    expect(res.statusCode).toBe(422)
    expect(res.json()).toEqual({ error: 'invalid_state', reason: 'video_on_production' })
  })
})
