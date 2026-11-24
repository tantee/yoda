import {
  EventEntry,
  Task,
  TaskWithContext,
  Todo,
  WorkflowTemplateDef,
  WorkflowTemplateSummary,
  WorkItem,
  WorkItemDetail,
  type Me,
  type TemplateTask,
} from '@yoda/shared'
import { and, asc, desc, eq, inArray, isNull, or, sql, type SQL } from 'drizzle-orm'
import { forbidden, notFound } from '../auth/plugin.js'
import type { Db, Tx } from '../db/client.js'
import { events, people, projectMembers, projects, tasks, workflowTemplates, workItems } from '../db/schema.js'

type Conn = Db | Tx
type TaskRow = typeof tasks.$inferSelect

const ACTIVE = ['proposed', 'open', 'in_progress', 'submitted'] as const

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

/** 404 unless the task exists and `me` may see its project. */
export async function requireTaskVisible(db: Conn, me: Me, taskId: string): Promise<void> {
  requireStaffMe(me)
  const [row] = await db.select({ projectId: tasks.projectId }).from(tasks).where(eq(tasks.id, taskId))
  if (!row || !(await canSeeProject(db, me, row.projectId))) throw notFound()
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

function toTask(row: TaskRow, def: WorkflowTemplateDef | undefined, who: Map<string, string>): Task {
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
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  })
}

/** Tasks joined with their work item / project, in the order the `where`/`orderBy` give. */
async function tasksWithContext(db: Conn, where: SQL | undefined, orderBy: SQL[]): Promise<TaskWithContext[]> {
  const rows = await db
    .select({ t: tasks, templateId: workItems.templateId, workItemTitle: workItems.title, workItemPriority: workItems.priority, projectName: projects.name })
    .from(tasks)
    .innerJoin(workItems, eq(workItems.id, tasks.workItemId))
    .innerJoin(projects, eq(projects.id, tasks.projectId))
    .where(where)
    .orderBy(...orderBy)
  const defs = await definitions(db, rows.map((r) => r.templateId))
  const who = await names(db, rows.flatMap((r) => [r.t.assigneeId, r.t.proposedAssigneeId]))
  return rows.map((r) =>
    TaskWithContext.parse({
      ...toTask(r.t, defs.get(r.templateId), who),
      workItemTitle: r.workItemTitle,
      workItemPriority: r.workItemPriority,
      projectName: r.projectName,
      inputs: [], // plan 3 task 6 fills these
      attachments: [],
    }),
  )
}

const workItemCols = {
  w: workItems,
  templateKey: workflowTemplates.key,
  templateVersion: workflowTemplates.version,
  definition: workflowTemplates.definition,
  ownerName: people.displayName,
}

function workItemQuery(db: Conn) {
  return db
    .select(workItemCols)
    .from(workItems)
    .innerJoin(workflowTemplates, eq(workflowTemplates.id, workItems.templateId))
    .innerJoin(people, eq(people.id, workItems.ownerId))
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
  return WorkItemDetail.parse({
    ...toWorkItem(r),
    steps,
    tasks: taskRows.map((t) => toTask(t, def, who)),
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

export async function getTask(db: Conn, me: Me, id: string): Promise<TaskWithContext> {
  requireStaffMe(me)
  const [t] = await tasksWithContext(db, eq(tasks.id, id), [])
  if (!t || !(await canSeeProject(db, me, t.projectId))) throw notFound()
  return t
}

export async function getTodo(db: Conn, me: Me): Promise<Todo> {
  requireStaffMe(me)
  const order = [priorityRank, asc(tasks.createdAt), asc(tasks.id)]

  const mine = await tasksWithContext(
    db,
    and(eq(tasks.assigneeId, me.id), inArray(tasks.state, ['open', 'in_progress'])),
    order,
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
  return Todo.parse({ tasks: mine, confirmations })
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
