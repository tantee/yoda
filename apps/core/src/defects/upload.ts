import {
  DEFECT_LIMITS,
  DEFECT_TYPES,
  DefectReportCreate,
  matchesPattern,
  type DefectAttachmentDecl,
  type Me,
} from '@yoda/shared'
import { and, eq } from 'drizzle-orm'
import type { FastifyRequest } from 'fastify'
import { z } from 'zod'
import { HttpError, notFound, unsupportedType } from '../auth/plugin.js'
import type { Db } from '../db/client.js'
import { projectMembers, projects } from '../db/schema.js'

const MiB = 1024 * 1024

/**
 * Per-request multipart limits of `POST /extension/defects` (the app-wide registration is untouched). `parts`
 * leaves room for one extra part, so a ninth file trips `files` and a second field trips `fields`.
 */
export const DEFECT_PART_LIMITS = {
  parts: DEFECT_LIMITS.maxFiles + 2,
  files: DEFECT_LIMITS.maxFiles,
  fields: 1,
  fieldSize: 64 * 1024,
  fileSize: 25 * MiB,
  headerPairs: 50,
} as const

const VIDEO_ROLES = new Set(['video', 'buffer'])

export const tooLargeFor = (reason: string) => new HttpError(413, { error: 'too_large', reason })
const invalid = (path: string, message: string) => new z.ZodError([{ code: 'custom', path: [path], message }])

/** WebM (and Matroska) starts with the EBML magic `1A 45 DF A3`. */
export function isWebm(buf: Uint8Array): boolean {
  return buf.length >= 4 && buf[0] === 0x1a && buf[1] === 0x45 && buf[2] === 0xdf && buf[3] === 0xa3
}

/**
 * Checks a report as soon as its JSON arrives, before any file byte is read: the reporter is a staff member of
 * the project (404 otherwise, admins included: plan decision 13), every declared file has an allowed type and
 * size for its role and the total fits (413 `role:<role>` / `total`, 415), and no video or buffer comes from a
 * production site (422 `video_on_production`): the tester's flag, or the page URL matching a production rule of
 * any of the person's projects.
 */
export async function validateDeclaredReport(
  db: Db,
  me: Me,
  report: DefectReportCreate,
  opts: { productionRules: readonly string[] },
): Promise<void> {
  const [member] = await db
    .select({ id: projects.id })
    .from(projectMembers)
    .innerJoin(projects, eq(projects.id, projectMembers.projectId))
    .where(and(eq(projectMembers.projectId, report.projectId), eq(projectMembers.personId, me.id), eq(projects.status, 'active')))
  if (!member || !me.isStaff) throw notFound()

  let total = 0
  for (const a of report.attachments) {
    if (!DEFECT_TYPES[a.role].includes(a.type)) throw unsupportedType()
    if (a.sizeBytes > DEFECT_LIMITS.perRole[a.role]) throw tooLargeFor(`role:${a.role}`)
    total += a.sizeBytes
  }
  if (total > DEFECT_LIMITS.maxReportBytes) throw tooLargeFor('total')

  if (report.attachments.some((a) => VIDEO_ROLES.has(a.role))) {
    const production = report.privacy.productionSite || opts.productionRules.some((p) => matchesPattern(p, report.page.url))
    if (production) throw new HttpError(422, { error: 'invalid_state', reason: 'video_on_production' })
  }
}

export type ReadFile = { decl: DefectAttachmentDecl; buf: Buffer }

const LIMIT_REASONS: Record<string, string> = { FST_PARTS_LIMIT: 'parts', FST_FILES_LIMIT: 'files', FST_FIELDS_LIMIT: 'fields' }

/**
 * Reads the multipart body: the `report` field first (`onReport` runs on it before any file part is read), then
 * each declared file, whose type and length must equal its declaration and whose WebM must carry the EBML magic.
 */
export async function readDefectParts(
  request: FastifyRequest,
  onReport: (report: DefectReportCreate) => Promise<void>,
): Promise<{ report: DefectReportCreate; files: ReadFile[] }> {
  if (!request.isMultipart()) throw unsupportedType()
  let report: DefectReportCreate | undefined
  const files: ReadFile[] = []
  const seen = new Set<string>()
  try {
    for await (const part of request.parts({ limits: DEFECT_PART_LIMITS })) {
      if (!report) {
        // Refusals never read on: the route answers with `Connection: close`.
        if (part.type !== 'field' || part.fieldname !== 'report') throw invalid('report', 'the report must be the first part')
        if (part.valueTruncated) throw tooLargeFor('report_size')
        let raw: unknown
        try {
          raw = JSON.parse(String(part.value))
        } catch {
          throw invalid('report', 'the report is not JSON')
        }
        report = DefectReportCreate.parse(raw)
        await onReport(report)
        continue
      }
      if (part.type !== 'file') throw tooLargeFor('fields')
      const decl = report.attachments.find((a) => a.part === part.fieldname)
      if (!decl || seen.has(part.fieldname)) throw invalid(part.fieldname, 'undeclared file part')
      seen.add(part.fieldname)
      const type = part.mimetype.split(';')[0]!.trim().toLowerCase()
      if (type !== decl.type) throw invalid(part.fieldname, 'type differs from the declaration')
      const buf = await readExactly(part.file, decl)
      if (VIDEO_ROLES.has(decl.role) && !isWebm(buf)) throw unsupportedType()
      files.push({ decl, buf })
    }
  } catch (err) {
    const code = (err as { code?: string }).code ?? ''
    const reason = LIMIT_REASONS[code]
    if (reason) throw tooLargeFor(reason)
    if (code === 'FST_INVALID_JSON_FIELD_ERROR' || code === 'FST_PROTO_VIOLATION') throw invalid('report', 'malformed multipart field')
    throw err
  }
  if (!report) throw invalid('report', 'the report is required')
  const missing = report.attachments.filter((a) => !seen.has(a.part))
  if (missing.length) throw invalid(missing[0]!.part, 'declared file part missing')
  return { report, files }
}

/**
 * A file part's bytes, never more than declared: the stream is destroyed as soon as it passes `decl.sizeBytes`,
 * so the bytes held in memory stay within the declared total (at most 50 MiB).
 */
async function readExactly(file: NodeJS.ReadableStream & { destroy?: (err?: Error) => void; truncated?: boolean }, decl: DefectAttachmentDecl): Promise<Buffer> {
  const chunks: Buffer[] = []
  let n = 0
  try {
    for await (const chunk of file as AsyncIterable<Buffer>) {
      n += chunk.length
      if (n > decl.sizeBytes) {
        file.destroy?.()
        throw invalid(decl.part, 'longer than the declaration')
      }
      chunks.push(chunk)
    }
  } catch (err) {
    if ((err as { code?: string }).code === 'FST_REQ_FILE_TOO_LARGE') throw tooLargeFor(`role:${decl.role}`)
    throw err
  }
  if (n !== decl.sizeBytes) throw invalid(decl.part, 'shorter than the declaration')
  return Buffer.concat(chunks, n)
}

/** A Postgres unique violation on `constraint`, through any driver or ORM wrapping. */
export function isUniqueViolation(err: unknown, constraint: string): boolean {
  for (let e = err as { code?: string; constraint_name?: string; constraint?: string; cause?: unknown } | undefined; e; e = e.cause as typeof e) {
    if (e.code === '23505' && (e.constraint_name === constraint || e.constraint === constraint)) return true
  }
  return false
}
