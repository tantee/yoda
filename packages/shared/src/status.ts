import { z } from 'zod'
import { DiscussionState } from './discussions.js'
import { Repo } from './gitlab.js'
import { KnowledgeStatus } from './knowledge.js'
import { EventEntry, IsoDate, LocalizedText, Priority } from './work.js'

const uuid = z.string().uuid()

export const Health = z.enum(['on_track', 'at_risk', 'blocked'])
export type Health = z.infer<typeof Health>

/**
 * Blocked: `stuck`, `urgent_discussion`, `sync_failed`. At risk: `overdue`, `high_discussion`, `ai_budget`.
 * `count` is the number of matching items or discussions; for `ai_budget` it is the percent of the month's budget
 * used. Samples are work items, except discussions for the two discussion codes; `ai_budget` has none.
 */
export const HealthReasonCode = z.enum(['stuck', 'urgent_discussion', 'sync_failed', 'overdue', 'high_discussion', 'ai_budget'])
export type HealthReasonCode = z.infer<typeof HealthReasonCode>

export const HealthReason = z.object({
  code: HealthReasonCode,
  count: z.number().int(),
  sample: z.array(z.object({ id: uuid, title: z.string() })).max(3),
})
export type HealthReason = z.infer<typeof HealthReason>

export const ProjectStatusSummary = z.object({
  projectId: uuid,
  name: z.string(),
  health: Health,
  /** Blocked reasons first, then at-risk reasons. */
  reasons: z.array(HealthReason),
  activeItems: z.number().int(),
  overdueItems: z.number().int(),
  /** Open or scheduled discussions of the project. */
  openDiscussions: z.number().int(),
  /** Active items by their current step key. */
  countsByStep: z.record(z.string(), z.number().int()),
  /** The name of each step key in `countsByStep` (from the templates its items use, like the board's). */
  stepNames: z.record(z.string(), LocalizedText),
  /** This Asia/Bangkok month, as counted against the budget. */
  aiSpendUsd: z.number(),
  aiBudgetUsd: z.number().nullable(),
})
export type ProjectStatusSummary = z.infer<typeof ProjectStatusSummary>

export const DepartmentStatus = z.object({
  projects: z.array(ProjectStatusSummary),
  totals: z.object({
    activeItems: z.number().int(),
    overdueItems: z.number().int(),
    openDiscussions: z.number().int(),
    aiSpendUsd: z.number(),
  }),
  /** Project-less AI calls this month (secretary, department-billed jobs). */
  departmentAiSpendUsd: z.number(),
})
export type DepartmentStatus = z.infer<typeof DepartmentStatus>

export const BoardItem = z.object({
  id: uuid,
  title: z.string(),
  priority: Priority,
  targetDate: IsoDate.nullable(),
  overdue: z.boolean(),
  ownerName: z.string(),
  /** Whole days without an event, once the item counts as stuck; null otherwise. */
  stuckDays: z.number().int().nullable(),
})
export type BoardItem = z.infer<typeof BoardItem>

export const BoardColumn = z.object({ stepKey: z.string(), stepName: LocalizedText, items: z.array(BoardItem) })
export type BoardColumn = z.infer<typeof BoardColumn>

/** A project member's load. Task counts span all projects (staff work only), like automatic assignment. */
export const PersonLoad = z.object({
  personId: uuid,
  name: z.string(),
  roles: z.array(z.string()),
  /** Open tasks assigned to them, plus tasks proposed for them. */
  openTasks: z.number().int(),
  inProgressTasks: z.number().int(),
  /** Automatic assignments today (Asia/Bangkok), as counted against the daily cap. */
  todayAssigned: z.number().int(),
})
export type PersonLoad = z.infer<typeof PersonLoad>

/** A project event with its work item, for the status timeline. */
export const TimelineEvent = EventEntry.extend({
  workItemId: uuid.nullable(),
  workItemTitle: z.string().nullable(),
})
export type TimelineEvent = z.infer<typeof TimelineEvent>

export const DiscussionSummary = z.object({
  id: uuid,
  question: z.string(),
  priority: Priority,
  state: DiscussionState,
  workItemId: uuid.nullable(),
  workItemTitle: z.string().nullable(),
  createdAt: z.string(),
})
export type DiscussionSummary = z.infer<typeof DiscussionSummary>

export const WeeklySummary = z.object({
  entryId: uuid,
  /** ISO week, e.g. `2026-W48`. */
  week: z.string().regex(/^\d{4}-W\d{2}$/),
  body: z.string(),
  status: KnowledgeStatus,
  createdAt: z.string(),
})
export type WeeklySummary = z.infer<typeof WeeklySummary>

export const WeeklySummaryReason = z.enum(['ai_not_configured', 'no_ai', 'no_activity', 'budget_exceeded', 'ai_failed'])
export type WeeklySummaryReason = z.infer<typeof WeeklySummaryReason>

/** Payload of the live-only `status.weekly_summary_outcome` event, sent on every summary run. */
export const WeeklySummaryOutcome = z.object({
  week: z.string().regex(/^\d{4}-W\d{2}$/),
  outcome: z.enum(['written', 'skipped']),
  reason: WeeklySummaryReason.optional(),
})
export type WeeklySummaryOutcome = z.infer<typeof WeeklySummaryOutcome>

export const ProjectStatus = ProjectStatusSummary.extend({
  /** One column per step of the templates in use, in template order. */
  board: z.array(BoardColumn),
  people: z.array(PersonLoad),
  /** Newest first. */
  recentEvents: z.array(TimelineEvent).max(30),
  /** Open or scheduled, most urgent first. */
  discussions: z.array(DiscussionSummary).max(20),
  repos: z.array(Repo),
  /** The newest summary of a finished week. */
  weeklySummary: WeeklySummary.nullable(),
  /** The summary of the week still running (`currentWeek`), written by a regenerate; null when none. */
  weeklyInProgress: WeeklySummary.nullable(),
  /** The ISO week in progress (Asia/Bangkok); a regenerate writes this week. */
  currentWeek: z.string().regex(/^\d{4}-W\d{2}$/),
  /** The AI gateway has a usable fast model (weekly summaries can be written). */
  aiConfigured: z.boolean(),
})
export type ProjectStatus = z.infer<typeof ProjectStatus>
