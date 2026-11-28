import 'fake-indexeddb/auto'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { bufferJob, BUFFER_MAX_MS, runBuffer, SegmentRing } from '../src/offscreen/buffer'
import { route } from '../src/offscreen/router'
import { armBuffer, bufferState, disarmBuffer, onBufferDisarmed, onBufferTabNavigated, onBufferTabRemoved, saveBuffer, type DisarmReason } from '../src/sw/buffer'
import { endClip, jobs, startClip } from '../src/sw/offscreen'
import { getDraft, listDrafts, newDraft, putDraft, type Draft } from '../src/drafts/db'
import { getClip, putClip } from '../src/drafts/clips'
import { resolveUrl } from '../src/sw/rules'
import { splitRegions, type VideoRegion } from '../src/video/regions'
import { buildReport, type ReportForm } from '../src/report/build-report'
import { sendReport } from '../src/report/send'
import { installChrome, type FakeChrome } from './support/chrome'

/** A MediaRecorder stand-in: one chunk per timeslice, labelled with the time it covers, and a last one on stop. */
class FakeRecorder {
  static all: FakeRecorder[] = []
  state: 'inactive' | 'recording' = 'inactive'
  ondataavailable: ((e: { data: Blob }) => void) | null = null
  onstop: (() => void) | null = null
  private timer: ReturnType<typeof setInterval> | null = null
  constructor(
    public stream: unknown,
    public opts: { mimeType: string; videoBitsPerSecond: number },
  ) {
    FakeRecorder.all.push(this)
  }
  start(timeslice?: number) {
    this.state = 'recording'
    this.timer = setInterval(() => this.emit(), timeslice ?? 1000)
  }
  private emit() {
    this.ondataavailable?.({ data: new Blob([String(Date.now())], { type: 'video/webm' }) })
  }
  stop() {
    if (this.state === 'inactive') return
    this.state = 'inactive'
    clearInterval(this.timer!)
    this.emit()
    this.onstop?.()
  }
}
const recording = () => FakeRecorder.all.filter((r) => r.state === 'recording')

const fakeStream = () => {
  const tracks = [{ stop: vi.fn(), onended: null as null | (() => void) }]
  return { getTracks: () => tracks, tracks }
}
const times = async (b: Blob) => (await b.text()).match(/\d{13}/g)!.map(Number)
const realTimers = () => vi.useRealTimers()
/** Lets async work started by a timer (the document's message to the worker) finish. */
const settle = async () => {
  for (let i = 0; i < 50; i++) await new Promise((r) => setImmediate(r))
}
const fakeTimers = () => vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] })

