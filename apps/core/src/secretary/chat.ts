import type { ActionCard, Me } from '@yoda/shared'
import type { ModelMessage } from 'ai'
import { and, asc, desc, eq, inArray, lte, sql } from 'drizzle-orm'
import { alias } from 'drizzle-orm/pg-core'
import type { AppDeps } from '../app.js'
import { AiFailed, AiRefused, type BillingTarget } from '../ai/gateway.js'
import { isTeamKind, threadAudience, type ThreadAudience } from '../chat/audience.js'
import { secretaryAnswers, postMessage, visibleConversation, type ConversationRow } from '../chat/service.js'
import type { Db, Tx } from '../db/client.js'
import { attachments, conversations, messages, people, projectMembers, projects, workItems } from '../db/schema.js'
import type { JobRun } from '../jobs/queue.js'
import { personAsMe } from '../proposals/service.js'
import { runWork, type WorkCtx } from '../work/context.js'
import { canSeeProject, getMyRequests, getWorkItemDetail, listTemplates, listWorkItems } from '../work/queries.js'
import { secretarySystemPrompt } from './prompt.js'
import { logLine, secretaryTools, type PendingAction } from './tools.js'

export type SecretaryDeps = Pick<AppDeps, 'db' | 'ai' | 'bus' | 'jobs' | 'config'>

/** Messages of the conversation the model sees (newest last). */
export const HISTORY_LIMIT = 30
/** Each history message is clipped to this many characters. */
export const HISTORY_MESSAGE_CHARS = 4000
/** Total characters of history sent to the model: the oldest messages are dropped first (never the trigger). */
export const HISTORY_TOTAL_CHARS = 30000
export const TRUNCATED_MARKER = '…[truncated]'
export const SECRETARY_MAX_STEPS = 6
export const SECRETARY_MAX_OUTPUT_TOKENS = 4000

export type FailureReason = 'budget_exceeded' | 'no_ai' | 'ai_unavailable' | 'ai_failed'
/** Stable marker the portal localizes (system messages only). */
export const secretaryFailed = (reason: FailureReason) => `[[secretary.failed:${reason}]]`

/** Why the secretary could not answer, for AI errors; null for anything else (unexpected). */
function failureReason(err: unknown): FailureReason | null {
  if (err instanceof AiRefused) return err.reason === 'unpriced_model' ? 'ai_unavailable' : err.reason
  if (err instanceof AiFailed) return err.reason === 'not_configured' ? 'ai_unavailable' : 'ai_failed'
  return null
}

/** `team`: a project / work_item thread, where several people may each ask the secretary. */
type Trigger = { id: string; conversationId: string; seq: number; team: boolean }

/**
 * Is the trigger already answered? In team threads only a reply to this very message counts (another person's
 * question must not swallow it). In personal/intake threads a reply (or failure marker) whose `replyToId`
 * message is this one or a later one does: each reply points at the last person message its history included,
 * so it covers everything up to there. `ai`/`system` messages without `replyToId` (e.g. `[[request.done]]`)
 * never count.
 */
async function answered(conn: Db | Tx, t: Trigger): Promise<boolean> {
  const repliedTo = alias(messages, 'replied_to')
  const [row] = await conn
    .select({ id: messages.id })
    .from(messages)
    .innerJoin(repliedTo, eq(repliedTo.id, messages.replyToId))
    .where(
      and(
        eq(messages.conversationId, t.conversationId),
        inArray(messages.authorKind, ['system', 'ai']),
        t.team ? eq(messages.replyToId, t.id) : sql`${repliedTo.seq} >= ${t.seq}`,
      ),
    )
    .limit(1)
  return !!row
}

/**
 * Locks the conversation (serializing replies) and reports whether the trigger is already answered.
 * Lock order: conversation → work item (a staged action may then lock its work item); code that needs both
 * must never take them the other way round.
 */
async function lockAndCheck(tx: Tx, t: Trigger): Promise<boolean> {
  await tx.select({ id: conversations.id }).from(conversations).where(eq(conversations.id, t.conversationId)).for('update')
  return answered(tx, t)
}

async function postFailure(deps: SecretaryDeps, t: Trigger, replyToId: string, reason: FailureReason): Promise<void> {
  await runWork(deps, { id: null, kind: 'system' }, async (ctx) => {
    if (await lockAndCheck(ctx.tx, t)) return
    await postMessage(ctx, {
      conversationId: t.conversationId,
      authorKind: 'system',
      authorId: null,
      text: secretaryFailed(reason),
      replyToId,
    })
  })
}

