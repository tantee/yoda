export type SseEvent = { event: string; data: string }

/** Parses as many complete SSE events as `buffer` holds; returns the unparsed remainder. */
export function parseSse(buffer: string): { events: SseEvent[]; rest: string } {
  const text = buffer.replace(/\r\n/g, '\n')
  const blocks = text.split('\n\n')
  const rest = blocks.pop() ?? ''
  const events: SseEvent[] = []
  for (const block of blocks) {
    let event = 'message'
    const data: string[] = []
    for (const line of block.split('\n')) {
      if (!line || line.startsWith(':')) continue
      const i = line.indexOf(':')
      const field = i === -1 ? line : line.slice(0, i)
      const value = i === -1 ? '' : line.slice(i + 1).replace(/^ /, '')
      if (field === 'event') event = value
      else if (field === 'data') data.push(value)
    }
    if (data.length) events.push({ event, data: data.join('\n') })
  }
  return { events, rest }
}

export type StreamStep = 'stream' | 'reconnect' | 'refresh-retry' | 'login'

/**
 * What the live stream does next. A token that cannot be refreshed (the session ended while idle) means signing
 * in again; a 401 gets one forced refresh and retry, then signing in again; other failures (network, 5xx) reconnect
 * with backoff. `status` is absent when the request itself failed.
 */
export function streamStep(o: { tokenOk: boolean; status?: number; retriedAuth: boolean }): StreamStep {
  if (!o.tokenOk) return 'login'
  if (o.status === 401) return o.retriedAuth ? 'login' : 'refresh-retry'
  if (o.status !== undefined && o.status >= 200 && o.status < 300) return 'stream'
  return 'reconnect'
}
