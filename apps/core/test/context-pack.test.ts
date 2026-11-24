import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { and, asc, desc, eq } from 'drizzle-orm'
import type { Me, TaskResult } from '@yoda/shared'
import type { AppDeps } from '../src/app.js'
import type { Db } from '../src/db/client.js'
import { AiRefused } from '../src/ai/gateway.js'
import { attachments, knowledgeEntries, people, projectMembers, projects, tasks } from '../src/db/schema.js'
import { buildContextPack, renderContextPack } from '../src/knowledge/context-pack.js'
import { InlineJobQueue } from '../src/jobs/queue.js'
import { assignTask, createWorkItem, submitTask } from '../src/work/engine.js'
import { runWork } from '../src/work/context.js'
import { resetDb, testDeps } from './helpers.js'

let deps: AppDeps
let db: Db

async function person(name: string, isAdmin = false): Promise<Me> {
  const [p] = await db
    .insert(people)
    .values({ keycloakSub: `sub-${name}-${Math.random()}`, username: name, displayName: name, isAdmin })
    .returning()
  return { id: p!.id, username: name, displayName: name, email: null, isStaff: true, isAdmin }
}

const run = <T>(me: Me, fn: Parameters<typeof runWork<T>>[2]) => runWork(deps, { id: me.id, kind: 'person' }, fn)

async function setup() {
  const pm = await person('pm')
  const dev = await person('dev')
  const qc = await person('qc')
  const [proj] = await db.insert(projects).values({ name: 'ระบบแล็บ', description: 'proj desc', autonomy: 'auto-assign', createdBy: pm.id }).returning()
  const projectId = proj!.id
  await db.insert(projectMembers).values([
    { projectId, personId: pm.id, roles: ['PM'] },
    { projectId, personId: dev.id, roles: ['DEV'] },
    { projectId, personId: qc.id, roles: ['QC'] },
  ])
  const wi = await run(pm, (ctx) =>
    createWorkItem(ctx, pm, projectId, { title: 'Login crash', description: 'wi desc', templateKey: 'bug-fix', priority: 'high' }),
  )
  return { pm, dev, qc, projectId, wi }
}
type S = Awaited<ReturnType<typeof setup>>

async function latest(wi: string, key: string) {
  const [row] = await db
    .select()
    .from(tasks)
    .where(and(eq(tasks.workItemId, wi), eq(tasks.templateTaskKey, key)))
    .orderBy(desc(tasks.attempt))
    .limit(1)
  return row!
}

async function complete(s: S, key: string, me: Me, result: Partial<TaskResult> = {}) {
  const t = await latest(s.wi, key)
  if (t.assigneeId !== me.id) await run(s.pm, (ctx) => assignTask(ctx, s.pm, t.id, me.id))
  await run(me, (ctx) => submitTask(ctx, me, t.id, { text: '', attachmentIds: [], ...result }))
  return t.id
}

/** Brings the item to the review-code task; implement was accepted with `text`. */
async function toReview(s: S, text = 'IMPLEMENT-RESULT-TEXT') {
  await complete(s, 'accept-bug', s.pm, { decision: 'approve' })
  const implementId = await complete(s, 'implement', s.dev, { text })
  await complete(s, 'draft-tests', s.qc, { text: 'tests' })
  return { implementId, review: await latest(s.wi, 'review-code') }
}

async function entry(s: S, over: Partial<typeof knowledgeEntries.$inferInsert> = {}) {
  const scope = over.scope ?? 'work_item'
  const [row] = await db
    .insert(knowledgeEntries)
    .values({
      lineageId: crypto.randomUUID(),
      version: 1,
      scope,
      projectId: scope === 'department' ? null : s.projectId,
      workItemId: scope === 'work_item' ? s.wi : null,
      type: 'document',
      title: 'Doc',
      body: 'body',
      status: 'confirmed',
      sourceKind: 'person',
      ...over,
    })
    .returning()
  return row!
}

async function attachment(s: S, over: Partial<typeof attachments.$inferInsert> = {}) {
  const [row] = await db
    .insert(attachments)
    .values({
      projectId: s.projectId,
      workItemId: s.wi,
      storageKey: `k-${Math.random()}`,
      fileName: 'f.txt',
      contentType: 'text/plain',
      sizeBytes: 1,
      uploadedBy: s.dev.id,
      ...over,
    })
    .returning()
  return row!
}

