import type { ConversationKind } from '@yoda/shared'
import { eq } from 'drizzle-orm'
import type { Db, Tx } from '../db/client.js'
import { workItems, type conversations } from '../db/schema.js'

export type ConversationRow = typeof conversations.$inferSelect

/** Thread kinds only their owner reads. */
export const OWN_KINDS = ['personal', 'intake'] as const

export type ThreadAudience = {
  kind: ConversationKind
  /** personal/intake: only the owner reads the thread. */
  own: boolean
  /** project/work_item: several people read the thread. */
  team: boolean
  projectId: string | null
  workItemId: string | null
  /** A work_item thread whose item currently has a requester, who reads the replies. */
  requesterVisible: boolean
  /** The work item's current requester (work_item threads), else null. */
  requesterId: string | null
  /** A non-staff person can read the thread: staff names stay out of it. */
  hideStaffNames: boolean
}

/** Is the thread shared (project/work_item) rather than one person's own? Decidable from the kind alone. */
export const isTeamKind = (kind: string): boolean => !(OWN_KINDS as readonly string[]).includes(kind)

/** Single source of truth for who reads a thread, for content decisions (not access: see visibleConversation). */
export async function threadAudience(db: Db | Tx, c: ConversationRow): Promise<ThreadAudience> {
  const team = isTeamKind(c.kind)
  let requesterId: string | null = null
  if (c.kind === 'work_item' && c.workItemId) {
    const [w] = await db.select({ requesterId: workItems.requesterId }).from(workItems).where(eq(workItems.id, c.workItemId))
    requesterId = w?.requesterId ?? null
  }
  return {
    kind: c.kind as ConversationKind,
    own: !team,
    team,
    projectId: team ? c.projectId : null,
    workItemId: team ? c.workItemId : null,
    requesterVisible: requesterId !== null,
    requesterId,
    hideStaffNames: c.kind === 'work_item',
  }
}
