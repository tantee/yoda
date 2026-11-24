import type { ActionCard, Attachment, AuthorKind, Conversation, ConversationCreate, Me, Message } from '@yoda/shared'
import { and, asc, desc, eq, gt, inArray, lt, or, sql, type SQL } from 'drizzle-orm'
import { notFound } from '../auth/plugin.js'
import { attachmentsByIds } from '../attachments/service.js'
import type { Db, Tx } from '../db/client.js'
import { attachments, conversationReads, conversations, messages, people, projectMembers, projects, workItems } from '../db/schema.js'
import { runWork, type WorkCtx, type WorkDeps } from '../work/context.js'
import { canSeeProject } from '../work/queries.js'

type Conn = Db | Tx
export type ConversationRow = typeof conversations.$inferSelect

/** Stored title of a personal/intake conversation; the portal localizes it. */
export const PERSONAL_TITLE = 'ผู้ช่วย'
/**
 * Interim secretary reply until the real secretary (plan 4, Task 8) replaces the job handler. A stable marker,
 * not prose: the portal shows it in the reader's language (system messages only).
 */
export const SECRETARY_NOT_READY = '[[secretary.not_ready]]'

const OWN_KINDS = ['personal', 'intake'] as const

/**
 * The caller's own assistant conversation, created on first use: `personal` for staff, `intake` for requesters.
 * Serialized per person with an advisory lock (the unique index only covers `personal`).
 */
