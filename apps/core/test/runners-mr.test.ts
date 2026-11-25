import type { Me } from '@yoda/shared'
import { and, eq } from 'drizzle-orm'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { AppDeps } from '../src/app.js'
import { agentRuns, aiCalls, events, mergeRequests, people, projectMembers, projectRepos, projects, runners, tasks, workItemRepos, workItems } from '../src/db/schema.js'
import { GitLabClient } from '../src/gitlab/client.js'
import { InlineJobQueue } from '../src/jobs/queue.js'
import { claimTask, type RunnerCtx } from '../src/runners/claims.js'
import { closingRefs } from '../src/gitlab/webhook.js'
import { openMergeRequest, runnerMrText } from '../src/runners/merge-requests.js'
import { meFromPerson } from '../src/runners/records.js'
import { newRunnerToken } from '../src/runners/tokens.js'
import { postProgress, submitResult, writeKnowledge } from '../src/runners/work.js'
import { latestTemplate } from '../src/workflow/seed.js'
import { FakeGitLab, startFakeGitLab } from './fake-gitlab.js'
import { resetDb, testDb, testDeps } from './helpers.js'

type TaskRow = typeof tasks.$inferSelect

const GL_PROJECT = 42
const WED_10 = new Date('2026-11-25T03:00:00Z')

let fake: FakeGitLab
let deps: AppDeps & { now: () => Date }
let jobs: InlineJobQueue
let owner: Me
let projectId: string
let itemId: string
let repoId: string
let implement: TaskRow
let rc: RunnerCtx
let branch: string

async function person(username: string): Promise<Me> {
  const db = await testDb()
  const [p] = await db.insert(people).values({ keycloakSub: `sub-${username}`, username, displayName: username, lastSeenStaff: true }).returning()
  return meFromPerson(p!)
}

async function runner(who: Me): Promise<RunnerCtx> {
  const db = await testDb()
  const { hash, prefix } = newRunnerToken()
  const [r] = await db
    .insert(runners)
    .values({
      name: `${who.username}-runner`,
      kind: 'server',
      ownerId: who.id,
      accountType: 'api-key',
      capabilities: ['code-change'],
      mode: 'unattended',
      tokenHash: hash,
      tokenPrefix: prefix,
      createdBy: who.id,
    })
    .returning()
  return { runner: r!, owner: who }
}

const taskRow = async (id: string) => (await (await testDb()).select().from(tasks).where(eq(tasks.id, id)))[0]!
const runRow = async (id: string) => (await (await testDb()).select().from(agentRuns).where(eq(agentRuns.id, id)))[0]!
const mrRows = async () => (await testDb()).select().from(mergeRequests)
const claim = async () => (await claimTask(deps, rc, implement.id)).run.id
const open = (runId: string, over: Partial<{ repoId: string; sourceBranch: string; title: string; description: string }> = {}) =>
  openMergeRequest(deps, rc, { runId, repoId, sourceBranch: branch, title: 'Fix lab report', description: 'Changes the parser.', ...over })

async function rejects(p: Promise<unknown>, statusCode: number, error: string): Promise<void> {
  await expect(p).rejects.toMatchObject({ statusCode, body: { error } })
}

async function makeDeps(gitlab: GitLabClient | null): Promise<void> {
  // gitlab-mr-effect runs here, so the MR effect on the implement task is observable.
  jobs = new InlineJobQueue({
    onError: (err, name, id) => console.warn(`test job ${name} ${id} failed`, err),
    ignore: ['draft-task', 'secretary-chat', 'secretary-event', 'discussion-brief', 'gitlab-issue-sync', 'gitlab-mr-reconcile'],
  })
  const base = await testDeps({ jobs, gitlab })
  deps = { ...base, now: () => WED_10 }
}

beforeEach(async () => {
  const db = await testDb()
  await resetDb(db)
  fake = await startFakeGitLab()
  fake.addProject('lab/report', GL_PROJECT)
  await makeDeps(new GitLabClient({ baseUrl: fake.url, token: 'fake-test-token', retryBaseMs: 1 }))
  owner = await person('dev')
  const [p] = await db.insert(projects).values({ name: 'Lab', autonomy: 'auto-assign' }).returning()
  projectId = p!.id
  await db.insert(projectMembers).values({ projectId, personId: owner.id, roles: ['DEV'] })
  const templateId = (await latestTemplate(db, 'bug-fix'))!.id
  const [w] = await db
    .insert(workItems)
    .values({ projectId, templateId, title: 'Fix lab report', ownerId: owner.id, requesterId: owner.id, currentStepKey: 'dev' })
    .returning()
  itemId = w!.id
  ;[implement] = await db
    .insert(tasks)
    .values({ workItemId: itemId, projectId, stepKey: 'dev', attempt: 1, type: 'ai', role: 'DEV', executor: 'ai', state: 'open', templateTaskKey: 'implement' })
    .returning()
  await db
    .insert(tasks)
    .values({ workItemId: itemId, projectId, stepKey: 'dev', attempt: 1, type: 'ai', role: 'QC', executor: 'ai', state: 'open', templateTaskKey: 'draft-tests' })
  const [repo] = await db
    .insert(projectRepos)
    .values({ projectId, gitlabProjectId: GL_PROJECT, pathWithNamespace: 'lab/report', webUrl: `${fake.url}/lab/report`, defaultBranch: 'main' })
    .returning()
  repoId = repo!.id
  await db.insert(workItemRepos).values({ workItemId: itemId, repoId, issueIid: 7, issueUrl: `${fake.url}/lab/report/-/issues/7` })
  rc = await runner(owner)
  branch = `yoda/${itemId.slice(0, 8)}-fix-lab-report`
  fake.pushBranch(GL_PROJECT, branch)
})

