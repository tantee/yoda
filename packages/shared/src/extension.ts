import { z } from 'zod'
import { Attachment } from './knowledge.js'
import type { Priority } from './work.js'
import { isExtensionId } from './extension-id.js'
import { parseMatchPattern } from './match-pattern.js'

export * from './extension-id.js'
export * from './match-pattern.js'

/**
 * Yoda Reporter contracts (docs/design/extension-proposal.md §7 and §10.1, D2 applied: nothing is masked). Core, the
 * portal, the extension and the e2e stub validate the same shapes.
 */

export const EXTENSION_API_VERSION = 1

/** Token prefixes: a prefix plus 32 random bytes in base64url (43 characters), as runner tokens. */
export const EXTENSION_TOKEN = { code: 'yoda_xc_', access: 'yoda_xt_', refresh: 'yoda_xr_' } as const
export type ExtensionTokenKind = keyof typeof EXTENSION_TOKEN

export function extensionTokenRe(kind: ExtensionTokenKind): RegExp {
  return new RegExp(`^${EXTENSION_TOKEN[kind]}[A-Za-z0-9_-]{43}$`)
}

// --- Versions (plan decision 7) ------------------------------------------------------------------------------

const RELEASE_RE = /^(0|[1-9]\d{0,4})\.(0|[1-9]\d{0,4})\.(0|[1-9]\d{0,4})(?:-rc\.([1-9]\d{0,2}))?$/

/** A final `x.y.z` or `x.y.z-rc.N` (N 1–999), with each part a valid Chrome version part. */
export function isReleaseVersion(v: string): boolean {
  const m = RELEASE_RE.exec(v)
  return !!m && [m[1], m[2], m[3]].every((p) => Number(p) <= 65535)
}

/** The manifest's `version` and `version_name`: a final release (`.1000`) is newer than its release candidates. */
export function manifestVersion(yodaVersion: string): { version: string; versionName: string } {
  if (!isReleaseVersion(yodaVersion)) throw new Error(`not a release version: ${yodaVersion}`)
  const m = RELEASE_RE.exec(yodaVersion)!
  return { version: `${m[1]}.${m[2]}.${m[3]}.${m[4] ?? '1000'}`, versionName: yodaVersion }
}

// --- Defect templates and fixed texts (plan decisions 11 and 12) ---------------------------------------------

/** Templates only the extension creates: hidden in the portal create dialog, refused by the create routes. */
export const EXTENSION_ONLY_TEMPLATES = ['defect'] as const

export function isExtensionOnlyTemplate(key: string): boolean {
  return (EXTENSION_ONLY_TEMPLATES as readonly string[]).includes(key)
}

/** What AI sees instead of a sensitive defect's title. */
export const DEFECT_SENSITIVE_TITLE = { th: 'รายงานข้อบกพร่อง (ข้อมูลอ่อนไหว)', en: 'Defect report (sensitive)' } as const

/** The work item description of a sensitive defect; the text lives only in `defect_reports`. */
export const DEFECT_WITHHELD_DESCRIPTION = {
  th: '[รายงานข้อบกพร่อง: ข้อความเก็บแยก ไม่ส่งให้ AI]',
  en: '[Defect report: text kept separately, not sent to AI]',
} as const

// --- Enums and limits ----------------------------------------------------------------------------------------

export const DefectSeverity = z.enum(['blocker', 'critical', 'major', 'minor', 'trivial'])
export type DefectSeverity = z.infer<typeof DefectSeverity>
export const DefectKind = z.enum(['defect', 'bug_fix_request'])
export type DefectKind = z.infer<typeof DefectKind>
export const AttachmentRole = z.enum(['screenshot', 'screenshot_full', 'video', 'buffer', 'console', 'network'])
export type AttachmentRole = z.infer<typeof AttachmentRole>
export const BuildSource = z.enum(['meta', 'well-known', 'header', 'gitlab', 'manual'])
export type BuildSource = z.infer<typeof BuildSource>

const PRIORITY_OF: Record<DefectSeverity, Priority> = { blocker: 'urgent', critical: 'urgent', major: 'high', minor: 'normal', trivial: 'low' }

