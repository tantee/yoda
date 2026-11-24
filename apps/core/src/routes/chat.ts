import { ConversationCreate, MessageCreate } from '@yoda/shared'
import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { requireSignedIn, requireStaff } from '../auth/plugin.js'
import {
  checkMessageAttachments,
  createConversation,
  ensurePersonalConversation,
  getConversation,
  getMessage,
  listConversations,
  listMessages,
  markRead,
  postMessage,
  requireConversation,
} from '../chat/service.js'
import { runWork } from '../work/context.js'

const IdParams = z.object({ id: z.string().uuid() })
const Page = z.object({
  before: z.coerce.number().int().positive().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
})
const Read = z.object({ seq: z.number().int().min(0) })

/** Chat for staff and requesters; every route only reaches conversations the caller can see (else 404). */
export function chatRoutes(app: FastifyInstance): void {
  const db = () => app.deps.db

  app.get('/conversations', async (request) => {
    requireSignedIn(request)
    return listConversations(db(), request.me)
  })

  app.get('/conversations/personal', async (request) => {
    requireSignedIn(request)
    const id = await ensurePersonalConversation(db(), request.me)
    return getConversation(db(), request.me, id)
  })

  app.post('/conversations', async (request, reply) => {
    requireStaff(request)
    const body = ConversationCreate.parse(request.body)
    const id = await createConversation(db(), request.me, body)
    return reply.status(201).send(await getConversation(db(), request.me, id))
  })

  app.get('/conversations/:id/messages', async (request) => {
    requireSignedIn(request)
    const { id } = IdParams.parse(request.params)
    const page = Page.parse(request.query)
    await requireConversation(db(), request.me, id)
    return listMessages(db(), request.me, id, page)
  })

  app.post('/conversations/:id/messages', async (request, reply) => {
    requireSignedIn(request)
    const { id } = IdParams.parse(request.params)
    const me = request.me
    const conversation = await requireConversation(db(), me, id)
    const body = MessageCreate.parse(request.body)
    await checkMessageAttachments(db(), me, conversation, body.attachmentIds)
    const messageId = await runWork(app.deps, { id: me.id, kind: 'person' }, (ctx) =>
      postMessage(ctx, { conversationId: id, authorKind: 'person', authorId: me.id, text: body.text, attachmentIds: body.attachmentIds }),
    )
    return reply.status(201).send(await getMessage(db(), me, messageId))
  })

  app.post('/conversations/:id/read', async (request, reply) => {
    requireSignedIn(request)
    const { id } = IdParams.parse(request.params)
    await requireConversation(db(), request.me, id)
    const { seq } = Read.parse(request.body)
    await markRead(db(), request.me, id, seq)
    return reply.status(204).send()
  })
}
