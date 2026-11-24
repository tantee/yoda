import type { Me } from '@yoda/shared'
import type { ModelMessage } from 'ai'
import { and, asc, desc, eq, gt, inArray } from 'drizzle-orm'
import type { AppDeps } from '../app.js'
import { AiFailed, AiRefused, errorSummary, type BillingTarget } from '../ai/gateway.js'
import { secretaryAnswers, postMessage, visibleConversation, OWN_KINDS, type ConversationRow } from '../chat/service.js'
import type { Db, Tx } from '../db/client.js'
import { attachments, conversations, messages, people, projectMembers, projects } from '../db/schema.js'
import type { JobRun } from '../jobs/queue.js'
import { personAsMe } from '../proposals/service.js'
import { runWork } from '../work/context.js'
import { canSeeProject, getMyRequests, getWorkItemDetail, listTemplates, listWorkItems } from '../work/queries.js'
import { secretarySystemPrompt } from './prompt.js'
import { progressNotes, secretaryTools, type PendingAction } from './tools.js'

export type SecretaryDeps = Pick<AppDeps, 'db' | 'ai' | 'bus' | 'jobs' | 'config'>

/** Messages of the conversation the model sees (newest last). */
export const HISTORY_LIMIT = 30
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

type Trigger = { id: string; conversationId: string; seq: number }

/** Has an `ai`/`system` message been posted after the trigger (a reply to it, or to a later message)? */
async function answered(conn: Db | Tx, t: Trigger): Promise<boolean> {
  const [row] = await conn
    .select({ id: messages.id })
    .from(messages)
    .where(and(eq(messages.conversationId, t.conversationId), gt(messages.seq, t.seq), inArray(messages.authorKind, ['system', 'ai'])))
    .limit(1)
  return !!row
}

/** Locks the conversation (serializing replies) and reports whether the trigger is already answered. */
async function lockAndCheck(tx: Tx, t: Trigger): Promise<boolean> {
  await tx.select({ id: conversations.id }).from(conversations).where(eq(conversations.id, t.conversationId)).for('update')
  return answered(tx, t)
}

async function postFailure(deps: SecretaryDeps, t: Trigger, reason: FailureReason): Promise<void> {
  await runWork(deps, { id: null, kind: 'system' }, async (ctx) => {
    if (await lockAndCheck(ctx.tx, t)) return
    await postMessage(ctx, { conversationId: t.conversationId, authorKind: 'system', authorId: null, text: secretaryFailed(reason) })
  })
}