/** Severity is the tester's statement; the priority is derived once from it (§10.2) and the PM may change it. */
export function severityPriority(s: DefectSeverity): Priority {
  return PRIORITY_OF[s]
}

const MiB = 1024 * 1024

export const DEFECT_LIMITS = {
  maxFiles: 8,
  maxReportBytes: 50 * MiB,
  perRole: { screenshot: 10 * MiB, screenshot_full: 15 * MiB, video: 25 * MiB, buffer: 25 * MiB, console: 1 * MiB, network: 1 * MiB },
} as const satisfies { maxFiles: number; maxReportBytes: number; perRole: Record<AttachmentRole, number> }

const IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/webp']
export const DEFECT_TYPES: Record<AttachmentRole, string[]> = {
  screenshot: IMAGE_TYPES,
  screenshot_full: IMAGE_TYPES,
  video: ['video/webm'],
  buffer: ['video/webm'],
  console: ['application/json'],
  network: ['application/json'],
}

export const MEDIA_ROLES = ['screenshot', 'screenshot_full', 'video', 'buffer'] as const satisfies readonly AttachmentRole[]
export const LOG_ROLES = ['console', 'network'] as const satisfies readonly AttachmentRole[]

// --- Captured page data (untrusted: validated and capped) ----------------------------------------------------

export const CAPTURE_CAPS = { entries: 500, message: 2048, backendBuilds: 10 } as const

export const ConsoleEntry = z.object({
  t: z.number(),
  level: z.enum(['log', 'info', 'warn', 'error', 'debug', 'exception', 'rejection']),
  message: z.string().max(CAPTURE_CAPS.message),
  source: z.string().max(500).optional(),
})
export type ConsoleEntry = z.infer<typeof ConsoleEntry>

/** Never headers or bodies (§10.1): unknown keys are stripped. */
export const NetworkEntry = z.object({
  t: z.number(),
  method: z.string().max(20),
  url: z.string().max(2048),
  status: z.number().int().nullable(),
  durationMs: z.number(),
  failed: z.boolean(),
  kind: z.enum(['fetch', 'xhr', 'resource']),
  yodaBuild: z.string().max(500).optional(),
})
export type NetworkEntry = z.infer<typeof NetworkEntry>

// --- Connect (§7.3) ------------------------------------------------------------------------------------------

const uuid = z.string().uuid()
const extensionId = z.string().refine(isExtensionId, 'not an extension id')

export const ExtensionAuthorize = z.object({
  extensionId,
  redirectUri: z.string().url().max(200),
  codeChallenge: z.string().regex(/^[A-Za-z0-9_-]{43}$/, 'must be an S256 challenge'),
  codeChallengeMethod: z.literal('S256'),
  state: z.string().min(1).max(200),
  browserLabel: z.string().trim().min(1).max(120),
})
export type ExtensionAuthorize = z.infer<typeof ExtensionAuthorize>

export const ExtensionAuthorizeResponse = z.object({ redirectTo: z.string() })
export type ExtensionAuthorizeResponse = z.infer<typeof ExtensionAuthorizeResponse>

export const ExtensionTokenRequest = z.discriminatedUnion('grantType', [
  z.object({ grantType: z.literal('authorization_code'), code: z.string().min(1).max(200), codeVerifier: z.string().min(1).max(200), extensionId: z.string().max(64) }),
  z.object({ grantType: z.literal('refresh_token'), refreshToken: z.string().min(1).max(200) }),
])
export type ExtensionTokenRequest = z.infer<typeof ExtensionTokenRequest>

export const ExtensionPerson = z.object({ id: uuid, displayName: z.string(), isStaff: z.boolean() })
export type ExtensionPerson = z.infer<typeof ExtensionPerson>

export const ExtensionTokenResponse = z.object({
  accessToken: z.string(),
  /** Seconds. */
  expiresIn: z.number().int(),
  refreshToken: z.string(),
  grantId: uuid,
  person: ExtensionPerson,
})
export type ExtensionTokenResponse = z.infer<typeof ExtensionTokenResponse>