/**
 * `secretary-chat` job: the secretary's reply to a person's message, acting as that person. Idempotent (skips
 * when a reply already answers the message, see `answered`). Tool writes are collected during the model run and applied
 * with the reply in one transaction, so a failed run changes nothing; failures post a
 * `[[secretary.failed:<reason>]]` system message instead of a reply.
 */
export async function secretaryChat(deps: SecretaryDeps, run: JobRun): Promise<void> {
  const { db } = deps
  const [m] = await db
    .select({ id: messages.id, conversationId: messages.conversationId, seq: messages.seq, authorKind: messages.authorKind, authorId: messages.authorId, text: messages.text, kind: conversations.kind })
    .from(messages)
    .innerJoin(conversations, eq(conversations.id, messages.conversationId))
    .where(eq(messages.id, run.id))
  if (!m || m.authorKind !== 'person' || !m.authorId || !secretaryAnswers(m.kind, m.text)) return
  const team = isTeamKind(m.kind) // from the kind alone: the dedupe check runs before the row is loaded
  const trigger: Trigger = { id: m.id, conversationId: m.conversationId, seq: Number(m.seq), team }
  if (await answered(db, trigger)) return
  const me = await personAsMe(db, m.authorId)
  // The author may have lost access to the thread since (e.g. removed from the project): no reply.
  const conversation = me ? await visibleConversation(db, me, m.conversationId) : null
  if (!me || !conversation) return

  let modelDone = false
  // The person message the reply answers: the trigger in team threads; in personal/intake threads the last
  // person message of the history sent (later ones the model never saw stay unanswered).
  let replyToId = trigger.id
  try {
    const audience = await threadAudience(db, conversation)
    const billing: BillingTarget = conversation.projectId ? { projectId: conversation.projectId } : { department: true }
    if (conversation.projectId) {
      const [p] = await db.select({ noAi: projects.noAi }).from(projects).where(eq(projects.id, conversation.projectId))
      // A noAi project's thread is never sent to the AI (the gateway would refuse too; this avoids building it).
      if (p?.noAi) throw new AiRefused('no_ai')
    }
    // Team threads: everyone in the thread reads the reply, so the secretary works only on the thread's project,
    // and work_item threads (the requester may read them) get no staff names or internal notes.
    const scopeProjectId = audience.projectId
    const system = secretarySystemPrompt({
      ...(await personContext(db, me, scopeProjectId)),
      thread: await threadContext(db, me, conversation),
      visibleToRequester: audience.hideStaffNames,
      today: new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Bangkok' }),
    })
    const { messages: history, lastPersonId } = await loadHistory(db, me, conversation, audience, trigger)
    if (!team && lastPersonId) replyToId = lastPersonId
    const pending: PendingAction[] = []
    const out = await deps.ai.chat({
      job: 'fast',
      billing,
      system,
      messages: history,
      tools: secretaryTools({ db, ai: deps.ai }, me, pending, {
        projectId: scopeProjectId,
        workItemId: audience.workItemId,
        hideStaffNames: audience.hideStaffNames,
        requesterVisible: audience.requesterVisible,
      }),
      maxSteps: SECRETARY_MAX_STEPS,
      maxOutputTokens: SECRETARY_MAX_OUTPUT_TOKENS,
      signal: run.signal,
    })
    modelDone = true
    await runWork(deps, { id: me.id, kind: 'ai' }, async (ctx) => {
      if (await lockAndCheck(ctx.tx, trigger)) return
      const { actions, failed } = await applyActions(ctx, pending)
      const text = failed ? `${out.text.trim()}\n\n${actionsFailedNote(out.text, failed)}` : out.text.trim()
      await postMessage(ctx, { conversationId: trigger.conversationId, authorKind: 'ai', authorId: null, text, actions, replyToId })
    })
  } catch (err) {
    const reason = failureReason(err)
    // Unexpected errors before the model ran (e.g. the database) are retried; after it, retrying would bill again.
    if (!reason && !modelDone && !run.isFinalAttempt) throw err
    console.warn(`secretary-chat ${run.id}: ${logLine(err)}`)
    await postFailure(deps, trigger, replyToId, reason ?? 'ai_failed')
  }
}

