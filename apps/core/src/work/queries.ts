import {
  ACTIVE_TASK_STATES,
  KEY_EVENT_TYPES,
  MyRequest,
  MyRequestDetail,
  REQUEST_TIMELINE_LIMIT,
  RequestEvent,
  Task,
  TaskWithContext,
  Todo,
  TodoWorkItem,
  WorkflowTemplateDef,
  WorkflowTemplateSummary,
  WorkItem,
  WorkItemDetail,
  WorkItemEventsPage,
  type Attachment,
  type Me,
  type RequestStatus,
  type TaskInput,
  type TaskRunSummary,
  type TemplateTask,
  type WorkItemStep,
  isExtensionOnlyTemplate,
} from '@yoda/shared'
import { and, asc, desc, eq, inArray, isNull, lt, or, sql, type SQL } from 'drizzle-orm'
import { alias } from 'drizzle-orm/pg-core'
import { forbidden, notFound } from '../auth/plugin.js'
import { attachmentsByTask } from '../attachments/service.js'
import type { Db, Tx } from '../db/client.js'
import { pendingForDecider } from '../proposals/service.js'
import { defectView } from '../defects/view.js'
import { agentRuns, discussions, events, people, projectMembers, projects, proposals, runners, tasks, workflowTemplates, workItems } from '../db/schema.js'

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
 * AI status of the tasks that still await the AI (open, unassigned, `ai` executor, project not noAi), from the
 * latest `ai.failed` / `ai.retried` event: `draft-text` tasks are 'failed' after a failure, else 'drafting';
 * runner tasks are 'failed' after the runners gave up (three strikes), else null (waiting for a runner).
 */
async function aiStates(db: Conn, items: { row: TaskRow; def: WorkflowTemplateDef | undefined }[]): Promise<Map<string, AiState>> {
  const waiting = items.filter(({ row }) => row.state === 'open' && row.executor === 'ai' && !row.assigneeId)
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
  const live = waiting.filter((w) => !noAi.has(w.row.projectId))
  if (!live.length) return out
  const evs = await db
    .select({ taskId: events.taskId, type: events.type, reason: events.reason })
    .from(events)
    .where(and(inArray(events.taskId, live.map((w) => w.row.id)), inArray(events.type, ['ai.failed', 'ai.retried'])))
    .orderBy(asc(events.seq))
  const latest = new Map<string, { type: string; reason: string | null }>()
  for (const e of evs) latest.set(e.taskId!, e)
  for (const { row, def } of live) {
    const e = latest.get(row.id)
    if (e?.type === 'ai.failed') out.set(row.id, { status: 'failed', reason: e.reason })
    else if (templateTask(def, row).capability === 'draft-text') out.set(row.id, { status: 'drafting', reason: null })
  }
  return out
}

/**
 * Tasks waiting on a runner's question: parked on a discussion that has not been decided (as claims see it).
 * Staff only, like runs.
 */
async function parkedTasks(db: Conn, taskIds: string[]): Promise<Set<string>> {
  if (!taskIds.length) return new Set()
  const rows = await db
    .select({ id: tasks.id })
    .from(tasks)
    .leftJoin(discussions, eq(discussions.id, tasks.parkedDiscussionId))
    .where(
      and(
        inArray(tasks.id, taskIds),
        sql`${tasks.parkedDiscussionId} is not null`,
        or(isNull(discussions.state), sql`${discussions.state} <> 'decided'`),
      ),
    )
  return new Set(rows.map((r) => r.id))
}

