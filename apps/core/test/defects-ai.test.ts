import { DEFECT_SENSITIVE_TITLE, DEFECT_WITHHELD_DESCRIPTION, type Me } from '@yoda/shared'
import { MockLanguageModelV4 } from 'ai/test'
import { and, eq } from 'drizzle-orm'
import type { FastifyInstance } from 'fastify'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { AiGateway } from '../src/ai/gateway.js'
import { buildApp, type AppDeps } from '../src/app.js'
import { discussions, knowledgeEntries, notifications, projectRepos, proposals, runners, tasks, workItemRepos, workItems } from '../src/db/schema.js'
import { buildBriefPrompt } from '../src/discussions/brief.js'
import { claimTask, listAvailableTasks } from '../src/runners/claims.js'
import { branchFor, getContextPack } from '../src/runners/work.js'
import { weeklyMaterial } from '../src/status/weekly.js'
import { decideProposal } from '../src/proposals/service.js'
import { createDefect } from '../src/defects/service.js'
import { aiTitle, redactToolOutput, sensitiveDefectIds } from '../src/defects/ai-view.js'
import type { GitLabClient } from '../src/gitlab/client.js'
import { syncIssues } from '../src/gitlab/sync.js'
import { LiveBus } from '../src/live/bus.js'
import { buildContextPack, renderContextPack } from '../src/knowledge/context-pack.js'
import { personAsMe } from '../src/proposals/service.js'
import { secretaryEvent } from '../src/secretary/events.js'
import { secretaryTools, type PendingAction } from '../src/secretary/tools.js'
import { runWork } from '../src/work/context.js'
import { assignTask, submitTask } from '../src/work/engine.js'
import { embeddingModel, textStream } from './ai-mocks.js'
import { InlineJobQueue } from '../src/jobs/queue.js'
import { makeProject, sampleReport } from './defect-fixtures.js'
import { mockModels, resetDb, testConfig, testDb, testDeps } from './helpers.js'
import { auth, login, type Who } from './support.js'

const TITLE = 'นายทดสอบ HN 0000'
const TEXT = 'คนไข้ทดสอบ เลขที่ 4242 แพ้ยา'
const STEP = 'เปิดแฟ้ม 4242'

let deps: AppDeps
let app: FastifyInstance
let prompts: string[]
let emb: ReturnType<typeof embeddingModel>
let jobs: InlineJobQueue
let admin: Who
let pm: Who
let qc: Who
let projectId: string

beforeEach(async () => {
  const db = await testDb()
  await resetDb(db)
  prompts = []
  const model = new MockLanguageModelV4({
    modelId: 'claude-haiku-5-5',
    doStream: async ({ prompt }) => {
      prompts.push(JSON.stringify(prompt))
      return { stream: textStream('สรุปงานเรียบร้อย') }
    },
  })
  emb = embeddingModel('text-embedding-3-small')
  const models = mockModels({ fast: model, embed: emb, ids: { draft: 'anthropic:claude-opus-5-5', fast: 'anthropic:claude-haiku-5-5', embed: 'openai:text-embedding-3-small' } })
  jobs = new InlineJobQueue({ onError: (err, name, id) => console.warn(`job ${name} ${id} failed`, err), ignore: ['draft-task', 'secretary-event', 'discussion-brief', 'gitlab-issue-sync', 'gitlab-mr-effect', 'gitlab-mr-reconcile'] })
  deps = await testDeps({ jobs, ai: new AiGateway({ db, bus: new LiveBus(), models, config: testConfig() }) })
  app = await buildApp({ ...deps, config: { ...deps.config, bootstrapAdmins: ['boss'] } })
  admin = await login(app, 'boss')
  pm = await login(app, 'pm', { staff: true, name: 'คุณพีเอ็ม' })
  qc = await login(app, 'qc', { staff: true, name: 'คุณคิวซี' })
  projectId = await makeProject(app, admin, 'OPD', [
    [pm, ['PM']],
    [qc, ['QC']],
  ])
})
afterEach(async () => {
  await app.close()
})

const me = async (who: Who): Promise<Me> => (await personAsMe(deps.db, who.id))!
const sensitivePrivacy = { confirmedNoPatientData: true as const, productionSite: false, textMayContainPatientData: true }

async function report(o: { sensitive: boolean; kind?: 'defect' | 'bug_fix_request'; title?: string }): Promise<string> {
  const m = await me(qc)
  const input = sampleReport(projectId, {
    kind: o.kind ?? 'defect',
    title: o.title ?? TITLE,
    description: TEXT,
    steps: [STEP],
    expected: `ควรแสดง ${TEXT}`,
    actual: `ไม่แสดง ${TEXT}`,
    ...(o.sensitive ? { privacy: sensitivePrivacy } : {}),
  })
  const meta = { grantId: null, extensionVersion: '1.1.0', idempotencyKey: null }
  return (await runWork(deps, { id: m.id, kind: 'person' }, (ctx) => createDefect(ctx, m, input, [], meta))).workItemId
}

