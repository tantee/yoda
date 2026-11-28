import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { DEFECT_WITHHELD_DESCRIPTION, validateTemplate, WorkflowTemplateDef, type Me } from '@yoda/shared'
import { eq } from 'drizzle-orm'
import type { FastifyInstance } from 'fastify'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { buildApp, type AppDeps } from '../src/app.js'
import { attachments, defectReports, events, knowledgeEntries, projects, tasks, workflowTemplates, workItems } from '../src/db/schema.js'
import { createDefect, type StoredDefectFile } from '../src/defects/service.js'
import { personAsMe } from '../src/proposals/service.js'
import { secretaryTools } from '../src/secretary/tools.js'
import { runWork } from '../src/work/context.js'
import { listTemplates } from '../src/work/queries.js'
import { makeProject, sampleReport } from './defect-fixtures.js'
import { resetDb, testDb, testDeps } from './helpers.js'
import { auth, login, type Who } from './support.js'

let deps: AppDeps
let app: FastifyInstance
let admin: Who
let qc: Who
let dev: Who
let projectId: string

beforeEach(async () => {
  await resetDb(await testDb())
  deps = await testDeps()
  app = await buildApp({ ...deps, config: { ...deps.config, bootstrapAdmins: ['boss'] } })
  admin = await login(app, 'boss')
  qc = await login(app, 'qc', { staff: true, name: 'คุณคิวซี' })
  dev = await login(app, 'dev', { staff: true, name: 'คุณเดฟ' })
  projectId = await makeProject(app, admin, 'OPD', [
    [qc, ['QC']],
    [dev, ['DEV']],
  ])
})
afterEach(async () => {
  await app.close()
})

const me = async (who: Who): Promise<Me> => (await personAsMe(deps.db, who.id))!
const files: StoredDefectFile[] = [
  { role: 'screenshot', storageKey: 'projects/p/defects/x/screenshot.png', fileName: 'screenshot.png', contentType: 'image/png', sizeBytes: 1000 },
  { role: 'video', storageKey: 'projects/p/defects/x/clip.webm', fileName: 'clip.webm', contentType: 'video/webm', sizeBytes: 5000 },
  { role: 'console', storageKey: 'projects/p/defects/x/console.json', fileName: 'console.json', contentType: 'application/json', sizeBytes: 200 },
]
const meta = { grantId: null, extensionVersion: '1.1.0', idempotencyKey: randomUUID() }

async function report(who: Who, o: Parameters<typeof sampleReport>[1] = {}, f: StoredDefectFile[] = files): Promise<string> {
  const m = await me(who)
  const { workItemId } = await runWork(deps, { id: m.id, kind: 'person' }, (ctx) => createDefect(ctx, m, sampleReport(projectId, o), f, meta))
  return workItemId
}

