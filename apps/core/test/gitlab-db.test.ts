import { beforeEach, describe, expect, it } from 'vitest'
import { sql } from 'drizzle-orm'
import { latestTemplate } from '../src/workflow/seed.js'
import { mergeRequests, people, projectRepos, projects, workItemRepos, workItems } from '../src/db/schema.js'
import { resetDb, testDb } from './helpers.js'

async function seed() {
  const db = await testDb()
  const [p] = await db.insert(people).values({ keycloakSub: 'k1', username: 'u1', displayName: 'U1' }).returning()
  const [proj] = await db.insert(projects).values({ name: 'P' }).returning()
  const [repo] = await db
    .insert(projectRepos)
    .values({ projectId: proj!.id, gitlabProjectId: 7, pathWithNamespace: 'g/app', webUrl: 'http://gl/g/app', defaultBranch: 'main' })
    .returning()
  return { db, p: p!, proj: proj!, repo: repo! }
}

describe('gitlab tables', () => {
  beforeEach(async () => resetDb(await testDb()))

  it('rejects a duplicate (repo, mr iid)', async () => {
    const { db, repo } = await seed()
    const v = { repoId: repo.id, mrIid: 1, title: 't', url: 'u', state: 'opened', sourceBranch: 'b' }
    await db.insert(mergeRequests).values(v)
    await expect(db.insert(mergeRequests).values(v)).rejects.toThrow()
  })

  it('rejects a duplicate gitlab project within a project', async () => {
    const { db, proj } = await seed()
    await expect(
      db.insert(projectRepos).values({ projectId: proj.id, gitlabProjectId: 7, pathWithNamespace: 'g/x', webUrl: 'u', defaultBranch: 'main' }),
    ).rejects.toThrow()
  })

  it('rejects an unknown sync status', async () => {
    const { db, repo, proj, p } = await seed()
    const [wi] = await db.insert(workItems).values({ projectId: proj.id, title: 'w', templateId: (await latestTemplate(db, 'software-change'))!.id, ownerId: p.id }).returning()
    await expect(db.insert(workItemRepos).values({ workItemId: wi!.id, repoId: repo.id, syncStatus: 'done' })).rejects.toThrow()
    await db.insert(workItemRepos).values({ workItemId: wi!.id, repoId: repo.id })
  })

  it('links one GitLab issue to at most one work item; a repo without a default branch is fine', async () => {
    const { db, repo, proj, p } = await seed()
    const templateId = (await latestTemplate(db, 'software-change'))!.id
    const [a] = await db.insert(workItems).values({ projectId: proj.id, title: 'a', templateId, ownerId: p.id }).returning()
    const [b] = await db.insert(workItems).values({ projectId: proj.id, title: 'b', templateId, ownerId: p.id }).returning()
    await db.insert(workItemRepos).values({ workItemId: a!.id, repoId: repo.id, issueIid: 3 })
    await expect(db.insert(workItemRepos).values({ workItemId: b!.id, repoId: repo.id, issueIid: 3 })).rejects.toThrow()
    // Many links without an issue yet.
    await db.insert(workItemRepos).values({ workItemId: b!.id, repoId: repo.id })
    await db.insert(projectRepos).values({ projectId: proj.id, gitlabProjectId: 8, pathWithNamespace: 'g/empty', webUrl: 'http://gl/g/empty', defaultBranch: null })
  })

  it('keeps one gitlab_settings row and accepts gitlab knowledge', async () => {
    const { db } = await seed()
    const r = await db.execute(sql`SELECT count(*)::int AS n FROM gitlab_settings`)
    expect(r[0]!.n).toBe(1)
    await expect(db.execute(sql`INSERT INTO gitlab_settings (id) VALUES (2)`)).rejects.toThrow()
  })
})
