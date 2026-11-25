import { describe, expect, it } from 'vitest'
import { EventType, GitLabStatus, MergeRequest, RepoLink, SourceKind, WorkItemReposPut } from '../src/index.js'

describe('gitlab schemas', () => {
  it('trims and bounds a repo path', () => {
    expect(RepoLink.parse({ path: '  group/sub/app  ' }).path).toBe('group/sub/app')
    expect(RepoLink.safeParse({ path: '   ' }).success).toBe(false)
    expect(RepoLink.safeParse({ path: 'x'.repeat(301) }).success).toBe(false)
  })
  it('defaults the pipeline to none', () => {
    const mr = MergeRequest.parse({
      id: crypto.randomUUID(), repoId: crypto.randomUUID(), mrIid: 3, title: 't', url: 'u',
      state: 'opened', sourceBranch: 'b', updatedAt: 'now',
    })
    expect(mr.pipeline).toBe('none')
  })
  it('caps linked repos at 20', () => {
    const ids = Array.from({ length: 21 }, () => crypto.randomUUID())
    expect(WorkItemReposPut.safeParse({ repoIds: ids }).success).toBe(false)
    expect(WorkItemReposPut.safeParse({ repoIds: ids.slice(0, 20) }).success).toBe(true)
  })
  it('knows the gitlab events and source kind', () => {
    expect(EventType.options).toContain('gitlab.mr_merged')
    expect(SourceKind.options).toContain('gitlab')
    expect(GitLabStatus.parse({ configured: false, reachable: null, botUsername: null, lastWebhookAt: null }).configured).toBe(false)
  })
})
