import {
  BoardColumn,
  DepartmentStatus,
  DiscussionSummary,
  PersonLoad,
  ProjectStatus,
  ProjectStatusSummary,
  TimelineEvent,
  WeeklySummary,
  type BoardItem,
  type LocalizedText,
  type Me,
  type Priority,
  type WorkflowTemplateDef,
} from '@yoda/shared'
import { and, asc, desc, eq, inArray, isNull, like, sql, type SQL } from 'drizzle-orm'
import { forbidden, notFound } from '../auth/plugin.js'
import { departmentMonthUsage, monthUsage, projectsMonthSpend } from '../ai/gateway.js'
import type { Db } from '../db/client.js'
import {
  discussions,
  events,
  knowledgeEntries,
  people,
  projectMembers,
  projectRepos,
  projects,
  workflowTemplates,
  workItemRepos,
  workItems,
} from '../db/schema.js'
import { toRepo } from '../gitlab/repos.js'
import { DAY_START } from '../work/assign.js'
import { canSeeProject } from '../work/queries.js'
import { bangkokDate, computeHealth, HEALTH_RULES, type HealthItem } from './health.js'

type ProjectRow = { id: string; name: string; aiBudgetUsd: string | null }

type ItemRow = {
  id: string
  projectId: string
  templateId: string
  title: string
  priority: string
  targetDate: string | null
  currentStepKey: string | null
  ownerName: string
  overdue: boolean
  /** Whole days since the item's latest event (or its creation). */
  idleDays: number
}

type DiscussionRow = {
  id: string
  projectId: string | null
  workItemId: string | null
  workItemTitle: string | null
  question: string
  priority: string
  state: string
  createdAt: Date
  ageDays: number
}

const UNDECIDED = ['open', 'scheduled']
const priorityRank = (p: string) => ({ urgent: 0, high: 1, normal: 2, low: 3 })[p as Priority] ?? 4
const days = (from: SQL) => sql<number>`floor(extract(epoch from (now() - ${from})) / 86400)::int`

/** Active work items of the projects, with their idle days (latest event per item) and overdue flag. */
async function activeItems(db: Db, projectIds: string[]): Promise<ItemRow[]> {
  if (!projectIds.length) return []
  const lastActivity = sql`coalesce((select max(e.created_at) from events e where e.work_item_id = ${workItems.id}), ${workItems.createdAt})`
  return db
    .select({
      id: workItems.id,
      projectId: workItems.projectId,
      templateId: workItems.templateId,
      title: workItems.title,
      priority: workItems.priority,
      targetDate: workItems.targetDate,
      currentStepKey: workItems.currentStepKey,
      ownerName: people.displayName,
      overdue: sql<boolean>`coalesce(${workItems.targetDate} < ${bangkokDate()}::date, false)`,
      idleDays: days(lastActivity),
    })
    .from(workItems)
    .innerJoin(people, eq(people.id, workItems.ownerId))
    .where(and(inArray(workItems.projectId, projectIds), eq(workItems.state, 'active')))
    .orderBy(asc(workItems.createdAt), asc(workItems.id))
}

/** Open or scheduled discussions of the projects, oldest first. */
async function undecidedDiscussions(db: Db, projectIds: string[]): Promise<DiscussionRow[]> {
  if (!projectIds.length) return []
  return db
    .select({
      id: discussions.id,
      projectId: discussions.projectId,
      workItemId: discussions.workItemId,
      workItemTitle: workItems.title,
      question: discussions.question,
      priority: discussions.priority,
      state: discussions.state,
      createdAt: discussions.createdAt,
      ageDays: days(sql`${discussions.createdAt}`),
    })
    .from(discussions)
    .leftJoin(workItems, eq(workItems.id, discussions.workItemId))
    .where(and(inArray(discussions.projectId, projectIds), inArray(discussions.state, UNDECIDED)))
    .orderBy(asc(discussions.createdAt), asc(discussions.id))
}

