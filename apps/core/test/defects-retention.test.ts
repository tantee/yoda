import { settingDef, type Me, type SettingKey } from '@yoda/shared'
import { and, eq } from 'drizzle-orm'
import type { FastifyInstance } from 'fastify'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { buildApp, type AppDeps } from '../src/app.js'
import { attachments, events, workItems } from '../src/db/schema.js'
import { purgeExpired, sweepOrphans } from '../src/defects/retention.js'
import { createDefect, type StoredDefectFile } from '../src/defects/service.js'
import { personAsMe } from '../src/proposals/service.js'
import type { SettingsStore } from '../src/settings/store.js'
import { createMemoryStorage } from '../src/storage/memory.js'
import { runWork } from '../src/work/context.js'
import { makeProject, sampleReport } from './defect-fixtures.js'
import { resetDb, testDb, testDeps } from './helpers.js'
import { auth, login, type Who } from './support.js'

const DAY = 86_400_000
let clock = new Date('2026-11-28T00:00:00Z')
let values: Partial<Record<SettingKey, unknown>>
let deps: AppDeps
let app: FastifyInstance
let admin: Who
let pm: Who
let qc: Who
let dev: Who
let projectId: string

function fakeStore() {
  return {
    recoveryForced: false,
    recovery: false,
    setupDone: true,
    keyStatus: 'ok',
    get: (k: SettingKey) => (Object.hasOwn(values, k) ? values[k] : settingDef(k).default),
    fromEnv: () => false,
    recoveryWritable: () => false,
  } as unknown as SettingsStore
}

beforeEach(async () => {
  await resetDb(await testDb())
  values = {}
  clock = new Date('2026-11-28T00:00:00Z')
  deps = await testDeps({ storage: createMemoryStorage(() => clock), settings: fakeStore() })
  app = await buildApp({ ...deps, config: { ...deps.config, bootstrapAdmins: ['boss'] } })
  admin = await login(app, 'boss')
  pm = await login(app, 'pm', { staff: true })
  qc = await login(app, 'qc', { staff: true })
  dev = await login(app, 'dev', { staff: true })
  projectId = await makeProject(app, admin, 'OPD', [
    [pm, ['PM']],
    [qc, ['QC']],
    [dev, ['DEV']],
  ])
})
afterEach(async () => {
  await app.close()
})

const me = async (who: Who): Promise<Me> => (await personAsMe(deps.db, who.id))!

/** A defect by QC with a screenshot and a console log, both stored. */
async function defect(): Promise<{ id: string; shot: string; log: string }> {
  const files: StoredDefectFile[] = []
  for (const [role, name, type] of [['screenshot', 'shot.png', 'image/png'], ['console', 'console.json', 'application/json']] as const) {
    const storageKey = `projects/${projectId}/defects/${crypto.randomUUID()}/file1/${name}`
    await deps.storage.put(storageKey, Buffer.from('x'), type)
    files.push({ role, storageKey, fileName: name, contentType: type, sizeBytes: 1 })
  }
  const m = await me(qc)
  const { workItemId } = await runWork(deps, { id: m.id, kind: 'person' }, (ctx) =>
    createDefect(ctx, m, sampleReport(projectId), files, { grantId: null, extensionVersion: '1.1.0', idempotencyKey: null }),
  )
  const rows = await deps.db.select().from(attachments).where(eq(attachments.workItemId, workItemId))
  return { id: workItemId, shot: rows.find((r) => r.role === 'screenshot')!.id, log: rows.find((r) => r.role === 'console')!.id }
}

/** Closes the item as `type` at `at` (the close time retention counts from). */
async function close(id: string, type: 'work_item.done' | 'work_item.cancelled', at: Date) {
  await deps.db.update(workItems).set({ state: type === 'work_item.done' ? 'done' : 'cancelled' }).where(eq(workItems.id, id))
  await deps.db.insert(events).values({ projectId, workItemId: id, type, actorKind: 'system', payload: {}, createdAt: at })
}