/**
 * Applies each staged tool write in its own savepoint: one that fails (e.g. access changed since the tool
 * ran) is rolled back and dropped from the cards; the others still apply with the reply.
 */
async function applyActions(ctx: WorkCtx, pending: PendingAction[]): Promise<{ actions: ActionCard[]; failed: number }> {
  const actions: ActionCard[] = []
  let failed = 0
  for (const apply of pending) {
    const emitted: WorkCtx['emitted'] = []
    const jobs: WorkCtx['jobs'] = []
    try {
      const card = await ctx.tx.transaction((sp) => apply({ ...ctx, tx: sp, emitted, jobs }))
      actions.push(card)
      ctx.emitted.push(...emitted)
      ctx.jobs.push(...jobs)
    } catch (err) {
      failed++
      console.warn(`secretary-chat: a staged action failed: ${logLine(err)}`)
    }
  }
  return { actions, failed }
}

/** Appended to a reply whose staged changes partly failed, in the reply's language (Thai or English). */
function actionsFailedNote(reply: string, failed: number): string {
  return /[\u0E00-\u0E7F]/.test(reply)
    ? `(หมายเหตุ: ทำรายการไม่สำเร็จ ${failed} รายการ จึงไม่ได้แนบไว้ในข้อความนี้)`
    : `(Note: ${failed} of the prepared changes could not be applied and ${failed === 1 ? 'is' : 'are'} not attached.)`
}

/**
 * The person, their (AI-visible) projects and the workflow templates, for the system prompt. In team threads
 * (`scopeProjectId`) only the thread's project is listed.
 */
async function personContext(db: Db, me: Me, scopeProjectId: string | null) {
  const person = { name: me.displayName, isStaff: me.isStaff, isAdmin: me.isAdmin }
  if (!me.isStaff) return { person, projects: [], hiddenProjects: 0, templates: [] }
  const rows = await db
    .select({ id: projects.id, name: projects.name, noAi: projects.noAi, autonomy: projects.autonomy, roles: projectMembers.roles })
    .from(projectMembers)
    .innerJoin(projects, eq(projects.id, projectMembers.projectId))
    .where(
      and(
        eq(projectMembers.personId, me.id),
        eq(projects.status, 'active'),
        scopeProjectId ? eq(projects.id, scopeProjectId) : undefined,
      ),
    )
    .orderBy(asc(projects.name))
  const templates = (await listTemplates(db)).map((t) => ({ key: t.key, name: t.name.en }))
  return {
    person,
    projects: rows.filter((r) => !r.noAi).map(({ id, name, roles, autonomy }) => ({ id, name, roles, autonomy })),
    hiddenProjects: rows.filter((r) => r.noAi).length,
    templates,
  }
}