const leaks = (s: string) => [TITLE, TEXT, STEP, '4242'].filter((x) => s.includes(x))

describe('ai-view', () => {
  it('sensitiveDefectIds and aiTitle', async () => {
    const hidden = await report({ sensitive: true })
    const shown = await report({ sensitive: false, title: 'ปุ่มบันทึกไม่ทำงาน' })
    const set = await sensitiveDefectIds(deps.db, [hidden, shown])
    expect([...set]).toEqual([hidden])
    expect(aiTitle({ id: hidden, title: TITLE }, set, 'th')).toBe(DEFECT_SENSITIVE_TITLE.th)
    expect(aiTitle({ id: hidden, title: TITLE }, set, 'en')).toBe(DEFECT_SENSITIVE_TITLE.en)
    expect(aiTitle({ id: shown, title: 'ปุ่มบันทึกไม่ทำงาน' }, set, 'th')).toBe('ปุ่มบันทึกไม่ทำงาน')
  })

  it('redactToolOutput replaces titles by id and anywhere in text, and leaves others alone', async () => {
    const hidden = await report({ sensitive: true })
    const out = await redactToolOutput(deps.db, await me(qc), {
      a: [{ workItemId: hidden, title: TITLE, workItem: TITLE }],
      b: { summary: `${TITLE}: normal → high` },
      c: 'other text',
    })
    expect(leaks(JSON.stringify(out))).toEqual([])
    expect(out).toEqual({
      a: [{ workItemId: hidden, title: DEFECT_SENSITIVE_TITLE.th, workItem: DEFECT_SENSITIVE_TITLE.th }],
      b: { summary: `${DEFECT_SENSITIVE_TITLE.th}: normal → high` },
      c: 'other text',
    })
  })
})