const row = async (id: string) => (await deps.db.select().from(attachments).where(eq(attachments.id, id)))[0]!
const exists = async (key: string) => {
  try {
    await deps.storage.get(key)
    return true
  } catch {
    return false
  }
}

describe('the noAi lock and removal', () => {
  it('PATCH noAi:false on a defect file is 409, by the uploader and by the PM; noAi:true is a no-op', async () => {
    const d = await defect()
    for (const who of [qc, pm]) {
      const res = await app.inject({ method: 'PATCH', url: `/attachments/${d.shot}`, headers: auth(who), payload: { noAi: false } })
      expect(res.statusCode).toBe(409)
      expect(res.json()).toEqual({ error: 'invalid_state', reason: 'defect_files_never_ai' })
    }
    const ok = await app.inject({ method: 'PATCH', url: `/attachments/${d.shot}`, headers: auth(qc), payload: { noAi: true } })
    expect(ok.statusCode).toBe(200)
    expect(ok.json()).toMatchObject({ noAi: true, role: 'screenshot' })
    expect((await row(d.shot)).noAi).toBe(true)
  })

  it('uploader, PM and admin may remove; another member gets 403; a chat upload gets 409', async () => {
    const d = await defect()
    const del = (who: Who, id: string) => app.inject({ method: 'DELETE', url: `/attachments/${id}`, headers: auth(who), payload: { reason: 'ภาพผิด' } })
    expect((await del(dev, d.shot)).statusCode).toBe(403)
    expect((await del(qc, d.shot)).statusCode).toBe(204)
    expect((await del(pm, d.log)).statusCode).toBe(204)
    const d2 = await defect()
    expect((await del(admin, d2.shot)).statusCode).toBe(204)
    expect((await app.inject({ method: 'DELETE', url: `/attachments/${d2.log}`, headers: auth(qc), payload: { reason: '' } })).statusCode).toBe(400)

    // An ordinary project upload has no role.
    const [plain] = await deps.db
      .insert(attachments)
      .values({ projectId, storageKey: 'projects/x/plain.txt', fileName: 'plain.txt', contentType: 'text/plain', sizeBytes: 1, uploadedBy: qc.id })
      .returning()
    const res = await del(qc, plain!.id)
    expect(res.statusCode).toBe(409)
    expect(res.json()).toEqual({ error: 'invalid_state', reason: 'not_defect_attachment' })

    const [e] = await deps.db.select().from(events).where(and(eq(events.type, 'attachment.removed'), eq(events.workItemId, d.id)))
    expect(e).toMatchObject({ actorId: qc.id, actorKind: 'person', payload: { attachmentId: d.shot, role: 'screenshot', reason: 'ภาพผิด' } })
  })

  it("the removed file's download is 404 purged and the row stays", async () => {
    const d = await defect()
    const key = (await row(d.shot)).storageKey
    await app.inject({ method: 'DELETE', url: `/attachments/${d.shot}`, headers: auth(qc), payload: { reason: 'ผิดไฟล์' } })
    const res = await app.inject({ url: `/attachments/${d.shot}/download`, headers: auth(pm) })
    expect(res.statusCode).toBe(404)
    expect(res.json()).toEqual({ error: 'not_found', reason: 'purged' })
    expect((await row(d.shot)).purgedAt).not.toBeNull()
    expect(await exists(key)).toBe(false)
    // The list still shows it, marked.
    const list = await app.inject({ url: `/projects/${projectId}/attachments?workItemId=${d.id}`, headers: auth(pm) })
    expect((list.json() as { id: string; purgedAt: string | null }[]).find((a) => a.id === d.shot)!.purgedAt).not.toBeNull()
  })
})

