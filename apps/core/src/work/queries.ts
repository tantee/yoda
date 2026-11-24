import {
  ACTIVE_TASK_STATES,
  EventEntry,
  MyRequest,
  Task,
  TaskWithContext,
  Todo,
  WorkflowTemplateDef,
  WorkflowTemplateSummary,
  WorkItem,
  WorkItemDetail,
  type Attachment,
  type Me,
  type RequestStatus,
  type TaskInput,
  type TemplateTask,
} from '@yoda/shared'
import { and, asc, desc, eq, inArray, isNull, or, sql, type SQL } from 'drizzle-orm'
import { alias } from 'drizzle-orm/pg-core'
import { forbidden, notFound } from '../auth/plugin.js'
import { attachmentsByTask } from '../attachments/service.js'
import type { Db, Tx } from '../db/client.js'
import { pendingForDecider } from '../proposals/service.js'
import { events, people, projectMembers, projects, tasks, workflowTemplates, workItems } from '../db/schema.js'

type Conn = Db | Tx
type TaskRow = typeof tasks.$inferSelect

const ACTIVE = ACTIVE_TASK_STATES

const priorityRank = sql`case ${workItems.priority} when 'urgent' then 0 when 'high' then 1 when 'normal' then 2 else 3 end`

/** Requesters are refused before any lookup, so ids are never probed. */
function requireStaffMe(me: Me): void {
  if (!me.isStaff) throw forbidden()
}

/** Admin, or a member of the project. */
export async function canSeeProject(db: Conn, me: Me, projectId: string): Promise<boolean> {
  if (me.isAdmin) return true
  const [row] = await db
    .select({ id: projectMembers.personId })
    .from(projectMembers)
    .where(and(eq(projectMembers.projectId, projectId), eq(projectMembers.personId, me.id)))
  return !!row
}

/** Staff who may see the project (admin or member). Requesters never see projects. */
async function staffSeesProject(db: Conn, me: Me, projectId: string): Promise<boolean> {
  return me.isStaff && (await canSeeProject(db, me, projectId))
}

/** A REQUESTER task assigned to `me`: the only tasks a requester may see. */
const ownRequesterTask = (me: Me, t: { role: string; assigneeId: string | null }) =>
  t.role === 'REQUESTER' && t.assigneeId === me.id

/**
 * 404 unless the task exists and `me` may see its project. With `requesterTask` (the read / start / submit
 * routes), a REQUESTER task assigned to `me` is visible too, for requesters and staff alike; without it
 * requesters are refused before any lookup.
 */
export async function requireTaskVisible(
  db: Conn,
  me: Me,
  taskId: string,
  opts: { requesterTask?: boolean } = {},
): Promise<void> {
  if (!opts.requesterTask) requireStaffMe(me)
  const [row] = await db
    .select({ projectId: tasks.projectId, role: tasks.role, assigneeId: tasks.assigneeId })
    .from(tasks)
    .where(eq(tasks.id, taskId))
  if (!row) throw notFound()
  if (await staffSeesProject(db, me, row.projectId)) return
  if (opts.requesterTask && ownRequesterTask(me, row)) return
  throw notFound()
}

/** 404 unless the work item exists and `me` may see its project. */
export async function requireWorkItemVisible(db: Conn, me: Me, id: string): Promise<void> {
  requireStaffMe(me)
  const [row] = await db.select({ projectId: workItems.projectId }).from(workItems).where(eq(workItems.id, id))
  if (!row || !(await canSeeProject(db, me, row.projectId))) throw notFound()
}

async function definitions(db: Conn, templateIds: string[]): Promise<Map<string, WorkflowTemplateDef>> {
  const ids = [...new Set(templateIds)]
  if (!ids.length) return new Map()
  const rows = await db.select().from(workflowTemplates).where(inArray(workflowTemplates.id, ids))
  return new Map(rows.map((r) => [r.id, r.definition as WorkflowTemplateDef]))
}

async function names(db: Conn, ids: (string | null)[]): Promise<Map<string, string>> {
  const set = [...new Set(ids.filter((x): x is string => !!x))]
  if (!set.length) return new Map()
  const rows = await db
    .select({ id: people.id, displayName: people.displayName })
    .from(people)
    .where(inArray(people.id, set))
  return new Map(rows.map((r) => [r.id, r.displayName]))
}

