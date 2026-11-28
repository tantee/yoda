import type { DefectClient, DefectPage } from '@yoda/shared'

/** What the ISOLATED script reads from the page on click (no page script runs it; nothing is masked: D2). */
export type PageMetadata = {
  page: DefectPage
  buildSources: { meta: string | null; wellKnown: unknown | null; headers: string[] }
  client: Omit<DefectClient, 'extensionVersion'>
}

/** The "include query string" switch off: the query goes, the hash stays (SPA routes live there). */
export function stripQuery(url: string): string {
  try {
    const u = new URL(url)
    u.search = ''
    return u.toString()
  } catch {
    return url
  }
}

type UaData = {
  brands?: { brand: string; version: string }[]
  platform?: string
  getHighEntropyValues?: (hints: string[]) => Promise<{ fullVersionList?: { brand: string; version: string }[]; platformVersion?: string; platform?: string }>
}

async function clientInfo(): Promise<PageMetadata['client']> {
  const ua = (navigator as unknown as { userAgentData?: UaData }).userAgentData
  let browser = 'Chrome'
  let browserVersion = ''
  let os = ua?.platform ?? navigator.platform ?? ''
  let osVersion = ''
  try {
    const hi = await ua?.getHighEntropyValues?.(['fullVersionList', 'platformVersion'])
    const list = hi?.fullVersionList ?? ua?.brands ?? []
    // The real browser: Edge, then Chrome, then Chromium; never a GREASE brand such as "Not.A/Brand".
    const real = list.filter((b) => !/not.?a.?brand/i.test(b.brand))
    const pick = real.find((b) => /edge/i.test(b.brand)) ?? real.find((b) => /chrome/i.test(b.brand) && !/chromium/i.test(b.brand)) ?? real.find((b) => /chromium/i.test(b.brand)) ?? real[0]
    if (pick) {
      browser = pick.brand.replace(/^(Microsoft|Google) /, '')
      browserVersion = pick.version
    }
    os = hi?.platform ?? os
    osVersion = hi?.platformVersion ?? ''
  } catch {
    // low-entropy values only
  }
  return {
    browser: browser.slice(0, 200),
    browserVersion: browserVersion.slice(0, 200),
    os: os.slice(0, 200),
    osVersion: osVersion.slice(0, 200),
    viewport: { w: window.innerWidth, h: window.innerHeight, dpr: window.devicePixelRatio || 1 },
    zoom: Math.round((window.outerWidth / Math.max(1, window.innerWidth)) * 100) / 100 || 1,
    locale: navigator.language.slice(0, 200),
    timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone.slice(0, 200),
  }
}

/** Runs in the page's ISOLATED world: the page, the build sources (same-origin well-known, 1 s) and the client. */
export async function collectMetadata(opts: { wellKnownTimeoutMs?: number } = {}): Promise<PageMetadata> {
  const metaContent = (name: string) => document.querySelector<HTMLMetaElement>(`meta[name="${name}"]`)?.content ?? null
  const routeName = metaContent('yoda-route')
  const route = `${location.pathname}${location.hash}${routeName ? ` (${routeName})` : ''}`.slice(0, 200)

  let wellKnown: unknown | null = null
  const headers: string[] = []
  try {
    const res = await fetch(`${location.origin}/.well-known/yoda-build.json`, {
      credentials: 'same-origin',
      cache: 'no-store',
      signal: AbortSignal.timeout(opts.wellKnownTimeoutMs ?? 1000),
    })
    const h = res.headers.get('x-yoda-build')
    if (h) headers.push(h)
    // Any content type: some servers send static JSON as text/plain. Only parsed data is kept (detectBuild filters).
    if (res.ok) wellKnown = await res.json().catch(() => null)
  } catch {
    // none, or too slow
  }
  return {
    page: { url: location.href.slice(0, 2048), title: document.title.slice(0, 300), route },
    buildSources: { meta: metaContent('yoda-build'), wellKnown, headers },
    client: await clientInfo(),
  }
}