describe('retention', () => {
  it('a done item purges media after 180 d and logs after 90 d, not a day earlier', async () => {
    const d = await defect()
    const closed = new Date('2026-01-01T00:00:00Z')
    await close(d.id, 'work_item.done', closed)
    expect(await purgeExpired(deps, new Date(closed.getTime() + 89 * DAY))).toEqual({ media: 0, logs: 0 })
    expect(await purgeExpired(deps, new Date(closed.getTime() + 90 * DAY))).toEqual({ media: 0, logs: 1 })
    expect((await row(d.log)).purgedAt).not.toBeNull()
    expect(await purgeExpired(deps, new Date(closed.getTime() + 179 * DAY))).toEqual({ media: 0, logs: 0 })
    expect(await purgeExpired(deps, new Date(closed.getTime() + 180 * DAY))).toEqual({ media: 1, logs: 0 })
    expect(await exists((await row(d.shot)).storageKey)).toBe(false)
    const purged = await deps.db.select().from(events).where(eq(events.type, 'attachment.purged'))
    expect(purged.map((e) => [e.actorKind, e.actorId, (e.payload as { role: string }).role]).sort()).toEqual([
      ['system', null, 'console'],
      ['system', null, 'screenshot'],
    ])
  })

  it('0 keeps everything', async () => {
    values = { 'extension.mediaRetentionDays': 0, 'extension.logRetentionDays': 0 }
    const d = await defect()
    await close(d.id, 'work_item.done', new Date('2020-01-01T00:00:00Z'))
    expect(await purgeExpired(deps, new Date('2026-11-28T00:00:00Z'))).toEqual({ media: 0, logs: 0 })
  })

  it('a reopened item is not purged', async () => {
    const d = await defect()
    await close(d.id, 'work_item.done', new Date('2020-01-01T00:00:00Z'))
    await deps.db.update(workItems).set({ state: 'active' }).where(eq(workItems.id, d.id))
    await deps.db.insert(events).values({ projectId, workItemId: d.id, type: 'work_item.reopened', actorKind: 'person', actorId: pm.id, payload: {} })
    expect(await purgeExpired(deps, new Date('2026-11-28T00:00:00Z'))).toEqual({ media: 0, logs: 0 })
  })

  it('a cancelled item counts from its cancel event', async () => {
    const d = await defect()
    const cancelled = new Date('2026-03-01T00:00:00Z')
    await close(d.id, 'work_item.cancelled', cancelled)
    expect(await purgeExpired(deps, new Date(cancelled.getTime() + 90 * DAY - 1000))).toEqual({ media: 0, logs: 0 })
    expect(await purgeExpired(deps, new Date(cancelled.getTime() + 90 * DAY))).toEqual({ media: 0, logs: 1 })
  })

  it('the daily jobs run retention and the sweep', async () => {
    const d = await defect()
    await close(d.id, 'work_item.done', new Date('2020-01-01T00:00:00Z'))
    await (deps.jobs as unknown as { runScheduled: (n: string) => Promise<void> }).runScheduled('defect-retention')
    expect((await row(d.shot)).purgedAt).not.toBeNull()
    expect((await row(d.log)).purgedAt).not.toBeNull()
    await (deps.jobs as unknown as { runScheduled: (n: string) => Promise<void> }).runScheduled('defect-orphan-sweep')
  })
})

describe('orphan sweep', () => {
  it('removes an unreferenced object older than 24 h, and keeps a referenced one and a fresh one', async () => {
    const d = await defect()
    const referenced = (await row(d.shot)).storageKey
    const old = `projects/${projectId}/defects/${crypto.randomUUID()}/file1/lost.png`
    await deps.storage.put(old, Buffer.from('x'), 'image/png')
    // A non-defect object is never touched.
    await deps.storage.put(`projects/${projectId}/other/doc.txt`, Buffer.from('x'), 'text/plain')
    clock = new Date(clock.getTime() + 2 * DAY)
    const fresh = `projects/${projectId}/defects/${crypto.randomUUID()}/file1/new.png`
    await deps.storage.put(fresh, Buffer.from('x'), 'image/png')
    expect(await sweepOrphans(deps, clock)).toBe(1)
    expect(await exists(old)).toBe(false)
    expect(await exists(referenced)).toBe(true)
    expect(await exists(fresh)).toBe(true)
    expect(await exists(`projects/${projectId}/other/doc.txt`)).toBe(true)
  })
})