describe('context packs', () => {
  beforeEach(async () => {
    deps = await testDeps()
    db = deps.db
    await resetDb(db)
  })
  afterEach(async () => {
    await (deps.jobs as InlineJobQueue).drain()
  })

  it('review-code pack carries the implement input, work item, project and task', async () => {
    const s = await setup()
    const { review } = await toReview(s)
    const { pack } = await buildContextPack(deps, review.id)
    expect(pack.task).toMatchObject({ id: review.id, stepKey: 'dev', attempt: 1, feedback: null })
    expect(pack.workItem).toMatchObject({ id: s.wi, title: 'Login crash', priority: 'high' })
    expect(pack.project).toMatchObject({ id: s.projectId, name: 'ระบบแล็บ' })
    expect(pack.inputs.map((i) => i.text).join('\n')).toContain('IMPLEMENT-RESULT-TEXT')
    const md = renderContextPack(pack)
    expect(md).toContain('IMPLEMENT-RESULT-TEXT')
    expect(md).toContain(pack.task.title.en)
    expect(md).toContain(pack.task.title.th)
  })

  it('orders sections and includes confirmed documents, decisions, progress and memory', async () => {
    const s = await setup()
    const { review } = await toReview(s)
    await entry(s, { title: 'WI-DOC', type: 'document' })
    await entry(s, { scope: 'project', title: 'PROJ-DEC', type: 'decision' })
    await entry(s, { scope: 'department', title: 'DEPT-DEC', type: 'decision' })
    await entry(s, { title: 'UNCONFIRMED-DOC', status: 'draft' })
    await entry(s, { title: 'OLD-DOC', supersededAt: new Date() })
    await entry(s, { title: 'WI-MEM', type: 'memory', status: 'draft' })
    await entry(s, { title: 'WI-PROG', type: 'progress' })
    await entry(s, { scope: 'project', type: 'fact', title: 'Login crash REL', body: 'Login crash' })
    const { pack } = await buildContextPack(deps, review.id)
    expect(pack.documents.map((e) => e.title)).toContain('WI-DOC')
    expect(pack.documents.map((e) => e.title)).not.toContain('UNCONFIRMED-DOC')
    expect(pack.documents.map((e) => e.title)).not.toContain('OLD-DOC')
    expect(pack.decisions.map((e) => e.title)).toEqual(expect.arrayContaining(['PROJ-DEC', 'DEPT-DEC']))
    expect(pack.memory.map((e) => e.title)).toEqual(['WI-MEM'])
    const md = renderContextPack(pack)
    const order = ['# Task', '# Work item', '# Project', 'Inputs from previous steps', 'Confirmed documents', 'Decisions', 'Recent progress', 'Working memory', 'Related knowledge']
    const at = order.map((h) => md.indexOf(h))
    expect(at.every((i) => i >= 0)).toBe(true)
    expect([...at].sort((a, b) => a - b)).toEqual(at)
    expect(md).toContain('[UNVERIFIED DRAFT]')
  })

  it('never includes noAi content: entry, attachment-linked entry, noAi project entries, input attachment text', async () => {
    const s = await setup()
    const { implementId, review } = await toReview(s)
    await entry(s, { title: 'SECRET-ENTRY', body: 'SECRET-ENTRY-BODY', noAi: true })
    const att = await attachment(s, { noAi: true, extractedText: 'SECRET-ATT-TEXT' })
    await entry(s, { title: 'SECRET-ATT-ENTRY', body: 'SECRET-ATT-ENTRY-BODY', attachmentId: att.id })
    await attachment(s, { taskId: implementId, fileName: 'ok.txt', extractedText: 'OPEN-ATT-TEXT' })
    await attachment(s, { taskId: implementId, fileName: 'no.txt', noAi: true, extractedText: 'HIDDEN-INPUT-TEXT' })
    await entry(s, { title: 'VISIBLE-DOC', body: 'visible body' })
    const { pack } = await buildContextPack(deps, review.id)
    const md = renderContextPack(pack)
    expect(JSON.stringify(pack) + md).not.toMatch(/SECRET|HIDDEN-INPUT/)
    expect(md).toContain('OPEN-ATT-TEXT')
    expect(md).toContain('VISIBLE-DOC')
  })

  it('related search also drops noAi entries (own flag and attachment) and entries already included', async () => {
    const s = await setup()
    const { review } = await toReview(s)
    const q = 'Login crash'
    await entry(s, { scope: 'project', type: 'fact', title: `${q} RELATED-OK`, body: q })
    await entry(s, { scope: 'project', type: 'fact', title: `${q} RELATED-NOAI`, body: q, noAi: true })
    const att = await attachment(s, { noAi: true })
    await entry(s, { scope: 'project', type: 'fact', title: `${q} RELATED-ATT`, body: q, attachmentId: att.id })
    await entry(s, { title: `${q} ALREADY-IN-DOCS`, body: q })
    const { pack } = await buildContextPack(deps, review.id)
    const rel = pack.related.map((e) => e.title).join('|')
    expect(rel).toContain('RELATED-OK')
    expect(rel).not.toContain('RELATED-NOAI')
    expect(rel).not.toContain('RELATED-ATT')
    expect(rel).not.toContain('ALREADY-IN-DOCS')
    expect(pack.documents.map((e) => e.title).join('|')).toContain('ALREADY-IN-DOCS')
  })

  it('a project-level noAi flag keeps entries of the project out (no pack at all)', async () => {
    const s = await setup()
    const { review } = await toReview(s)
    await db.update(projects).set({ noAi: true }).where(eq(projects.id, s.projectId))
    await expect(buildContextPack(deps, review.id)).rejects.toMatchObject({ name: 'AiRefused', reason: 'no_ai' })
    await expect(buildContextPack(deps, review.id)).rejects.toBeInstanceOf(AiRefused)
  })

  it('labels draft related entries [UNVERIFIED DRAFT]', async () => {
    const s = await setup()
    const { review } = await toReview(s)
    await entry(s, { scope: 'project', type: 'fact', status: 'draft', title: 'Login crash note', body: 'Login crash' })
    const { pack } = await buildContextPack(deps, review.id)
    expect(pack.related).toHaveLength(1)
    expect(renderContextPack(pack)).toContain('[UNVERIFIED DRAFT] Login crash note')
  })

  it('trims to maxChars keeping task instructions and the input', async () => {
    const s = await setup()
    const { review } = await toReview(s)
    for (let i = 0; i < 12; i++) {
      await entry(s, { type: 'progress', title: `prog ${i}`, body: 'p'.repeat(800) })
      await entry(s, { scope: 'project', type: 'fact', title: `Login crash ${i}`, body: `Login crash ${'r'.repeat(800)}` })
    }
    await entry(s, { title: 'BIG-DOC', body: 'd'.repeat(5000) })
    const full = renderContextPack((await buildContextPack(deps, review.id)).pack)
    expect(full.length).toBeGreaterThan(2000)
    const { pack } = await buildContextPack(deps, review.id, { maxChars: 2000 })
    const md = renderContextPack(pack)
    expect(md.length).toBeLessThanOrEqual(2000)
    expect(md).toContain(pack.task.instructions.en)
    expect(md).toContain('IMPLEMENT-RESULT-TEXT')
  })

  it('related hits never come from another project', async () => {
    const s = await setup()
    const { review } = await toReview(s)
    const [other] = await db.insert(projects).values({ name: 'other', createdBy: s.pm.id }).returning()
    await db.insert(knowledgeEntries).values({
      lineageId: crypto.randomUUID(), version: 1, scope: 'project', projectId: other!.id, type: 'fact',
      title: 'Login crash OTHER-PROJECT', body: 'Login crash', status: 'confirmed', sourceKind: 'person',
    })
    await entry(s, { scope: 'project', type: 'fact', title: 'Login crash MINE', body: 'Login crash' })
    const { pack } = await buildContextPack(deps, review.id)
    const rel = pack.related.map((e) => e.title).join('|')
    expect(rel).toContain('MINE')
    expect(rel).not.toContain('OTHER-PROJECT')
  })

  it('signals overBudget when the fixed header alone exceeds maxChars, and flattens multi-line titles', async () => {
    const s = await setup()
    const { review } = await toReview(s)
    await entry(s, { title: 'a\n# injected', body: 'b' })
    const { pack, overBudget } = await buildContextPack(deps, review.id, { maxChars: 50 })
    expect(overBudget).toBe(true)
    const full = await buildContextPack(deps, review.id)
    expect(full.overBudget).toBe(false)
    expect(renderContextPack(full.pack)).toContain('### a # injected')
    expect(renderContextPack(full.pack)).not.toMatch(/^# injected/m)
    expect(pack.inputs.length).toBeGreaterThan(0)
  })

  it('truncates inputs last with a marker', async () => {
    const s = await setup()
    const { review } = await toReview(s, 'x'.repeat(5000))
    const { pack } = await buildContextPack(deps, review.id, { maxChars: 1500 })
    const md = renderContextPack(pack)
    expect(md.length).toBe(1500)
    expect(md).toContain('…[truncated]')
    expect(md).toContain(pack.task.instructions.en)
  })

  it('shows "Changes requested" feedback from a changes round', async () => {
    const s = await setup()
    const { review } = await toReview(s)
    await run(s.pm, (ctx) => assignTask(ctx, s.pm, review.id, s.dev.id))
    await run(s.dev, (ctx) => submitTask(ctx, s.dev, review.id, { text: 'แก้ชื่อตัวแปร', attachmentIds: [], decision: 'changes' }))
    const next = await latest(s.wi, 'implement')
    expect(next.attempt).toBe(2)
    const { pack } = await buildContextPack(deps, next.id)
    expect(pack.task.feedback).toBe('แก้ชื่อตัวแปร')
    expect(renderContextPack(pack)).toMatch(/Changes requested[\s\S]*แก้ชื่อตัวแปร/)
  })
})