/** Active work items with a failed GitLab issue sync, one row per item. */
async function syncFailures(db: Db, projectIds: string[]): Promise<(HealthItem & { projectId: string })[]> {
  if (!projectIds.length) return []
  return db
    .selectDistinct({ id: workItems.id, title: workItems.title, projectId: workItems.projectId })
    .from(workItemRepos)
    .innerJoin(workItems, eq(workItems.id, workItemRepos.workItemId))
    .where(
      and(inArray(workItems.projectId, projectIds), eq(workItemRepos.syncStatus, 'failed'), eq(workItems.state, 'active')),
    )
    .orderBy(asc(workItems.id))
}

const groupBy = <T, K>(rows: T[], key: (r: T) => K): Map<K, T[]> => {
  const out = new Map<K, T[]>()
  for (const r of rows) {
    const k = key(r)
    const list = out.get(k)
    if (list) list.push(r)
    else out.set(k, [r])
  }
  return out
}

const asItem = (r: { id: string; title: string }): HealthItem => ({ id: r.id, title: r.title })
const asDiscussionItem = (d: DiscussionRow): HealthItem => ({ id: d.id, title: d.question })

/** Health and counts of each project, from a fixed number of queries whatever the item count. */
async function summarize(
  db: Db,
  rows: ProjectRow[],
  spend: Map<string, number>,
): Promise<{ summaries: ProjectStatusSummary[]; items: ItemRow[]; discussions: DiscussionRow[] }> {
  const ids = rows.map((p) => p.id)
  const [items, discussionRows, failures] = await Promise.all([
    activeItems(db, ids),
    undecidedDiscussions(db, ids),
    syncFailures(db, ids),
  ])
  const steps = await stepNamesOf(db, items)
  const itemsBy = groupBy(items, (i) => i.projectId)
  const discussionsBy = groupBy(discussionRows, (d) => d.projectId)
  const failuresBy = groupBy(failures, (f) => f.projectId)

  const summaries = rows.map((p) => {
    const its = itemsBy.get(p.id) ?? []
    const ds = discussionsBy.get(p.id) ?? []
    const budget = p.aiBudgetUsd === null ? null : Number(p.aiBudgetUsd)
    const spent = spend.get(p.id) ?? 0
    const overdue = its.filter((i) => i.overdue)
    const { health, reasons } = computeHealth({
      stuck: its.filter((i) => i.idleDays >= HEALTH_RULES.stuckDays).map(asItem),
      urgentOpen: ds.filter((d) => d.priority === 'urgent' && d.ageDays >= HEALTH_RULES.urgentDiscussionDays).map(asDiscussionItem),
      syncFailed: (failuresBy.get(p.id) ?? []).map(asItem),
      overdue: overdue.map(asItem),
      highOpen: ds.filter((d) => d.priority === 'high' && d.ageDays >= HEALTH_RULES.highDiscussionDays).map(asDiscussionItem),
      // Like the gateway's budget warning, a zero budget gives no ratio.
      aiRatio: budget !== null && budget > 0 ? spent / budget : null,
    })
    const countsByStep: Record<string, number> = {}
    const stepNames: Record<string, LocalizedText> = {}
    for (const i of its) {
      if (!i.currentStepKey) continue
      countsByStep[i.currentStepKey] = (countsByStep[i.currentStepKey] ?? 0) + 1
      stepNames[i.currentStepKey] ??= steps.get(i.templateId)?.get(i.currentStepKey) ?? { th: i.currentStepKey, en: i.currentStepKey }
    }
    return ProjectStatusSummary.parse({
      projectId: p.id,
      name: p.name,
      health,
      reasons,
      activeItems: its.length,
      overdueItems: overdue.length,
      openDiscussions: ds.length,
      countsByStep,
      stepNames,
      aiSpendUsd: spent,
      aiBudgetUsd: budget,
    })
  })
  return { summaries, items, discussions: discussionRows }
}

const projectCols = { id: projects.id, name: projects.name, aiBudgetUsd: projects.aiBudgetUsd }