afterEach(async () => {
  await jobs.drain()
  await fake.stop()
})

describe('openMergeRequest', () => {
  it('opens the MR in GitLab with Closes #<iid>, links the row and stores the branch on the run', async () => {
    const runId = await claim()
    const out = await open(runId, { description: 'Changes the parser. <!-- yoda:fake -->' })
    const [mr] = fake.mergeRequests.get(GL_PROJECT)!
    expect(mr).toMatchObject({ source_branch: branch, target_branch: 'main', title: 'Fix lab report', remove_source_branch: true })
    expect(mr!.description).toBe('Changes the parser.  yoda:fake\n\nCloses #7')
    expect(out).toEqual({ mrIid: mr!.iid, url: mr!.web_url })
    const rows = await mrRows()
    expect(rows).toEqual([expect.objectContaining({ repoId, mrIid: mr!.iid, workItemId: itemId, state: 'opened', sourceBranch: branch, url: mr!.web_url })])
    expect((await runRow(runId)).branch).toBe(branch)
    const db = await testDb()
    const [ev] = await db.select().from(events).where(eq(events.type, 'gitlab.mr_requested'))
    expect(ev).toMatchObject({
      workItemId: itemId,
      taskId: implement.id,
      actorId: owner.id,
      actorKind: 'ai',
      payload: expect.objectContaining({ runId, mergeRequestId: rows[0]!.id, mrIid: mr!.iid, branch }),
    })
  })

  it('is idempotent: the same call again returns the same MR, with no second row', async () => {
    const runId = await claim()
    const first = await open(runId)
    const again = await open(runId)
    expect(again).toEqual(first)
    expect(fake.mergeRequests.get(GL_PROJECT)).toHaveLength(1)
    expect(await mrRows()).toHaveLength(1)
    // Once the MR effect has ended the run, a retry is answered from the stored row.
    await jobs.drain()
    expect((await runRow(runId)).state).toBe('succeeded')
    expect(await open(runId)).toEqual(first)
    expect(fake.mergeRequests.get(GL_PROJECT)).toHaveLength(1)
  })

  it('createMergeRequest: GitLab\'s 409 for an open MR on the branch returns that MR', async () => {
    const client = new GitLabClient({ baseUrl: fake.url, token: 'fake-test-token', retryBaseMs: 1 })
    const input = { sourceBranch: branch, targetBranch: 'main', title: 'T', description: 'D', removeSourceBranch: true as const }
    const first = await client.createMergeRequest(GL_PROJECT, input)
    const again = await client.createMergeRequest(GL_PROJECT, input)
    expect(again).toEqual(first)
    expect(first).toMatchObject({ iid: 1, state: 'opened', webUrl: `${fake.url}/lab/report/-/merge_requests/1` })
    expect(fake.mergeRequests.get(GL_PROJECT)).toHaveLength(1)
    expect(fake.requests.filter((r) => r.method === 'GET' && r.path.endsWith('/merge_requests'))).toHaveLength(1)
    // Merged (not open) MRs on the branch don't block a new one.
    fake.mergeRequests.get(GL_PROJECT)![0]!.state = 'merged'
    expect((await client.createMergeRequest(GL_PROJECT, input)).iid).toBe(2)
  })

  it('neutralises closing references in the runner text, so the MR closes only this item\'s issue', async () => {
    const runId = await claim()
    await open(runId, { description: 'Fixes #3 and closes group/other#9' })
    const [mr] = fake.mergeRequests.get(GL_PROJECT)!
    expect(mr!.description).toBe('Refs #3 and Refs group/other#9\n\nCloses #7')
  })

  it.each([
    ['Closes issue #5', 'Refs #5'],
    ['closes issues #5 and #6', 'Refs #5 and #6'],
    ['RESOLVED: #3', 'Refs #3'],
    ['fix\n  #4, #8', 'Refs #4, #8'],
    ['Implementing: issues group/x#2', 'Refs group/x#2'],
    ['Closes https://gitlab.example/lab/report/-/issues/3', 'Refs https://gitlab.example/lab/report/-/issues/3'],
  ])('runnerMrText rewrites %j', (text, want) => {
    expect(runnerMrText(text)).toBe(want)
    expect(closingRefs(runnerMrText(text), 'lab/report')).toEqual([])
  })

  it('the title is rewritten too, and core\'s own Closes line still links the item', async () => {
    const runId = await claim()
    await open(runId, { title: 'Fixes #12: lab report', description: 'closes issues #5 and #6' })
    const [mr] = fake.mergeRequests.get(GL_PROJECT)!
    expect(mr!.title).toBe('Refs #12: lab report')
    expect(mr!.description).toBe('Refs #5 and #6\n\nCloses #7')
    expect(closingRefs(`${mr!.title}\n${mr!.description}`, 'lab/report')).toEqual([7])
    expect((await mrRows())[0]).toMatchObject({ title: 'Refs #12: lab report', workItemId: itemId })
  })

  it('without an issue in the repo there is no Closes line; the branch links the MR', async () => {
    const db = await testDb()
    await db.update(workItemRepos).set({ issueIid: null, issueUrl: null }).where(eq(workItemRepos.workItemId, itemId))
    const runId = await claim()
    await open(runId)
    expect(fake.mergeRequests.get(GL_PROJECT)![0]!.description).toBe('Changes the parser.')
    expect((await mrRows())[0]).toMatchObject({ workItemId: itemId })
  })

  it('refuses the default branch, another item\'s prefix and malformed branches with 422 invalid_branch', async () => {
    const runId = await claim()
    await rejects(open(runId, { sourceBranch: 'main' }), 422, 'invalid_branch')
    await rejects(open(runId, { sourceBranch: 'yoda/deadbeef-fix' }), 422, 'invalid_branch')
    await rejects(open(runId, { sourceBranch: `yoda/${itemId.slice(0, 8)}-Bad_Slug` }), 422, 'invalid_branch')
    await rejects(open(runId, { sourceBranch: `yoda/${itemId.slice(0, 8)}-${'a'.repeat(61)}` }), 422, 'invalid_branch')
    const db = await testDb()
    await db.update(projectRepos).set({ defaultBranch: branch }).where(eq(projectRepos.id, repoId))
    await rejects(open(runId), 422, 'invalid_branch')
    expect(fake.requests.filter((r) => r.method === 'POST')).toEqual([])
  })

  it('a branch GitLab does not have → 422 invalid_branch, no row', async () => {
    const runId = await claim()
    await rejects(open(runId, { sourceBranch: `yoda/${itemId.slice(0, 8)}-not-pushed` }), 422, 'invalid_branch')
    expect(await mrRows()).toEqual([])
  })

  it('a repo not linked to the work item → 422 repo_not_found', async () => {
    const db = await testDb()
    const [other] = await db
      .insert(projectRepos)
      .values({ projectId, gitlabProjectId: 43, pathWithNamespace: 'lab/other', webUrl: `${fake.url}/lab/other`, defaultBranch: 'main' })
      .returning()
    const runId = await claim()
    await rejects(open(runId, { repoId: other!.id }), 422, 'repo_not_found')
    await rejects(open(runId, { repoId: crypto.randomUUID() }), 422, 'repo_not_found')
  })

  it('no GitLab connection → 422 gitlab_not_connected', async () => {
    await makeDeps(null)
    const runId = await claim()
    await rejects(open(runId), 422, 'gitlab_not_connected')
  })

  it('GitLab failing → 502 gitlab_unavailable, no row and no branch on the run; the message carries no token or URL', async () => {
    const runId = await claim()
    fake.failNext(500)
    const err = await open(runId).catch((e: unknown) => e)
    expect(err).toMatchObject({ statusCode: 502, body: { error: 'gitlab_unavailable' } })
    expect(JSON.stringify(err)).not.toMatch(/fake-test-token|127\.0\.0\.1/)
    expect(String((err as Error).message)).not.toMatch(/fake-test-token|127\.0\.0\.1/)
    // A POST is not retried on 5xx.
    expect(fake.requests.filter((r) => r.method === 'POST')).toHaveLength(1)
    expect(await mrRows()).toEqual([])
    expect((await runRow(runId)).branch).toBeNull()
  })

  it('refuses a run that is not live', async () => {
    const runId = await claim()
    deps.now = () => new Date(WED_10.getTime() + 11 * 60_000)
    await expect(open(runId)).rejects.toMatchObject({ statusCode: 409, body: { reason: 'run_not_active' } })
    expect(fake.requests.filter((r) => r.method === 'POST')).toEqual([])
  })

  it('a later webhook for the same MR changes nothing', async () => {
    const runId = await claim()
    const { mrIid, url } = await open(runId)
    await jobs.drain()
    const db = await testDb()
    const before = await db.select().from(events).where(eq(events.workItemId, itemId))
    const { handleWebhook } = await import('../src/gitlab/webhook.js')
    const mr = fake.mergeRequests.get(GL_PROJECT)![0]!
    await handleWebhook(deps, 'fake-uuid-1', {
      object_kind: 'merge_request',
      project: { id: GL_PROJECT },
      object_attributes: { iid: mrIid, title: mr.title, url, state: 'opened', source_branch: branch, description: mr.description },
    }, null)
    await jobs.drain()
    expect(await mrRows()).toHaveLength(1)
    const after = await db.select().from(events).where(eq(events.workItemId, itemId))
    expect(after.map((e) => e.type)).toEqual(before.map((e) => e.type))
  })
})

