import { ChannelError } from './index.js'

const TIMEOUT_MS = 10_000

export type ProviderReply = { status: number; body: unknown }

/**
 * POSTs JSON to a chat provider. A network failure or timeout becomes a transient `<prefix>_unreachable` /
 * `<prefix>_timeout`: the error itself is dropped, since fetch errors can carry the request URL (Telegram's
 * holds the bot token) and provider text. The caller maps the HTTP status.
 */
export async function postJson(
  fetchFn: typeof fetch,
  prefix: string,
  url: string,
  body: unknown,
  headers: Record<string, string> = {},
): Promise<ProviderReply> {
  let res: Response
  try {
    res = await fetchFn(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    })
  } catch (err) {
    const name = (err as { name?: unknown })?.name
    throw new ChannelError(name === 'TimeoutError' || name === 'AbortError' ? `${prefix}_timeout` : `${prefix}_unreachable`, false)
  }
  let parsed: unknown = null
  try {
    parsed = await res.json()
  } catch {
    // A non-JSON body (a proxy's error page) is ignored; the status decides.
  }
  return { status: res.status, body: parsed }
}

/** 429, 408 and 5xx are worth retrying; any other non-2xx (400, 401, 403, 404…) will fail the same way again. */
export function statusError(prefix: string, status: number): ChannelError {
  const transient = status === 429 || status === 408 || status >= 500
  return new ChannelError(`${prefix}_${status}`, !transient)
}
