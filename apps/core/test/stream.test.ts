import type { LiveEvent } from '@yoda/shared'
import type { FastifyInstance } from 'fastify'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { resetDb, testDb } from './helpers.js'
import { signToken } from './jwt.js'
import { auth, login, makeApp, type Who } from './support.js'

let app: FastifyInstance
let base: string
let admin: Who
let member: Who
let outsider: Who
let nurse: Who
const readers: ReadableStreamDefaultReader<Uint8Array>[] = []

type Stream = { read(timeoutMs: number): Promise<string | 'timeout' | 'done'>; reader: ReadableStreamDefaultReader<Uint8Array> }

async function open(token: string): Promise<Stream & { status: number }> {
  const res = await fetch(`${base}/stream`, { headers: { authorization: `Bearer ${token}` } })
  const reader = res.body!.getReader()
  readers.push(reader)
  const dec = new TextDecoder()
  return {
    status: res.status,
    reader,
    async read(timeoutMs) {
      const r = await Promise.race([
        reader.read(),
        new Promise<'timeout'>((ok) => setTimeout(() => ok('timeout'), timeoutMs)),
      ])
      if (r === 'timeout') return 'timeout'
      return r.done ? 'done' : dec.decode(r.value)
    },
  }
}

/** Reads until `pred(buffer)` or timeout; returns the buffer. */
async function readUntil(s: Stream, pred: (b: string) => boolean, ms: number): Promise<string> {
  let buf = ''
  const end = Date.now() + ms
  while (!pred(buf) && Date.now() < end) {
    const r = await s.read(end - Date.now())
    if (r === 'timeout' || r === 'done') break
    buf += r
  }
  return buf
}

describe('GET /stream', () => {
  beforeEach(async () => {
    await resetDb(await testDb())
    app = await makeApp()
    base = await app.listen({ port: 0, host: '127.0.0.1' })
    admin = await login(app, 'boss')
    member = await login(app, 'member', { staff: true })
    outsider = await login(app, 'outsider', { staff: true })
    nurse = await login(app, 'nurse1')
  })
  afterEach(async () => {
    for (const r of readers.splice(0)) await r.cancel().catch(() => {})
    await app.close()
  })

  async function projectWithMember(): Promise<string> {
    const { id } = (
      await app.inject({ method: 'POST', url: '/projects', headers: auth(admin), payload: { name: 'P' } })
    ).json() as { id: string }
    const res = await app.inject({
      method: 'PUT',
      url: `/projects/${id}/members/${member.id}`,
      headers: auth(admin),
      payload: { roles: ['PM'] },
    })
    expect(res.statusCode).toBe(200)
    return id
  }

  it('streams visible events to members only', async () => {
    const projectId = await projectWithMember()
    const m = await open(member.token)
    const o = await open(outsider.token)
    expect(m.status).toBe(200)
    expect(await readUntil(m, (b) => b.includes(': connected\n\n'), 2000)).toContain(': connected')
    expect(await readUntil(o, (b) => b.includes(': connected\n\n'), 2000)).toContain(': connected')

    const res = await app.inject({
      method: 'POST',
      url: `/projects/${projectId}/work-items`,
      headers: auth(member),
      payload: { title: 'x', templateKey: 'bug-fix' },
    })
    expect(res.statusCode).toBe(201)

    const buf = await readUntil(m, (b) => b.includes('event: live'), 2000)
    const line = buf.split('\n').find((l) => l.startsWith('data: '))
    expect(buf).toContain('event: live\n')
    const ev = JSON.parse(line!.slice(6)) as LiveEvent
    expect(ev.projectId).toBe(projectId)
    expect(ev.type).toBe('work_item.created')

    expect(await readUntil(o, (b) => b.includes('event: live'), 1000)).not.toContain('event: live')
  })

  it('refuses requesters and anonymous callers', async () => {
    expect((await fetch(`${base}/stream`, { headers: { authorization: `Bearer ${nurse.token}` } })).status).toBe(403)
    expect((await fetch(`${base}/stream`)).status).toBe(401)
  })

  it('ends the stream at token expiry', async () => {
    const token = await signToken({
      sub: 'sub-member',
      preferred_username: 'member',
      groups: ['/it-dev'],
      exp: Math.floor(Date.now() / 1000) + 2,
    })
    const s = await open(token)
    expect(await readUntil(s, (b) => b.includes(': connected'), 1000)).toContain(': connected')
    const start = Date.now()
    let r: string
    do r = await s.read(4000)
    while (r !== 'done' && r !== 'timeout')
    expect(r).toBe('done')
    expect(Date.now() - start).toBeLessThan(4000)
  })
})
