import { LiveEvent } from '@yoda/shared'
import type Keycloak from 'keycloak-js'
import { loginLocale } from '~/utils/loginLocale'
import { requireKeycloak, sessionEnded } from '~/utils/session'
import { parseSse, streamStep } from '~/utils/sse'

/**
 * Streams /api/stream with fetch (EventSource cannot send Authorization). Reconnects with backoff; only when the
 * session really ended (the refresh token is gone or expired, or a 401 survives one forced refresh while online)
 * does it send the user to sign in again. A refresh that fails while offline just waits for the next reconnect.
 */
export function useLiveEvents(onEvent: (e: LiveEvent) => void, onReconnect?: () => void): void {
  const $keycloak = requireKeycloak(useNuxtApp().$keycloak as Keycloak | null)
  let stopped = false
  let controller: AbortController | null = null
  let timer: ReturnType<typeof setTimeout> | null = null
  let delay = 1000
  let connectedBefore = false

  function signIn() {
    stopped = true
    void $keycloak.login({ locale: loginLocale(document.cookie) })
  }

  function reconnectLater() {
    if (stopped) return
    timer = setTimeout(() => void connect(), delay)
    delay = Math.min(delay * 2, 30000)
  }

  async function connect(retriedAuth = false): Promise<void> {
    if (stopped) return
    let tokenOk = true
    try {
      await $keycloak.updateToken(retriedAuth ? -1 : 30)
    } catch {
      tokenOk = false
    }
    if (!tokenOk) {
      const step = streamStep({ tokenOk, sessionEnded: sessionEnded($keycloak), retriedAuth })
      return step === 'login' ? signIn() : reconnectLater()
    }
    controller = new AbortController()
    try {
      const res = await fetch('/api/stream', {
        headers: { Authorization: `Bearer ${$keycloak.token}`, Accept: 'text/event-stream' },
        signal: controller.signal,
      })
      const step = streamStep({ tokenOk, status: res.status, retriedAuth, online: navigator.onLine })
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
    reconnectLater()
  }

  onMounted(() => void connect())
  onBeforeUnmount(() => {
    stopped = true
    if (timer) clearTimeout(timer)
    controller?.abort()
  })
}
