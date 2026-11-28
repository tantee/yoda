import { DefectReportCreated, encodeDefectForm, type DefectReportCreate } from '@yoda/shared'
import { deleteDraft, getDraft } from '../drafts/db'
import type { ReportFile } from './build-report'

/**
 * Sending runs in the editor tab (plan decision 14): it can show progress and is not stopped mid-upload like a
 * service worker. The access token comes from the worker (`token.get`) and lives in this function only.
 */
export type TokenReply = { ok: true; token: string; origin: string } | { ok: false; error: string }
export type SendDeps = {
  token: (after401: boolean) => Promise<TokenReply>
  fetch: typeof fetch
  sleep: (ms: number) => Promise<void>
}
export type SendResult =
  | { ok: true; created: DefectReportCreated }
  | { ok: false; error: 'reconnect' }
  | { ok: false; error: string; reason?: string; retryAfter?: number }

const RETRIES = 3
/** A rate limit longer than this is reported to the tester instead of waited out. */
const MAX_WAIT_S = 30

export function defaultDeps(profileId: string): SendDeps {
  return {
    token: (after401) => chrome.runtime.sendMessage({ type: 'token.get', profileId, after401 }) as Promise<TokenReply>,
    fetch: (...a) => fetch(...a),
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
  }
}

/** Posts the report with the draft's Idempotency-Key, so a retry never files it twice; the draft goes on success. */
export async function sendReport(draftId: string, report: DefectReportCreate, files: ReportFile[], deps: SendDeps): Promise<SendResult> {
  const draft = await getDraft(draftId)
  if (!draft) return { ok: false, error: 'draft_missing' }
  let t = await deps.token(false)
  if (!t.ok) return { ok: false, error: 'reconnect' }
  let renewed = false
  for (let attempt = 0; ; attempt++) {
    let res: Response
    try {
      res = await deps.fetch(`${t.origin}/api/extension/defects`, {
        method: 'POST',
        headers: { authorization: `Bearer ${t.token}`, 'idempotency-key': draft.idempotencyKey },
        body: encodeDefectForm(report, files),
      })
    } catch {
      if (attempt < RETRIES) {
        await deps.sleep(1000 * 2 ** attempt)
        continue
      }
      return { ok: false, error: 'network' }
    }
    if (res.status === 200 || res.status === 201) {
      const created = DefectReportCreated.parse(await res.json())
      await deleteDraft(draftId)
      return { ok: true, created }
    }
    const body = (await res.json().catch(() => ({}))) as { error?: string; reason?: string; retryAfter?: number }
    if (res.status === 401 && !renewed) {
      renewed = true
      t = await deps.token(true)
      if (!t.ok) return { ok: false, error: 'reconnect' }
      continue
    }
    if (res.status === 401) return { ok: false, error: 'reconnect' }
    if (res.status === 429 && body.retryAfter !== undefined && body.retryAfter <= MAX_WAIT_S && attempt < RETRIES) {
      await deps.sleep(body.retryAfter * 1000)
      continue
    }
    if (res.status >= 500 && attempt < RETRIES) {
      await deps.sleep(1000 * 2 ** attempt)
      continue
    }
    if (res.status === 429) return { ok: false, error: 'rate_limited', retryAfter: body.retryAfter }
    return { ok: false, error: body.error ?? `http_${res.status}`, reason: body.reason }
  }
}
