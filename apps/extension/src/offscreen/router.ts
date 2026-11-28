/** The replay buffer's segment length and its disarm (D1); here so the worker can read them without the recorder. */
export const BUFFER_SEGMENT_MS = 30_000
export const BUFFER_MAX_MS = 15 * 60_000

/** A message for the offscreen document (decision 16): one document, jobs `clip` (C1) and `buffer` (D1). */
export type OffscreenMsg =
  | { target: 'offscreen'; job: 'clip'; type: 'start'; streamId: string; tabId: number; maxSeconds: number; width?: number; height?: number }
  | { target: 'offscreen'; job: 'clip'; type: 'stop' }
  | { target: 'offscreen'; job: 'buffer'; type: 'start'; streamId: string; tabId: number; width?: number; height?: number; segmentMs?: number }
  | { target: 'offscreen'; job: 'buffer'; type: 'stop' | 'save' }

export type JobHandler = (m: OffscreenMsg) => Promise<unknown> | unknown

export function isOffscreenMsg(m: unknown): m is OffscreenMsg {
  return !!m && typeof m === 'object' && (m as { target?: unknown }).target === 'offscreen' && ['clip', 'buffer'].includes(String((m as { job?: unknown }).job))
}

/** Dispatches a message to its job; anything not for the offscreen document is ignored (undefined). */
export function route(m: unknown, jobs: Partial<Record<'clip' | 'buffer', JobHandler>>): Promise<unknown> | undefined {
  if (!isOffscreenMsg(m)) return undefined
  const h = jobs[m.job]
  return h ? Promise.resolve(h(m)) : Promise.resolve({ ok: false, error: 'no_job' })
}