describe('SegmentRing and runBuffer (the offscreen document)', () => {
  beforeEach(() => {
    FakeRecorder.all = []
    fakeTimers()
  })
  afterEach(realTimers)

  it('the ring keeps the previous complete segment and the current one', () => {
    const ring = new SegmentRing(30_000)
    const b = (s: string) => new Blob([s])
    ring.push(b('a'))
    ring.rotate()
    ring.push(b('b'))
    ring.rotate()
    ring.push(b('c'))
    expect(ring.snapshot()).toHaveLength(2)
  })

  it('snapshot after 75 s gives two segments covering 45–75 s', async () => {
    const t0 = Date.now()
    const s = fakeStream()
    const buf = runBuffer(s as unknown as MediaStream, { onDisarmed: () => {}, Recorder: FakeRecorder as never, isSupported: () => true, fix: async (b) => b })
    await vi.advanceTimersByTimeAsync(75_000)
    // A fresh recorder for each segment: each one is a standalone WebM.
    expect(FakeRecorder.all).toHaveLength(3)
    expect(FakeRecorder.all[0]!.opts).toMatchObject({ mimeType: 'video/webm;codecs=vp9', videoBitsPerSecond: 1_000_000 })
    const segs = await buf.save()
    expect(segs).toHaveLength(2)
    const [a, b] = await Promise.all(segs.map((x) => times(x.blob)))
    // The first 30 s are gone; the previous segment is 30–60 s, the current one 60–75 s.
    expect(Math.min(...a!) - t0).toBeGreaterThanOrEqual(30_000)
    expect(Math.max(...a!) - t0).toBeLessThanOrEqual(60_000)
    expect(Math.min(...b!) - t0).toBeGreaterThan(60_000)
    expect(Math.max(...b!) - t0).toBe(75_000)
    expect(segs.map((x) => x.durationMs)).toEqual([30_000, 15_000])
    // Saving stops the recording and the capture.
    expect(recording()).toHaveLength(0)
    expect(s.tracks[0]!.stop).toHaveBeenCalled()
  })

  it('the duration is written into each saved segment', async () => {
    const fix = vi.fn(async (b: Blob, _ms: number) => b)
    const buf = runBuffer(fakeStream() as unknown as MediaStream, { onDisarmed: () => {}, Recorder: FakeRecorder as never, isSupported: () => true, fix })
    await vi.advanceTimersByTimeAsync(40_000)
    await buf.save()
    expect(fix.mock.calls.map((c) => c[1])).toEqual([30_000, 10_000])
  })

  it('the offscreen document disarms itself after 15 minutes without a save, with the service worker stopped', async () => {
    // No worker module runs here: only the document's job, its timer and the message it sends.
    const sent: unknown[] = []
    const s = fakeStream()
    const put = vi.fn()
    const job = bufferJob({ stream: async () => s as unknown as MediaStream, send: (m) => void sent.push(m), putClip: put, Recorder: FakeRecorder as never, isSupported: () => true, fix: async (b) => b })
    expect(await job({ target: 'offscreen', job: 'buffer', type: 'start', streamId: 'x', tabId: 1 })).toEqual({ ok: true })
    await vi.advanceTimersByTimeAsync(BUFFER_MAX_MS - 1)
    expect(recording()).toHaveLength(1)
    expect(sent).toEqual([])
    await vi.advanceTimersByTimeAsync(1)
    expect(recording()).toHaveLength(0)
    expect(s.tracks[0]!.stop).toHaveBeenCalled()
    expect(sent).toEqual([{ type: 'buffer.disarmed', reason: 'timeout' }])
    // Its memory is gone: a save now has nothing.
    expect(await job({ target: 'offscreen', job: 'buffer', type: 'save' })).toEqual({ ok: false, error: 'not_armed' })
    expect(put).not.toHaveBeenCalled()
  })

  it('the tab closing ends the capture and disarms the buffer', async () => {
    const sent: unknown[] = []
    const s = fakeStream()
    const job = bufferJob({ stream: async () => s as unknown as MediaStream, send: (m) => void sent.push(m), putClip: vi.fn(), Recorder: FakeRecorder as never, isSupported: () => true, fix: async (b) => b })
    await job({ target: 'offscreen', job: 'buffer', type: 'start', streamId: 'x', tabId: 1 })
    s.tracks[0]!.onended!()
    expect(recording()).toHaveLength(0)
    expect(sent).toEqual([{ type: 'buffer.disarmed', reason: 'tab_closed' }])
  })
})

