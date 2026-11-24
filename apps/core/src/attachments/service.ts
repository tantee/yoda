import type { Attachment } from '@yoda/shared'
import { and, desc, eq, type SQL } from 'drizzle-orm'
import type { Db } from '../db/client.js'
import { attachments, people } from '../db/schema.js'

export type AttachmentRow = typeof attachments.$inferSelect

export const MAX_UPLOAD_BYTES = 25 * 1024 * 1024

export const ALLOWED_TYPES = new Set([
  'text/plain',
  'text/markdown',
  'text/csv',
  'application/json',
  'application/pdf',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  'image/png',
  'image/jpeg',
  'image/gif',
  'image/webp',
])

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
  projectId: string
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
