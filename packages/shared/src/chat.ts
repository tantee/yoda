import { z } from 'zod'
import { Attachment } from './knowledge.js'

const uuid = z.string().uuid()

export const ConversationKind = z.enum(['personal', 'project', 'work_item', 'intake'])
export type ConversationKind = z.infer<typeof ConversationKind>

export const Conversation = z.object({
  id: uuid,
  kind: ConversationKind,
  ownerId: uuid,
  ownerName: z.string(),
  projectId: uuid.nullable(),
  workItemId: uuid.nullable(),
  title: z.string(),
  lastMessageAt: z.string().nullable(),
  unread: z.number().int(),
})
export type Conversation = z.infer<typeof Conversation>

export const AuthorKind = z.enum(['person', 'ai', 'system'])
export type AuthorKind = z.infer<typeof AuthorKind>

export const ActionCard = z.discriminatedUnion('type', [
  z.object({ type: z.literal('work_item_created'), workItemId: uuid, title: z.string() }),
  z.object({ type: z.literal('proposal'), proposalId: uuid }),
  z.object({ type: z.literal('knowledge_saved'), entryId: uuid, title: z.string() }),
  z.object({ type: z.literal('link'), label: z.string(), to: z.string() }),
])
export type ActionCard = z.infer<typeof ActionCard>

export const Message = z.object({
  id: uuid,
  conversationId: uuid,
  seq: z.number().int(),
  authorKind: AuthorKind,
  authorId: uuid.nullable(),
  authorName: z.string().nullable(),
  text: z.string(),
  attachments: z.array(Attachment),
  actions: z.array(ActionCard),
  createdAt: z.string(),
})
export type Message = z.infer<typeof Message>

export const MessageCreate = z.object({
  text: z.string().trim().min(1).max(20000),
  attachmentIds: z.array(uuid).max(10).default([]),
})
export type MessageCreate = z.infer<typeof MessageCreate>

export const ConversationCreate = z
  .object({
    kind: z.enum(['project', 'work_item']),
    projectId: uuid.optional(),
    workItemId: uuid.optional(),
    title: z.string().trim().min(1).max(200).optional(),
  })
  .superRefine((v, ctx) => {
    const bad = (message: string) => ctx.addIssue({ code: z.ZodIssueCode.custom, message })
    if (v.kind === 'project' && !v.projectId) bad('project conversation requires projectId')
    if (v.kind === 'work_item' && !v.workItemId) bad('work_item conversation requires workItemId')
  })
export type ConversationCreate = z.infer<typeof ConversationCreate>
