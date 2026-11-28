import { ExtensionSession } from '@yoda/shared'
import { accessToken, yodaFetch } from './api'
import { appendEntries, armTab, captureState, entries, nonceFor, onTabRemoved, onTabUpdated } from './capture-session'
import { purgeOldDrafts } from '../drafts/db'
import { TabChangedError } from '../capture/screenshot'
import { purgeClips, takeClip } from '../drafts/clips'
import { endClip, jobs, startClip, stopClip } from './offscreen'
import { injectCapture } from './inject'
import { pageMetadata, startReport } from './report-start'
import { allRules, deleteMineRule, repoOf, resolveUrl, saveMineRule } from './rules'
import { pickRule } from '../rules/match'
import { onMessage } from './messages'
import { exchangeProfile, removeProfile, updateProfileSettings } from './profiles'
import { initSecrets } from './secrets'
import { getProfile } from './store'

// The service worker keeps no state beyond in-flight promises (plan B3): everything lives in storage.
// Content scripts never read storage (TRUSTED_CONTEXTS), set before anything is written.
const ready = initSecrets()
// Drafts hold the unredacted capture: anything past its 24 hours goes whenever the worker starts.
const purge = () => {
  void purgeOldDrafts(Date.now()).catch(() => 0)
  // A clip is taken into a draft at once; one left behind (a crash in between) goes after an hour.
  void purgeClips(Date.now(), 3600_000).catch(() => 0)
}
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
    case 'video.start':
      return startClip(m)
    case 'video.stop':
      await stopClip()
      return { ok: true }
    case 'video.state':
      return { ok: true, clip: (await jobs()).clip ?? null }
    case 'video.done': {
      const job = await endClip()
      const clip = await takeClip(m.clipId)
      if (!job || !clip || job.tabId !== m.tabId) return { ok: false, error: 'unknown_clip' }
      const r = await startReport({ tabId: job.tabId, profileId: job.profileId, kind: 'video', projectId: job.projectId, attach: job.attach, video: clip.blob })
      return { ok: true, ...r }
    }
    case 'mapping.resolve': {
      const tab = await chrome.tabs.get(m.tabId)
      const url = tab.url ?? ''
      if (!/^https?:/i.test(url)) return { ok: true, resolved: null }
      const resolved = await resolveUrl(url, { refresh: m.refresh, readBuild: async () => repoOf(await pageMetadata(m.tabId)) })
      return { ok: true, resolved }
    }
    case 'rules.list':
      return { ok: true, rules: await allRules({ refresh: m.refresh }) }
    case 'rules.saveMine': {
      const r = await saveMineRule(m.rule)
      return r.ok ? r : { ok: false, error: 'invalid', errors: r.errors }
    }
    case 'rules.deleteMine':
      return deleteMineRule(m.id)
    case 'profile.update':
      return updateProfileSettings(m.profileId, m)
    case 'mapping.test': {
      // The options page's URL tester: the rules as they stand (no refresh), the winner and why.
      const picked = pickRule(m.url, await allRules())
      return { ok: true, picked }
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
