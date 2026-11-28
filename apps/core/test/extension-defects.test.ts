import { randomUUID } from 'node:crypto'
import { Readable } from 'node:stream'
import type { DefectAttachmentDecl, DefectReportCreate, DefectReportCreated, ExtensionTokenResponse } from '@yoda/shared'
import { eq } from 'drizzle-orm'
import type { FastifyInstance } from 'fastify'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { attachments, defectReports, workItems } from '../src/db/schema.js'
import { isWebm } from '../src/defects/upload.js'
import { DailyBytes } from '../src/extension/limits.js'
import { createMemoryStorage } from '../src/storage/memory.js'
import type { Storage } from '../src/storage/s3.js'
import { connectExtension, defectBody, json, makeProject, png, sampleReport, webm } from './defect-fixtures.js'
import { resetDb, testDb } from './helpers.js'
import { auth, login, makeApp, type Who } from './support.js'

let app: FastifyInstance
let storage: Storage & { keys: () => string[]; puts: () => number; failOnPut?: number }
let admin: Who
let qc: Who
let projectId: string
let tokens: ExtensionTokenResponse

/** Memory storage that lists its keys and can fail the n-th put. */
function spyStorage(): typeof storage {
  const inner = createMemoryStorage()
  const keys = new Set<string>()
  let puts = 0
  const s: typeof storage = {
    ...inner,
    keys: () => [...keys].sort(),
    puts: () => puts,
    async put(key, body, type) {
      puts += 1
      if (s.failOnPut && puts === s.failOnPut) throw new Error('storage down')
      keys.add(key)
      return inner.put(key, body, type)
    },
    async remove(key) {
      keys.delete(key)
      return inner.remove(key)
    },
  }
  return s
}

beforeEach(async () => {
  await resetDb(await testDb())
  storage = spyStorage()
  app = await makeApp({ storage })
  admin = await login(app, 'boss')
  qc = await login(app, 'qc', { staff: true, name: 'คุณคิวซี' })
  projectId = await makeProject(app, admin, 'OPD', [[qc, ['QC']]])
  tokens = await connectExtension(app, qc)
})
afterEach(async () => {
  await app.close()
})

type File = { part: string; name: string; type: string; data: Blob }
const decl = (f: File, role: DefectAttachmentDecl['role'], sizeBytes = f.data.size): DefectAttachmentDecl => ({ part: f.part, role, name: f.name, type: f.type, sizeBytes })

const shot: File = { part: 'file1', name: 'screenshot.png', type: 'image/png', data: png(1000) }
const clip: File = { part: 'file2', name: 'clip.webm', type: 'video/webm', data: webm(5000) }
const con: File = { part: 'file3', name: 'console.json', type: 'application/json', data: json([{ t: 1, level: 'error', message: '<script>x</script>' }]) }
const net: File = { part: 'file4', name: 'network.json', type: 'application/json', data: json([]) }
const four = (): [File, DefectAttachmentDecl['role']][] => [
  [shot, 'screenshot'],
  [clip, 'video'],
  [con, 'console'],
  [net, 'network'],
]

function reportWith(files: [File, DefectAttachmentDecl['role'], number?][], o: Partial<DefectReportCreate> = {}): DefectReportCreate {
  return sampleReport(projectId, { attachments: files.map(([f, role, size]) => decl(f, role, size)), ...o })
}

async function post(report: DefectReportCreate, files: File[], o: { key?: string; token?: ExtensionTokenResponse } = {}) {
  const body = await defectBody(report, files)
  return app.inject({
    method: 'POST',
    url: '/extension/defects',
    headers: { ...body.headers, authorization: `Bearer ${(o.token ?? tokens).accessToken}`, 'idempotency-key': o.key ?? randomUUID() },
    payload: body.payload,
  })
}

/**
 * Posts with everything after the report part held back until the reply arrives: a server that read on before
 * refusing would never answer (the test would time out).
 */
async function held(report: DefectReportCreate, files: File[]) {
  const { payload, headers } = await defectBody(report, files)
  const cut = payload.indexOf(Buffer.from(`name="${files[0]!.part}"`))
  expect(cut).toBeGreaterThan(0)
  let release: () => void = () => {}
  const gate = new Promise<void>((r) => (release = r))
  let sent = false
  const stream = new Readable({
    read() {
      if (sent) return
      sent = true
      this.push(payload.subarray(0, cut))
      void gate.then(() => {
        this.push(payload.subarray(cut))
        this.push(null)
      })
    },
  })
  try {
    return await app.inject({
      method: 'POST',
      url: '/extension/defects',
      headers: { ...headers, authorization: `Bearer ${tokens.accessToken}`, 'idempotency-key': randomUUID() },
      payload: stream,
    })
  } finally {
    release()
  }
}

