import { ExtensionSession } from '@yoda/shared'
import { accessToken, yodaFetch } from './api'
import { onMessage } from './messages'
import { exchangeProfile, removeProfile } from './profiles'
import { initSecrets } from './secrets'
import { getProfile } from './store'

// The service worker keeps no state beyond in-flight promises (plan B3): everything lives in storage.
// Content scripts never read storage (TRUSTED_CONTEXTS), set before anything is written.
const ready = initSecrets()
chrome.runtime.onStartup?.addListener(() => void initSecrets())
chrome.runtime.onInstalled?.addListener(() => void initSecrets())

onMessage(async (m) => {
  await ready
  switch (m.type) {
    case 'profile.exchange':
      return exchangeProfile(m) as Promise<{ ok: true } | { ok: false; error: string }>
    case 'profile.remove':
      await removeProfile(m.profileId)
      return { ok: true }
    case 'token.get': {
      // For the editor's upload (decision 14): the token stays in that page's memory only.
      const p = await getProfile(m.profileId)
      if (!p) return { ok: false, error: 'unknown_profile' }
      if (p.needsReconnect) return { ok: false, error: 'reconnect' }
      const token = await accessToken(m.profileId, { force: m.after401 })
      return token ? { ok: true, token, origin: p.url } : { ok: false, error: 'reconnect' }
    }
    case 'session.get': {
      const res = await yodaFetch(m.profileId, '/api/extension/session')
      if (!res.ok) return { ok: false, error: res.status === 401 ? 'reconnect' : `http_${res.status}` }
      return { ok: true, session: ExtensionSession.parse(await res.json()) }
    }
    default:
      return { ok: false, error: 'not_implemented' }
  }
})
