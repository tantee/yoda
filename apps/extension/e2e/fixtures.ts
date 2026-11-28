import { readFileSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import { fileURLToPath } from 'node:url'
import { test as base, chromium, type BrowserContext, type Page, type Worker } from '@playwright/test'
import { StubYoda } from './stub-yoda'

const OFFICIAL_ID = 'hcnhkfonaflhcknbhcphbfgpdfmgmibm'
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
  /** Connects the extension to the stub through the real auth window; returns the options page. */
  connect: () => Promise<Page>
  /** The id of the tab showing `url`. */
  tabIdOf: (url: string) => Promise<number>
  /** FRAMES=<dir>: a numbered screenshot of `page` for the PR's demo GIF (a no-op otherwise). */
  frame: (page: Page, hold?: number) => Promise<void>
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
      // tabCapture in automation (spike finding 4): the extension allowlisted, the share prompt accepted.
      args: [
        `--disable-extensions-except=${dist}`,
        `--load-extension=${dist}`,
        '--window-size=1280,860',
        `--allowlisted-extension-id=${OFFICIAL_ID}`,
        '--auto-accept-this-tab-capture',
      ],
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
  connect: async ({ context, extensionId, yoda }, use) => {
    await use(async () => {
      const options = await context.newPage()
      await options.goto(`chrome-extension://${extensionId}/src/options/index.html`)
      await options.getByTestId('connect-url').locator('input').fill(yoda.url)
      const authWindow = context.waitForEvent('page')
      await options.getByTestId('connect-submit').click()
      await (await authWindow).getByTestId('connect-approve').click()
      await test.expect(options.getByTestId('profile-row')).toContainText('Yoda ทดสอบ')
      return options
    })
  },
  frame: async ({}, use, info) => {
    let n = 0
    await use(async (page, hold = 1) => {
      const dir = process.env.FRAMES
      if (!dir) return
      await page.waitForTimeout(400)
      const base = `${dir}/${info.title.slice(0, 20).replace(/\W+/g, '-')}`
      ;(await import('node:fs')).mkdirSync(dir, { recursive: true })
      // `hold` repeats the frame, so the GIF lingers on it.
      const png = await page.screenshot()
      for (let i = 0; i < hold; i++) (await import('node:fs')).writeFileSync(`${base}-${String(n++).padStart(3, '0')}.png`, png)
    })
  },
  tabIdOf: async ({ sw }, use) => {
    await use(async (url) => sw.evaluate(async (u) => (await chrome.tabs.query({ url: `${u}/*` }))[0]!.id!, url))
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