/** Staff only. Active projects the caller can see (every active project for admins), by name. */
export async function getDepartmentStatus(db: Db, me: Me): Promise<DepartmentStatus> {
  if (!me.isStaff) throw forbidden()
  const rows: ProjectRow[] = me.isAdmin
    ? await db.select(projectCols).from(projects).where(eq(projects.status, 'active')).orderBy(asc(projects.name), asc(projects.id))
    : await db
        .select(projectCols)
        .from(projects)
        .innerJoin(projectMembers, and(eq(projectMembers.projectId, projects.id), eq(projectMembers.personId, me.id)))
        .where(eq(projects.status, 'active'))
        .orderBy(asc(projects.name), asc(projects.id))
  const [spend, department] = await Promise.all([projectsMonthSpend(db, rows.map((r) => r.id)), departmentMonthUsage(db)])
  const { summaries } = await summarize(db, rows, spend)
  const sum = (f: (s: ProjectStatusSummary) => number) => summaries.reduce((n, s) => n + f(s), 0)
  return DepartmentStatus.parse({
    projects: summaries,
    totals: {
      activeItems: sum((s) => s.activeItems),
      overdueItems: sum((s) => s.overdueItems),
      openDiscussions: sum((s) => s.openDiscussions),
      aiSpendUsd: sum((s) => s.aiSpendUsd),
    },
    departmentAiSpendUsd: department.costUsd,
  })
}

/** Step names (by template id, then step key) of the templates `items` use. */
async function stepNamesOf(db: Db, items: ItemRow[]): Promise<Map<string, Map<string, LocalizedText>>> {
  const templateIds = [...new Set(items.map((i) => i.templateId))]
  if (!templateIds.length) return new Map()
  const defs = await db
    .select({ id: workflowTemplates.id, definition: workflowTemplates.definition })
    .from(workflowTemplates)
    .where(inArray(workflowTemplates.id, templateIds))
  return new Map(defs.map((d) => [d.id, new Map((d.definition as WorkflowTemplateDef).steps.map((s) => [s.key, s.name]))]))
}

/** One column per step of the templates the active items use (template order), items most urgent first. */
async function board(db: Db, items: ItemRow[]): Promise<BoardColumn[]> {
  if (!items.length) return []
  const templateIds = [...new Set(items.map((i) => i.templateId))]
  const defs = await db
    .select({ id: workflowTemplates.id, definition: workflowTemplates.definition })
    .from(workflowTemplates)
    .where(inArray(workflowTemplates.id, templateIds))
  const byId = new Map(defs.map((d) => [d.id, d.definition as WorkflowTemplateDef]))
  const columns = new Map<string, BoardColumn>()
  // Templates in the order their first item appears, so the board is stable.
  for (const id of templateIds) {
    for (const step of byId.get(id)?.steps ?? []) {
      if (!columns.has(step.key)) columns.set(step.key, { stepKey: step.key, stepName: step.name, items: [] })
    }
  }
  const sorted = [...items].sort(
    (a, b) =>
      priorityRank(a.priority) - priorityRank(b.priority) ||
      (a.targetDate ?? '9999-12-31').localeCompare(b.targetDate ?? '9999-12-31'),
  )
  for (const i of sorted) {
    const column = i.currentStepKey ? columns.get(i.currentStepKey) : undefined
    if (!column) continue
    const card: BoardItem = {
      id: i.id,
      title: i.title,
      priority: i.priority as Priority,
      targetDate: i.targetDate,
      overdue: i.overdue,
      ownerName: i.ownerName,
      stuckDays: i.idleDays >= HEALTH_RULES.stuckDays ? i.idleDays : null,
    }
    column.items.push(card)
  }
  return [...columns.values()].map((c) => BoardColumn.parse(c))
}

/** Members with their roles and load across all projects (staff work only, as automatic assignment counts it). */
async function peopleLoad(db: Db, projectId: string): Promise<PersonLoad[]> {
  const rows = await db.execute<{
    person_id: string
    name: string
    roles: string[]
    open_tasks: number
    in_progress_tasks: number
    today_assigned: number
  }>(sql`
    SELECT m.person_id, p.display_name AS name, m.roles,
      (SELECT count(*) FROM tasks t
        WHERE t.role <> 'REQUESTER'
          AND ((t.assignee_id = p.id AND t.state = 'open') OR (t.proposed_assignee_id = p.id AND t.state = 'proposed'))
      )::int AS open_tasks,
      (SELECT count(*) FROM tasks t
        WHERE t.role <> 'REQUESTER' AND t.assignee_id = p.id AND t.state = 'in_progress'
      )::int AS in_progress_tasks,
      (SELECT count(*) FROM events e
        WHERE e.type = 'task.assigned'
          AND e.payload->>'auto' = 'true'
          AND e.payload->>'assigneeId' = p.id::text
          AND e.created_at >= ${DAY_START}
      )::int AS today_assigned
    FROM project_members m
    JOIN people p ON p.id = m.person_id
    WHERE m.project_id = ${projectId}
    ORDER BY p.display_name ASC, p.id ASC
  `)
  return rows.map((r) =>
    PersonLoad.parse({
      personId: r.person_id,
      name: r.name,
      roles: r.roles,
      openTasks: r.open_tasks,
      inProgressTasks: r.in_progress_tasks,
      todayAssigned: r.today_assigned,
    }),
  )
}

