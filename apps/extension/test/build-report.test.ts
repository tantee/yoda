import { describe, expect, it } from 'vitest'
import { buildReport, type ReportForm } from '../src/report/build-report'
import type { Draft } from '../src/drafts/db'

const png = new Blob([new Uint8Array(1234)], { type: 'image/png' })
const webm = new Blob([new Uint8Array([0x1a, 0x45, 0xdf, 0xa3, 0, 0])], { type: 'video/webm' })
const draft = (o: Partial<Draft> = {}): Draft => ({
  id: 'd1',
  createdAt: 0,
  profileId: 'p1',
  tabId: 1,
  tabUrl: 'https://app.example.org/opd?visit=12#/q',
  metadata: {
    page: { url: 'https://app.example.org/opd?visit=12#/q', title: 'OPD', route: '/opd' },
    buildSources: { meta: 'repo=demo/app;commit=abc1234', wellKnown: null, headers: [] },
    client: { browser: 'Chrome', browserVersion: '131', os: 'Windows', osVersion: '11', viewport: { w: 1280, h: 720, dpr: 1 }, zoom: 1, locale: 'th-TH', timeZone: 'Asia/Bangkok' },
  },
  console: [{ t: 1, level: 'error', message: 'boom' }],
  network: [{ t: 2, method: 'GET', url: 'https://api.example.org/x', status: 500, durationMs: 3, failed: true, kind: 'fetch', yodaBuild: 'repo=his/api;commit=e4f5' }],
  images: [{ role: 'screenshot', blob: png }],
  video: webm,
  idempotencyKey: '00000000-0000-4000-8000-0000000000aa',
  ...o,
})
const form = (o: Partial<ReportForm> = {}): ReportForm => ({
  projectId: '00000000-0000-4000-8000-000000000001',
  kind: 'defect',
  title: 'ปุ่มบันทึกไม่ทำงาน',
  severity: 'major',
  description: 'กดแล้วไม่มีอะไรเกิดขึ้น',
  steps: ['เปิดหน้า OPD', '', 'กดบันทึก'],
  expected: 'บันทึกสำเร็จ',
  actual: 'ไม่มีอะไรเกิดขึ้น',
  includeQuery: true,
  attach: { screenshot: true, video: true, buffer: true, console: true, network: true },
  confirmedNoPatientData: true,
  textMayContainPatientData: false,
  build: null,
  ...o,
})
const ctx = (o: Record<string, unknown> = {}) => ({ production: false, extensionVersion: '1.2.0', images: [{ role: 'screenshot' as const, blob: png }], ...o })

describe('buildReport', () => {
  it('sets confirmedNoPatientData only when ticked (otherwise throws), and declares each file type and exact size', () => {
    expect(() => buildReport(draft(), form({ confirmedNoPatientData: false }), ctx())).toThrow()
    const { report, files } = buildReport(draft(), form(), ctx())
    expect(report.privacy).toEqual({ confirmedNoPatientData: true, productionSite: false, textMayContainPatientData: false })
    expect(report.attachments).toEqual([
      { part: 'file1', role: 'screenshot', name: 'screenshot.png', type: 'image/png', sizeBytes: 1234 },
      { part: 'file2', role: 'video', name: 'video.webm', type: 'video/webm', sizeBytes: 6 },
      { part: 'file3', role: 'console', name: 'console.json', type: 'application/json', sizeBytes: files[2]!.data.size },
      { part: 'file4', role: 'network', name: 'network.json', type: 'application/json', sizeBytes: files[3]!.data.size },
    ])
    expect(files.map((f) => f.part)).toEqual(['file1', 'file2', 'file3', 'file4'])
    expect(report.steps).toEqual(['เปิดหน้า OPD', 'กดบันทึก'])
    expect(report.build).toEqual({ repo: 'demo/app', commit: 'abc1234', source: 'meta' })
    expect(report.backendBuilds).toEqual([{ origin: 'https://api.example.org', repo: 'his/api', commit: 'e4f5' }])
    expect(report.client.extensionVersion).toBe('1.2.0')
  })

  it('on production, video and buffer are never included and logs only when turned on', () => {
    const off = buildReport(draft({ buffer: [webm] }), form({ attach: { screenshot: true, video: true, buffer: true, console: false, network: false } }), ctx({ production: true }))
    expect(off.report.attachments.map((a) => a.role)).toEqual(['screenshot'])
    expect(off.report.privacy.productionSite).toBe(true)
    const on = buildReport(draft(), form(), ctx({ production: true }))
    expect(on.report.attachments.map((a) => a.role)).toEqual(['screenshot', 'console', 'network'])
  })

  it('includeQuery=false strips the query and keeps the hash', () => {
    const { report } = buildReport(draft(), form({ includeQuery: false }), ctx())
    expect(report.page.url).toBe('https://app.example.org/opd#/q')
  })

  it('includeQuery=false also strips queries from the network and console logs', async () => {
    const d = draft({
      console: [{ t: 1, level: 'error', message: 'GET https://api.example.org/p?hn=123456 failed; see https://app.example.org/x?id=9#top', source: 'https://app.example.org/a.js?v=1:10' }],
      network: [{ t: 2, method: 'GET', url: 'https://api.example.org/p?hn=123456', status: 500, durationMs: 3, failed: true, kind: 'fetch' }],
    })
    const read = async (files: { name: string; data: Blob }[], name: string) => JSON.parse(await files.find((f) => f.name === name)!.data.text())
    const off = buildReport(d, form({ includeQuery: false }), ctx()).files
    expect((await read(off, 'network.json'))[0].url).toBe('https://api.example.org/p')
    const c = (await read(off, 'console.json'))[0]
    expect(c.message).toBe('GET https://api.example.org/p failed; see https://app.example.org/x#top')
    expect(c.message).not.toContain('123456')
    expect(c.source).toBe('https://app.example.org/a.js:10')
    const on = buildReport(d, form({ includeQuery: true }), ctx()).files
    expect((await read(on, 'network.json'))[0].url).toContain('hn=123456')
  })

  it('unticked files are omitted', () => {
    const { report } = buildReport(draft(), form({ attach: { screenshot: false, video: false, buffer: false, console: true, network: false } }), ctx())
    expect(report.attachments.map((a) => a.role)).toEqual(['console'])
  })

  it('a build the tester edited wins, as manual', () => {
    const { report } = buildReport(draft(), form({ build: { commit: 'fff0000', branch: 'main' } }), ctx())
    expect(report.build).toEqual({ commit: 'fff0000', branch: 'main', source: 'manual' })
  })
})