export async function ensurePersonalConversation(db: Db, me: Me): Promise<string> {
  const find = async (c: Conn) =>
    (
      await c
        .select({ id: conversations.id })
        .from(conversations)
        .where(and(eq(conversations.ownerId, me.id), inArray(conversations.kind, [...OWN_KINDS])))
        .orderBy(asc(conversations.createdAt), asc(conversations.id))
        .limit(1)
    )[0]?.id
  const found = await find(db)
  if (found) return found
  return db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`personal-conversation:${me.id}`}))`)
    const again = await find(tx)
    if (again) return again
    const [row] = await tx
      .insert(conversations)
      .values({ kind: me.isStaff ? 'personal' : 'intake', ownerId: me.id, title: PERSONAL_TITLE })
      .returning({ id: conversations.id })
    return row!.id
  })
}

/** The conversation when `me` may see it, else null. */
export async function visibleConversation(db: Conn, me: Me, conversationId: string): Promise<ConversationRow | null> {
  const [c] = await db.select().from(conversations).where(eq(conversations.id, conversationId))
  if (!c) return null
  // Only personal/intake threads belong to their owner; team threads need current access, even for their
  // creator (a staff member removed from the project loses the threads they started there).
  if ((OWN_KINDS as readonly string[]).includes(c.kind)) return c.ownerId === me.id ? c : null
  if (c.kind !== 'project' && c.kind !== 'work_item') return null
  // Requesters are never project members; checked anyway so a stray membership can't open project threads.
  if (me.isStaff && c.projectId && (await canSeeProject(db, me, c.projectId))) return c
  if (c.kind === 'work_item' && c.workItemId) {
    const [w] = await db.select({ requesterId: workItems.requesterId }).from(workItems).where(eq(workItems.id, c.workItemId))
    if (w?.requesterId === me.id) return c
  }
  return null
}

/**
 * Personal and intake conversations: the owner only. `project` threads: staff project members and admins;
 * `work_item` threads: the same, plus the work item's requester. Creating a team thread grants nothing.
 */
export async function canSeeConversation(db: Conn, me: Me, conversationId: string): Promise<boolean> {
  return (await visibleConversation(db, me, conversationId)) !== null
}

export async function requireConversation(db: Conn, me: Me, conversationId: string): Promise<ConversationRow> {
  const c = await visibleConversation(db, me, conversationId)
  if (!c) throw notFound()
  return c
}

/** SQL mirror of `visibleConversation`, for listing. */
function visibleWhere(db: Conn, me: Me): SQL {
  const threads = inArray(conversations.kind, ['project', 'work_item'])
  const staff = me.isStaff
    ? me.isAdmin
      ? threads
      : and(
          threads,
          inArray(
            conversations.projectId,
            db.select({ id: projectMembers.projectId }).from(projectMembers).where(eq(projectMembers.personId, me.id)),
          ),
        )
    : undefined
  const asRequester = and(
    eq(conversations.kind, 'work_item'),
    inArray(conversations.workItemId, db.select({ id: workItems.id }).from(workItems).where(eq(workItems.requesterId, me.id))),
  )
  const own = and(eq(conversations.ownerId, me.id), inArray(conversations.kind, [...OWN_KINDS]))
  return or(own, staff, asRequester)!
}

async function queryConversations(db: Conn, me: Me, extra?: SQL): Promise<Conversation[]> {
  const lastRead = sql`coalesce(${conversationReads.lastReadSeq}, 0)`
  const rows = await db
    .select({
      c: conversations,
      ownerName: people.displayName,
      unread: sql<number>`(select count(*)::int from ${messages} m
        where m.conversation_id = ${conversations.id} and m.seq > ${lastRead}
        and m.author_id is distinct from ${me.id})`,
    })
    .from(conversations)
    .innerJoin(people, eq(people.id, conversations.ownerId))
    .leftJoin(
      conversationReads,
      and(eq(conversationReads.conversationId, conversations.id), eq(conversationReads.personId, me.id)),
    )
    .where(and(visibleWhere(db, me), extra))
    .orderBy(desc(sql`coalesce(${conversations.lastMessageAt}, ${conversations.createdAt})`), desc(conversations.id))
  // Requesters never see staff names: only their own name on threads they own.
  const hideOwner = (ownerId: string) => !me.isStaff && ownerId !== me.id
  return rows.map(({ c, ownerName, unread }) => ({
    id: c.id,
    kind: c.kind as Conversation['kind'],
    ownerId: c.ownerId,
    ownerName: hideOwner(c.ownerId) ? null : ownerName,
    projectId: c.projectId,
    workItemId: c.workItemId,
    title: c.title,
    lastMessageAt: c.lastMessageAt?.toISOString() ?? null,
    unread: Number(unread),
  }))
}

/** Mine plus the project and work-item threads I can see, most recently active first, with unread counts. */
export function listConversations(db: Conn, me: Me): Promise<Conversation[]> {
  return queryConversations(db, me)
}

export async function getConversation(db: Conn, me: Me, id: string): Promise<Conversation> {
  const [c] = await queryConversations(db, me, eq(conversations.id, id))
  if (!c) throw notFound()
  return c
}

/** Staff only (the route checks). `work_item` threads take the item's project; a different `projectId` → 404. */
export async function createConversation(db: Db, me: Me, body: ConversationCreate): Promise<string> {
  let projectId: string
  let workItemId: string | null = null
  let title: string
  if (body.kind === 'project') {
    const [p] = await db.select({ id: projects.id, name: projects.name }).from(projects).where(eq(projects.id, body.projectId!))
    if (!p || !(await canSeeProject(db, me, p.id))) throw notFound()
    projectId = p.id
    title = p.name
  } else {
    const [w] = await db
      .select({ id: workItems.id, projectId: workItems.projectId, title: workItems.title })
      .from(workItems)
      .where(eq(workItems.id, body.workItemId!))
    if (!w || !(await canSeeProject(db, me, w.projectId))) throw notFound()
    if (body.projectId && body.projectId !== w.projectId) throw notFound()
    projectId = w.projectId
    workItemId = w.id
    title = w.title
  }
  const [row] = await db
    .insert(conversations)
    .values({ kind: body.kind, ownerId: me.id, projectId, workItemId, title: body.title ?? title })
    .returning({ id: conversations.id })
  return row!.id
}

/**
 * Files that may be shared into the thread besides its own uploads: the whole project in `project` threads,
 * only the work item's files in `work_item` threads (the requester sees those), none in personal/intake.
 */
function shareableScope(c: ConversationRow): SQL | undefined {
  if (c.kind === 'project' && c.projectId) return eq(attachments.projectId, c.projectId)
  if (c.kind === 'work_item' && c.projectId && c.workItemId) {
    return and(eq(attachments.projectId, c.projectId), eq(attachments.workItemId, c.workItemId))
  }
  return undefined
}

/**
 * Message attachments must be files uploaded to this conversation or, for staff who can see the project,
 * files in the thread's shareable scope. Anything else → 404 (never confirms other ids).
 */
export async function checkMessageAttachments(db: Conn, me: Me, c: ConversationRow, ids: string[]): Promise<void> {
  const set = [...new Set(ids)]
  if (!set.length) return
  const staffShares = me.isStaff && c.projectId && (await canSeeProject(db, me, c.projectId))
  const rows = await db
    .select({ id: attachments.id })
    .from(attachments)
    .where(
      and(
        inArray(attachments.id, set),
        or(eq(attachments.conversationId, c.id), staffShares ? shareableScope(c) : undefined),
      ),
    )
  if (rows.length !== set.length) throw notFound()
}

/**
 * True when the attachment belongs to the conversation: uploaded there, or posted in one of its messages and
 * still within the thread's shareable scope (so a work-item thread never serves another item's files).
 */
export async function attachmentInConversation(db: Conn, c: ConversationRow, attachmentId: string): Promise<boolean> {
  const scope = shareableScope(c)
  const [row] = await db
    .select({ id: attachments.id })
    .from(attachments)
    .where(
      and(
        eq(attachments.id, attachmentId),
        or(
          eq(attachments.conversationId, c.id),
          scope
            ? and(
                scope,
                sql`exists (select 1 from ${messages} m where m.conversation_id = ${c.id}
                  and ${attachmentId}::uuid = any(m.attachment_ids))`,
              )
            : undefined,
        ),
      ),
    )
  return !!row
}

/**
 * Posts a message: bumps `last_message_at`, pushes a live `message.created` event for the conversation and,
 * for person-authored messages, enqueues the secretary reply. Callers check permissions.
 */
export async function postMessage(
  ctx: WorkCtx,
  input: {
    conversationId: string
    authorKind: AuthorKind
    authorId: string | null
    text: string
    attachmentIds?: string[]
    actions?: ActionCard[]
  },
): Promise<string> {
  const { tx } = ctx
  const [c] = await tx
    .select({ projectId: conversations.projectId, workItemId: conversations.workItemId })
    .from(conversations)
    .where(eq(conversations.id, input.conversationId))
  if (!c) throw notFound()
  const [m] = await tx
    .insert(messages)
    .values({
      conversationId: input.conversationId,
      authorKind: input.authorKind,
      authorId: input.authorId,
      text: input.text,
      attachmentIds: [...new Set(input.attachmentIds ?? [])],
      actions: input.actions ?? [],
    })
    .returning({ id: messages.id })
  // greatest() ignores the null of a first message; concurrent posts never move it backwards.
  await tx
    .update(conversations)
    .set({
      lastMessageAt: sql`greatest(${conversations.lastMessageAt}, (select created_at from ${messages} where id = ${m!.id}))`,
    })
    .where(eq(conversations.id, input.conversationId))
  ctx.emitted.push({
    type: 'message.created',
    conversationId: input.conversationId,
    projectId: c.projectId,
    workItemId: c.workItemId,
    taskId: null,
    personId: null,
  })
  if (input.authorKind === 'person') ctx.jobs.push({ name: 'secretary-chat', id: m!.id })
  return m!.id
}

/**
 * Messages as `me` sees them. Requesters see no staff identities (as on their task pages): another person's
 * `authorId`/`authorName` are null, and attachment `uploadedById` null / `uploadedByName` blank unless they
 * uploaded the file.
 */
async function queryMessages(
  db: Conn,
  me: Me,
  where: SQL,
  opts: { limit?: number } = {},
): Promise<Message[]> {
  const q = db
    .select({ m: messages, authorName: people.displayName })
    .from(messages)
    .leftJoin(people, eq(people.id, messages.authorId))
    .where(where)
    .orderBy(desc(messages.seq))
  const rows = (opts.limit ? await q.limit(opts.limit) : await q).reverse()
  const files = await attachmentsByIds(
    db,
    rows.flatMap((r) => r.m.attachmentIds),
  )
  const asRequester = !me.isStaff
  const file = (a: Attachment): Attachment =>
    asRequester && a.uploadedById !== me.id ? { ...a, uploadedById: null, uploadedByName: '' } : a
  const other = (authorId: string | null) => asRequester && authorId !== me.id
  return rows.map(({ m, authorName }) => ({
    id: m.id,
    conversationId: m.conversationId,
    seq: Number(m.seq),
    authorKind: m.authorKind as AuthorKind,
    authorId: other(m.authorId) ? null : m.authorId,
    authorName: other(m.authorId) ? null : (authorName ?? null),
    text: m.text,
    attachments: m.attachmentIds.flatMap((id) => {
      const a = files.get(id)
      return a ? [file(a)] : []
    }),
    actions: m.actions as ActionCard[],
    createdAt: m.createdAt.toISOString(),
  }))
}

/** Newest page (before `before` when given), in ascending order. Callers check visibility. */
export function listMessages(
  db: Conn,
  me: Me,
  conversationId: string,
  page: { before?: number; limit: number },
): Promise<Message[]> {
  return queryMessages(
    db,
    me,
    and(eq(messages.conversationId, conversationId), page.before ? lt(messages.seq, page.before) : undefined)!,
    { limit: page.limit },
  )
}

export async function getMessage(db: Conn, me: Me, id: string): Promise<Message> {
  const [m] = await queryMessages(db, me, eq(messages.id, id))
  if (!m) throw notFound()
  return m
}

/**
 * Moves `me`'s read marker forward to `seq` (never backwards), clamped to the conversation's last message so
 * a too-large seq can't pre-read future messages. Callers check visibility.
 */
export async function markRead(db: Conn, me: Me, conversationId: string, seq: number): Promise<void> {
  const [{ max }] = await db
    .select({ max: sql<number>`coalesce(max(${messages.seq}), 0)::bigint` })
    .from(messages)
    .where(eq(messages.conversationId, conversationId))
  await db
    .insert(conversationReads)
    .values({ conversationId, personId: me.id, lastReadSeq: Math.min(seq, Number(max)) })
    .onConflictDoUpdate({
      target: [conversationReads.conversationId, conversationReads.personId],
      set: { lastReadSeq: sql`greatest(${conversationReads.lastReadSeq}, excluded.last_read_seq)` },
    })
}

/**
 * `secretary-chat` job until the real secretary lands (plan 4, Task 8): one `system` reply to a person
 * message in a personal/intake conversation, so the portal's typing indicator ends. Team threads get no
 * reply. Idempotent: skipped when a `system`/`ai` message already follows (a retry, or a reply to a later
 * message that also ends the typing indicator).
 */
export async function interimSecretaryReply(deps: WorkDeps, messageId: string): Promise<void> {
  const [m] = await deps.db
    .select({ conversationId: messages.conversationId, seq: messages.seq, authorKind: messages.authorKind, kind: conversations.kind })
    .from(messages)
    .innerJoin(conversations, eq(conversations.id, messages.conversationId))
    .where(eq(messages.id, messageId))
  if (!m || m.authorKind !== 'person' || !(OWN_KINDS as readonly string[]).includes(m.kind)) return
  await runWork(deps, { id: null, kind: 'system' }, async (ctx) => {
    // Serializes replies within the conversation so concurrent retries can't both post.
    await ctx.tx.select({ id: conversations.id }).from(conversations).where(eq(conversations.id, m.conversationId)).for('update')
    const [answered] = await ctx.tx
      .select({ id: messages.id })
      .from(messages)
      .where(
        and(
          eq(messages.conversationId, m.conversationId),
          gt(messages.seq, m.seq),
          inArray(messages.authorKind, ['system', 'ai']),
        ),
      )
      .limit(1)
    if (answered) return
    await postMessage(ctx, { conversationId: m.conversationId, authorKind: 'system', authorId: null, text: SECRETARY_NOT_READY })
  })
}
