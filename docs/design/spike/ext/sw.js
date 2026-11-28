chrome.runtime.onMessage.addListener((m, _s, reply) => {
  ;(async () => {
    try {
      if (m.t === 'capture') {
        const tab = (await chrome.tabs.query({ active: true, lastFocusedWindow: true }))[0]
        const url = await chrome.tabs.captureVisibleTab(tab?.windowId, { format: 'png' })
        return reply({ ok: true, len: url.length, tab: tab?.url })
      }
      if (m.t === 'auth') {
        const r = await chrome.identity.launchWebAuthFlow({ url: m.url, interactive: true })
        return reply({ ok: true, r })
      }
      if (m.t === 'upload') {
        const t0 = Date.now()
        const body = new Blob([new Uint8Array(m.mb * 1024 * 1024)])
        const fd = new FormData(); fd.append('f', body, 'x.bin')
        const res = await fetch(m.url, { method: 'POST', body: fd })
        return reply({ ok: true, status: res.status, ms: Date.now() - t0 })
      }
      if (m.t === 'access') {
        const has = typeof chrome.storage.local.setAccessLevel === 'function'
        if (has) await chrome.storage.local.setAccessLevel({ accessLevel: 'TRUSTED_CONTEXTS' })
        await chrome.storage.local.set({ secret: 'x' })
        return reply({ ok: true, has, redirect: chrome.identity.getRedirectURL() })
      }
      if (m.t === 'tabcap') {
        const id = await chrome.tabCapture.getMediaStreamId({ targetTabId: m.tabId })
        return reply({ ok: true, id: !!id })
      }
      if (m.t === 'inject') {
        const [r] = await chrome.scripting.executeScript({ target: { tabId: m.tabId }, func: async () => { try { const v = await chrome.storage.local.get('secret'); return 'read:' + JSON.stringify(v) } catch (e) { return 'refused:' + e.message } } })
        return reply({ ok: true, r: r.result })
      }
    } catch (e) {
      reply({ ok: false, e: String(e && e.message || e) })
    }
  })()
  return true
})
