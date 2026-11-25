import { DiscussionCreate, DiscussionOption, KnowledgeCreate, Priority, WorkItemCreate, type ActionCard, type Me } from '@yoda/shared'
import { tool, type ToolSet } from 'ai'
import { and, desc, eq, inArray, isNull, sql } from 'drizzle-orm'
import { z } from 'zod'
import { errorSummary, type AiGateway } from '../ai/gateway.js'
import { HttpError, notFound } from '../auth/plugin.js'
import type { Db, Tx } from '../db/client.js'
import { attachments, conversations, knowledgeEntries, people, projects, workItems } from '../db/schema.js'
import { codeSummary, withoutGitLabLinks } from '../gitlab/repos.js'
import { createEntry } from '../knowledge/service.js'
import { searchKnowledge } from '../knowledge/search.js'
import { createProposal, supersedePending } from '../proposals/service.js'
import type { WorkCtx } from '../work/context.js'
import { lockItem, memberRoles } from '../work/engine.js'
import { canSeeProject, getMyAnswers, getMyRequests, getTodo, getWorkItemDetail, listTemplates, listWorkItems } from '../work/queries.js'
import { latestTemplate } from '../workflow/seed.js'

/**
 * A tool's write, applied only after the model's reply succeeded, in the same transaction that posts the reply
 * (so a failed or aborted chat leaves nothing half-done). `apply` re-checks permissions inside the transaction.
 */
export type PendingAction = (ctx: WorkCtx) => Promise<ActionCard>

/** A refusal whose message is safe to show the model and the person (no ids, SQL or stack). */
export class ToolRefusal extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ToolRefusal'
  }
}

export const NOT_AVAILABLE = 'This is not available to the assistant (the project is marked "do not send to AI").'
const NOT_MEMBER = 'You are not a member of that project, so I cannot do this there.'
const NOT_FOUND = 'Not found, or you do not have access to it.'
const OUT_OF_SCOPE = "In this thread I can only work on the thread's own project. Ask me in your personal chat for anything else."
const OWN_ITEM_ONLY =
  "This thread is visible to the requester, so I can only change or note things on the thread's own work item here. Ask me in your personal chat for anything else."

/** A requester-visible thread: writes only ever target the thread's own work item. */
function requireOwnItem(scope: ToolScope, workItemId: string | undefined): void {
  if (scope.requesterVisible && workItemId !== scope.workItemId) throw new ToolRefusal(OWN_ITEM_ONLY)
}

/**
 * Team threads (`projectId` set): everyone in the thread reads the reply, so tools work only on that project.
 * `hideStaffNames` (work_item threads): no staff names or internal notes in tool results.
 * `requesterVisible` (work_item threads whose item has a requester): no tools that return internal content
 * (knowledge search, project status, other work items); only this item (sanitized) and confirm-first writes.
 */
export type ToolScope = {
  projectId: string | null
  /** The thread's work item (work_item threads). */
  workItemId: string | null
  hideStaffNames: boolean
  requesterVisible: boolean
}
const PERSONAL: ToolScope = { projectId: null, workItemId: null, hideStaffNames: false, requesterVisible: false }

function requireInScope(scope: ToolScope, projectId: string): void {
  if (scope.projectId && scope.projectId !== projectId) throw new ToolRefusal(OUT_OF_SCOPE)
}

/**
 * One loggable line for an error: `errorSummary`'s first line, so database errors log the statement but never
 * its parameters (project content).
 */
export function logLine(err: unknown): string {
  return errorSummary(err).split('\n')[0]!
}

/** Maps any failure to a user-safe message; unexpected errors are logged (message only) and generalised. */
function safeMessage(err: unknown): string {
  if (err instanceof ToolRefusal) return err.message
  if (err instanceof HttpError) {
    switch (err.statusCode) {
      case 404:
        return NOT_FOUND
      case 403:
        return 'You do not have permission to do that.'
      case 409:
        return 'That cannot be done in its current state.'
      default:
        return 'That request is not valid.'
    }
  }
  console.warn(`secretary tool failed: ${logLine(err)}`)
  return 'Something went wrong while doing that.'
}