export const ExtensionTokenErrorReason = z.enum(['invalid_grant', 'reauth_required', 'revoked'])
export type ExtensionTokenErrorReason = z.infer<typeof ExtensionTokenErrorReason>

/** The latest release core can serve (A12); null when none is built in. */
export const ExtensionLatest = z.object({ version: z.string(), zipUrl: z.string(), crxUrl: z.string().nullable() }).nullable()
export type ExtensionLatest = z.infer<typeof ExtensionLatest>

const PlainText = z.object({ th: z.string(), en: z.string() })

export const ExtensionSession = z.object({
  apiVersion: z.number().int(),
  instance: z.object({ name: PlainText, publicUrl: z.string(), version: z.string() }),
  latestExtension: ExtensionLatest,
  person: ExtensionPerson,
  /** The person's member projects only, for admins too (plan decision 13). */
  projects: z.array(
    z.object({ id: uuid, name: z.string(), noAi: z.boolean(), kinds: z.array(DefectKind), repos: z.array(z.string()) }),
  ),
  limits: z.object({
    maxFileBytes: z.number().int(),
    maxReportBytes: z.number().int(),
    maxFiles: z.number().int(),
    maxVideoSeconds: z.number().int(),
    perRole: z.record(AttachmentRole, z.number().int()),
    allowedTypes: z.record(AttachmentRole, z.array(z.string())),
  }),
  policy: z.object({ videoOnProduction: z.literal(false), logsOnProductionDefault: z.literal(false), requireConfirm: z.literal(true) }),
})
export type ExtensionSession = z.infer<typeof ExtensionSession>

// --- URL mapping (plan decision 3) ---------------------------------------------------------------------------

const pattern = z.string().max(500).refine((p) => parseMatchPattern(p) !== null, 'not a match pattern')

export const MappingRule = z.object({
  pattern,
  projectId: uuid,
  environment: z.string().nullable(),
  production: z.boolean(),
  source: z.enum(['app_url', 'gitlab']),
  build: z.object({ repo: z.string(), ref: z.string().nullable(), sha: z.string().nullable(), deployedAt: z.string().nullable() }).nullable(),
})
export type MappingRule = z.infer<typeof MappingRule>

export const ExtensionMappings = z.object({ rules: z.array(MappingRule), ttlSeconds: z.literal(600) })
export type ExtensionMappings = z.infer<typeof ExtensionMappings>

// --- Connected browsers --------------------------------------------------------------------------------------

export const GrantRevokeReason = z.enum(['user', 'admin', 'admin_all', 'reuse_detected', 'extension_not_allowed', 'not_staff'])
export type GrantRevokeReason = z.infer<typeof GrantRevokeReason>

export const ExtensionGrant = z.object({
  id: uuid,
  extensionId: z.string(),
  browserLabel: z.string(),
  createdAt: z.string(),
  lastUsedAt: z.string().nullable(),
  lastIp: z.string().nullable(),
  revokedAt: z.string().nullable(),
  revokeReason: GrantRevokeReason.nullable(),
  person: z.object({ id: uuid, displayName: z.string() }),
})
export type ExtensionGrant = z.infer<typeof ExtensionGrant>

// --- Project application URLs (A7) ---------------------------------------------------------------------------

export const AppUrl = z.object({
  id: uuid,
  pattern: z.string(),
  environment: z.string().nullable(),
  production: z.boolean(),
  createdAt: z.string(),
})
export type AppUrl = z.infer<typeof AppUrl>

export const AppUrlsPut = z.object({
  urls: z
    .array(z.object({ pattern, environment: z.string().trim().min(1).max(100).nullable().default(null), production: z.boolean() }))
    .max(50),
})
export type AppUrlsPut = z.infer<typeof AppUrlsPut>

// --- Defect reports (§10.1) ----------------------------------------------------------------------------------

const short = z.string().max(200)

export const DefectAttachmentDecl = z.object({
  part: z.string().regex(/^file[1-8]$/),
  role: AttachmentRole,
  name: z.string().min(1).max(120),
  type: z.string().min(1).max(100),
  sizeBytes: z.number().int().min(0),
})
export type DefectAttachmentDecl = z.infer<typeof DefectAttachmentDecl>

