import { z } from 'zod'

const uuid = z.string().uuid()

export const KnowledgeType = z.enum(['fact', 'decision', 'document', 'progress', 'memory'])
export type KnowledgeType = z.infer<typeof KnowledgeType>
export const KnowledgeStatus = z.enum(['draft', 'confirmed'])
export type KnowledgeStatus = z.infer<typeof KnowledgeStatus>
export const KnowledgeScope = z.enum(['department', 'project', 'work_item'])
export type KnowledgeScope = z.infer<typeof KnowledgeScope>
export const SourceKind = z.enum(['person', 'ai', 'upload', 'task'])
export type SourceKind = z.infer<typeof SourceKind>

export const KnowledgeEntry = z.object({
  id: uuid,
  lineageId: uuid,
  version: z.number().int(),
  scope: KnowledgeScope,
  projectId: uuid.nullable(),
  workItemId: uuid.nullable(),
  type: KnowledgeType,
  title: z.string(),
  body: z.string(),
  status: KnowledgeStatus,
  sourceKind: SourceKind,
  sourceRef: z.string().nullable(),
  noAi: z.boolean(),
  attachmentId: uuid.nullable(),
  createdById: uuid.nullable(),
  createdByName: z.string().nullable(),
  createdAt: z.string(),
})
export type KnowledgeEntry = z.infer<typeof KnowledgeEntry>

export const KnowledgeCreate = z
  .object({
    scope: KnowledgeScope,
    projectId: uuid.optional(),
    workItemId: uuid.optional(),
    type: KnowledgeType,
    title: z.string().trim().min(1).max(300),
    body: z.string().max(200000).default(''),
    noAi: z.boolean().default(false),
  })
  .superRefine((v, ctx) => {
    const bad = (message: string) => ctx.addIssue({ code: z.ZodIssueCode.custom, message })
    if (v.scope === 'department' && (v.projectId || v.workItemId)) bad('department scope takes no projectId or workItemId')
    if (v.scope === 'project' && !v.projectId) bad('project scope requires projectId')
    if (v.scope === 'work_item' && !v.workItemId) bad('work_item scope requires workItemId')
  })
export type KnowledgeCreate = z.infer<typeof KnowledgeCreate>

export const KnowledgeUpdate = z
  .object({
    title: z.string().trim().min(1).max(300),
    body: z.string().max(200000),
    noAi: z.boolean(),
  })
  .partial()
  .refine((v) => Object.keys(v).length > 0, { message: 'at least one field is required' })
export type KnowledgeUpdate = z.infer<typeof KnowledgeUpdate>

export const KnowledgeSearchHit = KnowledgeEntry.extend({ score: z.number(), snippet: z.string() })
export type KnowledgeSearchHit = z.infer<typeof KnowledgeSearchHit>

export const Attachment = z.object({
  id: uuid,
  projectId: uuid,
  workItemId: uuid.nullable(),
  taskId: uuid.nullable(),
  fileName: z.string(),
  contentType: z.string(),
  sizeBytes: z.number().int(),
  noAi: z.boolean(),
  hasText: z.boolean(),
  uploadedById: uuid,
  uploadedByName: z.string(),
  createdAt: z.string(),
})
export type Attachment = z.infer<typeof Attachment>

export const AiUsage = z.object({
  month: z.string(),
  costUsd: z.number(),
  budgetUsd: z.number().nullable(),
  calls: z.number().int(),
})
export type AiUsage = z.infer<typeof AiUsage>