/** Runs a tool body; any failure becomes a tool error with a user-safe message. */
const guarded =
  <I, O>(fn: (input: I) => Promise<O>) =>
  async (input: I): Promise<O> => {
    try {
      return await fn(input)
    } catch (err) {
      throw new ToolRefusal(safeMessage(err))
    }
  }

export type ToolDeps = { db: Db; ai: Pick<AiGateway, 'embed'> }

async function noAiProjects(db: Db, ids: string[]): Promise<Set<string>> {
  const set = [...new Set(ids)]
  if (!set.length) return new Set()
  const rows = await db
    .select({ id: projects.id })
    .from(projects)
    .where(and(inArray(projects.id, set), eq(projects.noAi, true)))
  return new Set(rows.map((r) => r.id))
}

/** The project when it exists and `me` (staff) may see it; refuses noAi projects. */
async function aiVisibleProject(db: Db, me: Me, projectId: string): Promise<{ id: string; name: string; autonomy: string }> {
  const [p] = await db
    .select({ id: projects.id, name: projects.name, noAi: projects.noAi, autonomy: projects.autonomy })
    .from(projects)
    .where(eq(projects.id, projectId))
  if (!p || !me.isStaff || !(await canSeeProject(db, me, p.id))) throw new ToolRefusal(NOT_MEMBER)
  if (p.noAi) throw new ToolRefusal(NOT_AVAILABLE)
  return p
}

async function aiVisibleWorkItem(db: Db, me: Me, workItemId: string) {
  const [w] = await db.select().from(workItems).where(eq(workItems.id, workItemId))
  if (!w || !me.isStaff || !(await canSeeProject(db, me, w.projectId))) throw new ToolRefusal(NOT_FOUND)
  const project = await aiVisibleProject(db, me, w.projectId)
  return { item: w, project }
}