describe('happy path and idempotency', () => {
  it('a report with a PNG, a WebM and two JSON logs creates one item and four noAi attachments', async () => {
    const res = await post(reportWith(four()), four().map(([f]) => f))
    expect(res.statusCode, res.body).toBe(201)
    const body = res.json() as DefectReportCreated
    expect(body).toMatchObject({ title: 'ปุ่มบันทึกไม่ทำงาน', stepKey: 'triage', state: 'active', aiAllowed: true })
    expect(body.url).toBe(`http://localhost:3000/work-items/${body.workItemId}`)
    expect(body.attachments.map((a) => [a.role, a.noAi, a.sizeBytes]).sort()).toEqual(
      [['screenshot', true, 1000], ['video', true, 5000], ['console', true, con.data.size], ['network', true, net.data.size]].sort(),
    )
    const rows = await (await testDb()).select().from(attachments).where(eq(attachments.workItemId, body.workItemId))
    expect(rows).toHaveLength(4)
    for (const r of rows) expect(r.storageKey.startsWith(`projects/${projectId}/defects/`)).toBe(true)
    expect(storage.keys()).toHaveLength(4)
  })

  it('the same Idempotency-Key afterwards returns 200 and the same body, and stores nothing new', async () => {
    const key = randomUUID()
    const first = await post(reportWith(four()), four().map(([f]) => f), { key })
    expect(first.statusCode).toBe(201)
    const again = await post(reportWith(four()), four().map(([f]) => f), { key })
    expect(again.statusCode, again.body).toBe(200)
    expect(again.json()).toEqual(first.json())
    expect(storage.keys()).toHaveLength(4)
    expect(await (await testDb()).select().from(workItems)).toHaveLength(1)
  })

  it("two concurrent posts from one grant with one key: the second waits and gets the winner's body; one item; no 429", async () => {
    const key = randomUUID()
    const [a, b] = await Promise.all([
      post(reportWith(four()), four().map(([f]) => f), { key }),
      post(reportWith(four()), four().map(([f]) => f), { key }),
    ])
    expect([a.statusCode, b.statusCode].sort()).toEqual([200, 201])
    expect(a.json()).toEqual(b.json())
    expect(await (await testDb()).select().from(workItems)).toHaveLength(1)
    expect(storage.keys()).toHaveLength(4)
    // The second waited: only one upload's files were ever put.
    expect(storage.puts()).toBe(4)
  })

  it('the same key from two grants of one person: one item, the loser removes its objects and gets the winner', async () => {
    const second = await connectExtension(app, qc)
    const key = randomUUID()
    const [a, b] = await Promise.all([
      post(reportWith(four()), four().map(([f]) => f), { key }),
      post(reportWith(four()), four().map(([f]) => f), { key, token: second }),
    ])
    expect([a.statusCode, b.statusCode].sort()).toEqual([200, 201])
    expect(a.json()).toEqual(b.json())
    expect(await (await testDb()).select().from(workItems)).toHaveLength(1)
    expect(storage.keys()).toHaveLength(4)
  })

  it('a failure after the commit keeps the report and its files, and a retry gets the same body', async () => {
    const publish = app.deps.bus.publish.bind(app.deps.bus)
    let failing = true
    app.deps.bus.publish = (e) => {
      if (failing) {
        failing = false
        throw new Error('bus down')
      }
      publish(e)
    }
    const key = randomUUID()
    const first = await post(reportWith(four()), four().map(([f]) => f), { key })
    expect(first.statusCode, first.body).toBe(201)
    expect(storage.keys()).toHaveLength(4)
    const rows = await (await testDb()).select().from(attachments)
    expect(rows.map((r) => r.storageKey).sort()).toEqual(storage.keys())
    const again = await post(reportWith(four()), four().map(([f]) => f), { key })
    expect(again.statusCode).toBe(200)
    expect(again.json()).toEqual(first.json())
  })

  it('two concurrent posts from one grant with different keys: the second gets 429', async () => {
    const [a, b] = await Promise.all([post(reportWith(four()), four().map(([f]) => f)), post(reportWith(four()), four().map(([f]) => f))])
    expect([a.statusCode, b.statusCode].sort()).toEqual([201, 429])
    expect([a, b].find((r) => r.statusCode === 429)!.json()).toEqual({ error: 'rate_limited', retryAfter: 5 })
  })

  it('a missing or malformed Idempotency-Key is 400', async () => {
    const body = await defectBody(reportWith([]), [])
    for (const key of [undefined, 'not-a-uuid']) {
      const res = await app.inject({
        method: 'POST',
        url: '/extension/defects',
        headers: { ...body.headers, authorization: `Bearer ${tokens.accessToken}`, ...(key ? { 'idempotency-key': key } : {}) },
        payload: body.payload,
      })
      expect(res.statusCode).toBe(400)
      expect(res.json().error).toBe('validation')
    }
  })
})

