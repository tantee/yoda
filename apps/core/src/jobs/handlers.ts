import type { AppDeps } from '../app.js'
import { runDraft } from '../ai/drafter.js'
import { runBrief } from '../discussions/brief.js'
import { runMrEffect } from '../gitlab/effects.js'
import { reconcileMergeRequests } from '../gitlab/reconcile.js'
import { syncIssues } from '../gitlab/sync.js'
import { embedEntry } from '../knowledge/service.js'
import { deliver } from '../notifications/deliver.js'
import { expireLeases } from '../runners/claims.js'
import { secretaryChat } from '../secretary/chat.js'
import { secretaryEvent } from '../secretary/events.js'
import { secretarySweep } from '../secretary/sweep.js'
import { fanOutWeeklySummaries, weeklySummaryJob } from '../status/weekly.js'
import { syncEnvironmentsJob } from '../gitlab/environments.js'

/** Registers every job handler on `deps.jobs` (server.ts with pg-boss, tests with InlineJobQueue). */
export async function registerJobHandlers(deps: Pick<AppDeps, 'db' | 'ai' | 'bus' | 'jobs' | 'config' | 'gitlab' | 'mailTransport'>): Promise<void> {
  await deps.jobs.work('embed-entry', (run) => embedEntry(deps, run))
  await deps.jobs.work('draft-task', (run) => runDraft(deps, run.id, run))
  await deps.jobs.work('secretary-chat', (run) => secretaryChat(deps, run))
  await deps.jobs.work('secretary-event', (run) => secretaryEvent(deps, run))
  await deps.jobs.work('secretary-sweep', () => secretarySweep(deps))
  await deps.jobs.work('discussion-brief', (run) => runBrief(deps, run.id, run))
  await deps.jobs.work('gitlab-issue-sync', (run) => syncIssues(deps, run))
  await deps.jobs.work('gitlab-mr-effect', (run) => runMrEffect(deps, run))
  await deps.jobs.work('gitlab-mr-reconcile', (run) => reconcileMergeRequests(deps, run))
  await deps.jobs.work('runner-lease-sweep', () => expireLeases(deps))
  await deps.jobs.work('weekly-summary', () => fanOutWeeklySummaries(deps))
  await deps.jobs.work('weekly-summary-project', (run) => weeklySummaryJob(deps, run))
  await deps.jobs.work('notify-deliver', (run) => deliver(deps, run.id, run))
  await deps.jobs.work('gitlab-env-sync', (run) => syncEnvironmentsJob(deps, run.id))
}
