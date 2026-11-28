// An in-memory stand-in for the chrome.* APIs the extension's modules use (unit tests only).
type Listener = (msg: unknown, sender: chrome.runtime.MessageSender, reply: (r: unknown) => void) => boolean | void

function area(name: string) {
  const data = new Map<string, unknown>()
  return {
    name,
    data,
    accessLevel: 'TRUSTED_AND_UNTRUSTED_CONTEXTS' as string,
    async get(keys?: string | string[] | null) {
      if (keys == null) return Object.fromEntries(data)
      const list = Array.isArray(keys) ? keys : [keys]
      return Object.fromEntries(list.filter((k) => data.has(k)).map((k) => [k, structuredClone(data.get(k))]))
    },
    async set(items: Record<string, unknown>) {
      for (const [k, v] of Object.entries(items)) data.set(k, structuredClone(v))
    },
    async remove(keys: string | string[]) {
      for (const k of Array.isArray(keys) ? keys : [keys]) data.delete(k)
    },
    async clear() {
      data.clear()
    },
    async setAccessLevel(o: { accessLevel: string }) {
      this.accessLevel = o.accessLevel
    },
  }
}

export type FakeChrome = ReturnType<typeof makeChrome>

export function makeChrome(opts: { id?: string } = {}) {
  const id = opts.id ?? 'hcnhkfonaflhcknbhcphbfgpdfmgmibm'
  const listeners: Listener[] = []
  const calls: string[] = []
  const granted = new Set<string>()
  const fake = {
    calls,
    granted,
    storage: { local: area('local'), session: area('session') },
    runtime: {
      id,
      getURL: (p: string) => `chrome-extension://${id}/${p.replace(/^\//, '')}`,
      getManifest: () => ({ version: '1.2.0.1000', version_name: '1.2.0' }),
      onMessage: { addListener: (l: Listener) => listeners.push(l), removeListener: () => {} },
      /** Delivers a message as Chrome would, with the given sender. */
      deliver(msg: unknown, sender: chrome.runtime.MessageSender): Promise<unknown> {
        return new Promise((resolve) => {
          let answered = false
          for (const l of listeners) {
            const keep = l(msg, sender, (r) => {
              answered = true
              resolve(r)
            })
            if (keep === true) return
          }
          if (!answered) resolve(undefined)
        })
      },
      sendMessage: async (msg: unknown) => fake.runtime.deliver(msg, { id, url: `chrome-extension://${id}/src/editor/index.html`, origin: `chrome-extension://${id}` }),
    },
    permissions: {
      request: async (p: { origins?: string[] }) => {
        calls.push(`permissions.request:${(p.origins ?? []).join(',')}`)
        for (const o of p.origins ?? []) granted.add(o)
        return true
      },
      remove: async (p: { origins?: string[] }) => {
        calls.push(`permissions.remove:${(p.origins ?? []).join(',')}`)
        for (const o of p.origins ?? []) granted.delete(o)
        return true
      },
      contains: async (p: { origins?: string[] }) => (p.origins ?? []).every((o) => granted.has(o)),
    },
    identity: {
      getRedirectURL: () => `https://${id}.chromiumapp.org/`,
      launchWebAuthFlow: async (_o: { url: string; interactive: boolean }): Promise<string | undefined> => undefined,
    },
  }
  return fake
}

/** Installs a fresh fake as globalThis.chrome and returns it. */
export function installChrome(opts: { id?: string } = {}): FakeChrome {
  const fake = makeChrome(opts)
  ;(globalThis as unknown as { chrome: unknown }).chrome = fake
  return fake
}