describe('early rejection', () => {
  it('a report part that is not first is 400', async () => {
    const fd = new FormData()
    fd.append('file1', shot.data, shot.name)
    fd.append('report', JSON.stringify(reportWith([[shot, 'screenshot']])))
    const res = new Response(fd)
    const r = await app.inject({
      method: 'POST',
      url: '/extension/defects',
      headers: { 'content-type': res.headers.get('content-type')!, authorization: `Bearer ${tokens.accessToken}`, 'idempotency-key': randomUUID() },
      payload: Buffer.from(await res.arrayBuffer()),
    })
    expect(r.statusCode).toBe(400)
    expect(r.json().error).toBe('validation')
  })

  it('an invalid report is rejected before any file part is read', async () => {
    const res = await held({ ...reportWith([[shot, 'screenshot']]), title: '' } as DefectReportCreate, [shot])
    expect(res.statusCode).toBe(400)
    expect(res.json().error).toBe('validation')
    expect(res.headers.connection).toBe('close')
  })

  it('a declared 26 MB video is 413 role:video, read before the bytes', async () => {
    const res = await held(reportWith([[clip, 'video', 26 * 1024 * 1024]]), [clip])
    expect(res.statusCode).toBe(413)
    expect(res.json()).toEqual({ error: 'too_large', reason: 'role:video' })
    expect(res.headers.connection).toBe('close')
  })

  it('a file longer than declared is refused without reading it all', async () => {
    const big = { ...con, data: new Blob([new Uint8Array(2 * 1024 * 1024).fill(32)], { type: 'application/json' }) }
    const res = await post(reportWith([[big, 'console', 10]]), [big])
    expect(res.statusCode).toBe(400)
    expect(storage.keys()).toEqual([])
  })

  it('a declared total over 50 MiB is 413 total', async () => {
    const big = 10 * 1024 * 1024
    const files = [1, 2, 3, 4, 5, 6].map((i) => ({ ...shot, part: `file${i}`, name: `s${i}.png` }))
    const res = await post(reportWith(files.map((f) => [f, 'screenshot', big])), files)
    expect(res.statusCode).toBe(413)
    expect(res.json()).toEqual({ error: 'too_large', reason: 'total' })
  })

  it('a declared type not allowed for its role is 415', async () => {
    const res = await held(reportWith([[{ ...shot, type: 'image/gif' }, 'screenshot']]), [shot])
    expect(res.statusCode).toBe(415)
    expect(res.json().error).toBe('unsupported_type')
  })

  it('a ninth file is 413 files, and so is a 65 KiB report field', async () => {
    const eight = [1, 2, 3, 4, 5, 6, 7, 8].map((i) => ({ ...shot, part: `file${i}`, name: `s${i}.png`, data: png(10) }))
    const ninth = { ...shot, part: 'file9', name: 's9.png', data: png(10) }
    const res = await post(reportWith(eight.map((f) => [f, 'screenshot'])), [...eight, ninth])
    expect(res.statusCode).toBe(413)
    expect(res.json()).toEqual({ error: 'too_large', reason: 'files' })

    const long = reportWith([], { description: 'ก'.repeat(10000), steps: Array.from({ length: 30 }, () => 'ข'.repeat(500)), expected: 'ค'.repeat(2000), actual: 'ง'.repeat(2000) })
    expect(Buffer.byteLength(JSON.stringify(long))).toBeGreaterThan(65 * 1024)
    const res2 = await post(long, [])
    expect(res2.statusCode).toBe(413)
    expect(res2.json()).toEqual({ error: 'too_large', reason: 'report_size' })
  })

  it('a file whose length differs from its declaration is 400', async () => {
    const res = await post(reportWith([[shot, 'screenshot', 999]]), [shot])
    expect(res.statusCode).toBe(400)
    expect(res.json().error).toBe('validation')
    expect(storage.keys()).toEqual([])
  })

  it('an undeclared part, or a declared part that never arrives, is 400', async () => {
    const extra = await post(reportWith([[shot, 'screenshot']]), [shot, { ...con, part: 'file2' }])
    expect(extra.statusCode).toBe(400)
    const missing = await post(reportWith([[shot, 'screenshot'], [con, 'console']]), [shot])
    expect(missing.statusCode).toBe(400)
    expect(storage.keys()).toEqual([])
    expect(await (await testDb()).select().from(workItems)).toEqual([])
  })

  it('a fake .webm without EBML magic is 415', async () => {
    const fake = { ...clip, data: new Blob([new Uint8Array(100).fill(7)], { type: 'video/webm' }) }
    const res = await post(reportWith([[fake, 'video']]), [fake])
    expect(res.statusCode).toBe(415)
    expect(storage.keys()).toEqual([])
  })

  it('isWebm', () => {
    expect(isWebm(Buffer.from([0x1a, 0x45, 0xdf, 0xa3, 0]))).toBe(true)
    expect(isWebm(Buffer.from([0x1a, 0x45, 0xdf]))).toBe(false)
    expect(isWebm(Buffer.from('RIFF'))).toBe(false)
  })
})

