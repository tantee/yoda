import type { AppDeps } from '../app.js'
import { embedEntry } from '../knowledge/service.js'

/** Registers every job handler on `deps.jobs` (server.ts with pg-boss, tests with InlineJobQueue). */
export async function registerJobHandlers(deps: Pick<AppDeps, 'db' | 'ai' | 'jobs'>): Promise<void> {
  await deps.jobs.work('embed-entry', (run) => embedEntry(deps, run))
}
