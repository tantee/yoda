import { randomUUID } from 'node:crypto'
import { DefectReportCreated, type Me } from '@yoda/shared'
import { and, eq } from 'drizzle-orm'
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import { z } from 'zod'
import { HttpError } from '../auth/plugin.js'
import { listAttachments, sanitizeFileName } from '../attachments/service.js'
import type { Db } from '../db/client.js'
import { defectReports, workItems } from '../db/schema.js'
import { createDefect, type StoredDefectFile } from '../defects/service.js'
import { isUniqueViolation, readDefectParts, validateDeclaredReport } from '../defects/upload.js'
import type { ExtensionLimits } from '../extension/limits.js'
import { productionRulesForPerson } from '../extension/mappings.js'
import { runWork } from '../work/context.js'

const IdempotencyKey = z.string().uuid()
const rateLimited = (retryAfter: number) => new HttpError(429, { error: 'rate_limited', retryAfter })

type Outcome = { status: 200 | 201; body: DefectReportCreated }

/** What the extension gets back for a filed report (also for a repeated Idempotency-Key). */
export async function defectCreated(db: Db, publicUrl: string, workItemId: string): Promise<DefectReportCreated> {
  const [row] = await db
    .select({ w: workItems, sensitive: defectReports.sensitive })
    .from(workItems)
    .innerJoin(defectReports, eq(defectReports.workItemId, workItems.id))
    .where(eq(workItems.id, workItemId))
  if (!row) throw new Error(`defect ${workItemId} not found`)
  return DefectReportCreated.parse({
    workItemId,
    url: `${publicUrl.replace(/\/+$/, '')}/work-items/${workItemId}`,
    title: row.w.title,
    stepKey: row.w.currentStepKey,
    state: row.w.state,
    aiAllowed: !row.sensitive,
    attachments: await listAttachments(db, row.w.projectId, { workItemId }),
  })
}

async function storedFor(db: Db, personId: string, key: string): Promise<{ id: string; grantId: string | null } | null> {
  const [r] = await db
    .select({ id: defectReports.workItemId, grantId: defectReports.grantId })
    .from(defectReports)
    .where(and(eq(defectReports.reportedBy, personId), eq(defectReports.idempotencyKey, key)))
  return r ?? null
}

/** Reads and drops what is left of the request body (a repeated report: its files are not needed). */
function drain(request: FastifyRequest): void {
  request.raw.resume()
}

/**
 * `POST /extension/defects` (plan A6): one multipart report, idempotent on `Idempotency-Key`. A repeat, or a
 * duplicate still in flight, is answered before any limiter with the first report's body. The report part is
 * validated before any file byte is read; a refusal answers with `Connection: close` and reads no further.
 */