describe('access and rules', () => {
  it('video on a production site is 422 video_on_production; a screenshot there is fine', async () => {
    const privacy = { confirmedNoPatientData: true as const, productionSite: true, textMayContainPatientData: false }
    const res = await held(reportWith([[clip, 'video']], { privacy }), [clip])
    expect(res.statusCode).toBe(422)
    expect(res.json()).toEqual({ error: 'invalid_state', reason: 'video_on_production' })
    const ok = await post(reportWith([[shot, 'screenshot']], { privacy }), [shot])
    expect(ok.statusCode).toBe(201)
  })

  it('a non-member gets 404; a revoked grant 401', async () => {
    const other = await makeProject(app, admin, 'Other', [])
    const res = await post(sampleReport(other), [])
    expect(res.statusCode).toBe(404)
    await app.inject({ method: 'POST', url: '/extension/revoke', headers: { authorization: `Bearer ${tokens.accessToken}` } })
    const revoked = await post(reportWith([]), [])
    expect(revoked.statusCode).toBe(401)
  })

  it('a Keycloak token is 401', async () => {
    const body = await defectBody(reportWith([]), [])
    const res = await app.inject({ method: 'POST', url: '/extension/defects', headers: { ...body.headers, ...auth(qc), 'idempotency-key': randomUUID() }, payload: body.payload })
    expect(res.statusCode).toBe(401)
  })

  it('the 21st report in an hour is 429 with retryAfter', async () => {
    for (let i = 0; i < 20; i++) expect((await post(reportWith([]), [])).statusCode).toBe(201)
    const res = await post(reportWith([]), [])
    expect(res.statusCode).toBe(429)
    expect(res.json().retryAfter).toBeGreaterThan(0)
  })

  it('a storage failure after two puts removes both objects and creates no item', async () => {
    storage.failOnPut = 3
    const res = await post(reportWith(four()), four().map(([f]) => f))
    expect(res.statusCode).toBe(500)
    expect(storage.keys()).toEqual([])
    const db = await testDb()
    expect(await db.select().from(workItems)).toEqual([])
    expect(await db.select().from(defectReports)).toEqual([])
  })
})

describe('DailyBytes', () => {
  it('refuses what does not fit in 24 hours, says when it will, and takes released bytes back', () => {
    let now = 0
    const d = new DailyBytes(100, () => now)
    const a = d.take('p', 60)
    expect(a.ok).toBe(true)
    now = 3_600_000
    expect(d.take('p', 30).ok).toBe(true)
    // 90 used: 20 more does not fit until the first 60 leave the window, 23 h from now.
    expect(d.take('p', 20)).toEqual({ ok: false, retryAfter: 23 * 3600 })
    expect(d.take('other', 100).ok).toBe(true)
    if (a.ok) a.release()
    expect(d.take('p', 20).ok).toBe(true)
  })
})
