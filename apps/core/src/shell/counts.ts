import { ACTIVE_TASK_STATES, RequesterCounts, StaffCounts, type Me } from '@yoda/shared'
import { and, count, eq, inArray, notExists, notInArray } from 'drizzle-orm'
import { listConversations } from '../chat/service.js'
import type { Db, Tx } from '../db/client.js'
import { discussionResponses, discussions, tasks, workItems } from '../db/schema.js'
import { visibleTo } from '../discussions/queries.js'
import { getTodo } from '../work/queries.js'

type Conn = Db | Tx

/**
 * Rail badges for staff, from the same queries their pages use:
 * - `todo`: every row on the To-do page (my tasks, confirmations, proposals to decide, steps awaiting advance);
 * - `chat`: visible threads with unread messages (conversation_reads tracks the last read message);
 * - `discussions`: open or scheduled discussions `me` can see and has not responded to yet (no vote or opinion).
 */
export async function staffCounts(db: Conn, me: Me): Promise<StaffCounts> {
  const [todo, threads, [open]] = await Promise.all([
    getTodo(db, me),
    listConversations(db, me),
    db
      .select({ n: count() })
      .from(discussions)
      .where(
        and(
          inArray(discussions.state, ['open', 'scheduled']),
          visibleTo(me),
          notExists(
            db
              .select({ id: discussionResponses.id })
              .from(discussionResponses)
              .where(and(eq(discussionResponses.discussionId, discussions.id), eq(discussionResponses.authorId, me.id))),
          ),
        ),
      ),
  ])
  return StaffCounts.parse({
    todo: todo.tasks.length + todo.confirmations.length + todo.proposals.length + todo.awaitingAdvance.length,
    chat: threads.filter((c) => c.unread > 0).length,
    discussions: open?.n ?? 0,
  })
}

/** Requesters: their own requests still in progress, and the questions waiting for their answer. */
export async function requesterCounts(db: Conn, me: Me): Promise<RequesterCounts> {
  const [[requests], [answers]] = await Promise.all([
    db
      .select({ n: count() })
      .from(workItems)
      .where(and(eq(workItems.requesterId, me.id), notInArray(workItems.state, ['done', 'cancelled']))),
    db
      .select({ n: count() })
      .from(tasks)
      .where(and(eq(tasks.assigneeId, me.id), eq(tasks.role, 'REQUESTER'), inArray(tasks.state, [...ACTIVE_TASK_STATES]))),
  ])
  return RequesterCounts.parse({ requests: requests?.n ?? 0, answers: answers?.n ?? 0 })
}
