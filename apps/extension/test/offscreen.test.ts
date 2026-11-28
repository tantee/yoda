import { beforeEach, describe, expect, it, vi } from 'vitest'
import { route } from '../src/offscreen/router'
import { closeOffscreenIfIdle, endClip, ensureOffscreen, jobs, startClip } from '../src/sw/offscreen'
import { installChrome } from './support/chrome'

let docs = 0
const created = vi.fn()
const closed = vi.fn()
let offscreenReply: unknown = { ok: true }
const sent: unknown[] = []
const tabs: Record<number, { url: string }> = { 1: { url: 'https://uat.example.org/opd' }, 2: { url: 'https://his.example.org/opd' } }

beforeEach(async () => {
  installChrome()
  docs = 0
  created.mockReset()
  closed.mockReset()
  sent.length = 0
  offscreenReply = { ok: true }
  const g = globalThis as unknown as { chrome: Record<string, unknown> }
  Object.assign(g.chrome.runtime as object, {
    getContexts: async () => Array.from({ length: docs }, () => ({ contextType: 'OFFSCREEN_DOCUMENT' })),
    sendMessage: async (m: unknown) => {
      sent.push(m)
      return offscreenReply
    },
  })
  g.chrome.offscreen = {
    createDocument: async (o: unknown) => {
      created(o)
      await new Promise((r) => setTimeout(r, 5))
      docs = 1
    },
    closeDocument: async () => {
      closed()
      docs = 0
    },
  }
  g.chrome.tabs = { get: async (id: number) => ({ id, ...tabs[id] }) }
  g.chrome.tabCapture = { getMediaStreamId: async () => 'stream-1' }
  await chrome.storage.local.set({ profiles: [{ id: 'p1', name: 'Yoda', colour: '#000', url: 'https://yoda.example.org', isDefault: true, managed: false, sessionOnly: false, grantId: null, person: null, needsReconnect: true }] })
})

describe('offscreen document', () => {
  it('only one offscreen document is created, even for concurrent callers or when the buffer already runs', async () => {
    await Promise.all([ensureOffscreen(), ensureOffscreen()])
    expect(created).toHaveBeenCalledOnce()
    await ensureOffscreen()
    expect(created).toHaveBeenCalledOnce()
    expect(created.mock.calls[0]![0]).toMatchObject({ url: 'src/offscreen/index.html', reasons: ['USER_MEDIA'] })
  })

  it('a clip message is routed to the clip job; other messages are not for the document', async () => {
    const clip = vi.fn(() => ({ ok: true }))
    const buffer = vi.fn()
    expect(await route({ target: 'offscreen', job: 'clip', type: 'stop' }, { clip, buffer })).toEqual({ ok: true })
    expect(clip).toHaveBeenCalledOnce()
    expect(buffer).not.toHaveBeenCalled()
    expect(route({ type: 'video.done' }, { clip })).toBeUndefined()
  })

  it('the document is closed when the last job ends, and kept while the buffer runs', async () => {
    expect((await startClip({ tabId: 1, profileId: 'p1', maxSeconds: 30 })).ok).toBe(true)
    expect(sent.at(-1)).toMatchObject({ target: 'offscreen', job: 'clip', type: 'start', streamId: 'stream-1', tabId: 1, maxSeconds: 30 })
    await chrome.storage.session.set({ 'offscreen.jobs': { ...(await jobs()), buffer: { tabId: 3, startedAt: 0 } } })
    await endClip()
    expect(closed).not.toHaveBeenCalled()
    await chrome.storage.session.set({ 'offscreen.jobs': {} })
    expect(await closeOffscreenIfIdle()).toBe(true)
    expect(closed).toHaveBeenCalledOnce()
  })

  it('video.start is refused on a production tab', async () => {
    // A connected profile whose cached Yoda rules mark the site production.
    await chrome.storage.local.set({
      profiles: [{ id: 'p1', name: 'Yoda', colour: '#000', url: 'https://yoda.example.org', isDefault: true, managed: false, sessionOnly: false, grantId: null, person: null, needsReconnect: false }],
      'mappings.p1': { at: Date.now(), ttlMs: 600_000, rules: [{ id: 'y1', pattern: 'https://his.example.org/*', profileId: 'p1', projectId: null, environment: 'production', production: true, source: 'yoda', order: 0 }] },
    })
    expect(await startClip({ tabId: 2, profileId: 'p1', maxSeconds: 30 })).toEqual({ ok: false, error: 'production' })
    expect(created).not.toHaveBeenCalled()
    expect((await jobs()).clip).toBeUndefined()
  })

  it('a second clip while one runs is refused; a failed start forgets the job', async () => {
    expect((await startClip({ tabId: 1, profileId: 'p1', maxSeconds: 30 })).ok).toBe(true)
    expect(await startClip({ tabId: 1, profileId: 'p1', maxSeconds: 30 })).toEqual({ ok: false, error: 'busy' })
    await endClip()
    offscreenReply = { ok: false }
    expect(await startClip({ tabId: 1, profileId: 'p1', maxSeconds: 30 })).toEqual({ ok: false, error: 'capture_failed' })
    expect((await jobs()).clip).toBeUndefined()
  })
})