export function extensionDefectRoutes(app: FastifyInstance, limits: ExtensionLimits): void {
  const db = () => app.deps.db
  /** Uploads in flight by `${grantId}:${key}`. */
  const inFlight = new Map<string, Promise<Outcome>>()
  /** The key each grant is uploading: one upload per grant at a time. */
  const activeByGrant = new Map<string, string>()

  app.post('/extension/defects', { config: { public: true, extension: 'token' } }, async (request, reply) => {
    if (!request.extension) throw new HttpError(401, { error: 'unauthorized' })
    const { grant, me } = request.extension
    const key = IdempotencyKey.parse(request.headers['idempotency-key'])
    const flight = `${grant.id}:${key}`

    // A duplicate of an upload in flight waits for it. When the first upload was refused, this one gets the same
    // answer; when it failed on its own (e.g. its connection dropped), this request uploads its own body.
    for (let pending = inFlight.get(flight); pending; pending = inFlight.get(flight)) {
      try {
        const { body } = await pending
        drain(request)
        return reply.status(200).send(body)
      } catch (err) {
        if (err instanceof HttpError || err instanceof z.ZodError) {
          reply.header('connection', 'close')
          throw err
        }
      }
    }
    const work = upload(request, reply, me, grant.id, key)
    inFlight.set(flight, work)
    work.catch(() => {})
    try {
      const { status, body } = await work
      return reply.status(status).send(body)
    } finally {
      inFlight.delete(flight)
    }
  })

  async function upload(request: FastifyRequest, reply: FastifyReply, me: Me, grantId: string, key: string): Promise<Outcome> {
    const publicUrl = app.deps.config.portalUrl
    const stored = await storedFor(db(), me.id, key)
    if (stored) {
      drain(request)
      return { status: 200, body: await defectCreated(db(), publicUrl, stored.id) }
    }
    // Check and claim with no await between them: one upload per grant at a time.
    const other = activeByGrant.get(grantId)
    if (other && other !== key) {
      reply.header('connection', 'close')
      throw rateLimited(5)
    }
    activeByGrant.set(grantId, key)

    /** Objects put for this upload; emptied once the report is committed (they then belong to it). */
    const keys: string[] = []
    let release: (() => void) | null = null
    let committed = false
    try {
      const rules = await productionRulesForPerson(db(), me.id)
      const { report, files } = await readDefectParts(request, async (report) => {
        await validateDeclaredReport(db(), me, report, { productionRules: rules })
        // Counted once the report is acceptable, so a refused one uses up no quota.
        const r = limits.defects.take(me.id)
        if (!r.ok) throw rateLimited(r.retryAfter)
        const bytes = limits.defectBytes.take(me.id, report.attachments.reduce((n, a) => n + a.sizeBytes, 0))
        if (!bytes.ok) throw rateLimited(bytes.retryAfter)
        release = bytes.release
      })

      const folder = `projects/${report.projectId}/defects/${randomUUID()}`
      const stored: StoredDefectFile[] = []
      for (const f of files) {
        const fileName = sanitizeFileName(f.decl.name)
        const storageKey = `${folder}/${f.decl.part}/${fileName}`
        await app.deps.storage.put(storageKey, f.buf, f.decl.type)
        keys.push(storageKey)
        stored.push({ role: f.decl.role, storageKey, fileName, contentType: f.decl.type, sizeBytes: f.buf.length })
      }

      let workItemId: string
      try {
        ;({ workItemId } = await runWork(app.deps, { id: me.id, kind: 'person' }, (ctx) =>
          createDefect(ctx, me, report, stored, { grantId, extensionVersion: report.client.extensionVersion, idempotencyKey: key }),
        ))
      } catch (err) {
        // Either the same key from another grant of this person won the race (a unique violation), or our report
        // committed and something after the commit failed (runWork publishes and queues after it).
        let winner: Awaited<ReturnType<typeof storedFor>>
        try {
          winner = await storedFor(db(), me.id, key)
        } catch {
          // Unknown whether the report committed: keep the objects (the orphan sweep removes them if not).
          committed = true
          throw err
        }
        if (!winner) throw err
        if (winner.grantId === grantId) {
          committed = true
          keys.length = 0
          request.log.warn({ workItemId: winner.id, grantId }, 'defect committed; a step after the commit failed')
          return { status: 201, body: await defectCreated(db(), publicUrl, winner.id) }
        }
        if (!isUniqueViolation(err, 'defect_reports_idempotency')) request.log.warn({ grantId }, 'defect upload lost to another grant')
        await removeAll(keys)
        ;(release as (() => void) | null)?.()
        committed = true
        return { status: 200, body: await defectCreated(db(), publicUrl, winner.id) }
      }
      committed = true
      keys.length = 0
      request.log.info({ workItemId, grantId, personId: me.id, files: stored.length }, 'defect reported')
      return { status: 201, body: await defectCreated(db(), publicUrl, workItemId) }
    } catch (err) {
      if (!committed) {
        await removeAll(keys)
        ;(release as (() => void) | null)?.()
        // The body may be unread: never keep this connection.
        reply.header('connection', 'close')
      }
      throw err
    } finally {
      if (activeByGrant.get(grantId) === key) activeByGrant.delete(grantId)
    }
  }

  async function removeAll(keys: string[]): Promise<void> {
    for (const k of keys.splice(0)) await app.deps.storage.remove(k).catch(() => {})
  }
}