/** The latest runner run of each task (work item detail, staff only). */
async function latestRuns(db: Conn, taskIds: string[]): Promise<Map<string, TaskRunSummary>> {
  if (!taskIds.length) return new Map()
  const rows = await db
    .selectDistinctOn([agentRuns.taskId], {
      taskId: agentRuns.taskId,
      state: agentRuns.state,
      runnerName: runners.name,
      heartbeatAt: agentRuns.heartbeatAt,
      branch: agentRuns.branch,
    })
    .from(agentRuns)
    .innerJoin(runners, eq(runners.id, agentRuns.runnerId))
    .where(inArray(agentRuns.taskId, taskIds))
    .orderBy(agentRuns.taskId, desc(agentRuns.startedAt), desc(agentRuns.id))
  return new Map(
    rows.map((r) => [
      r.taskId,
      { state: r.state as TaskRunSummary['state'], runnerName: r.runnerName, heartbeatAt: r.heartbeatAt.toISOString(), branch: r.branch },
    ]),
  )
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
    capability: tt.capability ?? null,
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
            isNull(tasks.supersededAt),
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
      const result = (dep.result ?? { text: '' }) as TaskInput['result']
      const depFiles = requesterView ? forRequester(files.get(dep.id) ?? [], viewer!.id, { onlyOwn: true }) : (files.get(dep.id) ?? [])
      inputs.push({
        templateTaskKey: key,
        title: depTask.title,
        executor: dep.executor as TaskInput['executor'],
        // A requester never learns the ids of staff files they cannot see.
        result: requesterView ? { ...forRequesterResult(result), attachmentIds: visibleIds(result.attachmentIds, depFiles) } : result,
        attachments: depFiles,
      })
    }
    const task = toTask(r.t, def, who, ai)
    return TaskWithContext.parse({
      ...task,
      result: requesterView && task.result ? forRequesterResult(task.result) : task.result,
      // Requesters see no template internals (which tasks run on AI runners).
      capability: requesterView ? null : task.capability,
      workItemTitle: r.workItemTitle,
      workItemPriority: r.workItemPriority,
      projectName: r.projectName,
      inputs,
      viewerIsRequester: requesterView,
      attachments: requesterView ? forRequester(files.get(r.t.id) ?? [], viewer!.id) : (files.get(r.t.id) ?? []),
    })
  })
}

/**
 * Attachments as requester `viewerId` may see them: no staff names or ids (another uploader's `uploadedById`
 * is null), and with `onlyOwn` only files the viewer uploaded, so staff-internal files on earlier tasks never
 * appear.
 */
function forRequester(list: Attachment[], viewerId: string, opts: { onlyOwn?: boolean } = {}): Attachment[] {
  return list
    .filter((a) => !opts.onlyOwn || a.uploadedById === viewerId)
    .map((a) => ({ ...a, uploadedById: a.uploadedById === viewerId ? a.uploadedById : null, uploadedByName: '' }))
}

/** A task result as a requester sees it: without the AI drafter's internal `confidence` / `missing` notes. */
function forRequesterResult<T extends { confidence?: unknown; missing?: unknown }>(result: T): Omit<T, 'confidence' | 'missing'> {
  const { confidence: _confidence, missing: _missing, ...rest } = result
  return rest
}

