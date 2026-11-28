import type { FastifyInstance } from 'fastify'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { Attachment } from '@yoda/shared'
import { eq } from 'drizzle-orm'
import { attachments, tasks } from '../src/db/schema.js'
import { buildApp } from '../src/app.js'
import type { AttachmentStoredHook } from '../src/attachments/service.js'
import type { Storage } from '../src/storage/s3.js'
import { resetDb, testDb, testDeps } from './helpers.js'
import { auth, login, type Who } from './support.js'

let app: FastifyInstance
let admin: Who
let pm: Who
let member: Who
let outsider: Who
let nurse: Who
let puts: string[]
let removed: string[]
/** Per-test upload hook; the app's hook delegates to it. */
let onStored: AttachmentStoredHook

const NO_ID = '00000000-0000-4000-8000-000000000000'

function multipart(
  file: { name: string; type: string; data: Buffer },
  fields: Record<string, string> = {},
): { payload: Buffer; headers: Record<string, string> } {
  const b = '----yodaTestBoundary'
  const parts: Buffer[] = []
  for (const [k, v] of Object.entries(fields)) {
    parts.push(Buffer.from(`--${b}\r\nContent-Disposition: form-data; name="${k}"\r\n\r\n${v}\r\n`))
  }
  parts.push(
    Buffer.from(
      `--${b}\r\nContent-Disposition: form-data; name="file"; filename="${file.name}"\r\nContent-Type: ${file.type}\r\n\r\n`,
    ),
    file.data,
    Buffer.from(`\r\n--${b}--\r\n`),
  )
  return { payload: Buffer.concat(parts), headers: { 'content-type': `multipart/form-data; boundary=${b}` } }
}

const upload = (who: Who, projectId: string, file: Parameters<typeof multipart>[0], fields?: Record<string, string>) => {
  const m = multipart(file, fields)
  return app.inject({
    method: 'POST',
    url: `/projects/${projectId}/attachments`,
    headers: { ...auth(who), ...m.headers },
    payload: m.payload,
  })
}

const call = (who: Who, method: 'GET' | 'PATCH', url: string, payload?: unknown) =>
  app.inject({ method, url, headers: auth(who), payload: payload as object | undefined })

async function newProject(): Promise<string> {
  const created = await app.inject({ method: 'POST', url: '/projects', headers: auth(admin), payload: { name: 'ระบบรายงานแล็บ' } })
  const { id } = created.json() as { id: string }
  for (const [who, roles] of [[pm, ['PM']], [member, ['DEV']]] as [Who, string[]][]) {
    const r = await app.inject({ method: 'PUT', url: `/projects/${id}/members/${who.id}`, headers: auth(admin), payload: { roles } })
    expect(r.statusCode).toBe(200)
  }
  return id
}

/** Minimal single-page PDF; `content` is the page content stream. */
function makePdf(content: string): Buffer {
  const objs = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 144] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>',
    `<< /Length ${content.length} >>\nstream\n${content}\nendstream`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ]
  let out = '%PDF-1.4\n'
  const offsets: number[] = []
  objs.forEach((o, i) => {
    offsets.push(out.length)
    out += `${i + 1} 0 obj\n${o}\nendobj\n`
  })
  const xref = out.length
  out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n`
  for (const o of offsets) out += `${String(o).padStart(10, '0')} 00000 n \n`
  out += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`
  return Buffer.from(out, 'latin1')
}

