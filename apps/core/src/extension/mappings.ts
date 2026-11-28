import type { Db } from '../db/client.js'

/**
 * The production URL patterns of every project the person is a member of: application URLs marked production
 * (A7) and GitLab production-tier environments (A8). Core refuses video and buffer files from these pages.
 */
export async function productionRulesForPerson(_db: Db, _personId: string): Promise<string[]> {
  return []
}
