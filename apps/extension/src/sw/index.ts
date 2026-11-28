import { ExtensionSession } from '@yoda/shared'
import { accessToken, yodaFetch } from './api'
import { appendEntries, armTab, captureState, entries, nonceFor, onTabRemoved, onTabUpdated } from './capture-session'
import { purgeOldDrafts } from '../drafts/db'
import { TabChangedError } from '../capture/screenshot'
import { injectCapture } from './inject'
import { startReport } from './report-start'
import { onMessage } from './messages'
import { exchangeProfile, removeProfile } from './profiles'
import { initSecrets } from './secrets'
import { getProfile } from './store'

// The service worker keeps no state beyond in-flight promises (plan B3): everything lives in storage.
// Content scripts never read storage (TRUSTED_CONTEXTS), set before anything is written.
const ready = initSecrets()
// Drafts hold the unredacted capture: anything past its 24 hours goes whenever the worker starts.
const purge = () => void purgeOldDrafts(Date.now()).catch(() => 0)
purge()
chrome.runtime.onStartup?.addListener(() => {
  void initSecrets()
  purge()
})
chrome.runtime.onInstalled?.addListener(() => {
  void initSecrets()
  purge()
})

onMessage(async (m, { sender }) => {
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
    case 'capture.arm': {
      const tab = await chrome.tabs.get(m.tabId)
      if (!tab.url) return { ok: false, error: 'no_access' }
      try {
        await armTab(m.tabId, tab.url, injectCapture)
      } catch {
        return { ok: false, error: 'injection_failed' }
      }
      return { ok: true, state: await captureState(m.tabId) }
    }
    case 'capture.collected':
      // Only from the tab's current injection: onMessage checked the sender and the nonce.
      if (sender.tab?.id !== undefined) await appendEntries(sender.tab.id, m.entries)
      return { ok: true }
    case 'capture.screenshot':
    case 'capture.fullPage':
    case 'capture.textOnly': {
      if (!m.profileId) return { ok: false, error: 'no_profile' }
      const kind = m.type === 'capture.fullPage' ? 'fullPage' : m.type === 'capture.textOnly' ? 'textOnly' : 'screenshot'
      try {
        const r = await startReport({ tabId: m.tabId, profileId: m.profileId, kind, projectId: m.projectId, attach: m.attach })
        return { ok: true, ...r }
      } catch (e) {
        if (e instanceof TabChangedError) return { ok: false, error: 'tab_changed' }
        throw e
      }
    }
    case 'capture.state':
      return { ok: true, state: await captureState(m.tabId), counts: countsOf(await entries(m.tabId)) }
    default:
      return { ok: false, error: 'not_implemented' }
  }
}, { nonceFor })

const countsOf = (e: Awaited<ReturnType<typeof entries>>) => ({ console: e.console.length, errors: e.console.filter((c) => c.level === 'error' || c.level === 'exception' || c.level === 'rejection').length, failedRequests: e.network.filter((n) => n.failed).length })

chrome.tabs.onUpdated.addListener((tabId, change, tab) => void onTabUpdated(tabId, change, tab, injectCapture).catch(() => {}))
chrome.tabs.onRemoved.addListener((tabId) => void onTabRemoved(tabId).catch(() => {}))