/** Of `ids`, those among the visible `files`, in order. */
function visibleIds(ids: string[] | undefined, files: Attachment[]): string[] {
  const seen = new Set(files.map((f) => f.id))
  return (ids ?? []).filter((id) => seen.has(id))
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

type AdvanceState = {
  /** Ids of the items that are `awaitingAdvance`. */
  awaiting: Set<string>
  /** Open / scheduled discussions per item id (absent: none). */
  openDiscussions: Map<string, number>
}

/**
 * Per row: its open / scheduled discussion count, and whether the item is `awaitingAdvance`: active, every
 * task of the current step accepted (latest attempt), a next step exists, no step_advance proposal is
 * pending, and no open discussion holds the step.
 */
async function advanceState(db: Conn, rows: WorkItemJoined[]): Promise<AdvanceState> {
  const openDiscussions = new Map<string, number>()
  const active = rows.filter((r) => r.w.state === 'active').map((r) => r.w.id)
  if (active.length) {
    const counts = await db
      .select({ workItemId: discussions.workItemId, n: sql<number>`count(*)::int` })
      .from(discussions)
      .where(and(inArray(discussions.workItemId, active), inArray(discussions.state, ['open', 'scheduled'])))
      .groupBy(discussions.workItemId)
    for (const c of counts) if (c.workItemId) openDiscussions.set(c.workItemId, c.n)
  }
  const candidates = rows.filter((r) => {
    if (r.w.state !== 'active' || openDiscussions.has(r.w.id)) return false
    const def = r.definition as WorkflowTemplateDef
    const i = def.steps.findIndex((s) => s.key === r.w.currentStepKey)
    return i >= 0 && i < def.steps.length - 1
  })
  if (!candidates.length) return { awaiting: new Set(), openDiscussions }
  const ids = candidates.map((r) => r.w.id)
  const taskRows = await db
    .select({ workItemId: tasks.workItemId, key: tasks.templateTaskKey, attempt: tasks.attempt, state: tasks.state })
    .from(tasks)
    .where(and(inArray(tasks.workItemId, ids), isNull(tasks.supersededAt)))
  const pending = await db
    .select({ workItemId: proposals.workItemId })
    .from(proposals)
    .where(and(inArray(proposals.workItemId, ids), eq(proposals.kind, 'step_advance'), eq(proposals.state, 'pending')))
  const blocked = new Set(pending.map((p) => p.workItemId))
  const latest = new Map<string, { attempt: number; state: string }>()
  for (const t of taskRows) {
    const k = `${t.workItemId}/${t.key}`
    const cur = latest.get(k)
    if (!cur || t.attempt > cur.attempt) latest.set(k, t)
  }
  const out = new Set<string>()
  for (const r of candidates) {
    if (blocked.has(r.w.id)) continue
    const step = (r.definition as WorkflowTemplateDef).steps.find((s) => s.key === r.w.currentStepKey)!
    if (step.tasks.every((t) => latest.get(`${r.w.id}/${t.key}`)?.state === 'accepted')) out.add(r.w.id)
  }
  return { awaiting: out, openDiscussions }
}

function toWorkItem(r: WorkItemJoined, state: AdvanceState): WorkItem {
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
    targetDate: w.targetDate,
    ownerId: w.ownerId,
    ownerName: r.ownerName,
    requesterId: w.requesterId,
    requesterName: r.requesterName,
    state: w.state,
    awaitingAdvance: state.awaiting.has(w.id),
    openDiscussions: state.openDiscussions.get(w.id) ?? 0,
    createdAt: w.createdAt.toISOString(),
    updatedAt: w.updatedAt.toISOString(),
  })
}

/** The item's step track: steps before the current one (all of them once done) are done. */
function stepsOf(def: WorkflowTemplateDef, w: { state: string; currentStepKey: string | null }): WorkItemStep[] {
  const currentIndex = def.steps.findIndex((s) => s.key === w.currentStepKey)
  return def.steps.map((s, i) => ({
    key: s.key,
    name: s.name,
    status:
      w.state === 'done' || (currentIndex >= 0 && i < currentIndex)
        ? ('done' as const)
        : i === currentIndex
          ? ('current' as const)
          : ('pending' as const),
  }))
}

/**
 * The To-do page's context: work items (title, project, priority, target date, step track) and project names
 * for the given ids, limited to projects `me` sees as staff.
 */
async function todoContext(
  db: Conn,
  me: Me,
  workItemIds: string[],
  projectIds: string[],
): Promise<{ workItems: Record<string, TodoWorkItem>; projectNames: Record<string, string> }> {
  const ids = [...new Set(workItemIds)]
  const rows = ids.length
    ? await db
        .select({ w: workItems, projectName: projects.name, definition: workflowTemplates.definition })
        .from(workItems)
        .innerJoin(projects, eq(projects.id, workItems.projectId))
        .innerJoin(workflowTemplates, eq(workflowTemplates.id, workItems.templateId))
        .where(inArray(workItems.id, ids))
    : []
  const allProjects = [...new Set([...projectIds, ...rows.map((r) => r.w.projectId)])]
  const hidden = await projectsHiddenFrom(db, me, allProjects)
  const items: Record<string, TodoWorkItem> = {}
  for (const r of rows) {
    if (hidden.has(r.w.projectId)) continue
    items[r.w.id] = TodoWorkItem.parse({
      id: r.w.id,
      title: r.w.title,
      projectId: r.w.projectId,
      projectName: r.projectName,
      priority: r.w.priority,
      targetDate: r.w.targetDate,
      steps: stepsOf(r.definition as WorkflowTemplateDef, r.w),
    })
  }
  const visible = allProjects.filter((id) => !hidden.has(id))
  const named = visible.length
    ? await db.select({ id: projects.id, name: projects.name }).from(projects).where(inArray(projects.id, visible))
    : []
  return { workItems: items, projectNames: Object.fromEntries(named.map((p) => [p.id, p.name])) }
}

