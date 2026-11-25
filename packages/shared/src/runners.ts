import { z } from 'zod'
import { KnowledgeType } from './knowledge.js'

const uuid = z.string().uuid()

export const RunnerKind = z.enum(['server', 'dev-machine'])
export type RunnerKind = z.infer<typeof RunnerKind>
export const RunnerMode = z.enum(['on-demand', 'unattended'])
export type RunnerMode = z.infer<typeof RunnerMode>
export const AccountType = z.enum(['api-key', 'org-plan', 'personal-subscription'])
export type AccountType = z.infer<typeof AccountType>
/** Template capabilities a runner can work; `draft-text` is drafted by core and never offered. */
export const RunnerCapability = z.enum(['analyze-repo', 'code-change', 'run-tests'])
export type RunnerCapability = z.infer<typeof RunnerCapability>

const hhmm = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/)

/** When an unattended runner may claim work, in Asia/Bangkok. Days are 0 (Sunday) to 6. */
export const WorkingHours = z
  .object({
    days: z.array(z.number().int().min(0).max(6)).min(1),
    start: hhmm,
    end: hhmm,
  })
  .refine((w) => w.end > w.start, { message: 'end must be after start', path: ['end'] })
export type WorkingHours = z.infer<typeof WorkingHours>

export const Runner = z.object({
  id: uuid,
  name: z.string().trim().min(1).max(80),
  kind: RunnerKind,
  ownerId: uuid,
  ownerName: z.string(),
  accountType: AccountType,
  capabilities: z.array(RunnerCapability).min(1),
  mode: RunnerMode,
  maxConcurrent: z.number().int().min(1).max(4),
  workingHours: WorkingHours.nullable(),
  paused: z.boolean(),
  revokedAt: z.string().nullable(),
  lastSeenAt: z.string().nullable(),
  activeRuns: z.number().int(),
  createdAt: z.string(),
})
export type Runner = z.infer<typeof Runner>

export const RunnerCreate = Runner.pick({
  name: true,
  kind: true,
  accountType: true,
  capabilities: true,
  mode: true,
  maxConcurrent: true,
  workingHours: true,
}).extend({ ownerId: uuid.optional() })
export type RunnerCreate = z.infer<typeof RunnerCreate>

export const RunnerPatch = Runner.pick({
  name: true,
  capabilities: true,
  mode: true,
  maxConcurrent: true,
  workingHours: true,
  paused: true,
}).partial()
export type RunnerPatch = z.infer<typeof RunnerPatch>

/** The token is shown once, at creation. */
export const RunnerCreated = z.object({ runner: Runner, token: z.string() })
export type RunnerCreated = z.infer<typeof RunnerCreated>

export const RunnerSettings = z.object({ paused: z.boolean(), allowPersonalUnattended: z.boolean() })
export type RunnerSettings = z.infer<typeof RunnerSettings>

export const AgentRunState = z.enum(['running', 'succeeded', 'failed', 'expired', 'parked', 'released'])
export type AgentRunState = z.infer<typeof AgentRunState>

/** Model usage a runner reports with its result; cost counts toward the project's AI budget. */
export const RunUsage = z.object({
  model: z.string().max(100),
  inputTokens: z.number().int().min(0).optional(),
  outputTokens: z.number().int().min(0).optional(),
  costUsd: z.number().min(0).max(1000).optional(),
})
export type RunUsage = z.infer<typeof RunUsage>

export const AgentRun = z.object({
  id: uuid,
  taskId: uuid,
  runnerId: uuid,
  runnerName: z.string(),
  state: AgentRunState,
  startedAt: z.string(),
  heartbeatAt: z.string(),
  leaseExpiresAt: z.string(),
  endedAt: z.string().nullable(),
  branch: z.string().nullable(),
  error: z.string().nullable(),
  usage: RunUsage.nullable(),
})
export type AgentRun = z.infer<typeof AgentRun>

/** The latest run of a task, as staff see it on the work item (requesters never see runs). */
export const TaskRunSummary = z.object({
  state: AgentRunState,
  runnerName: z.string(),
  heartbeatAt: z.string(),
  branch: z.string().nullable(),
})
export type TaskRunSummary = z.infer<typeof TaskRunSummary>

/** Why a claim (or a call on a run) was refused: the `reason` of a 409 `invalid_state`. */
export const ClaimRefusal = z.enum([
  'runner_revoked',
  'runner_paused',
  'all_runners_paused',
  'outside_hours',
  'at_capacity',
  'personal_unattended_not_allowed',
  'no_ai',
  'budget_exceeded',
  'task_unavailable',
  'already_claimed',
  'run_not_active',
  'needs_decision',
])
export type ClaimRefusal = z.infer<typeof ClaimRefusal>

// Declared here, not imported from work.ts, which imports this file.
const TaskTitle = z.object({ th: z.string(), en: z.string() })

/** A task a runner may claim. */
export const AvailableTask = z.object({
  taskId: uuid,
  title: TaskTitle,
  workItemId: uuid,
  workItemTitle: z.string(),
  projectName: z.string(),
  capability: RunnerCapability,
  stepKey: z.string(),
  priority: z.enum(['low', 'normal', 'high', 'urgent']),
  createdAt: z.string(),
})
export type AvailableTask = z.infer<typeof AvailableTask>

// MCP tool inputs, shared by core's MCP server and the runner.

export const ListTasksInput = z.object({ capabilities: z.array(RunnerCapability).optional() })
export type ListTasksInput = z.infer<typeof ListTasksInput>

export const ClaimInput = z.object({ taskId: uuid })
export type ClaimInput = z.infer<typeof ClaimInput>

export const RunRef = z.object({ runId: uuid })
export type RunRef = z.infer<typeof RunRef>

export const SearchInput = z.object({
  query: z.string().min(1).max(500),
  workItemId: uuid.optional(),
  limit: z.number().int().min(1).max(20).optional(),
})
export type SearchInput = z.infer<typeof SearchInput>

export const WriteKnowledgeInput = RunRef.extend({
  type: KnowledgeType.extract(['fact', 'memory', 'document', 'progress']),
  title: z.string().min(1).max(200),
  body: z.string().min(1).max(20000),
})
export type WriteKnowledgeInput = z.infer<typeof WriteKnowledgeInput>

export const ProgressInput = RunRef.extend({ note: z.string().min(1).max(4000) })
export type ProgressInput = z.infer<typeof ProgressInput>

export const OpenMrInput = RunRef.extend({
  repoId: uuid,
  sourceBranch: z.string().min(1),
  title: z.string().min(1).max(200),
  description: z.string().max(20000),
})
export type OpenMrInput = z.infer<typeof OpenMrInput>

export const SubmitInput = RunRef.extend({
  text: z.string().min(1).max(50000),
  usage: RunUsage.optional(),
})
export type SubmitInput = z.infer<typeof SubmitInput>

export const AskHumanInput = RunRef.extend({
  question: z.string().min(1).max(500),
  details: z.string().max(4000),
  options: z.array(z.string()).max(5).optional(),
})
export type AskHumanInput = z.infer<typeof AskHumanInput>

export const ReleaseInput = RunRef.extend({
  reason: z.string().min(1).max(500),
  failed: z.boolean(),
})
export type ReleaseInput = z.infer<typeof ReleaseInput>
