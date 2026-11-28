// Phase 0 spike (B1), scratch only: see docs/design/extension-spike.md. somchai/dev is the DEV ONLY local realm user.
import { chromium } from 'playwright'
const S = process.argv[2]
const ctx = await chromium.launchPersistentContext(`${S}/profile2`, { executablePath: process.env.CHROME, headless: true, args: [`--disable-extensions-except=${S}/ext`, `--load-extension=${S}/ext`] })
let [sw] = ctx.serviceWorkers(); if (!sw) sw = await ctx.waitForEvent('serviceworker')
const id = new URL(sw.url()).host
const page = await ctx.newPage()
await page.goto('http://localhost:3100/todo')
await page.waitForURL(/18181/); await page.fill('#username', 'somchai'); await page.fill('#password', 'dev'); await page.click('#kc-login')
await page.waitForURL(/localhost:3100\/todo/); await page.waitForTimeout(1500)
const popup = await ctx.newPage(); await popup.goto(`chrome-extension://${id}/popup.html`)
const url = `http://localhost:3100/extension/connect?ext=${id}&redirect_uri=${encodeURIComponent(`https://${id}.chromiumapp.org/`)}&code_challenge=${'a'.repeat(43)}&state=s&browser=spike`
const before = ctx.pages().length
const auth = popup.evaluate((url) => chrome.runtime.sendMessage({ t: 'auth', url }), url)
const win = await ctx.waitForEvent('page', { timeout: 10000 })
await win.waitForURL(/extension\/connect/, { timeout: 20000 }).catch(() => {})
await win.waitForTimeout(3000)
const approve = await win.getByTestId('connect-approve').count()
const r = { authWindowUrl: win.url().slice(0, 60), approveButton: approve }
if (approve) { await win.getByTestId('connect-approve').click(); await win.waitForTimeout(2500); r.error = await win.getByTestId('connect-error').textContent().catch(() => null) }
await win.close().catch(() => {})
r.result = await Promise.race([auth, new Promise((res) => setTimeout(() => res('timeout'), 3000))])
console.log(JSON.stringify(r))
await ctx.close()
