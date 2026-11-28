import 'fake-indexeddb/auto'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { getDraft, newDraft, putDraft } from '../src/drafts/db'
import { sendReport, type SendDeps } from '../src/report/send'

const report = { projectId: '00000000-0000-4000-8000-000000000001' } as never
const files = [{ part: 'file1', name: 'screenshot.png', type: 'image/png', data: new Blob([new Uint8Array(3)], { type: 'image/png' }) }]
const created = { workItemId: '00000000-0000-4000-8000-0000000000bb', url: 'https://yoda.example.org/work-items/x', title: 't', stepKey: 'triage', state: 'active', aiAllowed: true, attachments: [] }
let draftId: string
let key: string

beforeEach(async () => {
  const d = newDraft({ profileId: 'p1', tabId: 1, tabUrl: 'https://a.example.org/' })
  draftId = d.id
  key = d.idempotencyKey
  await putDraft(d)
})

function deps(responses: (Response | Error)[], o: Partial<SendDeps> = {}): SendDeps & { calls: RequestInit[]; tokens: boolean[] } {
  const calls: RequestInit[] = []
  const tokens: boolean[] = []
  return {
    calls,
    tokens,
    token: async (after401) => {
      tokens.push(after401)
      return { ok: true, token: after401 ? 'yoda_xt_2' : 'yoda_xt_1', origin: 'https://yoda.example.org' }
    },
    fetch: async (_url, init) => {
      calls.push(init!)
      const r = responses.shift()!
      if (r instanceof Error) throw r
      return r
    },
    sleep: async () => {},
    ...o,
  }
}
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

describe('sendReport', () => {
  it('send asks token.get and never reads storage directly', async () => {
    const storage = vi.fn()
    ;(globalThis as unknown as { chrome: unknown }).chrome = { storage: { local: { get: storage }, session: { get: storage } } }
    const d = deps([json(201, created)])
    expect(await sendReport(draftId, report, files, d)).toEqual({ ok: true, created })
    expect(d.tokens).toEqual([false])
    expect(storage).not.toHaveBeenCalled()
    expect(new Headers(d.calls[0]!.headers).get('authorization')).toBe('Bearer yoda_xt_1')
  })

  it('send retries a 503 with the same Idempotency-Key and deletes the draft on 201', async () => {
    const d = deps([json(503, {}), new TypeError('network'), json(201, created)])
    expect((await sendReport(draftId, report, files, d)).ok).toBe(true)
    expect(d.calls.map((c) => new Headers(c.headers).get('idempotency-key'))).toEqual([key, key, key])
    expect(await getDraft(draftId)).toBeNull()
  })

  it('on 401 asks token.get again once', async () => {
    const d = deps([json(401, { error: 'unauthorized' }), json(201, created)])
    expect((await sendReport(draftId, report, files, d)).ok).toBe(true)
    expect(d.tokens).toEqual([false, true])
  })

  it('413 shows the limit and keeps the draft', async () => {
    const d = deps([json(413, { error: 'too_large', reason: 'role:video' })])
    expect(await sendReport(draftId, report, files, d)).toEqual({ ok: false, error: 'too_large', reason: 'role:video' })
    expect(await getDraft(draftId)).not.toBeNull()
  })

  it('429 waits retryAfter', async () => {
    const slept: number[] = []
    const d = deps([json(429, { error: 'rate_limited', retryAfter: 7 }), json(201, created)], { sleep: async (ms) => void slept.push(ms) })
    expect((await sendReport(draftId, report, files, d)).ok).toBe(true)
    expect(slept).toContain(7000)
  })

  it('a long 429 is reported, not waited for', async () => {
    const d = deps([json(429, { error: 'rate_limited', retryAfter: 3600 })])
    expect(await sendReport(draftId, report, files, d)).toEqual({ ok: false, error: 'rate_limited', retryAfter: 3600 })
  })

  it('422 video_on_production and 415 are reported with their reasons', async () => {
    expect(await sendReport(draftId, report, files, deps([json(422, { error: 'invalid_state', reason: 'video_on_production' })]))).toEqual({ ok: false, error: 'invalid_state', reason: 'video_on_production' })
    expect(await sendReport(draftId, report, files, deps([json(415, { error: 'unsupported_type' })]))).toEqual({ ok: false, error: 'unsupported_type', reason: undefined })
  })

  it('a reconnect-needed profile keeps the draft and shows Reconnect', async () => {
    const d = deps([], { token: async () => ({ ok: false, error: 'reconnect' }) })
    expect(await sendReport(draftId, report, files, d)).toEqual({ ok: false, error: 'reconnect' })
    expect(await getDraft(draftId)).not.toBeNull()
  })
})