describe('the replay buffer in the worker', () => {
  let fake: FakeChrome
  let docs = 0
  const created = vi.fn()
  const closed = vi.fn()
  const capture = vi.fn()
  const badges: Record<number, string> = {}
  let streams: ReturnType<typeof fakeStream>[] = []
  const tabs: Record<number, { url?: string }> = {}
  const put = vi.fn(putClip)
  const opened: string[] = []
  let job: ReturnType<typeof bufferJob>

  const connected = { id: 'p1', name: 'Yoda', colour: '#000', url: 'https://yoda.example.org', isDefault: true, managed: false, sessionOnly: false, grantId: null, person: null, needsReconnect: false }
  const mapped = (production: boolean, pattern: string, i: number) => ({ id: `y${i}`, pattern, profileId: 'p1', projectId: null, environment: production ? 'production' : 'uat', production, source: 'yoda', order: i })

  beforeEach(async () => {
    FakeRecorder.all = []
    fakeTimers()
    fake = installChrome()
    docs = 0
    created.mockReset()
    closed.mockReset()
    capture.mockReset()
    put.mockClear()
    streams = []
    opened.length = 0
    for (const k of Object.keys(badges)) delete badges[+k]
    Object.assign(tabs, { 1: { url: 'https://uat.example.org/opd' }, 2: { url: 'https://his.example.org/opd' }, 3: { url: 'https://other.example.org/' }, 4: { url: undefined } })
    // The offscreen document runs in this process: the worker's messages reach its real buffer job.
    job = bufferJob({
      stream: async () => {
        const s = fakeStream()
        streams.push(s)
        return s as unknown as MediaStream
      },
      send: (m) => void onBufferDisarmed((m as { reason: DisarmReason }).reason),
      putClip: put,
      Recorder: FakeRecorder as never,
      isSupported: () => true,
      fix: async (b) => b,
    })
    const g = globalThis as unknown as { chrome: Record<string, unknown> }
    Object.assign(g.chrome.runtime as object, {
      getContexts: async () => Array.from({ length: docs }, () => ({ contextType: 'OFFSCREEN_DOCUMENT' })),
      sendMessage: async (m: unknown) => route(m, { clip: () => ({ ok: true }), buffer: job }) ?? undefined,
    })
    g.chrome.offscreen = {
      createDocument: async (o: unknown) => {
        created(o)
        docs = 1
      },
      closeDocument: async () => {
        closed()
        docs = 0
      },
    }
    g.chrome.tabs = { get: async (id: number) => ({ id, width: 1280, height: 800, ...tabs[id] }), create: async (o: { url: string }) => void opened.push(o.url) }
    g.chrome.tabCapture = {
      getMediaStreamId: async (o: unknown) => {
        capture(o)
        return 'stream-1'
      },
    }
    g.chrome.action = {
      setBadgeText: async (o: { text: string; tabId: number }) => void (badges[o.tabId] = o.text),
      setBadgeBackgroundColor: async () => {},
    }
    g.chrome.scripting = { executeScript: async () => [] }
    ;(fake.storage as Record<string, unknown>).managed = { get: async () => ({}) }
    await chrome.storage.local.set({
      profiles: [connected],
      'mappings.p1': { at: Date.now(), ttlMs: 3600_000, rules: [mapped(false, 'https://uat.example.org/*', 0), mapped(true, 'https://his.example.org/*', 1)] },
    })
  })
  afterEach(realTimers)

  const arm = (tabId = 1) => armBuffer({ tabId, profileId: 'p1' })

  it('arms on a mapped page that is not production: one document, the red badge, the job remembered', async () => {
    expect(await arm()).toEqual({ ok: true })
    expect(created).toHaveBeenCalledOnce()
    expect(capture).toHaveBeenCalledWith({ targetTabId: 1 })
    expect(badges[1]).toBe('●')
    expect(recording()).toHaveLength(1)
    expect(await bufferState()).toMatchObject({ tabId: 1, profileId: 'p1', url: 'https://uat.example.org/opd' })
    expect(await arm()).toEqual({ ok: false, error: 'busy' })
  })

  it('production never arms (and unknown, unmapped or policy-off pages never arm)', async () => {
    expect(await arm(2)).toEqual({ ok: false, error: 'production' })
    expect(await arm(4)).toEqual({ ok: false, error: 'unknown_page' })
    expect(await arm(3)).toEqual({ ok: false, error: 'not_mapped' })
    // A connected Yoda whose mappings were never fetched: production is unknown.
    await chrome.storage.local.remove('mappings.p1')
    expect(await arm(1)).toEqual({ ok: false, error: 'unknown_page' })
    expect(created).not.toHaveBeenCalled()
    expect(capture).not.toHaveBeenCalled()
    expect(badges).toEqual({})
    expect(await bufferState()).toBeNull()
  })

  it('the managed policy turns the buffer off (allowBuffer or allowVideo false)', async () => {
    for (const p of [{ allowBuffer: false }, { allowVideo: false }]) {
      ;(fake.storage as Record<string, unknown>).managed = { get: async () => p }
      expect(await arm()).toEqual({ ok: false, error: 'policy' })
    }
    expect(capture).not.toHaveBeenCalled()
  })

  it('the popup offers the buffer only on a mapped page known not to be production, when policy allows', async () => {
    const g = globalThis as unknown as { fetch: unknown }
    const realFetch = g.fetch
    // The session fetch for the project may fail here: only the flags matter.
    g.fetch = async () => new Response('{}', { status: 500 })
    try {
      expect((await resolveUrl('https://uat.example.org/opd')).bufferAllowed).toBe(true)
      expect((await resolveUrl('https://his.example.org/opd')).bufferAllowed).toBe(false)
      expect((await resolveUrl('https://other.example.org/')).bufferAllowed).toBe(false)
      ;(fake.storage as Record<string, unknown>).managed = { get: async () => ({ allowBuffer: false }) }
      const off = await resolveUrl('https://uat.example.org/opd')
      expect([off.videoAllowed, off.bufferAllowed]).toEqual([true, false])
    } finally {
      g.fetch = realFetch
    }
  })

  it('nothing is written to IndexedDB or storage while armed', async () => {
    const before = { local: structuredClone(Object.fromEntries(fake.storage.local.data)) }
    await arm()
    await vi.advanceTimersByTimeAsync(75_000)
    expect(put).not.toHaveBeenCalled()
    expect(await indexedDB.databases()).toEqual([])
    expect(Object.fromEntries(fake.storage.local.data)).toEqual(before.local)
    // The session area holds the job only: which tab, since when; no video.
    const session = JSON.stringify(Object.fromEntries(fake.storage.session.data))
    expect([...fake.storage.session.data.keys()]).toEqual(['offscreen.jobs'])
    expect(session.length).toBeLessThan(400)
  })

  const triggers: Record<DisarmReason, () => Promise<unknown>> = {
    user: () => disarmBuffer('user'),
    production: () => onBufferTabNavigated(1, 'https://his.example.org/opd'),
    left_mapped_site: () => onBufferTabNavigated(1, 'https://other.example.org/x'),
    tab_closed: () => onBufferTabRemoved(1),
    timeout: async () => {
      await vi.advanceTimersByTimeAsync(BUFFER_MAX_MS)
      await settle()
    },
    saved: async () => {
      realTimers()
      return saveBuffer()
    },
  }
  for (const reason of Object.keys(triggers) as DisarmReason[]) {
    it(`disarm (${reason}) stops the recorder and clears the badge`, async () => {
      await arm()
      await vi.advanceTimersByTimeAsync(5_000)
      expect(badges[1]).toBe('●')
      await triggers[reason]()
      expect(recording()).toHaveLength(0)
      expect(streams[0]!.tracks[0]!.stop).toHaveBeenCalled()
      expect(badges[1]).toBe('')
      expect(await bufferState()).toBeNull()
      expect(closed).toHaveBeenCalledOnce()
    })
  }

  it('navigating within the mapped site keeps it armed; an unreadable URL disarms it', async () => {
    await arm()
    await onBufferTabNavigated(1, 'https://uat.example.org/ipd')
    await onBufferTabNavigated(5, 'https://his.example.org/')
    expect(recording()).toHaveLength(1)
    await onBufferTabNavigated(1, undefined)
    expect(recording()).toHaveLength(0)
  })

  it('save puts the segments into a new draft, deletes the handed-over clips and opens the editor', async () => {
    await arm()
    await vi.advanceTimersByTimeAsync(35_000)
    realTimers()
    const r = await saveBuffer()
    expect(r).toMatchObject({ ok: true })
    const d = (await getDraft((r as { draftId: string }).draftId))!
    expect(d.buffer).toHaveLength(2)
    expect(d.video).toBeUndefined()
    expect(d.form).toMatchObject({ attach: { buffer: true } })
    expect(opened[0]).toContain(`src/editor/index.html?draft=${d.id}`)
    expect(put).toHaveBeenCalledTimes(2)
    for (const c of put.mock.calls) expect(await getClip(c[0].id)).toBeNull()
  })

  it('save keeps no video when the tab is on a production page by then', async () => {
    await arm()
    await vi.advanceTimersByTimeAsync(5_000)
    tabs[1] = { url: 'https://his.example.org/opd' }
    realTimers()
    const r = (await saveBuffer()) as { draftId: string }
    const d = (await getDraft(r.draftId))!
    expect(d.buffer).toBeUndefined()
    expect(d.notice).toBe('video_dropped')
  })

  it('a clip while the buffer runs shares the one offscreen document', async () => {
    await arm()
    expect((await startClip({ tabId: 1, profileId: 'p1', maxSeconds: 30 })).ok).toBe(true)
    expect(created).toHaveBeenCalledOnce()
    expect(await jobs()).toMatchObject({ clip: { tabId: 1 }, buffer: { tabId: 1 } })
    await disarmBuffer('user')
    // The clip still runs: the document stays.
    expect(closed).not.toHaveBeenCalled()
    await endClip()
    expect(closed).toHaveBeenCalledOnce()
  })

  it('a buffer job whose document is gone is forgotten', async () => {
    await arm()
    // The document went away (an extension reload), and its memory with it.
    docs = 0
    await job({ target: 'offscreen', job: 'buffer', type: 'stop' })
    expect(await bufferState()).toBeNull()
    expect(badges[1]).toBe('')
    expect(await arm()).toEqual({ ok: true })
  })

  it('no draft is made when the save fails', async () => {
    await arm()
    realTimers()
    const before = (await listDrafts()).length
    // Nothing recorded yet: no segment.
    FakeRecorder.all[0]!.ondataavailable = null
    const r = await saveBuffer()
    expect(r.ok).toBe(false)
    expect(await listDrafts()).toHaveLength(before)
    expect(await bufferState()).toBeNull()
  })
})

