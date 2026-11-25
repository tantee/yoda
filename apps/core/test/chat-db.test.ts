import { randomUUID } from 'node:crypto'
import { beforeEach, describe, expect, it } from 'vitest'
import {
  attachments,
  conversations,
  notifications,
  people,
  projects,
  proposals,
  tasks,
  workItems,
  workflowTemplates,
} from '../src/db/schema.js'
import { resetDb, testDb } from './helpers.js'

async function seed() {
  const db = await testDb()
  const [p] = await db.insert(people).values({ keycloakSub: randomUUID(), username: 'u', displayName: 'U' }).returning()
  const [proj] = await db.insert(projects).values({ name: 'P' }).returning()
  const [tpl] = await db.select().from(workflowTemplates).limit(1)
  const [wi] = await db
    .insert(workItems)
    .values({ projectId: proj!.id, templateId: tpl!.id, title: 'W', ownerId: p!.id })
    .returning()
  return { db, person: p!, project: proj!, workItem: wi! }
}

describe('chat tables', () => {
  beforeEach(async () => {
    await resetDb(await testDb())
  })

  it('allows one personal conversation per owner', async () => {
    const { db, person } = await seed()
    const v = { kind: 'personal', ownerId: person.id, title: 'me' }
    await db.insert(conversations).values(v)
    await expect(db.insert(conversations).values(v)).rejects.toThrow()
  })

  it('enforces conversation kind/id consistency', async () => {
    const { db, person, project, workItem } = await seed()
    await expect(db.insert(conversations).values({ kind: 'project', ownerId: person.id, title: 't' })).rejects.toThrow()
    await expect(
      db.insert(conversations).values({ kind: 'project', ownerId: person.id, title: 't', projectId: project.id, workItemId: workItem.id }),
    ).rejects.toThrow()
    await expect(
      db.insert(conversations).values({ kind: 'work_item', ownerId: person.id, title: 't', projectId: project.id }),
    ).rejects.toThrow()
    await db.insert(conversations).values({ kind: 'project', ownerId: person.id, title: 't', projectId: project.id })
    await db
      .insert(conversations)
      .values({ kind: 'work_item', ownerId: person.id, title: 't', projectId: project.id, workItemId: workItem.id })
  })

  it('allows one pending step_advance proposal per work item', async () => {
    const { db, project, workItem } = await seed()
    const v = { projectId: project.id, workItemId: workItem.id, kind: 'step_advance', createdByKind: 'ai' }
    await db.insert(proposals).values(v)
    await expect(db.insert(proposals).values(v)).rejects.toThrow()
    await db.insert(proposals).values({ ...v, state: 'accepted' })
    await db.insert(proposals).values({ ...v, kind: 'priority_change' })
  })

  it('de-duplicates notifications per person and key', async () => {
    const { db, person } = await seed()
    const v = { personId: person.id, kind: 'task_assigned', title: 't', body: 'b', dedupeKey: 'k' }
    await db.insert(notifications).values(v)
    await expect(db.insert(notifications).values(v)).rejects.toThrow()
    await db.insert(notifications).values({ ...v, dedupeKey: null })
    await db.insert(notifications).values({ ...v, dedupeKey: null })
  })

  it('accepts the REQUESTER task role', async () => {
    const { db, project, workItem } = await seed()
    await db.insert(tasks).values({
      workItemId: workItem.id,
      projectId: project.id,
      stepKey: 's',
      templateTaskKey: 't',
      attempt: 1,
      type: 'human',
      role: 'REQUESTER',
      executor: 'human',
      state: 'open',
    })
  })

  it('requires an attachment to belong to a project or a conversation', async () => {
    const { db, person, project } = await seed()
    const base = { storageKey: randomUUID(), fileName: 'f', contentType: 'text/plain', sizeBytes: 1, uploadedBy: person.id }
    await expect(db.insert(attachments).values(base)).rejects.toThrow()
    const [c] = await db.insert(conversations).values({ kind: 'personal', ownerId: person.id, title: 'c' }).returning()
    await db.insert(attachments).values({ ...base, conversationId: c!.id })
    await db.insert(attachments).values({ ...base, storageKey: randomUUID(), projectId: project.id })
  })
})