describe('MR effect and the run', () => {
  it('accepting the implement task ends its running run (succeeded, mr_effect); a later submit is already_done', async () => {
    const runId = await claim()
    await open(runId)
    await jobs.drain()
    expect(await taskRow(implement.id)).toMatchObject({ state: 'accepted' })
    const run = await runRow(runId)
    expect(run).toMatchObject({ state: 'succeeded', branch })
    expect(run.endedAt).not.toBeNull()
    const db = await testDb()
    const [ev] = await db.select().from(events).where(and(eq(events.type, 'run.succeeded'), eq(events.taskId, implement.id)))
    expect(ev).toMatchObject({ reason: 'mr_effect', payload: expect.objectContaining({ runId }) })
    // The slot is free: a fresh claim of another task is not blocked by this run.
    expect(await db.select().from(agentRuns).where(eq(agentRuns.state, 'running'))).toEqual([])

    const out = await submitResult(deps, rc, { runId, text: 'Implemented', usage: { model: 'm', costUsd: 0.5 } })
    expect(out).toEqual({ outcome: 'already_done' })
    expect(await db.select().from(aiCalls)).toHaveLength(1)
    // Submitting again does not count the cost twice.
    expect(await submitResult(deps, rc, { runId, text: 'Implemented', usage: { model: 'm', costUsd: 0.5 } })).toEqual({ outcome: 'already_done' })
    expect(await db.select().from(aiCalls)).toHaveLength(1)
    const accepted = await db.select().from(events).where(and(eq(events.taskId, implement.id), eq(events.type, 'task.accepted')))
    expect(accepted).toHaveLength(1)
  })
})