const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n)}…` : s)

const uuid = z.string().uuid()

/** Tools for staff: read what they can see (never noAi content) and prepare confirm-first changes. */
function staffTools(deps: ToolDeps, me: Me, pending: PendingAction[], scope: ToolScope): ToolSet {
  const { db } = deps
  const tools: ToolSet = {
    search_knowledge: tool({
      description:
        'Search the knowledge base (documents, facts, decisions, progress notes) of the projects the person can see, plus department knowledge. Optionally limit to one project.',
      inputSchema: z.object({ query: z.string().trim().min(1).max(500), projectId: uuid.optional() }),
      execute: guarded(async ({ query, projectId: asked }) => {
        if (asked) requireInScope(scope, asked)
        const projectId = scope.projectId ?? asked
        if (projectId) await aiVisibleProject(db, me, projectId)
        const hits = await searchKnowledge(db, me, { query, projectId, forAi: true, limit: 8 }, deps.ai)
        const names = await projectNames(db, hits.map((h) => h.projectId))
        return hits.map((h) => ({
          entryId: h.id,
          title: h.title,
          type: h.type,
          project: h.projectId ? (names.get(h.projectId) ?? null) : 'department',
          verified: h.status === 'confirmed',
          text: h.snippet,
        }))
      }),
    }),

    my_todo: tool({
      description: "The person's to-do: their open tasks, tasks waiting for their confirmation, and proposals they may decide.",
      inputSchema: z.object({}),
      execute: guarded(async () => {
        const todo = await getTodo(db, me)
        const hidden = await noAiProjects(db, [
          ...todo.tasks.map((t) => t.projectId),
          ...todo.confirmations.map((t) => t.projectId),
          ...todo.proposals.flatMap((p) => (p.projectId ? [p.projectId] : [])),
          ...todo.awaitingAdvance.map((w) => w.projectId),
        ])
        const task = (t: (typeof todo.tasks)[number]) => ({
          taskId: t.id,
          title: t.title.th,
          workItemId: t.workItemId,
          workItem: t.workItemTitle,
          project: t.projectName,
          priority: t.workItemPriority,
          state: t.state,
        })
        const visible = <T extends { projectId: string | null }>(xs: T[]) => xs.filter((x) => !x.projectId || !hidden.has(x.projectId))
        const all = todo.tasks.length + todo.confirmations.length + todo.proposals.length + todo.awaitingAdvance.length
        const shown = visible(todo.tasks).length + visible(todo.confirmations).length + visible(todo.proposals).length + visible(todo.awaitingAdvance).length
        return {
          myTasks: visible(todo.tasks).map(task),
          toConfirm: visible(todo.confirmations).map(task),
          proposalsToDecide: visible(todo.proposals).map((p) => ({ proposalId: p.id, kind: p.kind, summary: p.summary })),
          stepsAwaitingAdvance: visible(todo.awaitingAdvance).map((w) => ({ workItemId: w.id, title: w.title })),
          notAvailableToAssistant: all - shown,
        }
      }),
    }),

    project_status: tool({
      description: 'Status of a project: its active work items with priority and current step.',
      inputSchema: z.object({ projectId: uuid }),
      execute: guarded(async ({ projectId }) => {
        requireInScope(scope, projectId)
        const p = await aiVisibleProject(db, me, projectId)
        const items = await listWorkItems(db, me, projectId)
        const count = (state: string) => items.filter((w) => w.state === state).length
        return {
          project: p.name,
          autonomy: p.autonomy,
          counts: { active: count('active'), done: count('done'), cancelled: count('cancelled') },
          activeWorkItems: items
            .filter((w) => w.state === 'active')
            .slice(0, 30)
            .map((w) => ({
              workItemId: w.id,
              title: w.title,
              priority: w.priority,
              currentStep: w.currentStepKey,
              awaitingAdvance: w.awaitingAdvance,
            })),
        }
      }),
    }),

    work_item: tool({
      description: 'Details of one work item: description, steps, open tasks, recent progress notes and (where shown) its code status in GitLab.',
      inputSchema: z.object({ workItemId: uuid }),
      execute: guarded(async ({ workItemId }) => {
        const { item } = await aiVisibleWorkItem(db, me, workItemId)
        requireInScope(scope, item.projectId)
        // A requester-visible thread only ever shows its own work item.
        if (scope.requesterVisible && workItemId !== scope.workItemId) throw new ToolRefusal(OUT_OF_SCOPE)
        const d = await getWorkItemDetail(db, me, workItemId)
        // A requester reads (or may later read) work_item threads: no GitLab links, issues or merge requests there.
        const readable = scope.hideStaffNames || scope.requesterVisible
        const code = readable ? null : await codeSummary(db, workItemId)
        return {
          title: d.title,
          description: clip(readable ? await withoutGitLabLinks(db, d.projectId, d.description) : d.description, 2000),
          priority: d.priority,
          state: d.state,
          steps: d.steps.map((s) => ({ name: s.name.th, status: s.status })),
          openTasks: d.tasks
            .filter((t) => ['proposed', 'open', 'in_progress', 'submitted'].includes(t.state))
            .map((t) => ({
              taskId: t.id,
              title: t.title.th,
              role: t.role,
              state: t.state,
              ...(scope.hideStaffNames ? {} : { assignee: t.assigneeName }),
            })),
          ...(scope.hideStaffNames ? {} : { recentProgress: await progressNotes(db, workItemId, 5) }),
          ...(code ? { code } : {}),
        }
      }),
    }),

    propose_work_item: tool({
      description:
        'Propose a new work item in a project. Creates a confirmation card; nothing is created until the person (or a PM) confirms it.',
      inputSchema: z.object({
        projectId: uuid,
        title: z.string().trim().min(1).max(200),
        description: z.string().max(10000),
        templateKey: z.string().min(1),
        priority: Priority,
        requesterId: uuid.optional(),
      }),
      execute: guarded(async (input) => {
        requireInScope(scope, input.projectId)
        // Naming someone else as the requester is for staff in threads the requester cannot read.
        if (input.requesterId && (!me.isStaff || scope.requesterVisible)) {
          throw new ToolRefusal('I cannot set a requester from this thread. Ask me in your personal chat.')
        }
        await aiVisibleProject(db, me, input.projectId)
        if (!(await latestTemplate(db, input.templateKey))) {
          const keys = (await listTemplates(db)).map((t) => t.key)
          throw new ToolRefusal(`Unknown workflow template. Use one of: ${keys.join(', ')}.`)
        }
        if (input.requesterId) await requirePerson(db, input.requesterId)
        const payload = WorkItemCreate.parse({ ...input, projectId: undefined })
        pending.push(async (ctx) => {
          if (!me.isAdmin && !(await memberRoles(ctx.tx, input.projectId, me.id))) throw notFound()
          const proposalId = await createProposal(ctx, {
            projectId: input.projectId,
            workItemId: null,
            kind: 'create_work_item',
            summary: input.title,
            reason: '',
            payload: { ...payload, projectId: input.projectId },
            onBehalfOf: me.id,
          })
          return { type: 'proposal', proposalId }
        })
        return { status: 'prepared', note: 'A confirmation card will be attached to your reply. The work item is created only once someone confirms it.' }
      }),
    }),

    propose_priority: tool({
      description: "Suggest a work item's priority. This always becomes a proposal a PM confirms; it is never applied directly.",
      inputSchema: z.object({ workItemId: uuid, priority: Priority, reason: z.string().trim().min(1).max(2000) }),
      execute: guarded(async ({ workItemId, priority, reason }) => {
        requireOwnItem(scope, workItemId)
        const { item } = await aiVisibleWorkItem(db, me, workItemId)
        requireInScope(scope, item.projectId)
        if (item.state !== 'active') throw new ToolRefusal('That work item is no longer active.')
        if (item.priority === priority) throw new ToolRefusal(`The priority is already ${priority}.`)
        pending.push(async (ctx) => {
          const locked = await lockItem(ctx.tx, workItemId)
          if (!me.isAdmin && !(await memberRoles(ctx.tx, locked.projectId, me.id))) throw notFound()
          if (locked.state !== 'active') throw new ToolRefusal('That work item is no longer active.')
          // The secretary never changes priority itself, whatever the project's autonomy: a PM decides.
          await supersedePending(ctx, workItemId, 'priority_change')
          const proposalId = await createProposal(ctx, {
            projectId: locked.projectId,
            workItemId,
            kind: 'priority_change',
            summary: `${locked.title}: ${locked.priority} → ${priority}`,
            reason,
            payload: { priority },
            onBehalfOf: me.id,
          })
          return { type: 'proposal', proposalId }
        })
        return { status: 'prepared', note: 'A priority change proposal will be attached to your reply; a PM must confirm it.' }
      }),
    }),

    raise_discussion: tool({
      description:
        'Propose raising a discussion for the team about a decision with real trade-offs or conflicting requirements, linked to a project or one of its work items. Creates a confirmation card; the discussion is raised only once the person (or a PM) confirms it, and an AI brief is then prepared.',
      inputSchema: z.object({
        question: z.string().trim().min(1).max(500),
        details: z.string().max(20000).default(''),
        workItemId: uuid.optional(),
        projectId: uuid.optional(),
        options: z.array(DiscussionOption).max(8).default([]),
      }),
      execute: guarded(async (input) => {
        if (input.projectId) requireInScope(scope, input.projectId)
        // In a work item's thread the discussion belongs to that work item.
        if (scope.workItemId && input.workItemId && input.workItemId !== scope.workItemId) throw new ToolRefusal(OUT_OF_SCOPE)
        const workItemId = input.workItemId ?? scope.workItemId ?? undefined
        let projectId = input.projectId ?? scope.projectId ?? undefined
        if (workItemId) {
          const { item } = await aiVisibleWorkItem(db, me, workItemId)
          requireInScope(scope, item.projectId)
          if (projectId && projectId !== item.projectId) throw new ToolRefusal('That work item is not in that project.')
          if (item.state !== 'active') throw new ToolRefusal('That work item is no longer active.')
          projectId = item.projectId
        } else if (projectId) {
          await aiVisibleProject(db, me, projectId)
        } else {
          throw new ToolRefusal('A discussion needs a project or a work item.')
        }
        const parsed = DiscussionCreate.parse({ ...input, projectId, workItemId })
        const keys = parsed.options.map((o) => o.key)
        if (new Set(keys).size !== keys.length) throw new ToolRefusal('Option keys must be unique.')
        const payload = { question: parsed.question, details: parsed.details, priority: parsed.priority, options: parsed.options }
        const targetProject = projectId!
        pending.push(async (ctx) => {
          if (!me.isAdmin && !(await memberRoles(ctx.tx, targetProject, me.id))) throw notFound()
          if (workItemId) {
            const locked = await lockItem(ctx.tx, workItemId)
            if (locked.state !== 'active') throw new ToolRefusal('That work item is no longer active.')
          }
          const proposalId = await createProposal(ctx, {
            projectId: targetProject,
            workItemId: workItemId ?? null,
            kind: 'raise_discussion',
            summary: parsed.question,
            reason: '',
            payload,
            onBehalfOf: me.id,
          })
          return { type: 'proposal', proposalId }
        })
        return { status: 'prepared', note: 'A confirmation card will be attached to your reply. The discussion is raised only once someone confirms it.' }
      }),
    }),

    save_note: tool({
      description: 'Save a note (a fact or a memory) to a project, or to one of its work items, as an unverified draft for the team to confirm.',
      inputSchema: z.object({
        projectId: uuid,
        workItemId: uuid.optional(),
        type: z.enum(['fact', 'memory']),
        title: z.string().trim().min(1).max(300),
        body: z.string().max(20000),
      }),
      execute: guarded(async (input) => {
        requireInScope(scope, input.projectId)
        requireOwnItem(scope, input.workItemId)
        await aiVisibleProject(db, me, input.projectId)
        if (input.workItemId) {
          const { item } = await aiVisibleWorkItem(db, me, input.workItemId)
          if (item.projectId !== input.projectId) throw new ToolRefusal(NOT_FOUND)
        }
        const create = KnowledgeCreate.parse({
          scope: input.workItemId ? 'work_item' : 'project',
          projectId: input.projectId,
          workItemId: input.workItemId,
          type: input.type,
          title: input.title,
          body: input.body,
        })
        pending.push(async (ctx) => {
          const entryId = await createEntry(ctx, me, { ...create, status: 'draft', sourceKind: 'ai' })
          return { type: 'knowledge_saved', entryId, title: input.title }
        })
        return { status: 'prepared', note: 'The note will be saved as an unverified draft when your reply is sent.' }
      }),
    }),
  }
  // The person's to-do spans all their projects: personal chat only.
  if (scope.projectId) delete tools.my_todo
  if (scope.requesterVisible) {
    delete tools.search_knowledge
    delete tools.project_status
    // Staff-only deliberation never belongs in a thread the requester reads.
    delete tools.raise_discussion
  }
  return tools
}

/** Tools for requesters: only their own requests, never staff names or internal content. */
function requesterTools(deps: ToolDeps, me: Me, pending: PendingAction[]): ToolSet {
  const { db } = deps
  const ownRequests = async () => {
    const list = await getMyRequests(db, me)
    const rows = list.length
      ? await db
          .select({ id: workItems.id, noAi: projects.noAi })
          .from(workItems)
          .innerJoin(projects, eq(projects.id, workItems.projectId))
          .where(inArray(workItems.id, list.map((r) => r.workItemId)))
      : []
    const hidden = new Set(rows.filter((r) => r.noAi).map((r) => r.id))
    return list.map((r) => ({ ...r, hidden: hidden.has(r.workItemId) }))
  }
  return {
    my_requests: tool({
      description: "The person's own requests and their plain-language status.",
      inputSchema: z.object({}),
      execute: guarded(async () =>
        (await ownRequests()).map((r) =>
          r.hidden
            ? { workItemId: r.workItemId, details: NOT_AVAILABLE }
            : { workItemId: r.workItemId, title: r.title, status: r.status, currentStep: r.currentStepName?.th ?? null, updatedAt: r.updatedAt },
        ),
      ),
    }),

    request_status: tool({
      description: "Status of one of the person's own requests, including anything waiting for their answer.",
      inputSchema: z.object({ workItemId: uuid }),
      execute: guarded(async ({ workItemId }) => {
        const r = (await ownRequests()).find((x) => x.workItemId === workItemId)
        if (!r) throw new ToolRefusal('I cannot find that request among your requests.')
        if (r.hidden) throw new ToolRefusal(NOT_AVAILABLE)
        const answers = (await getMyAnswers(db, me)).filter((t) => t.workItemId === workItemId)
        return {
          title: r.title,
          status: r.status,
          currentStep: r.currentStepName?.th ?? null,
          updatedAt: r.updatedAt,
          waitingForYou: answers.map((t) => ({ title: t.title.th, instructions: clip(t.instructions.th, 500) })),
        }
      }),
    }),

    submit_request: tool({
      description:
        'Send a new request to the team, optionally with files the person uploaded in this chat. The team confirms it and chooses the project.',
      inputSchema: z.object({
        title: z.string().trim().min(1).max(200),
        description: z.string().max(10000),
        attachmentIds: z.array(uuid).max(10).default([]),
      }),
      execute: guarded(async ({ title, description, attachmentIds }) => {
        const ids = [...new Set(attachmentIds)]
        await requireOwnIntakeUploads(db, me, ids)
        const templates = await listTemplates(db)
        const templateKey = templates.find((t) => t.key === 'software-change')?.key ?? templates[0]?.key
        if (!templateKey) throw new ToolRefusal('Requests cannot be submitted right now.')
        const payload = { ...WorkItemCreate.parse({ title, description, templateKey, priority: 'normal' }), attachmentIds: ids }
        pending.push(async (ctx) => {
          await requireOwnIntakeUploads(ctx.tx, me, ids)
          const proposalId = await createProposal(ctx, {
            projectId: null,
            workItemId: null,
            kind: 'create_work_item',
            summary: title,
            reason: '',
            payload,
            onBehalfOf: me.id,
          })
          return { type: 'proposal', proposalId }
        })
        return { status: 'prepared', note: 'The request will be sent to the team when your reply is posted; they will confirm it.' }
      }),
    }),
  }
}

async function requirePerson(db: Db, id: string): Promise<void> {
  const [p] = await db.select({ id: people.id }).from(people).where(eq(people.id, id))
  if (!p) throw new ToolRefusal('That requester is not a known person.')
}

/** Every id must be a file `me` uploaded to their own personal/intake conversation. */
async function requireOwnIntakeUploads(db: Db | Tx, me: Me, ids: string[]): Promise<void> {
  if (!ids.length) return
  const rows = await db
    .select({ id: attachments.id })
    .from(attachments)
    .innerJoin(conversations, eq(conversations.id, attachments.conversationId))
    .where(
      and(
        inArray(attachments.id, ids),
        eq(attachments.uploadedBy, me.id),
        eq(conversations.ownerId, me.id),
        inArray(conversations.kind, ['personal', 'intake']),
      ),
    )
  if (rows.length !== ids.length) throw new ToolRefusal('Only files you uploaded in this chat can be attached.')
}

async function projectNames(db: Db, ids: (string | null)[]): Promise<Map<string, string>> {
  const set = [...new Set(ids.filter((x): x is string => !!x))]
  if (!set.length) return new Map()
  const rows = await db.select({ id: projects.id, name: projects.name }).from(projects).where(inArray(projects.id, set))
  return new Map(rows.map((r) => [r.id, r.name]))
}

/** Latest progress notes of a work item that may go to the AI (no noAi entries or entries of noAi files). */
export async function progressNotes(db: Db, workItemId: string, limit: number): Promise<{ title: string; text: string }[]> {
  const rows = await db
    .select({ title: knowledgeEntries.title, body: knowledgeEntries.body })
    .from(knowledgeEntries)
    .where(
      and(
        eq(knowledgeEntries.workItemId, workItemId),
        eq(knowledgeEntries.type, 'progress'),
        isNull(knowledgeEntries.supersededAt),
        sql`not ${knowledgeEntries.noAi}`,
        sql`not exists (select 1 from attachments a where a.id = ${knowledgeEntries.attachmentId} and a.no_ai)`,
      ),
    )
    .orderBy(desc(knowledgeEntries.createdAt), desc(knowledgeEntries.id))
    .limit(limit)
  return rows.map((r) => ({ title: r.title, text: clip(r.body, 800) }))
}

/** The tool set for the person: staff tools for staff, requester tools otherwise; `scope` for team threads. */
export function secretaryTools(deps: ToolDeps, me: Me, pending: PendingAction[], scope: ToolScope = PERSONAL): ToolSet {
  return me.isStaff ? staffTools(deps, me, pending, scope) : requesterTools(deps, me, pending)
}
