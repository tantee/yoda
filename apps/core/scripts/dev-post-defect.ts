// DEV ONLY: posts one Yoda Reporter defect report to a local Yoda with an extension access token, the way the
// extension does (docs/development.md, "Yoda Reporter by hand"). Never point it at a production install.
//
//   YODA_URL=http://localhost:3000 YODA_XT=yoda_xt_… PROJECT_ID=<uuid> pnpm --filter @yoda/core dev-post-defect
//   (SCREENSHOT=<a .png file> sends that image instead of a 1×1 pixel)
import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { DefectReportCreate, encodeDefectForm, type DefectReportCreated } from '@yoda/shared'

const base = (process.env.YODA_URL ?? 'http://localhost:3000').replace(/\/+$/, '')
const token = process.env.YODA_XT
const projectId = process.env.PROJECT_ID
if (!token || !projectId) {
  console.error('Set YODA_XT (an extension access token) and PROJECT_ID.')
  process.exit(2)
}

// A 1×1 PNG and a short console log stand in for the capture.
const png = Uint8Array.from(
  process.env.SCREENSHOT
    ? readFileSync(process.env.SCREENSHOT)
    : Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64'),
)
const log = new TextEncoder().encode(JSON.stringify([{ t: Date.now(), level: 'error', message: 'TypeError: cannot read properties of undefined (reading "save")' }]))

const report = DefectReportCreate.parse({
  projectId,
  kind: 'defect',
  title: 'ปุ่มบันทึกไม่ทำงาน (ทดสอบ)',
  severity: 'major',
  description: 'กดบันทึกแล้วไม่มีอะไรเกิดขึ้น',
  steps: ['เปิดหน้า OPD', 'กรอกข้อมูลทดสอบ', 'กดบันทึก'],
  expected: 'บันทึกสำเร็จ',
  actual: 'ไม่มีอะไรเกิดขึ้น และ console มี error',
  page: { url: 'https://app.example.org/opd?visit=12', title: 'OPD', route: '/opd' },
  build: { repo: 'his/opd-web', branch: 'main', commit: 'a1b2c3d', env: 'review', source: 'manual' },
  backendBuilds: [],
  client: {
    browser: 'Chrome',
    browserVersion: '131',
    os: 'macOS',
    osVersion: '15',
    viewport: { w: 1440, h: 900, dpr: 2 },
    zoom: 1,
    locale: 'th-TH',
    timeZone: 'Asia/Bangkok',
    extensionVersion: 'dev',
  },
  capturedAt: new Date().toISOString(),
  attachments: [
    { part: 'file1', role: 'screenshot', name: 'screenshot.png', type: 'image/png', sizeBytes: png.byteLength },
    { part: 'file2', role: 'console', name: 'console.json', type: 'application/json', sizeBytes: log.byteLength },
  ],
  privacy: { confirmedNoPatientData: true, productionSite: false, textMayContainPatientData: false },
})

const body = encodeDefectForm(report, [
  { part: 'file1', name: 'screenshot.png', type: 'image/png', data: new Blob([png], { type: 'image/png' }) },
  { part: 'file2', name: 'console.json', type: 'application/json', data: new Blob([log], { type: 'application/json' }) },
])
const res = await fetch(`${base}/api/extension/defects`, {
  method: 'POST',
  headers: { authorization: `Bearer ${token}`, 'idempotency-key': randomUUID() },
  body,
})
const text = await res.text()
if (!res.ok) {
  console.error(`${res.status} ${text}`)
  process.exit(1)
}
const created = JSON.parse(text) as DefectReportCreated
console.log(`${res.status} ${created.url}`)