async function recentEvents(db: Db, projectId: string): Promise<TimelineEvent[]> {
  const rows = await db
    .select({ e: events, actorName: people.displayName, workItemTitle: workItems.title })
    .from(events)
    .leftJoin(people, eq(people.id, events.actorId))
    .leftJoin(workItems, eq(workItems.id, events.workItemId))
    .where(eq(events.projectId, projectId))
    .orderBy(desc(events.seq))
    .limit(30)
  return rows.map(({ e, actorName, workItemTitle }) =>
    TimelineEvent.parse({
      id: e.id,
      type: e.type,
      actorKind: e.actorKind,
      actorId: e.actorId,
      actorName: actorName ?? null,
      taskId: e.taskId,
      reason: e.reason,
      payload: e.payload,
      createdAt: e.createdAt.toISOString(),
      workItemId: e.workItemId,
      workItemTitle: workItemTitle ?? null,
    }),
  )
}

/** The latest weekly summary entry (ref key `weekly:<projectId>:<week>`), null when none yet. */
async function latestWeeklySummary(db: Db, projectId: string): Promise<WeeklySummary | null> {
  const prefix = `weekly:${projectId}:`
  const [row] = await db
    .select()
    .from(knowledgeEntries)
    .where(
      and(
        eq(knowledgeEntries.projectId, projectId),
        like(knowledgeEntries.sourceRef, `${prefix}%`),
        isNull(knowledgeEntries.supersededAt),
      ),
    )
    .orderBy(desc(knowledgeEntries.sourceRef), desc(knowledgeEntries.createdAt))
    .limit(1)
  if (!row) return null
  return WeeklySummary.parse({
    entryId: row.id,
    week: row.sourceRef!.slice(prefix.length),
    body: row.body,
    status: row.status,
    createdAt: row.createdAt.toISOString(),
  })
}

/** Staff who can see the project (403 for requesters, 404 for non-members and unknown ids). */
export async function getProjectStatus(db: Db, me: Me, projectId: string, opts: { aiConfigured: boolean }): Promise<ProjectStatus> {
  if (!me.isStaff) throw forbidden()
  const [project] = await db.select(projectCols).from(projects).where(eq(projects.id, projectId))
  if (!project || !(await canSeeProject(db, me, projectId))) throw notFound()
  const usage = await monthUsage(db, projectId)
  const { summaries, items, discussions: ds } = await summarize(db, [project], new Map([[projectId, usage.costUsd]]))
  const [columns, load, timeline, repos, weekly] = await Promise.all([
    board(db, items),
    peopleLoad(db, projectId),
    recentEvents(db, projectId),
    db.select().from(projectRepos).where(eq(projectRepos.projectId, projectId)).orderBy(asc(projectRepos.pathWithNamespace)),
    latestWeeklySummary(db, projectId),
  ])
  const open = [...ds]
    .sort((a, b) => priorityRank(a.priority) - priorityRank(b.priority) || a.createdAt.getTime() - b.createdAt.getTime())
    .slice(0, 20)
    .map((d) =>
      DiscussionSummary.parse({
        id: d.id,
        question: d.question,
        priority: d.priority,
        state: d.state,
        workItemId: d.workItemId,
        workItemTitle: d.workItemTitle,
        createdAt: d.createdAt.toISOString(),
      }),
    )
  return ProjectStatus.parse({
    ...summaries[0],
    board: columns,
    people: load,
    recentEvents: timeline,
    discussions: open,
    repos: repos.map(toRepo),
    weeklySummary: weekly,
    aiConfigured: opts.aiConfigured,
  })
}