export async function getWorkItemDetail(db: Conn, me: Me, id: string): Promise<WorkItemDetail> {
  requireStaffMe(me)
  const [r] = await workItemQuery(db).where(eq(workItems.id, id))
  if (!r || !(await canSeeProject(db, me, r.w.projectId))) throw notFound()
  const def = r.definition as WorkflowTemplateDef

  const steps = stepsOf(def, r.w)

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

  const who = await names(db, taskRows.flatMap((t) => [t.assigneeId, t.proposedAssigneeId]))
  const ai = await aiStates(db, taskRows.map((row) => ({ row, def })))
  const runs = await latestRuns(db, taskRows.map((t) => t.id))
  const parked = await parkedTasks(db, taskRows.map((t) => t.id))
  return WorkItemDetail.parse({
    ...toWorkItem(r, await advanceState(db, [r])),
    steps,
    tasks: taskRows.map((t) => ({ ...toTask(t, def, who, ai), run: runs.get(t.id) ?? null, parked: parked.has(t.id) })),
    defect: await defectView(db, id),
  })
}

function eventEntry(e: typeof events.$inferSelect, actorName: string | null) {
  return {
    id: e.id,
    type: e.type,
    actorKind: e.actorKind,
    actorId: e.actorId,
    actorName: actorName ?? null,
    taskId: e.taskId,
    reason: e.reason,
    payload: e.payload,
    createdAt: e.createdAt.toISOString(),
  }
}

/**
 * One page of a work item's timeline, newest first by seq (staff who see the item; 404 otherwise). `before` is
 * the seq cursor from the previous page; `nextBefore` is null once the oldest event is on the page.
 */
export async function listWorkItemEvents(
  db: Conn,
  me: Me,
  id: string,
  { before, limit, kind = 'all' }: { before?: number; limit: number; kind?: 'all' | 'key' },
): Promise<WorkItemEventsPage> {
  await requireWorkItemVisible(db, me, id)
  const rows = await db
    .select({ e: events, actorName: people.displayName })
    .from(events)
    .leftJoin(people, eq(people.id, events.actorId))
    .where(
      and(
        eq(events.workItemId, id),
        before === undefined ? undefined : lt(events.seq, before),
        kind === 'key' ? inArray(events.type, [...KEY_EVENT_TYPES]) : undefined,
      ),
    )
    .orderBy(desc(events.seq))
    .limit(limit + 1)
  const more = rows.length > limit
  const shown = rows.slice(0, limit)
  return WorkItemEventsPage.parse({
    events: shown.map(({ e, actorName }) => ({ ...eventEntry(e, actorName), seq: e.seq })),
    nextBefore: more ? shown.at(-1)!.e.seq : null,
  })
}

export async function listWorkItems(db: Conn, me: Me, projectId: string): Promise<WorkItem[]> {
  requireStaffMe(me)
  const [project] = await db.select({ id: projects.id }).from(projects).where(eq(projects.id, projectId))
  if (!project || !(await canSeeProject(db, me, projectId))) throw notFound()
  const rows = await workItemQuery(db)
    .where(eq(workItems.projectId, projectId))
    .orderBy(desc(workItems.createdAt), desc(workItems.id))
  const state = await advanceState(db, rows)
  return rows.map((r) => toWorkItem(r, state))
}