const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n)}…` : s)

/** Short context for project / work_item threads (the project is not noAi: checked before). */
async function threadContext(db: Db, me: Me, c: ConversationRow): Promise<string | null> {
  if (!c.projectId || !isTeamKind(c.kind)) return null
  // Staff outside the project reach a work_item thread only as its requester: they get the requester's view.
  const insider = me.isStaff && (await canSeeProject(db, me, c.projectId))
  if (c.kind === 'work_item' && c.workItemId) {
    if (!insider) {
      // The requester's own request, in plain-language status only.
      const r = (await getMyRequests(db, me)).find((x) => x.workItemId === c.workItemId)
      return r ? `Their request "${r.title}" (id ${r.workItemId}): status ${r.status}${r.currentStepName ? `, step ${r.currentStepName.th}` : ''}.` : null
    }
    const d = await getWorkItemDetail(db, me, c.workItemId)
    const current = d.steps.find((s) => s.status === 'current')
    const open = d.tasks.filter((t) => ['proposed', 'open', 'in_progress', 'submitted'].includes(t.state))
    const lines = [
      `Work item "${d.title}" (id ${d.id}), priority ${d.priority}, state ${d.state}${current ? `, current step ${current.name.th}` : ''}.`,
      d.description ? `Description: ${clip(d.description, 1000)}` : '',
      open.length ? 'Open tasks:' : 'No open tasks.',
      // The requester may read this thread: no assignee names, no internal progress notes.
      ...open.map((t) => `- ${t.title.th} (${t.role}, ${t.state})`),
    ]
    return lines.filter(Boolean).join('\n')
  }
  if (!insider) return null
  const [p] = await db.select({ name: projects.name, description: projects.description }).from(projects).where(eq(projects.id, c.projectId))
  const items = (await listWorkItems(db, me, c.projectId)).filter((w) => w.state === 'active').slice(0, 15)
  return [
    `Project "${p?.name ?? ''}" (id ${c.projectId}).`,
    p?.description ? `Description: ${clip(p.description, 500)}` : '',
    items.length ? 'Active work items:' : 'No active work items.',
    ...items.map((w) => `- ${w.title} (id ${w.id}, priority ${w.priority}, step ${w.currentStepKey ?? '-'})`),
  ]
    .filter(Boolean)
    .join('\n')
}

/**
 * The last messages as model messages. In team threads the history ends at the trigger (later questions are
 * other people's to ask) and person messages are labelled: by name in project threads; in work_item threads
 * (the requester may read them) only as "Me" / "Requester" / "Team member". System messages (markers) are left
 * out; attachments appear by name and id, and "do not send to AI" files by id only. Each message is clipped to
 * HISTORY_MESSAGE_CHARS and the oldest ones are dropped until the whole fits HISTORY_TOTAL_CHARS (the trigger
 * always stays). `lastPersonId`: the newest person message kept.
 */
async function loadHistory(
  db: Db,
  me: Me,
  c: ConversationRow,
  a: ThreadAudience,
  trigger: Trigger,
): Promise<{ messages: ModelMessage[]; lastPersonId: string | null }> {
  const rows = (
    await db
      .select({ m: messages, name: people.displayName })
      .from(messages)
      .leftJoin(people, eq(people.id, messages.authorId))
      .where(
        and(
          eq(messages.conversationId, c.id),
          inArray(messages.authorKind, ['person', 'ai']),
          trigger.team ? lte(messages.seq, trigger.seq) : undefined,
        ),
      )
      .orderBy(desc(messages.seq))
      .limit(HISTORY_LIMIT)
  ).reverse()
  const ids = [...new Set(rows.flatMap((r) => r.m.attachmentIds))]
  const files = ids.length
    ? new Map(
        (await db.select({ id: attachments.id, fileName: attachments.fileName, noAi: attachments.noAi }).from(attachments).where(inArray(attachments.id, ids))).map(
          (a) => [a.id, a],
        ),
      )
    : new Map<string, { id: string; fileName: string; noAi: boolean }>()
  const label = (authorId: string | null, name: string | null): string => {
    if (authorId === me.id) return a.kind === 'project' ? me.displayName : 'Me'
    if (a.kind === 'project' && me.isStaff) return name ?? 'Someone'
    return authorId !== null && authorId === a.requesterId ? 'Requester' : 'Team member'
  }

  const items = rows.map(({ m, name }) => {
    let content = clipText(m.text, HISTORY_MESSAGE_CHARS)
    if (m.authorKind === 'person' && trigger.team) content = `${label(m.authorId, name)}: ${content}`
    const attached = m.attachmentIds.flatMap((id) => {
      const f = files.get(id)
      if (!f) return []
      return [f.noAi ? `[attached file id ${id}: not available to the assistant]` : `[attached file "${f.fileName}" id ${id}]`]
    })
    if (attached.length) content = `${content}\n${attached.join('\n')}`
    return { id: m.id, role: m.authorKind === 'ai' ? ('assistant' as const) : ('user' as const), content }
  })
  // Oldest first out until the history fits (the trigger is never dropped).
  let total = items.reduce((n, x) => n + x.content.length, 0)
  for (let i = 0; i < items.length && total > HISTORY_TOTAL_CHARS; ) {
    if (items[i]!.id === trigger.id) {
      i++
      continue
    }
    total -= items[i]!.content.length
    items.splice(i, 1)
  }

  const out: { role: 'user' | 'assistant'; content: string }[] = []
  for (const { role, content } of items) {
    const last = out.at(-1)
    if (last && last.role === role) last.content = `${last.content}\n\n${content}`
    else out.push({ role, content })
  }
  while (out[0]?.role === 'assistant') out.shift()
  return { messages: out, lastPersonId: items.findLast((x) => x.role === 'user')?.id ?? null }
}

/** `s` cut to `n` characters, marked when cut. */
function clipText(s: string, n: number): string {
  return s.length > n ? `${s.slice(0, n)}${TRUNCATED_MARKER}` : s
}
