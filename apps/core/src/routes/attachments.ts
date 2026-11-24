import { randomUUID } from 'node:crypto'
import { and, eq } from 'drizzle-orm'
import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { forbidden, notFound, requireStaff, tooLarge, unsupportedType } from '../auth/plugin.js'
import { extractText } from '../attachments/extract.js'
import {
  ALLOWED_TYPES,
  getAttachment,
  listAttachments,
  runOnAttachmentStored,
  sanitizeFileName,
} from '../attachments/service.js'
import { attachments, tasks, workItems } from '../db/schema.js'
import { canManageProject } from '../projects/access.js'
import { canSeeProject } from '../work/queries.js'

const IdParams = z.object({ id: z.string().uuid() })
const ListQuery = z.object({ workItemId: z.string().uuid().optional(), taskId: z.string().uuid().optional() })
const Patch = z.object({ noAi: z.boolean() })
const OptionalUuid = z.string().uuid().optional()

export function attachmentRoutes(app: FastifyInstance): void {
  const db = () => app.deps.db
  const storage = () => app.deps.storage

  app.post('/projects/:id/attachments', async (request, reply) => {
    requireStaff(request)
    const { id: projectId } = IdParams.parse(request.params)
    const me = request.me
    if (!(await canSeeProject(db(), me, projectId))) throw notFound()
    if (!request.isMultipart()) throw unsupportedType()

    let file: { name: string; type: string; buf: Buffer } | undefined
    const fields: Record<string, string> = {}
    try {
      for await (const part of request.parts()) {
        if (part.type === 'file') {
          if (file) {
            part.file.resume()
            continue
          }
          if (part.fieldname !== 'file') {
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
        .where(and(eq(tasks.id, taskId), eq(tasks.projectId, projectId)))
      if (!t) throw notFound()
    }

    const fileName = sanitizeFileName(file.name)
    const storageKey = `projects/${projectId}/${randomUUID()}/${fileName}`
    const text = await extractText(file.buf, file.type, fileName)
    await storage().put(storageKey, file.buf, file.type)
    let row: typeof attachments.$inferSelect
    try {
      ;[row] = await db()
        .insert(attachments)
        .values({
          projectId,
          workItemId: workItemId ?? null,
          taskId: taskId ?? null,
          storageKey,
          fileName,
          contentType: file.type,
          sizeBytes: file.buf.length,
          noAi,
          extractedText: text,
          uploadedBy: me.id,
        })
        .returning()
    } catch (err) {
      await storage().remove(storageKey).catch(() => {})
      throw err
    }
    await runOnAttachmentStored(row, text)
    return reply.status(201).send(await getAttachment(db(), row.id))
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
    if (!row || !(await canSeeProject(db(), request.me, row.projectId))) throw notFound()
    const stream = await storage().get(row.storageKey)
    return reply
      .header('Content-Type', row.contentType)
      .header('Content-Disposition', `attachment; filename*=UTF-8''${encodeRFC5987(row.fileName)}`)
      .send(stream)
  })

  app.patch('/attachments/:id', async (request) => {
    requireStaff(request)
    const { id } = IdParams.parse(request.params)
    const body = Patch.parse(request.body)
    const me = request.me
    const [row] = await db().select().from(attachments).where(eq(attachments.id, id))
    if (!row || !(await canSeeProject(db(), me, row.projectId))) throw notFound()
    if (row.uploadedBy !== me.id && !(await canManageProject(db(), me, row.projectId))) throw forbidden()
    await db().update(attachments).set({ noAi: body.noAi }).where(eq(attachments.id, id))
    // TODO(task 5): propagate to the knowledge entry via the knowledge service.
    return getAttachment(db(), id)
  })
}

function encodeRFC5987(name: string): string {
  return encodeURIComponent(name).replace(/['()*]/g, (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase())
}
