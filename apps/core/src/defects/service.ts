import { DEFECT_WITHHELD_DESCRIPTION, severityPriority, type AttachmentRole, type DefectReportCreate, type Me } from '@yoda/shared'
import { eq } from 'drizzle-orm'
import { notFound } from '../auth/plugin.js'
import { attachments, defectReports, projects } from '../db/schema.js'
import { lockProject } from '../projects/access.js'
import { recordEvent, type WorkCtx } from '../work/context.js'
import { createWorkItem, memberRoles } from '../work/engine.js'

/** A file already put in storage under `projects/<projectId>/defects/…`, about to get its attachment row. */
export type StoredDefectFile = { role: AttachmentRole; storageKey: string; fileName: string; contentType: string; sizeBytes: number }

export type DefectMeta = { grantId: string | null; extensionVersion: string | null; idempotencyKey: string | null }

/** The withheld-text marker, Thai first, as every fixed text the portal writes into stored content. */
export const WITHHELD_DESCRIPTION = `${DEFECT_WITHHELD_DESCRIPTION.th}\n${DEFECT_WITHHELD_DESCRIPTION.en}`

/** The work item description of a report that may go to AI: the tester's text in one readable block. */
export function composeDescription(r: Pick<DefectReportCreate, 'description' | 'steps' | 'expected' | 'actual' | 'page'>): string {
  const parts: string[] = []
  if (r.description.trim()) parts.push(r.description.trim())
  if (r.steps.length) parts.push(['ขั้นตอน / Steps', ...r.steps.map((s, i) => `${i + 1}. ${s}`)].join('\n'))
  if (r.expected.trim()) parts.push(`ผลที่คาดไว้ / Expected:\n${r.expected.trim()}`)
  if (r.actual.trim()) parts.push(`ผลที่เกิดขึ้น / Actual:\n${r.actual.trim()}`)
  parts.push(`หน้า / Page: ${r.page.url}`)
  return parts.join('\n\n')
}

/**
 * Files a defect report as a work item (Yoda Reporter): the item, its `defect_reports` row and one noAi attachment
 * row per stored file, in the caller's transaction. Only staff members of the project report (admins too need
 * to be members: plan decision 13); anyone else gets 404. A sensitive report (the tester's flag, or a noAi
 * project) keeps its text only in `defect_reports`.
 */
export async function createDefect(
  ctx: WorkCtx,
  me: Me,
  input: DefectReportCreate,
  files: StoredDefectFile[],
  meta: DefectMeta,
): Promise<{ workItemId: string }> {
  const { tx } = ctx
  await lockProject(tx, input.projectId, 'share')
  const [project] = await tx.select({ noAi: projects.noAi, status: projects.status }).from(projects).where(eq(projects.id, input.projectId))
  if (!project || project.status !== 'active' || !me.isStaff || !(await memberRoles(tx, input.projectId, me.id))) throw notFound()
  const sensitive = input.privacy.textMayContainPatientData || project.noAi

  const workItemId = await createWorkItem(
    ctx,
    me,
    input.projectId,
    {
      title: input.title,
      description: sensitive ? WITHHELD_DESCRIPTION : composeDescription(input),
      templateKey: input.kind === 'bug_fix_request' ? 'bug-fix' : 'defect',
      priority: severityPriority(input.severity),
      ownerId: me.id,
      requesterId: me.id,
    },
    { allowExtensionOnly: true },
  )

  await tx.insert(defectReports).values({
    workItemId,
    kind: input.kind,
    severity: input.severity,
    description: input.description,
    steps: input.steps,
    expected: input.expected,
    actual: input.actual,
    pageUrl: input.page.url,
    pageTitle: input.page.title,
    route: input.page.route ?? null,
    build: input.build ?? null,
    backendBuilds: input.backendBuilds,
    client: input.client,
    capturedAt: new Date(input.capturedAt),
    reportedBy: me.id,
    source: 'extension',
    extensionVersion: meta.extensionVersion,
    grantId: meta.grantId,
    productionSite: input.privacy.productionSite,
    textMayContainPatientData: input.privacy.textMayContainPatientData,
    sensitive,
    idempotencyKey: meta.idempotencyKey,
  })

  // Media and logs are never AI material: noAi always, and no knowledge entry (the onStored hook is not called).
  if (files.length) {
    await tx.insert(attachments).values(
      files.map((f) => ({
        projectId: input.projectId,
        workItemId,
        storageKey: f.storageKey,
        fileName: f.fileName,
        contentType: f.contentType,
        sizeBytes: f.sizeBytes,
        noAi: true,
        role: f.role,
        uploadedBy: me.id,
      })),
    )
  }

  await recordEvent(ctx, {
    type: 'defect.reported',
    projectId: input.projectId,
    workItemId,
    taskId: null,
    payload: {
      source: 'extension',
      extensionVersion: meta.extensionVersion,
      grantId: meta.grantId,
      kind: input.kind,
      severity: input.severity,
      files: files.map((f) => ({ role: f.role, sizeBytes: f.sizeBytes })),
      productionSite: input.privacy.productionSite,
      aiAllowed: !sensitive,
    },
  })
  return { workItemId }
}