function templateTask(def: WorkflowTemplateDef | undefined, row: TaskRow): TemplateTask {
  const t = def?.steps.find((s) => s.key === row.stepKey)?.tasks.find((x) => x.key === row.templateTaskKey)
  if (!t) throw new Error(`template task ${row.stepKey}/${row.templateTaskKey} missing`)
  return t
}

type AiState = { status: 'drafting' | 'failed'; reason: string | null }

/**
 * AI draft status of the tasks that still await the AI (open, unassigned, `ai` executor, `draft-text`, project
 * not noAi): 'failed' when the latest `ai.failed` / `ai.retried` event is a failure, else 'drafting'.
 */
async function aiStates(db: Conn, items: { row: TaskRow; def: WorkflowTemplateDef | undefined }[]): Promise<Map<string, AiState>> {
  const waiting = items.filter(
    ({ row, def }) =>
      row.state === 'open' && row.executor === 'ai' && !row.assigneeId && templateTask(def, row).capability === 'draft-text',
  )
  const out = new Map<string, AiState>()
  if (!waiting.length) return out
  const noAi = new Set(
    (
      await db
        .select({ id: projects.id })
        .from(projects)
        .where(and(inArray(projects.id, [...new Set(waiting.map((w) => w.row.projectId))]), eq(projects.noAi, true)))
    ).map((p) => p.id),
  )
  const ids = waiting.filter((w) => !noAi.has(w.row.projectId)).map((w) => w.row.id)
  if (!ids.length) return out
  const evs = await db
    .select({ taskId: events.taskId, type: events.type, reason: events.reason })
    .from(events)
    .where(and(inArray(events.taskId, ids), inArray(events.type, ['ai.failed', 'ai.retried'])))
    .orderBy(asc(events.seq))
  const latest = new Map<string, { type: string; reason: string | null }>()
  for (const e of evs) latest.set(e.taskId!, e)
  for (const id of ids) {
    const e = latest.get(id)
    out.set(id, e?.type === 'ai.failed' ? { status: 'failed', reason: e.reason } : { status: 'drafting', reason: null })
  }
  return out
}

function toTask(row: TaskRow, def: WorkflowTemplateDef | undefined, who: Map<string, string>, ai: Map<string, AiState>): Task {
  const tt = templateTask(def, row)
  return Task.parse({
    id: row.id,
    workItemId: row.workItemId,
    projectId: row.projectId,
    stepKey: row.stepKey,
    templateTaskKey: row.templateTaskKey,
    attempt: row.attempt,
    type: row.type,
    role: row.role,
    executor: row.executor,
    title: tt.title,
    instructions: tt.instructions,
    feedback: row.feedback,
    state: row.state,
    assigneeId: row.assigneeId,
    assigneeName: row.assigneeId ? (who.get(row.assigneeId) ?? null) : null,
    proposedAssigneeId: row.proposedAssigneeId,
    proposedAssigneeName: row.proposedAssigneeId ? (who.get(row.proposedAssigneeId) ?? null) : null,
    result: row.result ?? null,
    aiStatus: ai.get(row.id)?.status ?? null,
    aiFailReason: ai.get(row.id)?.reason ?? null,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  })
}

/**
 * Tasks joined with their work item / project, in the order the `where`/`orderBy` give.
 * With `viewer`, tasks of projects the viewer cannot see as staff (a requester's own REQUESTER tasks) get the
 * requester view: inputs only from the immediately preceding dependency (the last `dependsOn` key).
 */
