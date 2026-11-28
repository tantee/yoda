import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import {
  Attachment,
  AttachmentRole,
  CAPTURE_CAPS,
  ConsoleEntry,
  DEFECT_LIMITS,
  DEFECT_SENSITIVE_TITLE,
  DEFECT_TYPES,
  DEFECT_WITHHELD_DESCRIPTION,
  DefectReportCreate,
  EXTENSION_API_VERSION,
  EXTENSION_ONLY_TEMPLATES,
  EXTENSION_TOKEN,
  ExtensionAuthorize,
  ExtensionSession,
  ExtensionTokenRequest,
  NetworkEntry,
  OFFICIAL_EXTENSION_ID,
  chromiumappRedirect,
  encodeDefectForm,
  extensionIdFromPublicKey,
  extensionTokenRe,
  isExtensionId,
  isReleaseVersion,
  manifestVersion,
  severityPriority,
} from '../src/index.js'

// A throwaway RSA key made for this test only (its private half was deleted at once). The ID was computed outside
// this code: `openssl dgst -sha256 -binary pub.der | xxd -p | cut -c1-32 | tr 0-9a-f a-p`.
const TEST_SPKI_B64 =
  'MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEAtPB7g61pffuWGQ8BxL+AyEX/KNYWKe2981BwNNy2f423DReMfxK9kiefX9hYMt/klvF3ClF5VynbubA7RLcihCFz7oJfvEEgZAPWMFzfge9HIbOl2c/1e0n0P4KZv9j3dOa/eRW31/r9lHoz1Amz6GA4h7t7btB2tc7o4IqEjznFLjhftsw3PH38KrLTwbD61hGo05P0X7AnHLrhPzKJxDg4z7I+HVEUGsP2EoT5Rf9ChKDRRlmHvmE4RyKhd+TOQSa5JAl8kIjMgQlqZ4yed0P7BU0T1D7MmmCLS6xS3Ux8UD68zDtOgHtuKobtRMLpXbSPh4urPgmulnKA+9hOWwIDAQAB'
const TEST_ID = 'mmcaeimamhfdkmmkfpgfijlhiepcjoje'

/** The proposal's §10.1 report, D2 applied (no `masked`). */
function sampleReport(o: Record<string, unknown> = {}) {
  return {
    projectId: '00000000-0000-4000-8000-000000000001',
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
    attachments: [
      { part: 'file1', role: 'screenshot', name: 'screenshot.png', type: 'image/png', sizeBytes: 1000 },
      { part: 'file2', role: 'console', name: 'console.json', type: 'application/json', sizeBytes: 200 },
    ],
    privacy: { confirmedNoPatientData: true, productionSite: false, textMayContainPatientData: false },
    ...o,
  }
}

describe('versions (decision 7)', () => {
  it('maps a final release above its release candidates', () => {
    expect(manifestVersion('1.2.0')).toEqual({ version: '1.2.0.1000', versionName: '1.2.0' })
    expect(manifestVersion('1.2.0-rc.3')).toEqual({ version: '1.2.0.3', versionName: '1.2.0-rc.3' })
    expect(manifestVersion('1.2.0-rc.999')).toEqual({ version: '1.2.0.999', versionName: '1.2.0-rc.999' })
  })
  it('refuses any other form', () => {
    for (const v of ['1.2', '1.2.0-rc', '1.2.0-rc.0', '1.2.0-rc.1000', '1.2.0-beta.1', '01.2.0', 'v1.2.0', '1.2.0.4']) {
      expect(() => manifestVersion(v), v).toThrow()
      expect(isReleaseVersion(v), v).toBe(false)
    }
    expect(isReleaseVersion('1.2.0')).toBe(true)
    expect(isReleaseVersion('1.2.0-rc.1')).toBe(true)
  })
})