describe('mosaic on buffer segments', () => {
  const region = (id: string, fromMs: number, toMs: number): VideoRegion => ({ id, rect: { x: 1, y: 2, w: 30, h: 40 }, fromMs, toMs, block: 8 })

  it('regions spanning the segment boundary are split per segment', () => {
    const out = splitRegions([region('a', 25_000, 35_000), region('b', 1_000, 2_000), region('c', 40_000, 50_000)], [30_000, 15_000])
    expect(out).toHaveLength(2)
    expect(out[0]!.map((r) => [r.id, r.fromMs, r.toMs])).toEqual([
      ['a', 25_000, 30_000],
      ['b', 1_000, 2_000],
    ])
    expect(out[1]!.map((r) => [r.id, r.fromMs, r.toMs])).toEqual([
      ['a', 0, 5_000],
      ['c', 10_000, 15_000],
    ])
    expect(out[1]![0]!.rect).toEqual({ x: 1, y: 2, w: 30, h: 40 })
  })

  const webm = (n: number) => new Blob([new Uint8Array([0x1a, 0x45, 0xdf, 0xa3, n])], { type: 'video/webm' })
  const form: ReportForm = {
    projectId: '00000000-0000-4000-8000-000000000001',
    kind: 'defect',
    title: 'x',
    severity: 'major',
    description: '',
    steps: [],
    expected: '',
    actual: '',
    includeQuery: true,
    attach: { screenshot: true, video: true, buffer: true, console: true, network: true },
    confirmedNoPatientData: true,
    textMayContainPatientData: false,
    build: null,
  }
  const ctx = { production: false, extensionVersion: '1.2.0', images: [] }
  const withBuffer = (o: Partial<Draft> = {}): Draft => ({ ...newDraft({ profileId: 'p1', tabId: 1, tabUrl: 'https://uat.example.org/' }), buffer: [webm(1), webm(2)], ...o })

  it('buildReport names the segments and refuses one with unapplied regions', () => {
    const { files } = buildReport(withBuffer(), form, ctx)
    expect(files.map((f) => f.name)).toEqual(['buffer-1.webm', 'buffer-2.webm'])
    expect(() => buildReport(withBuffer({ bufferRegions: [[], [region('a', 0, 1000)]] }), form, ctx)).toThrow('mosaic_not_applied')
    // Unticked, the buffer does not go, so nothing is refused.
    expect(buildReport(withBuffer({ bufferRegions: [[region('a', 0, 1000)]] }), { ...form, attach: { ...form.attach, buffer: false } }, ctx).files).toEqual([])
  })

  it('sendReport refuses a segment the stored draft has unapplied regions on, or that is not the stored one', async () => {
    installChrome()
    const fetch = vi.fn()
    const deps = { token: async () => ({ ok: true as const, token: 't', origin: 'https://yoda.example.org' }), fetch, sleep: async () => {} }
    const d = withBuffer()
    const { report, files } = buildReport(d, form, ctx)
    // Another editor tab drew a region on segment 2 meanwhile.
    await putDraft({ ...d, bufferRegions: [[], [region('a', 0, 1000)]] })
    expect(await sendReport(d.id, report, files, deps)).toEqual({ ok: false, error: 'mosaic_not_applied' })
    // Or applied a mosaic: the stored segment is no longer this tab's.
    await putDraft({ ...d, buffer: [webm(1), webm(9)] })
    expect(await sendReport(d.id, report, files, deps)).toEqual({ ok: false, error: 'mosaic_not_applied' })
    expect(fetch).not.toHaveBeenCalled()
  })
})