describe('attachments API', () => {
  beforeEach(async () => {
    await resetDb(await testDb())
    puts = []
    removed = []
    const deps = await testDeps()
    const real = deps.storage
    const spy: Storage = {
      put: async (k, b, t) => {
        puts.push(k)
        return real.put(k, b, t)
      },
      get: (k) => real.get(k),
      list: (p) => real.list(p),
      remove: async (k) => {
        removed.push(k)
        return real.remove(k)
      },
      ping: () => real.ping(),
    }
    app = await buildApp({ ...deps, config: { ...deps.config, bootstrapAdmins: ['boss'] }, storage: spy, onAttachmentStored: (r, t) => onStored(r, t) })
    admin = await login(app, 'boss')
    pm = await login(app, 'pm1', { staff: true })
    member = await login(app, 'dev1', { staff: true })
    outsider = await login(app, 'out1', { staff: true })
    nurse = await login(app, 'nurse1')
    onStored = async () => {}
  })
  afterEach(async () => {
    for (const k of puts) await app.deps.storage.remove(k).catch(() => {})
    await app.close()
  })

  it('uploads a Thai text file, extracts text, downloads identical bytes with a UTF-8 filename', async () => {
    const p = await newProject()
    const data = Buffer.from('ผลแล็บของผู้ป่วย: ปกติ\n', 'utf8')
    const res = await upload(member, p, { name: 'ผลแล็บ.txt', type: 'text/plain', data })
    expect(res.statusCode).toBe(201)
    const a = res.json() as Attachment
    expect(a).toMatchObject({ fileName: 'ผลแล็บ.txt', contentType: 'text/plain', hasText: true, noAi: false, projectId: p, uploadedById: member.id })
    expect(a.sizeBytes).toBe(data.length)
    expect(puts[0]).toMatch(new RegExp(`^projects/${p}/[0-9a-f-]{36}/ผลแล็บ\\.txt$`))

    const dl = await call(member, 'GET', `/attachments/${a.id}/download`)
    expect(dl.statusCode).toBe(200)
    expect(dl.rawPayload.equals(data)).toBe(true)
    expect(dl.headers['content-type']).toContain('text/plain')
    expect(dl.headers['x-content-type-options']).toBe('nosniff')
    expect(dl.headers['content-disposition']).toBe(`attachment; filename*=UTF-8''${encodeURIComponent('ผลแล็บ.txt')}`)

    const list = (await call(member, 'GET', `/projects/${p}/attachments`)).json() as Attachment[]
    expect(list.map((x) => x.id)).toEqual([a.id])
  })

  it('calls the onAttachmentStored hook with the row and text', async () => {
    const p = await newProject()
    const seen: unknown[] = []
    onStored = async (row, text) => {
      seen.push([row.fileName, text])
    }
    await upload(member, p, { name: 'a.txt', type: 'text/plain', data: Buffer.from('hello') })
    expect(seen).toEqual([['a.txt', 'hello']])
  })

  it('extracts text from a PDF, and accepts a PDF without a text layer', async () => {
    const p = await newProject()
    const withText = makePdf('BT /F1 18 Tf 20 80 Td (Hello Yoda lab report) Tj ET')
    const r1 = await upload(member, p, { name: 'r.pdf', type: 'application/pdf', data: withText })
    expect(r1.statusCode).toBe(201)
    expect((r1.json() as Attachment).hasText).toBe(true)
    const noText = makePdf('10 10 100 50 re f')
    const r2 = await upload(member, p, { name: 'scan.pdf', type: 'application/pdf', data: noText })
    expect(r2.statusCode).toBe(201)
    expect((r2.json() as Attachment).hasText).toBe(false)
  })

  it('stores images without text and a corrupt docx still uploads', async () => {
    const p = await newProject()
    const png = await upload(member, p, { name: 'x.png', type: 'image/png', data: Buffer.from([137, 80, 78, 71]) })
    expect(png.statusCode).toBe(201)
    expect((png.json() as Attachment).hasText).toBe(false)
    const docx = await upload(member, p, {
      name: 'bad.docx',
      type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      data: Buffer.from('not a zip'),
    })
    expect(docx.statusCode).toBe(201)
    expect((docx.json() as Attachment).hasText).toBe(false)
  })

  it('rejects unsupported types with 415 and writes nothing', async () => {
    const p = await newProject()
    const res = await upload(member, p, { name: 'a.exe', type: 'application/x-msdownload', data: Buffer.from('MZ') })
    expect(res.statusCode).toBe(415)
    expect(res.json()).toEqual({ error: 'unsupported_type' })
    expect(puts).toEqual([])
    expect((await call(member, 'GET', `/projects/${p}/attachments`)).json()).toEqual([])
  })

  it('rejects files over 25 MB with 413 and writes nothing', async () => {
    const p = await newProject()
    const res = await upload(member, p, { name: 'big.txt', type: 'text/plain', data: Buffer.alloc(26 * 1024 * 1024, 97) })
    expect(res.statusCode).toBe(413)
    expect(res.json()).toEqual({ error: 'too_large' })
    expect(puts).toEqual([])
    expect((await call(member, 'GET', `/projects/${p}/attachments`)).json()).toEqual([])
  })

  it('requesters get 403; non-member staff get 404 on upload, list and download', async () => {
    const p = await newProject()
    const file = { name: 'a.txt', type: 'text/plain', data: Buffer.from('x') }
    const a = (await upload(member, p, file)).json() as Attachment
    expect((await upload(nurse, p, file)).statusCode).toBe(403)
    expect((await call(nurse, 'GET', `/projects/${p}/attachments`)).statusCode).toBe(403)
    expect((await call(nurse, 'GET', `/attachments/${a.id}/download`)).statusCode).toBe(403)
    expect((await upload(outsider, p, file)).statusCode).toBe(404)
    expect((await call(outsider, 'GET', `/projects/${p}/attachments`)).statusCode).toBe(404)
    expect((await call(outsider, 'GET', `/attachments/${a.id}/download`)).statusCode).toBe(404)
    expect((await call(member, 'GET', `/attachments/${NO_ID}/download`)).statusCode).toBe(404)
    expect(puts).toHaveLength(1)
  })

  it('404s a workItemId or taskId that does not belong to the project', async () => {
    const p = await newProject()
    const file = { name: 'a.txt', type: 'text/plain', data: Buffer.from('x') }
    expect((await upload(member, p, file, { workItemId: NO_ID })).statusCode).toBe(404)
    expect((await upload(member, p, file, { taskId: NO_ID })).statusCode).toBe(404)
    expect(puts).toEqual([])
  })

  it('does not 500 on UTF-16 text containing NULs', async () => {
    const p = await newProject()
    const data = Buffer.from('\uFEFFlab result normal ผลแล็บ', 'utf16le')
    expect(data.includes(0)).toBe(true)
    const res = await upload(member, p, { name: 'u16.txt', type: 'text/plain', data })
    expect(res.statusCode).toBe(201)
    const [row] = await (await testDb()).select().from(attachments).where(eq(attachments.id, (res.json() as Attachment).id))
    expect(row.extractedText).not.toBeNull()
    expect(row.extractedText).not.toContain('\u0000')
  })

  it('404s a task that belongs to a different work item than the given workItemId', async () => {
    const p = await newProject()
    const mk = async () =>
      (await app.inject({ method: 'POST', url: `/projects/${p}/work-items`, headers: auth(pm), payload: { title: 'x', templateKey: 'bug-fix' } })).json() as { id: string }
    const [w1, w2] = [await mk(), await mk()]
    const [t] = await (await testDb()).select().from(tasks).where(eq(tasks.workItemId, w1.id))
    const file = { name: 'a.txt', type: 'text/plain', data: Buffer.from('x') }
    expect((await upload(member, p, file, { workItemId: w2.id, taskId: t.id })).statusCode).toBe(404)
    expect((await upload(member, p, file, { workItemId: w1.id, taskId: t.id })).statusCode).toBe(201)
  })

  it('links to a work item, filters the list, and honours noAi at upload', async () => {
    const p = await newProject()
    const w = (
      await app.inject({
        method: 'POST',
        url: `/projects/${p}/work-items`,
        headers: auth(pm),
        payload: { title: 'แก้รายงาน', templateKey: 'bug-fix' },
      })
    ).json() as { id: string }
    const file = { name: 'a.txt', type: 'text/plain', data: Buffer.from('x') }
    const linked = (await upload(member, p, file, { workItemId: w.id, noAi: 'true' })).json() as Attachment
    await upload(member, p, file)
    expect(linked).toMatchObject({ workItemId: w.id, noAi: true })
    const filtered = (await call(member, 'GET', `/projects/${p}/attachments?workItemId=${w.id}`)).json() as Attachment[]
    expect(filtered.map((x) => x.id)).toEqual([linked.id])
    expect(((await call(member, 'GET', `/projects/${p}/attachments`)).json() as Attachment[])).toHaveLength(2)
  })

  it('PATCH noAi: uploader and PM allowed, unrelated member forbidden', async () => {
    const p = await newProject()
    const third = await login(app, 'dev2', { staff: true })
    await app.inject({ method: 'PUT', url: `/projects/${p}/members/${third.id}`, headers: auth(admin), payload: { roles: ['DEV'] } })
    const a = (await upload(member, p, { name: 'a.txt', type: 'text/plain', data: Buffer.from('x') })).json() as Attachment
    const url = `/attachments/${a.id}`
    expect((await call(third, 'PATCH', url, { noAi: true })).statusCode).toBe(403)
    const own = await call(member, 'PATCH', url, { noAi: true })
    expect(own.statusCode).toBe(200)
    expect((own.json() as Attachment).noAi).toBe(true)
    expect((await call(pm, 'PATCH', url, { noAi: false })).statusCode).toBe(200)
    expect((await call(outsider, 'PATCH', url, { noAi: true })).statusCode).toBe(404)
    expect((await call(nurse, 'PATCH', url, { noAi: true })).statusCode).toBe(403)
    expect((await call(member, 'PATCH', url, { noAi: 'yes' })).statusCode).toBe(400)
  })
  it('conversation uploads: stored under the conversation, project thread files carry the project, no knowledge hook', async () => {
    const p = await newProject()
    const seen: string[] = []
    onStored = async (row) => {
      seen.push(row.fileName)
    }
    const thread = (await app.inject({ method: 'POST', url: '/conversations', headers: auth(pm), payload: { kind: 'project', projectId: p } })).json() as { id: string }
    const m = multipart({ name: 'chat.txt', type: 'text/plain', data: Buffer.from('hello') })
    const res = await app.inject({ method: 'POST', url: `/conversations/${thread.id}/attachments`, headers: { ...auth(member), ...m.headers }, payload: m.payload })
    expect(res.statusCode).toBe(201)
    expect(res.json()).toMatchObject({ projectId: p, conversationId: thread.id, hasText: true })
    expect(puts.at(-1)).toMatch(new RegExp(`^conversations/${thread.id}/[0-9a-f-]{36}/chat\\.txt$`))
    expect(seen).toEqual([])
    const big = multipart({ name: 'big.txt', type: 'text/plain', data: Buffer.alloc(26 * 1024 * 1024, 97) })
    const tooBig = await app.inject({ method: 'POST', url: `/conversations/${thread.id}/attachments`, headers: { ...auth(member), ...big.headers }, payload: big.payload })
    expect(tooBig.statusCode).toBe(413)
    expect((await call(outsider, 'GET', `/conversations/${thread.id}/attachments/${res.json().id}/download`)).statusCode).toBe(404)
  })
})