describe('extension IDs', () => {
  it('derives the Chrome ID from the public key', async () => {
    const der = Uint8Array.from(atob(TEST_SPKI_B64), (c) => c.charCodeAt(0))
    expect(await extensionIdFromPublicKey(der)).toBe(TEST_ID)
  })
  it('knows the ID shape and the redirect URI', () => {
    expect(isExtensionId(TEST_ID)).toBe(true)
    expect(isExtensionId('a'.repeat(31))).toBe(false)
    expect(isExtensionId('q'.repeat(32))).toBe(false)
    expect(isExtensionId('A'.repeat(32))).toBe(false)
    expect(chromiumappRedirect(TEST_ID)).toBe(`https://${TEST_ID}.chromiumapp.org/`)
    expect(OFFICIAL_EXTENSION_ID === null || isExtensionId(OFFICIAL_EXTENSION_ID)).toBe(true)
  })

  it('derives the official ID from the committed public key (keys/yoda-reporter.pub)', async () => {
    const b64 = readFileSync(new URL('../../../keys/yoda-reporter.pub', import.meta.url), 'utf8').trim()
    expect(b64).toMatch(/^MIIBIjAN[A-Za-z0-9+/]+=*$/) // 2048-bit RSA SPKI, public half only
    expect(await extensionIdFromPublicKey(Buffer.from(b64, 'base64'))).toBe(OFFICIAL_EXTENSION_ID)
    expect(OFFICIAL_EXTENSION_ID).toBe('hcnhkfonaflhcknbhcphbfgpdfmgmibm')
  })
})

describe('tokens', () => {
  it('matches a prefix plus 43 base64url characters', () => {
    expect(EXTENSION_TOKEN).toEqual({ code: 'yoda_xc_', access: 'yoda_xt_', refresh: 'yoda_xr_' })
    const body = 'A'.repeat(42) + '_'
    expect(extensionTokenRe('access').test(`yoda_xt_${body}`)).toBe(true)
    expect(extensionTokenRe('access').test(`yoda_xr_${body}`)).toBe(false)
    expect(extensionTokenRe('refresh').test(`yoda_xr_${body}x`)).toBe(false)
    expect(extensionTokenRe('code').test(`yoda_xc_${'A'.repeat(42)}+`)).toBe(false)
    expect(EXTENSION_API_VERSION).toBe(1)
  })
})

describe('defects', () => {
  it('maps every severity to a priority', () => {
    expect(severityPriority('blocker')).toBe('urgent')
    expect(severityPriority('critical')).toBe('urgent')
    expect(severityPriority('major')).toBe('high')
    expect(severityPriority('minor')).toBe('normal')
    expect(severityPriority('trivial')).toBe('low')
  })

  it('keeps the limits, types and the extension-only template', () => {
    expect(DEFECT_LIMITS.maxFiles).toBe(8)
    expect(DEFECT_LIMITS.maxReportBytes).toBe(50 * 1024 * 1024)
    expect(DEFECT_LIMITS.perRole.video).toBe(25 * 1024 * 1024)
    expect(DEFECT_TYPES.video).toEqual(['video/webm'])
    expect(DEFECT_TYPES.console).toEqual(['application/json'])
    expect(DEFECT_TYPES.screenshot).toEqual(['image/png', 'image/jpeg', 'image/webp'])
    expect(EXTENSION_ONLY_TEMPLATES).toEqual(['defect'])
    expect(Attachment.shape.role.removeDefault().unwrap().options).toEqual(AttachmentRole.options)
    expect(DEFECT_SENSITIVE_TITLE.en).toBe('Defect report (sensitive)')
    expect(DEFECT_WITHHELD_DESCRIPTION.th).toBe('[รายงานข้อบกพร่อง: ข้อความเก็บแยก ไม่ส่งให้ AI]')
  })

  it('accepts the §10.1 report without masked', () => {
    const r = DefectReportCreate.parse(sampleReport())
    expect(r.page.url).toBe('https://app.example.org/opd?visit=12')
    expect(r.attachments[0]).toEqual({ part: 'file1', role: 'screenshot', name: 'screenshot.png', type: 'image/png', sizeBytes: 1000 })
    expect(DefectReportCreate.parse(sampleReport({ description: undefined })).description).toBe('')
  })

  it('refuses a report without the confirmation, too many steps or files, or a long title', () => {
    const bad = (o: Record<string, unknown>) => DefectReportCreate.safeParse(sampleReport(o)).success
    expect(bad({ privacy: { confirmedNoPatientData: false, productionSite: false, textMayContainPatientData: false } })).toBe(false)
    expect(bad({ steps: Array.from({ length: 31 }, (_, i) => `step ${i}`) })).toBe(false)
    expect(bad({ steps: Array.from({ length: 30 }, (_, i) => `step ${i}`) })).toBe(true)
    const att = (i: number) => ({ part: `file${i}`, role: 'console', name: `c${i}.json`, type: 'application/json', sizeBytes: 1 })
    expect(bad({ attachments: Array.from({ length: 9 }, (_, i) => att(i + 1)) })).toBe(false)
    expect(bad({ attachments: Array.from({ length: 8 }, (_, i) => att(i + 1)) })).toBe(true)
    expect(bad({ title: 'x'.repeat(201) })).toBe(false)
    expect(bad({ title: 'x'.repeat(200) })).toBe(true)
    expect(bad({ title: '   ' })).toBe(false)
  })

  it('encodes the report part first, then the files in order', async () => {
    const report = DefectReportCreate.parse(sampleReport())
    const fd = encodeDefectForm(report, [
      { part: 'file1', name: 'screenshot.png', type: 'image/png', data: new Blob([new Uint8Array(1000)], { type: 'image/png' }) },
      { part: 'file2', name: 'console.json', type: 'application/json', data: new Blob(['[]'], { type: 'application/json' }) },
    ])
    const res = new Response(fd)
    const text = await res.text()
    const names = [...text.matchAll(/; name="([^"]+)"/g)].map((m) => m[1])
    expect(names).toEqual(['report', 'file1', 'file2'])
    expect(text).toContain('filename="screenshot.png"')
    const back = await new Response(text, { headers: { 'content-type': res.headers.get('content-type')! } }).formData()
    expect(JSON.parse(back.get('report') as string)).toEqual(report)
  })
})