export async function tasksWithContext(
  db: Conn,
  where: SQL | undefined,
  orderBy: SQL[],
  viewer?: Me,
): Promise<TaskWithContext[]> {
  const rows = await db
    .select({ t: tasks, templateId: workItems.templateId, workItemTitle: workItems.title, workItemPriority: workItems.priority, projectName: projects.name })
    .from(tasks)
    .innerJoin(workItems, eq(workItems.id, tasks.workItemId))
    .innerJoin(projects, eq(projects.id, tasks.projectId))
    .where(where)
    .orderBy(...orderBy)
  const defs = await definitions(db, rows.map((r) => r.templateId))
  const who = await names(db, rows.flatMap((r) => [r.t.assigneeId, r.t.proposedAssigneeId]))
  const ai = await aiStates(db, rows.map((r) => ({ row: r.t, def: defs.get(r.templateId) })))

  const restricted = viewer ? await projectsHiddenFrom(db, viewer, rows.map((r) => r.t.projectId)) : new Set<string>()
  // Inputs: for each dependsOn key, the latest accepted attempt of that task in the same work item.
  const depsOf = new Map(
    rows.map((r) => {
      const deps = templateTask(defs.get(r.templateId), r.t).dependsOn
      return [r.t.id, restricted.has(r.t.projectId) ? deps.slice(-1) : deps]
    }),
  )
  const withDeps = rows.filter((r) => depsOf.get(r.t.id)!.length)
  const accepted = withDeps.length
    ? await db
        .select()
        .from(tasks)
        .where(
          and(
            inArray(tasks.workItemId, [...new Set(withDeps.map((r) => r.t.workItemId))]),
            inArray(tasks.templateTaskKey, [...new Set(withDeps.flatMap((r) => depsOf.get(r.t.id)!))]),
            eq(tasks.state, 'accepted'),
          ),
        )
    : []
  const latestAccepted = new Map<string, TaskRow>()
  for (const a of accepted) {
    const k = `${a.workItemId}/${a.templateTaskKey}`
    const cur = latestAccepted.get(k)
    if (!cur || a.attempt > cur.attempt) latestAccepted.set(k, a)
  }
  const files = await attachmentsByTask(db, [...rows.map((r) => r.t.id), ...[...latestAccepted.values()].map((a) => a.id)])

  return rows.map((r) => {
    const def = defs.get(r.templateId)
    const inputs: TaskInput[] = []
    const requesterView = restricted.has(r.t.projectId)
    for (const key of depsOf.get(r.t.id)!) {
      const dep = latestAccepted.get(`${r.t.workItemId}/${key}`)
      if (!dep) continue
      const depTask = templateTask(def, dep)
      inputs.push({
        templateTaskKey: key,
        title: depTask.title,
        executor: dep.executor as TaskInput['executor'],
        result: (dep.result ?? { text: '' }) as TaskInput['result'],
        attachments: requesterView ? forRequester(files.get(dep.id) ?? [], { uploadedBy: viewer!.id }) : (files.get(dep.id) ?? []),
      })
    }
    return TaskWithContext.parse({
      ...toTask(r.t, def, who, ai),
      workItemTitle: r.workItemTitle,
      workItemPriority: r.workItemPriority,
      projectName: r.projectName,
      inputs,
      attachments: requesterView ? forRequester(files.get(r.t.id) ?? []) : (files.get(r.t.id) ?? []),
    })
  })
}

/**
 * Attachments as a requester may see them: no staff names, and (with `uploadedBy`) only files that person
 * uploaded, so staff-internal files on earlier tasks never appear.
 */
function forRequester(list: Attachment[], opts: { uploadedBy?: string } = {}): Attachment[] {
  return list
    .filter((a) => !opts.uploadedBy || a.uploadedById === opts.uploadedBy)
    .map((a) => ({ ...a, uploadedByName: '' }))
}

/** Of `projectIds`, those `me` cannot see as staff (all of them for a requester). */
async function projectsHiddenFrom(db: Conn, me: Me, projectIds: string[]): Promise<Set<string>> {
  const ids = [...new Set(projectIds)]
  if (!ids.length || (me.isStaff && me.isAdmin)) return new Set()
  if (!me.isStaff) return new Set(ids)
  const member = await db
    .select({ id: projectMembers.projectId })
    .from(projectMembers)
    .where(and(eq(projectMembers.personId, me.id), inArray(projectMembers.projectId, ids)))
  const seen = new Set(member.map((m) => m.id))
  return new Set(ids.filter((id) => !seen.has(id)))
}

const requester = alias(people, 'requester')

const workItemCols = {
  w: workItems,
  templateKey: workflowTemplates.key,
  templateVersion: workflowTemplates.version,
  definition: workflowTemplates.definition,
  ownerName: people.displayName,
  requesterName: requester.displayName,
}

function workItemQuery(db: Conn) {
  return db
    .select(workItemCols)
    .from(workItems)
    .innerJoin(workflowTemplates, eq(workflowTemplates.id, workItems.templateId))
    .innerJoin(people, eq(people.id, workItems.ownerId))
    .leftJoin(requester, eq(requester.id, workItems.requesterId))
}