/** Staff see tasks of their projects; anyone sees a REQUESTER task assigned to them (the requester view). */
export async function getTask(db: Conn, me: Me, id: string): Promise<TaskWithContext> {
  const [t] = await tasksWithContext(db, eq(tasks.id, id), [], me)
  if (!t) throw notFound()
  if (!(await staffSeesProject(db, me, t.projectId)) && !ownRequesterTask(me, t)) throw notFound()
  // Requesters never see runs.
  if (t.viewerIsRequester) return t
  const runs = await latestRuns(db, [t.id])
  const parked = await parkedTasks(db, [t.id])
  return { ...t, run: runs.get(t.id) ?? null, parked: parked.has(t.id) }
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
  const inScope = (col: typeof tasks.projectId | typeof workItems.projectId) =>
    me.isAdmin ? or(inArray(col, pmProjects), inArray(col, pmlessProjects)) : inArray(col, pmProjects)
  const scope = inScope(tasks.projectId)

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
  // Finished steps waiting for a PM to advance them (e.g. after the step_advance proposal was rejected).
  const items = await workItemQuery(db)
    .where(and(inScope(workItems.projectId), eq(workItems.state, 'active')))
    .orderBy(priorityRank, asc(workItems.updatedAt), asc(workItems.id))
  const state = await advanceState(db, items)
  const proposalList = await pendingForDecider(db, me)
  const awaitingAdvance = items.filter((r) => state.awaiting.has(r.w.id)).map((r) => toWorkItem(r, state))
  // Tasks shown in the requester view get no context: their project stays hidden.
  const staffTasks = [...mine.filter((t) => !t.viewerIsRequester), ...confirmations]
  const context = await todoContext(
    db,
    me,
    [
      ...staffTasks.map((t) => t.workItemId),
      ...proposalList.flatMap((p) => (p.workItemId ? [p.workItemId] : [])),
      ...awaitingAdvance.map((w) => w.id),
    ],
    [
      ...staffTasks.map((t) => t.projectId),
      ...proposalList.flatMap((p) => (p.projectId ? [p.projectId] : [])),
      ...awaitingAdvance.map((w) => w.projectId),
    ],
  )
  return Todo.parse({
    tasks: mine,
    confirmations,
    proposals: proposalList,
    awaitingAdvance,
    ...context,
  })
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
  return myRequestRows(db, me, eq(workItems.requesterId, me.id))
}

async function myRequestRows(db: Conn, me: Me, where: SQL): Promise<MyRequest[]> {
  const rows = await db
    .select({ w: workItems, projectName: projects.name, definition: workflowTemplates.definition })
    .from(workItems)
    .innerJoin(projects, eq(projects.id, workItems.projectId))
    .innerJoin(workflowTemplates, eq(workflowTemplates.id, workItems.templateId))
    .where(where)
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
  const contacts = await names(db, rows.map((r) => r.w.ownerId))
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
      currentStepKey: step?.key ?? null,
      steps: stepsOf(def, w),
      targetDate: w.targetDate,
      contactName: contacts.get(w.ownerId) ?? null,
    })
  })
}

/** Work item events a requester may see on their own request; task events only for their own REQUESTER tasks. */
const REQUEST_ITEM_EVENTS = [
  'work_item.created', 'work_item.step_advanced', 'work_item.reopened', 'work_item.target_date_changed',
  'work_item.done', 'work_item.cancelled',
] as const
const REQUEST_TASK_EVENTS = ['task.created', 'task.accepted', 'task.rejected'] as const

/**
 * The caller's own request (404 otherwise, staff included: this is the requester view) with its plain-language
 * timeline and the delivery summary. Nothing here carries staff ids, reasons, payloads or internal tasks; the only
 * staff name is the contact person (the owner), as in the list.
 */
