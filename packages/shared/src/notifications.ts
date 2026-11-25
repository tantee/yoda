import { z } from 'zod'

const uuid = z.string().uuid()

export const NotificationKind = z.enum(['task_assigned', 'proposal_pending', 'request_update', 'work_item_stuck', 'secretary_message', 'budget_alert'])
export type NotificationKind = z.infer<typeof NotificationKind>

export const Notification = z.object({
  id: uuid,
  kind: NotificationKind,
  title: z.string(),
  body: z.string(),
  link: z.string().nullable(),
  readAt: z.string().nullable(),
  createdAt: z.string(),
})
export type Notification = z.infer<typeof Notification>