describe('the defect template', () => {
  it('defect.json passes validateTemplate and seeds', async () => {
    const def = WorkflowTemplateDef.parse(
      JSON.parse(readFileSync(fileURLToPath(new URL('../src/workflow/templates/defect.json', import.meta.url)), 'utf8')),
    )
    expect(validateTemplate(def)).toEqual([])
    expect(def.steps.map((s) => s.key)).toEqual(['triage', 'fix', 'verify'])
    expect(def.steps.flatMap((s) => s.tasks).every((t) => t.type !== 'ai')).toBe(true)
    const [row] = await deps.db.select().from(workflowTemplates).where(eq(workflowTemplates.key, 'defect'))
    expect(row).toBeDefined()
  })

  it('listTemplates omits defect', async () => {
    expect((await listTemplates(deps.db)).map((t) => t.key)).not.toContain('defect')
  })

  it('POST /projects/:id/work-items with templateKey defect is 422 extension_only_template', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/projects/${projectId}/work-items`,
      headers: auth(qc),
      payload: { title: 'x', templateKey: 'defect' },
    })
    expect(res.statusCode).toBe(422)
    expect(res.json()).toMatchObject({ error: 'invalid_state', reason: 'extension_only_template' })
  })
})

describe('the secretary', () => {
  it("the secretary's create tools refuse defect", async () => {
    const tools = secretaryTools({ db: deps.db, ai: deps.ai }, await me(qc), [])
    const input = { projectId, title: 'x', description: '', templateKey: 'defect', priority: 'normal' }
    await expect(tools.propose_work_item!.execute!(input as never, { toolCallId: 'p', messages: [], context: {} } as never)).rejects.toThrow(
      /Yoda Reporter/,
    )
  })
})

describe('createDefect', () => {
  it('makes a triage-step item owned and requested by the reporter, priority from severity', async () => {
    const id = await report(qc, { severity: 'critical' })
    const [w] = await deps.db.select().from(workItems).where(eq(workItems.id, id))
    expect(w).toMatchObject({ ownerId: qc.id, requesterId: qc.id, createdBy: qc.id, priority: 'urgent', currentStepKey: 'triage', title: 'ปุ่มบันทึกไม่ทำงาน' })
    const [t] = await deps.db.select().from(workflowTemplates).where(eq(workflowTemplates.id, w!.templateId))
    expect(t!.key).toBe('defect')
    const open = await deps.db.select().from(tasks).where(eq(tasks.workItemId, id))
    expect(open.map((x) => x.templateTaskKey)).toEqual(['triage-defect'])
    // Not sensitive: the composed text is the description.
    expect(w!.description).toContain('กดแล้วไม่มีอะไรเกิดขึ้น')
    expect(w!.description).toContain('กดบันทึก')
    expect(w!.description).toContain('บันทึกสำเร็จ')
  })

  it('bug_fix_request uses the bug-fix template', async () => {
    const id = await report(qc, { kind: 'bug_fix_request', severity: 'trivial' })
    const [w] = await deps.db.select({ key: workflowTemplates.key, priority: workItems.priority }).from(workItems)
      .innerJoin(workflowTemplates, eq(workflowTemplates.id, workItems.templateId)).where(eq(workItems.id, id))
    expect(w).toEqual({ key: 'bug-fix', priority: 'low' })
    const [d] = await deps.db.select().from(defectReports).where(eq(defectReports.workItemId, id))
    expect(d!.kind).toBe('bug_fix_request')
  })

  it('every attachment row is noAi and has its role; no knowledge entry is created', async () => {
    const id = await report(qc)
    const rows = await deps.db.select().from(attachments).where(eq(attachments.workItemId, id))
    expect(rows.map((r) => [r.role, r.noAi, r.projectId, r.uploadedBy]).sort()).toEqual(
      [['console', true, projectId, qc.id], ['screenshot', true, projectId, qc.id], ['video', true, projectId, qc.id]].sort(),
    )
    expect(await deps.db.select().from(knowledgeEntries)).toEqual([])
  })

  it('the event payload holds no text from the report', async () => {
    const id = await report(qc)
    const [e] = await deps.db.select().from(events).where(eq(events.type, 'defect.reported'))
    expect(e!.workItemId).toBe(id)
    expect(e!.payload).toEqual({
      source: 'extension',
      extensionVersion: '1.1.0',
      grantId: null,
      kind: 'defect',
      severity: 'major',
      files: [{ role: 'screenshot', sizeBytes: 1000 }, { role: 'video', sizeBytes: 5000 }, { role: 'console', sizeBytes: 200 }],
      productionSite: false,
      aiAllowed: true,
    })
    const text = JSON.stringify(await deps.db.select().from(events).where(eq(events.workItemId, id)))
    for (const s of ['ปุ่มบันทึก', 'กดแล้ว', 'บันทึกสำเร็จ', 'opd?visit']) expect(text).not.toContain(s)
  })

  it('a sensitive report keeps the text in defect_reports and the marker in work_items.description', async () => {
    const id = await report(qc, { privacy: { confirmedNoPatientData: true, productionSite: false, textMayContainPatientData: true } })
    const [w] = await deps.db.select().from(workItems).where(eq(workItems.id, id))
    expect(w!.description).toBe(`${DEFECT_WITHHELD_DESCRIPTION.th}\n${DEFECT_WITHHELD_DESCRIPTION.en}`)
    expect(w!.title).toBe('ปุ่มบันทึกไม่ทำงาน')
    const [d] = await deps.db.select().from(defectReports).where(eq(defectReports.workItemId, id))
    expect(d).toMatchObject({
      sensitive: true,
      textMayContainPatientData: true,
      description: 'กดแล้วไม่มีอะไรเกิดขึ้น',
      steps: ['เปิดหน้า OPD', 'กดบันทึก'],
      expected: 'บันทึกสำเร็จ',
      actual: 'ไม่มีอะไรเกิดขึ้น',
      pageUrl: 'https://app.example.org/opd?visit=12',
      reportedBy: qc.id,
      idempotencyKey: meta.idempotencyKey,
    })
    const [e] = await deps.db.select().from(events).where(eq(events.type, 'defect.reported'))
    expect(e!.payload).toMatchObject({ aiAllowed: false })
  })

  it('a noAi project makes every report sensitive', async () => {
    await deps.db.update(projects).set({ noAi: true }).where(eq(projects.id, projectId))
    const id = await report(qc)
    const [d] = await deps.db.select().from(defectReports).where(eq(defectReports.workItemId, id))
    expect(d).toMatchObject({ sensitive: true, textMayContainPatientData: false })
    const [w] = await deps.db.select().from(workItems).where(eq(workItems.id, id))
    expect(w!.description).toContain(DEFECT_WITHHELD_DESCRIPTION.en)
  })

  it('a staff non-member, and an admin who is not a member, get 404 and nothing is stored', async () => {
    const outsider = await login(app, 'outsider', { staff: true })
    await expect(report(outsider)).rejects.toMatchObject({ statusCode: 404 })
    await expect(report(admin)).rejects.toMatchObject({ statusCode: 404 })
    expect(await deps.db.select().from(defectReports)).toEqual([])
  })

  it('the work item detail carries the defect view, with the real text for a sensitive report', async () => {
    const id = await report(qc, { privacy: { confirmedNoPatientData: true, productionSite: false, textMayContainPatientData: true } })
    const res = await app.inject({ url: `/work-items/${id}`, headers: auth(dev) })
    expect(res.statusCode).toBe(200)
    expect(res.json().defect).toMatchObject({
      kind: 'defect',
      severity: 'major',
      description: 'กดแล้วไม่มีอะไรเกิดขึ้น',
      steps: ['เปิดหน้า OPD', 'กดบันทึก'],
      page: { url: 'https://app.example.org/opd?visit=12', title: 'OPD', route: '/opd' },
      build: { repo: 'his/opd-web', commit: 'a1b2c3d', source: 'meta' },
      reportedBy: { id: qc.id, displayName: 'คุณคิวซี' },
      source: 'extension',
      sensitive: true,
      textMayContainPatientData: true,
    })
    const list = await app.inject({ url: `/projects/${projectId}/attachments`, headers: auth(dev) })
    expect(list.statusCode).toBe(200)
    expect((list.json() as { role: string | null; noAi: boolean }[]).map((a) => [a.role, a.noAi]).sort()).toEqual([
      ['console', true],
      ['screenshot', true],
      ['video', true],
    ])
  })

  it('an ordinary work item has defect: null', async () => {
    const created = await app.inject({ method: 'POST', url: `/projects/${projectId}/work-items`, headers: auth(qc), payload: { title: 'x', templateKey: 'bug-fix' } })
    expect(created.statusCode).toBe(201)
    const res = await app.inject({ url: `/work-items/${created.json().id}`, headers: auth(qc) })
    expect(res.json().defect).toBeNull()
  })
})