export const DefectBuild = z.object({
  repo: short.optional(),
  branch: short.optional(),
  commit: short.optional(),
  env: short.optional(),
  builtAt: short.optional(),
  source: BuildSource,
})
export type DefectBuild = z.infer<typeof DefectBuild>

export const DefectBackendBuild = z.object({ origin: z.string().max(500), repo: short.optional(), branch: short.optional(), commit: short.optional() })
export type DefectBackendBuild = z.infer<typeof DefectBackendBuild>

export const DefectClient = z.object({
  browser: short,
  browserVersion: short,
  os: short,
  osVersion: short,
  viewport: z.object({ w: z.number(), h: z.number(), dpr: z.number() }),
  zoom: z.number(),
  locale: short,
  timeZone: short,
  extensionVersion: short,
})
export type DefectClient = z.infer<typeof DefectClient>

export const DefectPage = z.object({
  /** Kept as captured, query string included unless the tester dropped it (plan decision 5). */
  url: z.string().url().max(2048),
  title: z.string().max(300),
  route: z.string().max(200).optional(),
})
export type DefectPage = z.infer<typeof DefectPage>

export const DefectPrivacy = z.object({
  confirmedNoPatientData: z.literal(true),
  productionSite: z.boolean(),
  textMayContainPatientData: z.boolean(),
})
export type DefectPrivacy = z.infer<typeof DefectPrivacy>

export const DefectReportCreate = z.object({
  projectId: uuid,
  kind: DefectKind,
  title: z.string().trim().min(1).max(200),
  severity: DefectSeverity,
  description: z.string().max(10000).default(''),
  steps: z.array(z.string().max(500)).max(30),
  expected: z.string().max(2000),
  actual: z.string().max(2000),
  page: DefectPage,
  build: DefectBuild.optional(),
  backendBuilds: z.array(DefectBackendBuild).max(CAPTURE_CAPS.backendBuilds),
  client: DefectClient,
  capturedAt: z.string().datetime({ offset: true }),
  attachments: z
    .array(DefectAttachmentDecl)
    .max(DEFECT_LIMITS.maxFiles)
    .refine((a) => new Set(a.map((x) => x.part)).size === a.length, 'duplicate part'),
  privacy: DefectPrivacy,
})
export type DefectReportCreate = z.infer<typeof DefectReportCreate>

export const DefectReportCreated = z.object({
  workItemId: uuid,
  /** The portal link. */
  url: z.string(),
  title: z.string(),
  stepKey: z.string(),
  state: z.enum(['active', 'done', 'cancelled']),
  aiAllowed: z.boolean(),
  attachments: z.array(Attachment),
})
export type DefectReportCreated = z.infer<typeof DefectReportCreated>

/** What the portal's defect card reads (`WorkItemDetail.defect`). */
export const DefectReportView = z.object({
  kind: DefectKind,
  severity: DefectSeverity,
  /** The report text; for a sensitive report it lives only here, never in the work item description. */
  description: z.string(),
  steps: z.array(z.string()),
  expected: z.string(),
  actual: z.string(),
  page: DefectPage,
  build: DefectBuild.nullable(),
  backendBuilds: z.array(DefectBackendBuild),
  client: DefectClient,
  capturedAt: z.string(),
  reportedBy: z.object({ id: uuid, displayName: z.string() }),
  source: z.enum(['extension', 'portal']),
  productionSite: z.boolean(),
  textMayContainPatientData: z.boolean(),
  /** The tester's flag or the project's noAi: the text is kept from AI. */
  sensitive: z.boolean(),
})
export type DefectReportView = z.infer<typeof DefectReportView>

/** The multipart body of `POST /extension/defects`: the `report` part first, then the files in order. */
export function encodeDefectForm(report: DefectReportCreate, files: { part: string; name: string; type: string; data: Blob }[]): FormData {
  const fd = new FormData()
  fd.append('report', JSON.stringify(report))
  for (const f of files) fd.append(f.part, f.data.type === f.type ? f.data : new Blob([f.data], { type: f.type }), f.name)
  return fd
}
