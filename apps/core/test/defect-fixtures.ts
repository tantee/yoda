import { createHash } from 'node:crypto'
import { chromiumappRedirect, DefectReportCreate, encodeDefectForm, OFFICIAL_EXTENSION_ID, type ExtensionTokenResponse } from '@yoda/shared'
import type { FastifyInstance } from 'fastify'
import { expect } from 'vitest'
import { auth, type Who } from './support.js'

/** The proposal's §10.1 report (D2: nothing masked), parsed; `o` overrides top-level fields. */
export function sampleReport(projectId: string, o: Partial<DefectReportCreate> = {}): DefectReportCreate {
  return DefectReportCreate.parse({
    projectId,
    kind: 'defect',
    title: 'ปุ่มบันทึกไม่ทำงาน',
    severity: 'major',
    description: 'กดแล้วไม่มีอะไรเกิดขึ้น',
    steps: ['เปิดหน้า OPD', 'กดบันทึก'],
    expected: 'บันทึกสำเร็จ',
    actual: 'ไม่มีอะไรเกิดขึ้น',
    page: { url: 'https://app.example.org/opd?visit=12', title: 'OPD', route: '/opd' },
    build: { repo: 'his/opd-web', branch: 'main', commit: 'a1b2c3d', env: 'review', builtAt: '2026-11-27T10:00:00Z', source: 'meta' },
    backendBuilds: [{ origin: 'https://api.example.org', repo: 'his/opd-api', commit: 'e4f5a6b' }],
    client: {
      browser: 'Chrome',
      browserVersion: '131',
      os: 'Windows',
      osVersion: '11',
      viewport: { w: 1280, h: 720, dpr: 1 },
      zoom: 1,
      locale: 'th-TH',
      timeZone: 'Asia/Bangkok',
      extensionVersion: '1.1.0',
    },
    capturedAt: '2026-11-28T09:30:00+07:00',
    attachments: [],
    privacy: { confirmedNoPatientData: true, productionSite: false, textMayContainPatientData: false },
    ...o,
  })
}

/** A project made by `admin` with the given members and roles; returns its id. */
export async function makeProject(app: FastifyInstance, admin: Who, name: string, members: [Who, string[]][]): Promise<string> {
  const res = await app.inject({ method: 'POST', url: '/projects', headers: auth(admin), payload: { name } })
  expect(res.statusCode, res.body).toBe(201)
  const { id } = res.json() as { id: string }
  for (const [who, roles] of members) {
    const put = await app.inject({ method: 'PUT', url: `/projects/${id}/members/${who.id}`, headers: auth(admin), payload: { roles } })
    expect(put.statusCode, put.body).toBe(200)
  }
  return id
}

const VERIFIER = 'dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk'

/** Connects the official extension for `who` (authorize → token) and returns the token response. */
export async function connectExtension(app: FastifyInstance, who: Who, ip = '10.1.0.1'): Promise<ExtensionTokenResponse> {
  const ext = OFFICIAL_EXTENSION_ID!
  const challenge = createHash('sha256').update(VERIFIER).digest('base64url')
  const res = await app.inject({
    method: 'POST',
    url: '/extension/authorize',
    headers: auth(who),
    payload: { extensionId: ext, redirectUri: chromiumappRedirect(ext), codeChallenge: challenge, codeChallengeMethod: 'S256', state: 's', browserLabel: 'Chrome 131 Windows' },
  })
  expect(res.statusCode, res.body).toBe(200)
  const code = new URL(res.json().redirectTo).searchParams.get('code')!
  const tok = await app.inject({
    method: 'POST',
    url: '/extension/token',
    remoteAddress: ip,
    payload: { grantType: 'authorization_code', code, codeVerifier: VERIFIER, extensionId: ext },
  })
  expect(tok.statusCode, tok.body).toBe(200)
  return tok.json()
}

/** A multipart body built exactly as the extension builds it. */
export async function defectBody(
  report: DefectReportCreate,
  files: { part: string; name: string; type: string; data: Blob }[],
): Promise<{ payload: Buffer; headers: Record<string, string> }> {
  const res = new Response(encodeDefectForm(report, files))
  return { payload: Buffer.from(await res.arrayBuffer()), headers: { 'content-type': res.headers.get('content-type')! } }
}

/** EBML magic plus filler: enough for `isWebm`. */
export const webm = (n = 64) => new Blob([new Uint8Array([0x1a, 0x45, 0xdf, 0xa3, ...new Array(Math.max(0, n - 4)).fill(0)])], { type: 'video/webm' })
export const png = (n = 64) => new Blob([new Uint8Array([0x89, 0x50, 0x4e, 0x47, ...new Array(Math.max(0, n - 4)).fill(1)])], { type: 'image/png' })
export const json = (v: unknown) => new Blob([JSON.stringify(v)], { type: 'application/json' })