/**
 * `secretary-chat` job: the secretary's reply to a person's message, acting as that person. Idempotent (skips
 * when an `ai`/`system` message already follows). Tool writes are collected during the model run and applied
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
  const trigger: Trigger = { id: m.id, conversationId: m.conversationId, seq: Number(m.seq) }
  if (await answered(db, trigger)) return
  const me = await personAsMe(db, m.authorId)
  // The author may have lost access to the thread since (e.g. removed from the project): no reply.
  const conversation = me ? await visibleConversation(db, me, m.conversationId) : null
  if (!me || !conversation) return

  let modelDone = false
  try {
    const billing: BillingTarget = conversation.projectId ? { projectId: conversation.projectId } : { department: true }
    if (conversation.projectId) {
      const [p] = await db.select({ noAi: projects.noAi }).from(projects).where(eq(projects.id, conversation.projectId))
      // A noAi project's thread is never sent to the AI (the gateway would refuse too; this avoids building it).
      if (p?.noAi) throw new AiRefused('no_ai')
    }
    const system = secretarySystemPrompt({
      ...(await personContext(db, me)),
      thread: await threadContext(db, me, conversation),
      today: new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Bangkok' }),
    })
    const history = await loadHistory(db, me, conversation)
    const pending: PendingAction[] = []
    const out = await deps.ai.chat({
      job: 'fast',
      billing,
      system,
      messages: history,
      tools: secretaryTools({ db, ai: deps.ai }, me, pending),
      maxSteps: SECRETARY_MAX_STEPS,
      maxOutputTokens: SECRETARY_MAX_OUTPUT_TOKENS,
      signal: run.signal,
    })
    modelDone = true
    await runWork(deps, { id: me.id, kind: 'ai' }, async (ctx) => {
      if (await lockAndCheck(ctx.tx, trigger)) return
      const actions = []
      for (const apply of pending) actions.push(await apply(ctx))
      await postMessage(ctx, { conversationId: trigger.conversationId, authorKind: 'ai', authorId: null, text: out.text.trim(), actions })
    })
  } catch (err) {
    const reason = failureReason(err)
    // Unexpected errors before the model ran (e.g. the database) are retried; after it, retrying would bill again.
    if (!reason && !modelDone && !run.isFinalAttempt) throw err
    console.warn(`secretary-chat ${run.id}: ${errorSummary(err)}`)
    await postFailure(deps, trigger, reason ?? 'ai_failed')
  }
}

/** The person, their (AI-visible) projects and the workflow templates, for the system prompt. */
async function personContext(db: Db, me: Me) {
  const person = { name: me.displayName, isStaff: me.isStaff, isAdmin: me.isAdmin }
  if (!me.isStaff) return { person, projects: [], hiddenProjects: 0, templates: [] }
  const rows = await db
    .select({ id: projects.id, name: projects.name, noAi: projects.noAi, autonomy: projects.autonomy, roles: projectMembers.roles })
    .from(projectMembers)
    .innerJoin(projects, eq(projects.id, projectMembers.projectId))
    .where(and(eq(projectMembers.personId, me.id), eq(projects.status, 'active')))
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
  if (!c.projectId || (OWN_KINDS as readonly string[]).includes(c.kind)) return null
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
      ...open.map((t) => `- ${t.title.th} (${t.role}, ${t.state}${t.assigneeName ? `, ${t.assigneeName}` : ''})`),
    ]
    const notes = await progressNotes(db, d.id, 5)
    if (notes.length) lines.push('Recent progress notes:', ...notes.map((n) => `- ${n.title}: ${n.text}`))
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
 * The last messages as model messages. Person messages carry the author's name in team threads, except for
 * requesters, who never see staff names ("Team member"). System messages (markers) are left out; attachments
 * appear by name and id, and "do not send to AI" files by id only.
 */
async function loadHistory(db: Db, me: Me, c: ConversationRow): Promise<ModelMessage[]> {
  const rows = (
    await db
      .select({ m: messages, name: people.displayName })
      .from(messages)
      .leftJoin(people, eq(people.id, messages.authorId))
      .where(and(eq(messages.conversationId, c.id), inArray(messages.authorKind, ['person', 'ai'])))
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
  const team = !(OWN_KINDS as readonly string[]).includes(c.kind)

  const out: { role: 'user' | 'assistant'; content: string }[] = []
  for (const { m, name } of rows) {
    let content = m.text
    if (m.authorKind === 'person' && team) {
      const who = m.authorId === me.id ? (me.isStaff ? me.displayName : 'Me') : me.isStaff ? (name ?? 'Someone') : 'Team member'
      content = `${who}: ${content}`
    }
    const attached = m.attachmentIds.flatMap((id) => {
      const f = files.get(id)
      if (!f) return []
      return [f.noAi ? `[attached file id ${id}: not available to the assistant]` : `[attached file "${f.fileName}" id ${id}]`]
    })
    if (attached.length) content = `${content}\n${attached.join('\n')}`
    const role = m.authorKind === 'ai' ? 'assistant' : 'user'
    const last = out.at(-1)
    if (last && last.role === role) last.content = `${last.content}\n\n${content}`
    else out.push({ role, content })
  }
  while (out[0]?.role === 'assistant') out.shift()
  return out
}