type WorkItemJoined = Awaited<ReturnType<ReturnType<typeof workItemQuery>['execute']>>[number]

function toWorkItem(r: WorkItemJoined): WorkItem {
  const w = r.w
  return WorkItem.parse({
    id: w.id,
    projectId: w.projectId,
    title: w.title,
    description: w.description,
    templateKey: r.templateKey,
    templateVersion: r.templateVersion,
    currentStepKey: w.currentStepKey,
    priority: w.priority,
    ownerId: w.ownerId,
    ownerName: r.ownerName,
    requesterId: w.requesterId,
    requesterName: r.requesterName,
    state: w.state,
    createdAt: w.createdAt.toISOString(),
    updatedAt: w.updatedAt.toISOString(),
  })
}

export async function getWorkItemDetail(db: Conn, me: Me, id: string): Promise<WorkItemDetail> {
  requireStaffMe(me)
  const [r] = await workItemQuery(db).where(eq(workItems.id, id))
  if (!r || !(await canSeeProject(db, me, r.w.projectId))) throw notFound()
  const def = r.definition as WorkflowTemplateDef

  const currentIndex = def.steps.findIndex((s) => s.key === r.w.currentStepKey)
  const steps = def.steps.map((s, i) => ({
    key: s.key,
    name: s.name,
    status:
      r.w.state === 'done' || (currentIndex >= 0 && i < currentIndex)
        ? ('done' as const)
        : i === currentIndex
          ? ('current' as const)
          : ('pending' as const),
  }))

  const taskRows = await db.select().from(tasks).where(eq(tasks.workItemId, id))
  const position = (t: TaskRow): [number, number, number] => {
    const si = def.steps.findIndex((s) => s.key === t.stepKey)
    const ti = def.steps[si]?.tasks.findIndex((x) => x.key === t.templateTaskKey) ?? -1
    return [si, ti, t.attempt]
  }
  taskRows.sort((a, b) => {
    const pa = position(a)
    const pb = position(b)
    return pa[0] - pb[0] || pa[1] - pb[1] || pa[2] - pb[2]
  })

  const eventRows = await db
    .select({ e: events, actorName: people.displayName })
    .from(events)
    .leftJoin(people, eq(people.id, events.actorId))
    .where(eq(events.workItemId, id))
    .orderBy(asc(events.seq))

  const who = await names(db, taskRows.flatMap((t) => [t.assigneeId, t.proposedAssigneeId]))
  const ai = await aiStates(db, taskRows.map((row) => ({ row, def })))
  return WorkItemDetail.parse({
    ...toWorkItem(r),
    steps,
    tasks: taskRows.map((t) => toTask(t, def, who, ai)),
    events: eventRows.map(({ e, actorName }) =>
      EventEntry.parse({
        id: e.id,
        type: e.type,
        actorKind: e.actorKind,
        actorId: e.actorId,
        actorName: actorName ?? null,
        taskId: e.taskId,
        reason: e.reason,
        payload: e.payload,
        createdAt: e.createdAt.toISOString(),
      }),
    ),
  })
}

export async function listWorkItems(db: Conn, me: Me, projectId: string): Promise<WorkItem[]> {
  requireStaffMe(me)
  const [project] = await db.select({ id: projects.id }).from(projects).where(eq(projects.id, projectId))
  if (!project || !(await canSeeProject(db, me, projectId))) throw notFound()
  const rows = await workItemQuery(db)
    .where(eq(workItems.projectId, projectId))
    .orderBy(desc(workItems.createdAt), desc(workItems.id))
  return rows.map(toWorkItem)
}

/** Staff see tasks of their projects; anyone sees a REQUESTER task assigned to them (the requester view). */
export async function getTask(db: Conn, me: Me, id: string): Promise<TaskWithContext> {
  const [t] = await tasksWithContext(db, eq(tasks.id, id), [], me)
  if (!t) throw notFound()
  if (!(await staffSeesProject(db, me, t.projectId)) && !ownRequesterTask(me, t)) throw notFound()
  return t
}

