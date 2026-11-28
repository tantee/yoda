import { DefectReportCreate, type DefectAttachmentDecl, type DefectBuild, type DefectKind, type DefectSeverity } from '@yoda/shared'
import { detectBuild } from '../capture/build'
import { backendBuilds } from '../capture/logs'
import { stripQueriesInText, stripQuery } from '../capture/metadata'
import type { Draft } from '../drafts/db'

/** The editor's form, as the tester filled it in. */
export type ReportForm = {
  projectId: string
  kind: DefectKind
  title: string
  severity: DefectSeverity
  description: string
  steps: string[]
  expected: string
  actual: string
  includeQuery: boolean
  /** Which captured files go: on production, video and buffer never, and logs only when turned on. */
  attach: { screenshot: boolean; video: boolean; buffer: boolean; console: boolean; network: boolean }
  confirmedNoPatientData: boolean
  textMayContainPatientData: boolean
  /** The tester's edit of the detected build (then source manual), or null to keep what was detected. */
  build: Partial<Omit<DefectBuild, 'source'>> | null
}

export type ReportFile = { part: string; name: string; type: string; data: Blob }

const json = (v: unknown) => new Blob([JSON.stringify(v)], { type: 'application/json' })

/**
 * The report and its files, exactly as POST /extension/defects takes them: each file declared with its role,
 * name, type and exact size. `images` are the flattened screenshots (blur, mosaic and redact burned in): the
 * original capture is never sent. Throws when the tester has not confirmed the privacy check.
 */
export function buildReport(
  draft: Draft,
  form: ReportForm,
  ctx: { production: boolean; extensionVersion: string; images: { role: 'screenshot' | 'screenshot_full'; blob: Blob }[] },
): { report: DefectReportCreate; files: ReportFile[] } {
  if (!form.confirmedNoPatientData) throw new Error('the privacy check is not confirmed')
  const meta = draft.metadata
  const files: (ReportFile & { role: DefectAttachmentDecl['role'] })[] = []
  const add = (role: DefectAttachmentDecl['role'], name: string, type: string, data: Blob) => files.push({ part: `file${files.length + 1}`, role, name, type, data })

  if (form.attach.screenshot) for (const img of ctx.images) add(img.role, img.role === 'screenshot_full' ? 'screenshot-full.png' : 'screenshot.png', 'image/png', img.blob)
  if (!ctx.production) {
    // A video with mosaic regions is never sent with those regions unapplied (decision 1).
    if (form.attach.video && draft.video && draft.videoRegions?.length) throw new Error('mosaic_not_applied')
    if (form.attach.video && draft.video) add('video', 'video.webm', 'video/webm', draft.video)
    if (form.attach.buffer) draft.buffer?.forEach((b, i) => add('buffer', `buffer-${i + 1}.webm`, 'video/webm', b))
  }
  // Without the query, it goes from the logs too: request URLs and URLs in console text often carry the same ids.
  const consoleLog = form.includeQuery
    ? draft.console
    : draft.console.map((e) => ({ ...e, message: stripQueriesInText(e.message), ...(e.source ? { source: stripQueriesInText(e.source) } : {}) }))
  const networkLog = form.includeQuery ? draft.network : draft.network.map((e) => ({ ...e, url: stripQuery(e.url) }))
  if (form.attach.console && consoleLog.length) add('console', 'console.json', 'application/json', json(consoleLog))
  if (form.attach.network && networkLog.length) add('network', 'network.json', 'application/json', json(networkLog))

  const detected = draft.build !== undefined ? draft.build : meta ? detectBuild({ ...meta.buildSources, gitlab: null }) : null
  const edited = form.build && Object.values(form.build).some((v) => typeof v === 'string' && v.trim())
  const build: DefectBuild | null = edited ? { ...cleanBuild(form.build!), source: 'manual' } : detected
  const url = meta?.page.url ?? draft.tabUrl

  const report = DefectReportCreate.parse({
    projectId: form.projectId,
    kind: form.kind,
    title: form.title,
    severity: form.severity,
    description: form.description,
    steps: form.steps.map((s) => s.trim()).filter(Boolean),
    expected: form.expected,
    actual: form.actual,
    page: { url: form.includeQuery ? url : stripQuery(url), title: meta?.page.title ?? '', ...(meta?.page.route ? { route: meta.page.route } : {}) },
    ...(build ? { build } : {}),
    backendBuilds: backendBuilds(draft.network),
    client: { ...(meta?.client ?? { browser: 'Chrome', browserVersion: '', os: '', osVersion: '', viewport: { w: 0, h: 0, dpr: 1 }, zoom: 1, locale: navigator.language, timeZone: 'Asia/Bangkok' }), extensionVersion: ctx.extensionVersion },
    capturedAt: new Date(draft.createdAt || Date.now()).toISOString(),
    attachments: files.map((f) => ({ part: f.part, role: f.role, name: f.name, type: f.type, sizeBytes: f.data.size })),
    privacy: { confirmedNoPatientData: true, productionSite: ctx.production, textMayContainPatientData: form.textMayContainPatientData },
  })
  return { report, files: files.map(({ part, name, type, data }) => ({ part, name, type, data })) }
}

function cleanBuild(b: Partial<Omit<DefectBuild, 'source'>>): Partial<Omit<DefectBuild, 'source'>> {
  const out: Partial<Omit<DefectBuild, 'source'>> = {}
  for (const [k, v] of Object.entries(b)) if (typeof v === 'string' && v.trim()) (out as Record<string, string>)[k] = v.trim().slice(0, 200)
  return out
}