describe('submitResult racing the MR effect', () => {
  it('a submit that waited on the task lock while the effect ended the run is already_done', async () => {
    const runId = await claim()
    await open(runId)
    // Hold the work item's lock so the effect and the submit queue behind it, effect first.
    const db = await testDb()
    let release!: () => void
    const held = new Promise<void>((r) => (release = r))
    let locked!: () => void
    const isLocked = new Promise<void>((r) => (locked = r))
    const holder = db.transaction(async (tx) => {
      await tx.select().from(workItems).where(eq(workItems.id, itemId)).for('no key update')
      locked()
      await held
    })
    await isLocked
    const effect = jobs.drain()
    await new Promise((r) => setTimeout(r, 100))
    const submit = submitResult(deps, rc, { runId, text: 'Implemented' })
    await new Promise((r) => setTimeout(r, 100))
    release()
    await holder
    await effect
    expect(await submit).toEqual({ outcome: 'already_done' })
    expect((await runRow(runId)).state).toBe('succeeded')
  })
})

describe('knowledge writes re-check the task', () => {
  it('a cancelled or superseded task refuses writeKnowledge and postProgress', async () => {
    const runId = await claim()
    const db = await testDb()
    await db.update(tasks).set({ state: 'rejected' }).where(eq(tasks.id, implement.id))
    await expect(writeKnowledge(deps, rc, { runId, type: 'fact', title: 't', body: 'b' })).rejects.toMatchObject({
      statusCode: 409,
      body: { reason: 'task_unavailable' },
    })
    await expect(postProgress(deps, rc, { runId, note: 'n' })).rejects.toMatchObject({ statusCode: 409, body: { reason: 'task_unavailable' } })
    await db.update(tasks).set({ state: 'in_progress', supersededAt: new Date() }).where(eq(tasks.id, implement.id))
    await expect(writeKnowledge(deps, rc, { runId, type: 'fact', title: 't', body: 'b' })).rejects.toMatchObject({
      statusCode: 409,
      body: { reason: 'task_unavailable' },
    })
    await expect(postProgress(deps, rc, { runId, note: 'n' })).rejects.toMatchObject({ statusCode: 409, body: { reason: 'task_unavailable' } })
  })
})
