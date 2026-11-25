import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { GitLabClient, GitLabError } from '../src/gitlab/client.js'
import { startFakeGitLab, type FakeGitLab } from './fake-gitlab.js'

const TOKEN = 'glpat-SECRET-token-123'
let fake: FakeGitLab
let client: GitLabClient

beforeEach(async () => {
  fake = await startFakeGitLab()
  fake.requireToken(TOKEN)
  fake.addProject('group/sub/app', 42)
  client = new GitLabClient({ baseUrl: fake.url, token: TOKEN, retryBaseMs: 5, timeoutMs: 300 })
})
afterEach(() => fake.stop())

async function caught(p: Promise<unknown>): Promise<GitLabError> {
  try { await p } catch (e) { return e as GitLabError }
  throw new Error('expected rejection')
}

describe('GitLabClient', () => {
  it('gets a project by URL-encoded path', async () => {
    const p = await client.getProject('group/sub/app')
    expect(p).toMatchObject({ id: 42, path_with_namespace: 'group/sub/app', default_branch: 'main' })
    expect(fake.requests[0]!.path).toBe('/api/v4/projects/group%2Fsub%2Fapp')
    expect((await client.currentUser()).username).toBe('yoda-bot')
  })

  it('creates an issue, updates it, notes and imports it', async () => {
    const issue = await client.createIssue(42, { title: 'T', description: 'one' })
    expect(issue.iid).toBe(1)
    await client.updateIssue(42, issue.iid, { description: 'two' })
    await client.addIssueNote(42, issue.iid, 'changed')
    expect((await client.getIssue(42, 1)).description).toBe('two')
    expect(await client.importIssue(42, 1)).toMatchObject({ title: 'T', description: 'two', iid: 1 })
    expect(fake.notes.get('42/1')).toEqual(['changed'])
  })

  it('retries 500 twice then succeeds (3 requests)', async () => {
    fake.failNext(500, 2)
    await client.getProject(42)
    expect(fake.requests).toHaveLength(3)
  })

  it('honors Retry-After on 429', async () => {
    fake.failNext(429, 1, 0)
    await client.getProject(42)
    expect(fake.requests).toHaveLength(2)
  })

  it('does not retry POST on 5xx', async () => {
    fake.failNext(500, 2)
    expect(await caught(client.createIssue(42, { title: 'T', description: '' }))).toMatchObject({ code: 'unavailable', status: 500 })
    expect(fake.requests).toHaveLength(1)
  })

  it('retries POST on 429', async () => {
    fake.failNext(429, 1, 0)
    await client.addIssueNote(42, (await client.createIssue(42, { title: 'T', description: '' })).iid, 'n')
    expect(fake.requests.filter((r) => r.method === 'POST')).toHaveLength(3)
  })

  it('finds an issue by marker and ignores near-misses', async () => {
    fake.seedIssue(42, { title: 'a', description: 'x <!-- yoda:work-item:aaa-111 --> y' })
    fake.seedIssue(42, { title: 'b', description: '<!-- yoda:work-item:aaa-112 -->' })
    expect(await client.findIssueByMarker(42, '<!-- yoda:work-item:aaa-111 -->')).toMatchObject({ iid: 1 })
    expect(await client.findIssueByMarker(42, '<!-- yoda:work-item:aaa-11 -->')).toBeNull()
    expect(await client.findIssueByMarker(42, '<!-- yoda:work-item:zzz -->')).toBeNull()
  })

  it('gives up after 3 attempts as unavailable', async () => {
    fake.failNext(503, 10)
    const e = await caught(client.getProject(42))
    expect(e).toMatchObject({ code: 'unavailable', status: 503 })
    expect(fake.requests).toHaveLength(3)
  })

  it('maps 401 to forbidden without retry', async () => {
    const bad = new GitLabClient({ baseUrl: fake.url, token: 'wrong-token-xyz', retryBaseMs: 5 })
    const e = await caught(bad.getProject(42))
    expect(e).toMatchObject({ code: 'forbidden', status: 401 })
    expect(fake.requests).toHaveLength(1)
  })

  it('maps 404 and 400', async () => {
    expect(await caught(client.getProject('nope/none'))).toMatchObject({ code: 'not_found', status: 404 })
    expect(await caught(client.createIssue(42, { title: '', description: '' }))).toMatchObject({ code: 'bad_request', status: 400 })
  })

  it('times out as unavailable', async () => {
    fake.delayNext(1000, 3)
    const e = await caught(client.getProject(42))
    expect(e).toMatchObject({ code: 'unavailable', status: null })
  })

  it('never leaks the token or URL in errors', async () => {
    const errs: GitLabError[] = []
    fake.failNext(500, 3)
    errs.push(await caught(client.getProject(42)))
    errs.push(await caught(new GitLabClient({ baseUrl: fake.url, token: TOKEN, fetch: () => Promise.reject(new Error(`boom ${fake.url}`)), retryBaseMs: 1 }).currentUser()))
    errs.push(await caught(new GitLabClient({ baseUrl: fake.url, token: 'other-token-abc' }).getProject(42)))
    fake.delayNext(1000, 3)
    errs.push(await caught(client.currentUser()))
    for (const e of errs) {
      for (const s of [e.message, String(e), JSON.stringify(e), e.stack ?? '']) {
        expect(s).not.toContain(TOKEN)
        expect(s).not.toContain('other-token-abc')
        expect(s).not.toContain(fake.url)
      }
    }
    expect(fake.requests.some((r) => JSON.stringify(r).includes(TOKEN))).toBe(false)
  })
})
