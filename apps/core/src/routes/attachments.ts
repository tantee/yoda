import { randomUUID } from 'node:crypto'
import { and, eq } from 'drizzle-orm'
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import { z } from 'zod'
import { forbidden, HttpError, invalidState, notFound, requireSignedIn, requireStaff, tooLarge, unsupportedType } from '../auth/plugin.js'
import { attachmentInConversation, requireConversation } from '../chat/service.js'
import { extractText } from '../attachments/extract.js'
import {
  ALLOWED_TYPES,
  getAttachment,
  listAttachments,
  sanitizeFileName,
  type AttachmentStoredHook,
} from '../attachments/service.js'
import { attachments, tasks, workItems } from '../db/schema.js'
import { purgeOne } from '../defects/retention.js'
import { canManageProject } from '../projects/access.js'
import { propagateAttachmentNoAi } from '../knowledge/service.js'
import { runWork } from '../work/context.js'
import { canSeeProject } from '../work/queries.js'

const IdParams = z.object({ id: z.string().uuid() })
const ListQuery = z.object({ workItemId: z.string().uuid().optional(), taskId: z.string().uuid().optional() })
const Patch = z.object({ noAi: z.boolean() })
const RemoveBody = z.object({ reason: z.string().trim().min(1).max(500) })
const OptionalUuid = z.string().uuid().optional()
const ConversationFileParams = z.object({ conversationId: z.string().uuid(), id: z.string().uuid() })

type Upload = { name: string; type: string; buf: Buffer }