describe('a sensitive defect never reaches AI', () => {
  it('the context pack shows DEFECT_SENSITIVE_TITLE and the marker, never the title or the text', async () => {
    const id = await report({ sensitive: true })
    const [t] = await deps.db.select().from(tasks).where(eq(tasks.workItemId, id))
    const { pack } = await buildContextPack({ db: deps.db, ai: deps.ai }, t!.id)
    const text = renderContextPack(pack)
    expect(leaks(text)).toEqual([])
    // The related-knowledge search query is embedded: it carries the neutral title too.
    const embedded = JSON.stringify(emb.doEmbedCalls.map((c) => c.values))
    expect(embedded).toContain(DEFECT_SENSITIVE_TITLE.en)
    expect(leaks(embedded)).toEqual([])
    expect(text).toContain(DEFECT_SENSITIVE_TITLE.en)
    expect(text).toContain(DEFECT_WITHHELD_DESCRIPTION.en)
  })

  it('the GitLab issue section shows the neutral title and the marker, severity, build and browser, and no media bytes', async () => {
    const id = await report({ sensitive: true, kind: 'bug_fix_request' })
    const [repo] = await deps.db
      .insert(projectRepos)
      .values({ projectId, gitlabProjectId: 7, pathWithNamespace: 'his/opd-web', webUrl: 'https://gitlab.example.org/his/opd-web' })
      .returning()
    await deps.db.insert(workItemRepos).values({ workItemId: id, repoId: repo!.id }).onConflictDoNothing()
    const created: { title: string; description: string }[] = []
    const gitlab = {
      findIssueByMarker: async () => null,
      createIssue: async (_p: number, input: { title: string; description: string }) => {
        created.push(input)
        return { iid: 1, web_url: 'https://gitlab.example.org/his/opd-web/-/issues/1', description: input.description }
      },
      getIssue: async () => ({ iid: 1, description: created.at(-1)?.description ?? '', web_url: '', state: 'opened' }),
      updateIssue: async () => ({}),
      createIssueNote: async () => ({}),
    } as unknown as GitLabClient
    await syncIssues({ ...deps, config: { ...deps.config, portalUrl: 'https://yoda.example.org' }, gitlab }, { id, attempt: 1, isFinalAttempt: true })
    expect(created).toHaveLength(1)
    const [issue] = created
    expect(leaks(`${issue!.title}\n${issue!.description}`)).toEqual([])
    expect(issue!.title).toBe(DEFECT_SENSITIVE_TITLE.th)
    expect(issue!.description).toContain(DEFECT_SENSITIVE_TITLE.th)
    expect(issue!.description).toContain(DEFECT_WITHHELD_DESCRIPTION.th)
    expect(issue!.description).toContain('major')
    expect(issue!.description).toContain('a1b2c3d')
    expect(issue!.description).toContain('Chrome 131')
    expect(issue!.description).toContain(`https://yoda.example.org/work-items/${id}`)
  })

  it('the secretary done-event summary prompt never contains the real title or text', async () => {
    const id = await report({ sensitive: true })
    await deps.db.update(workItems).set({ state: 'done' }).where(eq(workItems.id, id))
    await secretaryEvent(deps, { id, attempt: 1, isFinalAttempt: true })
    expect(prompts).toHaveLength(1)
    expect(leaks(prompts[0]!)).toEqual([])
    expect(prompts[0]).toContain(DEFECT_SENSITIVE_TITLE.en)
    const [entry] = await deps.db.select().from(knowledgeEntries).where(eq(knowledgeEntries.workItemId, id))
    expect(leaks(entry!.title)).toEqual([])
  })

  it('every secretary tool that returns work items never returns the real title or text', async () => {
    const id = await report({ sensitive: true })
    const exec = async (tools: ReturnType<typeof secretaryTools>, name: string, input: unknown) => {
      const t = tools[name]
      expect(t, name).toBeDefined()
      return JSON.stringify(await t!.execute!(input as never, { toolCallId: name, messages: [], context: {} } as never))
    }

    // The PM proposes a priority change; its summary names the item.
    const pmMe = await me(pm)
    const pending: PendingAction[] = []
    const pmTools = secretaryTools({ db: deps.db, ai: deps.ai }, pmMe, pending)
    await exec(pmTools, 'propose_priority', { workItemId: id, priority: 'low', reason: 'ทดสอบ' })
    for (const p of pending) await runWork(deps, { id: pmMe.id, kind: 'ai' }, p)

    const qcMe = await me(qc)
    const qcTools = secretaryTools({ db: deps.db, ai: deps.ai }, qcMe, [])
    const outputs = [
      await exec(qcTools, 'search_knowledge', { query: TITLE }),
      await exec(qcTools, 'my_todo', {}),
      await exec(secretaryTools({ db: deps.db, ai: deps.ai }, pmMe, []), 'my_todo', {}),
      await exec(qcTools, 'project_status', { projectId }),
      await exec(qcTools, 'work_item', { workItemId: id }),
      // The reporter is the requester: their requests list, as the requester tools see it.
      await exec(secretaryTools({ db: deps.db, ai: deps.ai }, { ...qcMe, isStaff: false }, []), 'my_requests', {}),
    ]
    for (const o of outputs) expect(leaks(o), o).toEqual([])
    const all = outputs.join('\n')
    expect(all).toContain(DEFECT_SENSITIVE_TITLE.th)
    // The PM's to-do holds the priority proposal, whose summary is redacted.
    expect(outputs[2]).toContain(`${DEFECT_SENSITIVE_TITLE.th}: high → low`)
  })

  it('redactToolOutput matches titles by text only in projects the caller sees', async () => {
    await report({ sensitive: true })
    const outsider = await login(app, 'outsider', { staff: true })
    const out = await redactToolOutput(deps.db, await me(outsider), { note: `about ${TITLE}` })
    // Nothing is revealed about another project's defects: the outsider's own text comes back unchanged.
    expect(out).toEqual({ note: `about ${TITLE}` })
  })

  it('request_status, the requester view, carries the neutral title', async () => {
    const id = await report({ sensitive: true })
    const tools = secretaryTools({ db: deps.db, ai: deps.ai }, { ...(await me(qc)), isStaff: false }, [])
    const out = JSON.stringify(await tools.request_status!.execute!({ workItemId: id } as never, { toolCallId: 'r', messages: [], context: {} } as never))
    expect(leaks(out)).toEqual([])
    expect(out).toContain(DEFECT_SENSITIVE_TITLE.th)
  })

  it('a project thread and a work item thread give the secretary the neutral title', async () => {
    const id = await report({ sensitive: true })
    for (const payload of [{ kind: 'project', projectId }, { kind: 'work_item', workItemId: id }]) {
      const c = await app.inject({ method: 'POST', url: '/conversations', headers: auth(qc), payload })
      expect(c.statusCode, c.body).toBeLessThan(300)
      const posted = await app.inject({ method: 'POST', url: `/conversations/${c.json().id}/messages`, headers: auth(qc), payload: { text: '@ai สรุปงาน', attachmentIds: [] } })
      expect(posted.statusCode).toBe(201)
      await jobs.drain()
    }
    expect(prompts).toHaveLength(2)
    for (const p of prompts) {
      expect(leaks(p)).toEqual([])
      expect(p).toContain(DEFECT_SENSITIVE_TITLE.en)
    }
  })

  it('a discussion brief on a sensitive defect uses the neutral title in the prompt and the search query', async () => {
    const id = await report({ sensitive: true })
    const [d] = await deps.db.insert(discussions).values({ projectId, workItemId: id, question: 'ควรแก้แบบไหน', raisedBy: qc.id }).returning()
    const { prompt } = await buildBriefPrompt(deps, d!)
    expect(leaks(prompt)).toEqual([])
    expect(prompt).toContain(DEFECT_SENSITIVE_TITLE.en)
    expect(leaks(JSON.stringify(emb.doEmbedCalls.map((c) => c.values)))).toEqual([])
  })

  it('the weekly material names a sensitive defect by the neutral title', async () => {
    await report({ sensitive: true })
    const text = await weeklyMaterial(deps.db, projectId, new Date(Date.now() - 86_400_000))
    expect(text).toContain('defect.reported')
    expect(text).toContain(DEFECT_SENSITIVE_TITLE.en)
    expect(leaks(text)).toEqual([])
  })

  it('a runner sees the neutral title, and the branch is named from it', async () => {
    const id = await report({ sensitive: true, kind: 'bug_fix_request' })
    // Through intake: the PM accepts the report; the dev step opens the AI implement task.
    const pmMe = await me(pm)
    const [accept] = await deps.db.select().from(tasks).where(and(eq(tasks.workItemId, id), eq(tasks.templateTaskKey, 'accept-bug')))
    await runWork(deps, { id: pmMe.id, kind: 'person' }, (ctx) => assignTask(ctx, pmMe, accept!.id, pmMe.id))
    await runWork(deps, { id: pmMe.id, kind: 'person' }, (ctx) => submitTask(ctx, pmMe, accept!.id, { text: '', attachmentIds: [], decision: 'approve' }))
    const [advance] = await deps.db.select().from(proposals).where(and(eq(proposals.workItemId, id), eq(proposals.kind, 'step_advance'), eq(proposals.state, 'pending')))
    if (advance) await runWork(deps, { id: pmMe.id, kind: 'person' }, (ctx) => decideProposal(ctx, pmMe, advance.id, { decision: 'accept' }))
    const [w] = await deps.db.select().from(workItems).where(eq(workItems.id, id))
    expect(w!.currentStepKey).toBe('dev')

    const [runner] = await deps.db
      .insert(runners)
      .values({ name: 'pm-runner', kind: 'server', ownerId: pm.id, accountType: 'api-key', capabilities: ['code-change'], mode: 'unattended', tokenHash: 'h', tokenPrefix: 'p', createdBy: pm.id })
      .returning()
    const rc = { runner: runner!, owner: pmMe }
    const list = await listAvailableTasks(deps, rc, {})
    expect(list.map((t) => t.workItemTitle)).toEqual([DEFECT_SENSITIVE_TITLE.en])
    expect(branchFor(id, DEFECT_SENSITIVE_TITLE.en)).toMatch(/-defect-report-sensitive$/)
    const [impl] = await deps.db.select().from(tasks).where(and(eq(tasks.workItemId, id), eq(tasks.templateTaskKey, 'implement')))
    const { run } = await claimTask(deps, rc, impl!.id)
    const pack = await getContextPack(deps, rc, run.id)
    const text = JSON.stringify(pack)
    expect(leaks(text)).toEqual([])
    expect(text).toContain('defect-report-sensitive')
  })

  it('a non-sensitive defect shows its real title to AI', async () => {
    const id = await report({ sensitive: false, title: 'ปุ่มบันทึกไม่ทำงาน' })
    const tools = secretaryTools({ db: deps.db, ai: deps.ai }, await me(qc), [])
    const out = JSON.stringify(await tools.work_item!.execute!({ workItemId: id } as never, { toolCallId: 'w', messages: [], context: {} } as never))
    expect(out).toContain('ปุ่มบันทึกไม่ทำงาน')
    expect(out).toContain(TEXT)
    const [t] = await deps.db.select().from(tasks).where(eq(tasks.workItemId, id))
    const text = renderContextPack((await buildContextPack({ db: deps.db, ai: null }, t!.id)).pack)
    expect(text).toContain('ปุ่มบันทึกไม่ทำงาน')
  })

  it('outside notifications still carry the real work item title', async () => {
    const id = await report({ sensitive: true })
    const [t] = await deps.db.select().from(tasks).where(eq(tasks.workItemId, id))
    const pmMe = await me(pm)
    await runWork(deps, { id: pmMe.id, kind: 'person' }, (ctx) => assignTask(ctx, pmMe, t!.id, qc.id))
    const rows = await deps.db
      .select()
      .from(notifications)
      .where(and(eq(notifications.personId, qc.id), eq(notifications.kind, 'task_assigned')))
    expect(rows.length).toBeGreaterThan(0)
    expect(rows.some((n) => n.body === TITLE && n.link?.startsWith('/todo/'))).toBe(true)
  })
})