export async function getTodo(db: Conn, me: Me): Promise<Todo> {
  requireStaffMe(me)
  const order = [priorityRank, asc(tasks.createdAt), asc(tasks.id)]

  // Includes REQUESTER tasks of items this person asked for (requester view when outside the project).
  const mine = await tasksWithContext(
    db,
    and(eq(tasks.assigneeId, me.id), inArray(tasks.state, ['open', 'in_progress'])),
    order,
    me,
  )

  const pmProjects = db
    .select({ id: projectMembers.projectId })
    .from(projectMembers)
    .where(and(eq(projectMembers.personId, me.id), sql`'PM' = any(${projectMembers.roles})`))
  const pmlessProjects = db
    .select({ id: projects.id })
    .from(projects)
    .where(
      sql`not exists (select 1 from ${projectMembers} pm where pm.project_id = ${projects.id} and 'PM' = any(pm.roles))`,
    )
  const scope = me.isAdmin
    ? or(inArray(tasks.projectId, pmProjects), inArray(tasks.projectId, pmlessProjects))
    : inArray(tasks.projectId, pmProjects)

  const confirmations = await tasksWithContext(
    db,
    and(
      scope,
      inArray(tasks.state, [...ACTIVE]),
      or(
        eq(tasks.state, 'proposed'),
        and(isNull(tasks.assigneeId), isNull(tasks.proposedAssigneeId), eq(tasks.executor, 'human')),
        and(isNull(tasks.assigneeId), eq(tasks.executor, 'ai')),
      ),
    ),
    order,
  )
  return Todo.parse({ tasks: mine, confirmations, proposals: await pendingForDecider(db, me) })
}

/** "Things I need to answer": my active REQUESTER tasks, oldest first (any signed-in person). */
export async function getMyAnswers(db: Conn, me: Me): Promise<TaskWithContext[]> {
  return tasksWithContext(
    db,
    and(eq(tasks.assigneeId, me.id), eq(tasks.role, 'REQUESTER'), inArray(tasks.state, [...ACTIVE])),
    [asc(tasks.createdAt), asc(tasks.id)],
    me,
  )
}

/** Work items `me` asked for (requester_id = me), newest first, in plain-language status. */
export async function getMyRequests(db: Conn, me: Me): Promise<MyRequest[]> {
  const rows = await db
    .select({ w: workItems, projectName: projects.name, definition: workflowTemplates.definition })
    .from(workItems)
    .innerJoin(projects, eq(projects.id, workItems.projectId))
    .innerJoin(workflowTemplates, eq(workflowTemplates.id, workItems.templateId))
    .where(eq(workItems.requesterId, me.id))
    .orderBy(desc(workItems.createdAt), desc(workItems.id))
  if (!rows.length) return []
  const waiting = new Set(
    (
      await db
        .selectDistinct({ id: tasks.workItemId })
        .from(tasks)
        .where(
          and(
            inArray(tasks.workItemId, rows.map((r) => r.w.id)),
            eq(tasks.assigneeId, me.id),
            eq(tasks.role, 'REQUESTER'),
            inArray(tasks.state, [...ACTIVE]),
          ),
        )
    ).map((t) => t.id),
  )
  return rows.map(({ w, projectName, definition }) => {
    const def = definition as WorkflowTemplateDef
    const status: RequestStatus =
      w.state === 'cancelled' || w.state === 'done'
        ? w.state
        : waiting.has(w.id)
          ? 'waiting_for_you'
          : w.currentStepKey === def.steps[0]?.key
            ? 'submitted'
            : 'in_progress'
    const step = def.steps.find((s) => s.key === w.currentStepKey)
    return MyRequest.parse({
      workItemId: w.id,
      title: w.title,
      projectName,
      status,
      currentStepName: step?.name ?? null,
      updatedAt: w.updatedAt.toISOString(),
    })
  })
}

/** Latest version of every template, sorted by key. */
export async function listTemplates(db: Conn): Promise<WorkflowTemplateSummary[]> {
  const rows = await db
    .select()
    .from(workflowTemplates)
    .orderBy(asc(workflowTemplates.key), desc(workflowTemplates.version))
  const seen = new Set<string>()
  const out: WorkflowTemplateSummary[] = []
  for (const r of rows) {
    if (seen.has(r.key)) continue
    seen.add(r.key)
    const def = r.definition as WorkflowTemplateDef
    out.push(
      WorkflowTemplateSummary.parse({
        key: r.key,
        version: r.version,
        name: def.name,
        steps: def.steps.map((s) => ({ key: s.key, name: s.name })),
      }),
    )
  }
  return out
}
