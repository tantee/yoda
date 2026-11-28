import { readFileSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import { fileURLToPath } from 'node:url'
import { test as base, chromium, type BrowserContext, type Page, type Worker } from '@playwright/test'
import { StubYoda } from './stub-yoda'

const dist = fileURLToPath(new URL('../dist-e2e', import.meta.url))
const appHtml = readFileSync(fileURLToPath(new URL('./app-under-test/index.html', import.meta.url)))

/** The page under test, on its own origin: `/` and a `/api/fail` that answers 500. */
async function appServer(): Promise<{ url: string; close: () => Promise<void> }> {
  const s: Server = createServer((q, r) => {
    if (q.url === '/') {
      r.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
      return r.end(appHtml)
    }
    r.writeHead(q.url === '/api/fail' ? 500 : 404, { 'content-type': 'application/json' })
    r.end('{"error":"internal"}')
  })
  await new Promise<void>((res) => s.listen(0, '127.0.0.1', () => res()))
  return { url: `http://localhost:${(s.address() as { port: number }).port}`, close: () => new Promise((res) => { s.close(() => res()); s.closeAllConnections() }) }
}

type Fixtures = {
  yoda: StubYoda
  app: { url: string }
  context: BrowserContext
  sw: Worker
  extensionId: string
  /** The popup as a page, aimed at a tab (the e2e build alone honours ?tab=). */
  openPopup: (tabId: number) => Promise<Page>
}

export const test = base.extend<Fixtures>({
  yoda: async ({}, use) => {
    const y = new StubYoda()
    await y.start()
    await use(y)
    await y.stop()
  },
  app: async ({}, use) => {
    const a = await appServer()
    await use({ url: a.url })
    await a.close()
  },
  context: async ({}, use) => {
    const ctx = await chromium.launchPersistentContext('', {
      // Locally, CHROME may point at an installed Chromium; CI uses Playwright's.
      executablePath: process.env.CHROME || undefined,
      channel: process.env.CHROME ? undefined : 'chromium',
      headless: !process.env.HEADED,
      // captureVisibleTab grabs the real window, not an emulated viewport: size the window itself.
      viewport: null,
      args: [`--disable-extensions-except=${dist}`, `--load-extension=${dist}`, '--window-size=1280,860'],
    })
    await use(ctx)
    await ctx.close()
  },
  sw: async ({ context }, use) => {
    let [w] = context.serviceWorkers()
    if (!w) w = await context.waitForEvent('serviceworker')
    await use(w)
  },
  extensionId: async ({ sw }, use) => {
    await use(new URL(sw.url()).host)
  },
  openPopup: async ({ context, extensionId }, use) => {
    await use(async (tabId) => {
      const p = await context.newPage()
      await p.goto(`chrome-extension://${extensionId}/src/popup/index.html?tab=${tabId}`)
      return p
    })
  },
})

export const expect = test.expect
