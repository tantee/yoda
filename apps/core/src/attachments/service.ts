import { MAX_UPLOAD_BYTES, UPLOAD_ALLOWED_TYPES, type Attachment } from '@yoda/shared'
import { and, asc, desc, eq, inArray, type SQL } from 'drizzle-orm'
import type { Db, Tx } from '../db/client.js'
import { attachments, people } from '../db/schema.js'

export type AttachmentRow = typeof attachments.$inferSelect

export { MAX_UPLOAD_BYTES }

export const ALLOWED_TYPES: ReadonlySet<string> = new Set(UPLOAD_ALLOWED_TYPES)

/** Called after the attachment row is committed; wired per app in buildApp (default: knowledge entry). */
export type AttachmentStoredHook = (attachment: AttachmentRow, extractedText: string | null) => Promise<void>

/** Storage-key-safe file name: no path separators or control characters, bounded length; Thai is kept. */
export function sanitizeFileName(name: string): string {
  const base = name.split(/[\\/]/).pop() ?? ''
  const clean = base
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .replace(/^\.+/, '')
    .trim()
    .slice(0, 120)
  return clean || 'file'
}

const columns = {
  id: attachments.id,
  projectId: attachments.projectId,
  workItemId: attachments.workItemId,
  taskId: attachments.taskId,
  fileName: attachments.fileName,
  contentType: attachments.contentType,
  sizeBytes: attachments.sizeBytes,
  noAi: attachments.noAi,
  hasText: attachments.extractedText,
  uploadedById: attachments.uploadedBy,
  uploadedByName: people.displayName,
  createdAt: attachments.createdAt,
}

function toAttachment(r: {
  id: string
  projectId: string | null
  workItemId: string | null
  taskId: string | null
  fileName: string
  contentType: string
  sizeBytes: number
  noAi: boolean
  hasText: string | null
  uploadedById: string
  uploadedByName: string
  createdAt: Date
}): Attachment {
  return { ...r, hasText: r.hasText != null, createdAt: r.createdAt.toISOString() }
}

export async function getAttachment(db: Db, id: string): Promise<Attachment | null> {
  const [r] = await db
    .select(columns)
    .from(attachments)
    .innerJoin(people, eq(people.id, attachments.uploadedBy))
    .where(eq(attachments.id, id))
  return r ? toAttachment(r) : null
}

export async function listAttachments(
  db: Db,
  projectId: string,
  filter: { workItemId?: string; taskId?: string },
): Promise<Attachment[]> {
  const conds: SQL[] = [eq(attachments.projectId, projectId)]
  if (filter.workItemId) conds.push(eq(attachments.workItemId, filter.workItemId))
  if (filter.taskId) conds.push(eq(attachments.taskId, filter.taskId))
  const rows = await db
    .select(columns)
    .from(attachments)
    .innerJoin(people, eq(people.id, attachments.uploadedBy))
    .where(and(...conds))
    .orderBy(desc(attachments.createdAt), desc(attachments.id))
  return rows.map(toAttachment)
}

/** Attachments linked to each of the given tasks, oldest first. */
export async function attachmentsByTask(db: Db | Tx, taskIds: string[]): Promise<Map<string, Attachment[]>> {
  const out = new Map<string, Attachment[]>()
  const ids = [...new Set(taskIds)]
  if (!ids.length) return out
  const rows = await db
    .select(columns)
    .from(attachments)
    .innerJoin(people, eq(people.id, attachments.uploadedBy))
    .where(inArray(attachments.taskId, ids))
    .orderBy(asc(attachments.createdAt), asc(attachments.id))
  for (const r of rows) {
    const list = out.get(r.taskId!) ?? []
    list.push(toAttachment(r))
    out.set(r.taskId!, list)
  }
  return out
}
