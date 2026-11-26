import { LiveEvent } from '@yoda/shared'
import { parseSse, streamStep } from '~/utils/sse'

/**
 * Streams /api/stream with fetch (EventSource cannot send Authorization). Reconnects with backoff; when the session
 * has ended (token refresh fails, or a 401 survives one forced refresh) it sends the user to sign in again.
 */
export function useLiveEvents(onEvent: (e: LiveEvent) => void, onReconnect?: () => void): void {
  const { $keycloak } = useNuxtApp()
  let stopped = false
  let controller: AbortController | null = null
  let timer: ReturnType<typeof setTimeout> | null = null
  let delay = 1000
  let connectedBefore = false

  function signIn() {
    stopped = true
    void $keycloak.login()
  }

  async function connect(retriedAuth = false): Promise<void> {
    if (stopped) return
    // Outside the retry catch: a refresh that fails means the session is over, and retrying cannot fix that.
    let tokenOk = true
    try {
      await $keycloak.updateToken(retriedAuth ? -1 : 30)
    } catch {
      tokenOk = false
    }
    if (streamStep({ tokenOk, retriedAuth }) === 'login') return signIn()
    controller = new AbortController()
    try {
      const res = await fetch('/api/stream', {
        headers: { Authorization: `Bearer ${$keycloak.token}`, Accept: 'text/event-stream' },
        signal: controller.signal,
      })
      const step = streamStep({ tokenOk, status: res.status, retriedAuth })
      if (step === 'refresh-retry') return connect(true)
      if (step === 'login') return signIn()
      if (step !== 'stream' || !res.body) throw new Error(`stream_${res.status}`)
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
    timer = setTimeout(() => void connect(), delay)
    delay = Math.min(delay * 2, 30000)
  }

  onMounted(() => void connect())
  onBeforeUnmount(() => {
    stopped = true
    if (timer) clearTimeout(timer)
    controller?.abort()
  })
}
