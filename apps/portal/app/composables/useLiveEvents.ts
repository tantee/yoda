import { LiveEvent } from '@yoda/shared'
import { parseSse } from '~/utils/sse'

/** Streams /api/stream with fetch (EventSource cannot send Authorization). Reconnects with backoff. */
export function useLiveEvents(onEvent: (e: LiveEvent) => void, onReconnect?: () => void): void {
  const { $keycloak } = useNuxtApp()
  let stopped = false
  let controller: AbortController | null = null
  let timer: ReturnType<typeof setTimeout> | null = null
  let delay = 1000
  let connectedBefore = false

  async function connect() {
    if (stopped) return
    controller = new AbortController()
    try {
      await $keycloak.updateToken(30)
      const res = await fetch('/api/stream', {
        headers: { Authorization: `Bearer ${$keycloak.token}`, Accept: 'text/event-stream' },
        signal: controller.signal,
      })
      if (!res.ok || !res.body) throw new Error(`stream_${res.status}`)
      delay = 1000
      if (connectedBefore) onReconnect?.()
      connectedBefore = true
      const reader = res.body.getReader()
      const decoder = new TextDecoder()
      let buffer = ''
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        buffer += decoder.decode(value, { stream: true })
        const parsed = parseSse(buffer)
        buffer = parsed.rest
        for (const ev of parsed.events) {
          if (ev.event !== 'live') continue
          try {
            const r = LiveEvent.safeParse(JSON.parse(ev.data))
            if (r.success) onEvent(r.data)
          } catch {
            // ignore malformed payloads
          }
        }
      }
    } catch {
      // fall through to reconnect
    }
    if (stopped) return
    timer = setTimeout(connect, delay)
    delay = Math.min(delay * 2, 30000)
  }

  onMounted(connect)
  onBeforeUnmount(() => {
    stopped = true
    if (timer) clearTimeout(timer)
    controller?.abort()
  })
}
