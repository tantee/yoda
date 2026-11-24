import type { AppDeps } from '../app.js'
import { runDraft } from '../ai/drafter.js'
import { embedEntry } from '../knowledge/service.js'
import { secretaryChat } from '../secretary/chat.js'

/** Registers every job handler on `deps.jobs` (server.ts with pg-boss, tests with InlineJobQueue). */
export async function registerJobHandlers(deps: Pick<AppDeps, 'db' | 'ai' | 'bus' | 'jobs' | 'config'>): Promise<void> {
  await deps.jobs.work('embed-entry', (run) => embedEntry(deps, run))
  await deps.jobs.work('draft-task', (run) => runDraft(deps, run.id, run))
  await deps.jobs.work('secretary-chat', (run) => secretaryChat(deps, run))
}