describe('capture entries', () => {
  it('caps a console message at 2048 characters', () => {
    expect(ConsoleEntry.safeParse({ t: 1, level: 'error', message: 'x'.repeat(2049) }).success).toBe(false)
    expect(ConsoleEntry.safeParse({ t: 1, level: 'error', message: 'x'.repeat(2048) }).success).toBe(true)
    expect(ConsoleEntry.safeParse({ t: 1, level: 'trace', message: 'x' }).success).toBe(false)
    expect(CAPTURE_CAPS).toEqual({ entries: 500, message: 2048, backendBuilds: 10 })
  })
  it('keeps network entries without headers or bodies', () => {
    const e = NetworkEntry.parse({ t: 1, method: 'GET', url: 'https://api.example.org/x', status: 500, durationMs: 12, failed: true, kind: 'fetch', body: 'secret' })
    expect(e).not.toHaveProperty('body')
    expect(NetworkEntry.safeParse({ t: 1, method: 'GET', url: 'x'.repeat(2049), status: null, durationMs: 1, failed: true, kind: 'xhr' }).success).toBe(false)
  })
})

describe('connect shapes', () => {
  it('authorize takes an S256 challenge and a short browser label', () => {
    const ok = {
      extensionId: TEST_ID,
      redirectUri: chromiumappRedirect(TEST_ID),
      codeChallenge: 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM',
      codeChallengeMethod: 'S256',
      state: 'abc',
      browserLabel: 'Chrome 131 Windows',
    }
    expect(ExtensionAuthorize.safeParse(ok).success).toBe(true)
    expect(ExtensionAuthorize.safeParse({ ...ok, codeChallengeMethod: 'plain' }).success).toBe(false)
    expect(ExtensionAuthorize.safeParse({ ...ok, browserLabel: 'x'.repeat(121) }).success).toBe(false)
  })
  it('token requests are a code exchange or a refresh', () => {
    expect(ExtensionTokenRequest.safeParse({ grantType: 'refresh_token', refreshToken: 'yoda_xr_x' }).success).toBe(true)
    expect(ExtensionTokenRequest.safeParse({ grantType: 'authorization_code', code: 'c', codeVerifier: 'v', extensionId: TEST_ID }).success).toBe(true)
    expect(ExtensionTokenRequest.safeParse({ grantType: 'password' }).success).toBe(false)
  })
  it('the session policy is fixed', () => {
    const s = ExtensionSession.safeParse({
      apiVersion: 1,
      instance: { name: { th: 'ยอดา', en: 'Yoda' }, publicUrl: 'https://yoda.example.org', version: '1.1.0' },
      latestExtension: null,
      person: { id: '00000000-0000-4000-8000-000000000002', displayName: 'A', isStaff: true },
      projects: [{ id: '00000000-0000-4000-8000-000000000001', name: 'P', noAi: false, kinds: ['defect'], repos: ['his/opd-web'] }],
      limits: { maxFileBytes: 1, maxReportBytes: 2, maxFiles: 8, maxVideoSeconds: 30, perRole: DEFECT_LIMITS.perRole, allowedTypes: DEFECT_TYPES },
      policy: { videoOnProduction: false, logsOnProductionDefault: false, requireConfirm: true },
    })
    expect(s.success).toBe(true)
  })
})
