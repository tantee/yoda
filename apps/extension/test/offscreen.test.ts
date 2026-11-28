import 'fake-indexeddb/auto'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { route } from '../src/offscreen/router'
import { clipSize, clearStaleClip, closeOffscreenIfIdle, endClip, ensureOffscreen, jobs, onClipTabNavigated, startClip } from '../src/sw/offscreen'
import { startReport } from '../src/sw/report-start'
import { getDraft } from '../src/drafts/db'
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

  it('two concurrent starts: one records, the other is busy, and the running job is kept', async () => {
    const [a, b] = await Promise.all([startClip({ tabId: 1, profileId: 'p1', maxSeconds: 30 }), startClip({ tabId: 1, profileId: 'p1', maxSeconds: 30 })])
    expect([a, b].filter((r) => r.ok)).toHaveLength(1)
    expect([a, b].find((r) => !r.ok)).toEqual({ ok: false, error: 'busy' })
    expect((await jobs()).clip).toMatchObject({ tabId: 1, tainted: false })
    expect(closed).not.toHaveBeenCalled()
  })

  it('an unreadable page is refused like production', async () => {
    tabs[4] = { url: undefined as unknown as string }
    expect(await startClip({ tabId: 4, profileId: 'p1', maxSeconds: 30 })).toEqual({ ok: false, error: 'unknown_page' })
  })

  it('navigating to a page not known to be safe taints the clip and stops it', async () => {
    await startClip({ tabId: 1, profileId: 'p1', maxSeconds: 30 })
    await onClipTabNavigated(1, 'https://uat.example.org/other')
    expect((await jobs()).clip!.tainted).toBe(false)
    // activeTab is gone on another origin: the URL cannot be read.
    await onClipTabNavigated(1, undefined)
    expect((await jobs()).clip!.tainted).toBe(true)
    expect(sent.at(-1)).toMatchObject({ target: 'offscreen', job: 'clip', type: 'stop' })
  })

  it('a job whose offscreen document is gone, or long past its limit, is cleared', async () => {
    await startClip({ tabId: 1, profileId: 'p1', maxSeconds: 30 })
    await clearStaleClip(Date.now())
    expect((await jobs()).clip).toBeDefined()
    await clearStaleClip(Date.now() + 91_000)
    expect((await jobs()).clip).toBeUndefined()
    await startClip({ tabId: 1, profileId: 'p1', maxSeconds: 30 })
    docs = 0
    await clearStaleClip()
    expect((await jobs()).clip).toBeUndefined()
  })

  it('a tainted clip, or one whose tab closed on an unknown page, keeps no video; the draft is still made', async () => {
    const g = globalThis as unknown as { chrome: Record<string, Record<string, unknown>> }
    g.chrome.tabs!.create = async () => ({})
    g.chrome.scripting = { executeScript: async () => [] } as never
    const video = new Blob([new Uint8Array([0x1a, 0x45, 0xdf, 0xa3])], { type: 'video/webm' })
    const tainted = await startReport({ tabId: 1, profileId: 'p1', kind: 'video', video, url: 'https://uat.example.org/opd', tainted: true })
    const d1 = (await getDraft(tainted.draftId))!
    expect(d1.video).toBeUndefined()
    expect(d1.notice).toBe('video_dropped')
    // The tab is gone: the clip's start URL is used, and it is safe here.
    g.chrome.tabs!.get = async () => {
      throw new Error('No tab')
    }
    const gone = await startReport({ tabId: 9, profileId: 'p1', kind: 'video', video, url: 'https://uat.example.org/opd' })
    expect((await getDraft(gone.draftId))!.video).toBeDefined()
    const unknown = await startReport({ tabId: 9, profileId: 'p1', kind: 'video', video })
    expect((await getDraft(unknown.draftId))!.video).toBeUndefined()
  })

  it('the clip keeps the tab shape, at most 1280 wide, in even pixels', () => {
    expect(clipSize({ width: 1280, height: 773 })).toEqual({ width: 1280, height: 774 })
    expect(clipSize({ width: 1920, height: 1001 })).toEqual({ width: 1280, height: 668 })
    expect(clipSize({ width: 800, height: 600 })).toEqual({ width: 800, height: 600 })
    expect(clipSize({})).toEqual({})
  })
})
