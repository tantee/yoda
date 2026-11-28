/** A message for the offscreen document (decision 16): one document, jobs `clip` (C1) and `buffer` (D1). */
export type OffscreenMsg =
  | { target: 'offscreen'; job: 'clip'; type: 'start'; streamId: string; tabId: number; maxSeconds: number }
  | { target: 'offscreen'; job: 'clip'; type: 'stop' }
  | { target: 'offscreen'; job: 'buffer'; type: string; [k: string]: unknown }

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
