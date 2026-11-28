// Phase 0 spike (B1), scratch only: see docs/design/extension-spike.md.
import { chromium } from 'playwright'
import http from 'node:http'
const S = process.argv[2]
const srv = http.createServer((req, res) => { let n = 0; req.on('data', (c) => (n += c.length)); req.on('end', () => { res.writeHead(200, { 'access-control-allow-origin': '*' }); res.end(String(n)) }) }).listen(4999)
const out = {}
const ctx = await chromium.launchPersistentContext(`${S}/profile`, {
  executablePath: process.env.CHROME, channel: undefined,
  headless: true,
  args: [`--disable-extensions-except=${S}/ext`, `--load-extension=${S}/ext`, '--auto-accept-this-tab-capture', `--allowlisted-extension-id=<the unpacked spike ID>`, '--auto-select-desktop-capture-source=Entire screen'],
})
let [sw] = ctx.serviceWorkers()
if (!sw) sw = await ctx.waitForEvent('serviceworker')
const id = new URL(sw.url()).host
out.id = id
const page = await ctx.newPage()
await page.goto('https://example.org/')
const popup = await ctx.newPage()
await popup.goto(`chrome-extension://${id}/popup.html?tab=1`)
const msg = (m) => popup.evaluate((m) => chrome.runtime.sendMessage(m), m)
await page.bringToFront()
out.capture = await msg({ t: 'capture' })
out.access = await msg({ t: 'access' })
const tabId = await popup.evaluate(async () => (await chrome.tabs.query({ url: 'https://example.org/*' }))[0]?.id)
out.tabcap = await msg({ t: 'tabcap', tabId })
out.inject = await msg({ t: 'inject', tabId })
out.tabcapAllowlisted = out.tabcap
out.swUpload40 = await msg({ t: 'upload', url: 'http://localhost:4999/', mb: 40 })
out.pageUpload40 = await popup.evaluate(() => window.upload('http://localhost:4999/', 40))
await popup.click('#now'); await popup.click('#after'); await popup.waitForTimeout(1500)
out.permissions = await popup.textContent('#out')
// launchWebAuthFlow: does Playwright see the auth window as a page?
const pagesBefore = ctx.pages().length
const authP = msg({ t: 'auth', url: process.argv[3] })
await new Promise((r) => setTimeout(r, 4000))
out.authWindowSeen = ctx.pages().length > pagesBefore ? ctx.pages().map((p) => p.url()).slice(pagesBefore) : 'no new page'
out.auth = await Promise.race([authP, new Promise((r) => setTimeout(() => r('timeout'), 3000))])
console.log(JSON.stringify(out, null, 1))
await ctx.close(); srv.close()