export function attachmentRoutes(app: FastifyInstance, opts: { onStored: AttachmentStoredHook }): void {
  const db = () => app.deps.db
  const storage = () => app.deps.storage

  /** Reads the single `file` part (type-checked, size-limited by the multipart plugin) and the text fields. */
  async function readUpload(request: FastifyRequest): Promise<{ file: Upload; fields: Record<string, string> }> {
    if (!request.isMultipart()) throw unsupportedType()
    let file: Upload | undefined
    const fields: Record<string, string> = {}
    try {
      for await (const part of request.parts()) {
        if (part.type === 'file') {
          if (file || part.fieldname !== 'file') {
            part.file.resume()
            continue
          }
          const type = part.mimetype.split(';')[0].trim().toLowerCase()
          if (!ALLOWED_TYPES.has(type)) {
            part.file.resume()
            throw unsupportedType()
          }
          file = { name: part.filename, type, buf: await part.toBuffer() }
        } else if (typeof part.value === 'string') {
          fields[part.fieldname] = part.value
        }
      }
    } catch (err) {
      if ((err as { code?: string }).code === 'FST_REQ_FILE_TOO_LARGE') throw tooLarge()
      throw err
    }
    if (!file) throw z.ZodError.create([{ code: 'custom', path: ['file'], message: 'file is required' }])
    return { file, fields }
  }

  /** Extracts text, stores the bytes under `<prefix>/<uuid>/<name>` and inserts the row (removing the bytes on failure). */
  async function storeUpload(
    prefix: string,
    file: Upload,
    values: Pick<typeof attachments.$inferInsert, 'projectId' | 'conversationId' | 'workItemId' | 'taskId' | 'noAi' | 'uploadedBy'>,
  ): Promise<{ row: typeof attachments.$inferSelect; text: string | null }> {
    const fileName = sanitizeFileName(file.name)
    const storageKey = `${prefix}/${randomUUID()}/${fileName}`
    const text = await extractText(file.buf, file.type, fileName)
    await storage().put(storageKey, file.buf, file.type)
    try {
      const [row] = await db()
        .insert(attachments)
        .values({ ...values, storageKey, fileName, contentType: file.type, sizeBytes: file.buf.length, extractedText: text })
        .returning()
      return { row: row!, text }
    } catch (err) {
      await storage().remove(storageKey).catch(() => {})
      throw err
    }
  }

  /** Every download path: a removed or expired defect file is 404 `purged` (the row stays, the bytes are gone). */
  async function sendFile(reply: FastifyReply, row: typeof attachments.$inferSelect) {
    if (row.purgedAt) throw new HttpError(404, { error: 'not_found', reason: 'purged' })
    const stream = await storage().get(row.storageKey)
    return reply
      .header('Content-Type', row.contentType)
      .header('X-Content-Type-Options', 'nosniff')
      .header('Content-Disposition', `attachment; filename*=UTF-8''${encodeRFC5987(row.fileName)}`)
      .send(stream)
  }

  app.post('/projects/:id/attachments', async (request, reply) => {
    requireStaff(request)
    const { id: projectId } = IdParams.parse(request.params)
    const me = request.me
    if (!(await canSeeProject(db(), me, projectId))) throw notFound()
    const { file, fields } = await readUpload(request)

    const workItemId = OptionalUuid.parse(fields.workItemId || undefined)
    const taskId = OptionalUuid.parse(fields.taskId || undefined)
    const noAi = z.enum(['true', 'false']).optional().parse(fields.noAi || undefined) === 'true'
    if (workItemId) {
      const [w] = await db()
        .select({ id: workItems.id })
        .from(workItems)
        .where(and(eq(workItems.id, workItemId), eq(workItems.projectId, projectId)))
      if (!w) throw notFound()
    }
    if (taskId) {
      const [t] = await db()
        .select({ id: tasks.id })
        .from(tasks)
        .where(and(eq(tasks.id, taskId), eq(tasks.projectId, projectId), workItemId ? eq(tasks.workItemId, workItemId) : undefined))
      if (!t) throw notFound()
    }

    const { row, text } = await storeUpload(`projects/${projectId}`, file, {
      projectId,
      workItemId: workItemId ?? null,
      taskId: taskId ?? null,
      noAi,
      uploadedBy: me.id,
    })
    await opts.onStored(row, text)
    return reply.status(201).send(await getAttachment(db(), row.id))
  })

  /**
   * Chat uploads: no knowledge entry; `project_id` / `work_item_id` are the conversation's (null for
   * personal/intake).
   */
  app.post('/conversations/:id/attachments', async (request, reply) => {
    requireSignedIn(request)
    const { id: conversationId } = IdParams.parse(request.params)
    const me = request.me
    const conversation = await requireConversation(db(), me, conversationId)
    const { file, fields } = await readUpload(request)
    const noAi = z.enum(['true', 'false']).optional().parse(fields.noAi || undefined) === 'true'
    const { row } = await storeUpload(`conversations/${conversationId}`, file, {
      projectId: conversation.projectId,
      workItemId: conversation.workItemId,
      conversationId,
      noAi,
      uploadedBy: me.id,
    })
    return reply.status(201).send(await getAttachment(db(), row.id))
  })

  app.get('/conversations/:conversationId/attachments/:id/download', async (request, reply) => {
    requireSignedIn(request)
    const { conversationId, id } = ConversationFileParams.parse(request.params)
    const conversation = await requireConversation(db(), request.me, conversationId)
    if (!(await attachmentInConversation(db(), conversation, id))) throw notFound()
    const [row] = await db().select().from(attachments).where(eq(attachments.id, id))
    if (!row) throw notFound()
    return sendFile(reply, row)
  })

  app.get('/projects/:id/attachments', async (request) => {
    requireStaff(request)
    const { id } = IdParams.parse(request.params)
    const q = ListQuery.parse(request.query)
    if (!(await canSeeProject(db(), request.me, id))) throw notFound()
    return listAttachments(db(), id, q)
  })

  app.get('/attachments/:id/download', async (request, reply) => {
    requireStaff(request)
    const { id } = IdParams.parse(request.params)
    const [row] = await db().select().from(attachments).where(eq(attachments.id, id))
    if (!row?.projectId || !(await canSeeProject(db(), request.me, row.projectId))) throw notFound()
    return sendFile(reply, row)
  })

  /**
   * Removes a defect file (Yoda Reporter): the uploader, the project's PM or an admin, with a reason. The row
   * stays, marked purged; other uploads cannot be removed this way (409 `not_defect_attachment`).
   */
  app.delete('/attachments/:id', async (request, reply) => {
    requireStaff(request)
    const { id } = IdParams.parse(request.params)
    const { reason } = RemoveBody.parse(request.body ?? {})
    const me = request.me
    const [row] = await db().select().from(attachments).where(eq(attachments.id, id))
    if (!row?.projectId || !(await canSeeProject(db(), me, row.projectId))) throw notFound()
    if (!row.role) throw invalidState('not_defect_attachment')
    if (row.uploadedBy !== me.id && !(await canManageProject(db(), me, row.projectId))) throw forbidden()
    await purgeOne(app.deps, id, { kind: 'person', personId: me.id, reason })
    return reply.status(204).send()
  })

  app.patch('/attachments/:id', async (request) => {
    requireStaff(request)
    const { id } = IdParams.parse(request.params)
    const body = Patch.parse(request.body)
    const me = request.me
    const [row] = await db().select().from(attachments).where(eq(attachments.id, id))
    if (!row?.projectId || !(await canSeeProject(db(), me, row.projectId))) throw notFound()
    if (row.uploadedBy !== me.id && !(await canManageProject(db(), me, row.projectId))) throw forbidden()
    // Defect files are media and logs: never AI material (plan decision 6).
    if (row.role) {
      if (!body.noAi) throw new HttpError(409, { error: 'invalid_state', reason: 'defect_files_never_ai' })
      return getAttachment(db(), id)
    }
    await runWork(app.deps, { id: me.id, kind: 'person' }, async (ctx) => {
      await ctx.tx.update(attachments).set({ noAi: body.noAi }).where(eq(attachments.id, id))
      // In place on the current entry: a handling flag, not a content change (see propagateAttachmentNoAi).
      await propagateAttachmentNoAi(ctx, id, body.noAi)
    })
    return getAttachment(db(), id)
  })
}

function encodeRFC5987(name: string): string {
  return encodeURIComponent(name).replace(/['()*]/g, (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase())
}