export async function getMyRequestDetail(db: Conn, me: Me, id: string): Promise<MyRequestDetail> {
  const [request] = await myRequestRows(db, me, and(eq(workItems.id, id), eq(workItems.requesterId, me.id))!)
  if (!request) throw notFound()
  const [item] = await db
    .select({ definition: workflowTemplates.definition })
    .from(workItems)
    .innerJoin(workflowTemplates, eq(workflowTemplates.id, workItems.templateId))
    .where(eq(workItems.id, id))
  const def = item!.definition as WorkflowTemplateDef
  const stepName = (key: unknown) => def.steps.find((s) => s.key === key)?.name ?? null

  const rows = await db
    .select({ e: events, taskType: tasks.type })
    .from(events)
    .leftJoin(tasks, eq(tasks.id, events.taskId))
    .where(
      and(
        eq(events.workItemId, id),
        or(
          inArray(events.type, [...REQUEST_ITEM_EVENTS]),
          and(inArray(events.type, [...REQUEST_TASK_EVENTS]), eq(tasks.role, 'REQUESTER'), eq(tasks.assigneeId, me.id)),
        ),
      ),
    )
    .orderBy(desc(events.seq))
    .limit(REQUEST_TIMELINE_LIMIT)
  // A long history keeps where it started: the received event replaces the oldest row past the cap.
  if (rows.length === REQUEST_TIMELINE_LIMIT && !rows.some((r) => r.e.type === 'work_item.created')) {
    const [created] = await db
      .select({ e: events, taskType: tasks.type })
      .from(events)
      .leftJoin(tasks, eq(tasks.id, events.taskId))
      .where(and(eq(events.workItemId, id), eq(events.type, 'work_item.created')))
      .orderBy(events.seq)
      .limit(1)
    if (created) rows.splice(rows.length - 1, 1, created)
  }
  const timeline: RequestEvent[] = []
  for (const { e, taskType } of rows) {
    const payload = (e.payload ?? {}) as Record<string, unknown>
    const approval = taskType === 'approval'
    const byYou = e.actorId === me.id
    let kind: RequestEvent['kind'] | null = null
    let stepKey: string | null = null
    let date: string | null = null
    switch (e.type) {
      case 'work_item.created': kind = 'received'; break
      case 'work_item.step_advanced':
        // The last step's advance is followed by work_item.done.
        if (typeof payload.to === 'string') { kind = 'step'; stepKey = payload.to }
        break
      case 'work_item.reopened':
        if (typeof payload.to === 'string') { kind = 'reopened'; stepKey = payload.to }
        break
      case 'work_item.target_date_changed':
        kind = 'expected_date'
        date = typeof payload.to === 'string' ? payload.to : null
        break
      case 'work_item.done': kind = 'done'; break
      case 'work_item.cancelled': kind = 'cancelled'; break
      case 'task.created': kind = approval ? 'delivery' : 'question'; break
      case 'task.accepted': kind = approval ? 'accepted' : 'answered'; break
      // Only the requester's own "changes" decision; a task closed by a step reopen is not theirs.
      case 'task.rejected': kind = byYou ? 'changes' : null; break
    }
    if (!kind) continue
    timeline.push(
      RequestEvent.parse({ kind, at: e.createdAt.toISOString(), stepKey, stepName: stepKey ? stepName(stepKey) : null, date, byYou }),
    )
  }
  return MyRequestDetail.parse({ ...request, timeline, delivered: await deliveredText(db, me, id, def) })
}

/**
 * What the requester already sees as the input of their latest delivery acceptance (a REQUESTER approval task
 * assigned to them): the latest accepted attempt of its last dependency, as text only. Null without one.
 */
async function deliveredText(db: Conn, me: Me, workItemId: string, def: WorkflowTemplateDef): Promise<string | null> {
  const [accept] = await db
    .select()
    .from(tasks)
    .where(and(eq(tasks.workItemId, workItemId), eq(tasks.role, 'REQUESTER'), eq(tasks.type, 'approval'), eq(tasks.assigneeId, me.id)))
    .orderBy(desc(tasks.createdAt), desc(tasks.attempt))
    .limit(1)
  if (!accept) return null
  const depKey = templateTask(def, accept).dependsOn.at(-1)
  if (!depKey) return null
  const [dep] = await db
    .select({ result: tasks.result })
    .from(tasks)
    .where(
      and(eq(tasks.workItemId, workItemId), eq(tasks.templateTaskKey, depKey), eq(tasks.state, 'accepted'), isNull(tasks.supersededAt)),
    )
    .orderBy(desc(tasks.attempt))
    .limit(1)
  const text = (dep?.result as { text?: unknown } | null)?.text
  return typeof text === 'string' && text.trim() ? text : null
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
    // Extension-only templates (defect) are never offered for manual creation.
    if (seen.has(r.key) || isExtensionOnlyTemplate(r.key)) continue
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
