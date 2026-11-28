import { expect, test } from './fixtures'
import { LAB } from './stub-yoda'

if (process.env.DEMO) test.use({ video: 'on' })

test('arm the replay buffer on a mapped page, interact, save the last seconds and send them', async ({ context, yoda, app, sw, openPopup, connect, tabIdOf, frame }) => {
  // The replay buffer is for mapped sites: Yoda maps this app (not production).
  yoda.rules = [{ pattern: `http://localhost:${new URL(app.url).port}/*`, projectId: LAB, environment: 'uat', production: false, source: 'app_url', build: null }]
  await connect()
  const page = await context.newPage()
  await page.goto(app.url)
  const tabId = await tabIdOf(app.url)
  const badge = () => sw.evaluate((id) => chrome.action.getBadgeText({ tabId: id }), tabId)

  // Arm: the popup asks for tabCapture in the click; the offscreen document keeps the segments in memory.
  const popup = await openPopup(tabId)
  await expect(popup.getByTestId('action-buffer-arm')).toBeEnabled()
  await frame(popup, 3)
  await popup.getByTestId('action-buffer-arm').click()
  await expect(popup.getByTestId('popup-buffer')).toBeVisible({ timeout: 15_000 })
  await expect(popup.getByTestId('popup-error')).toHaveCount(0)
  await expect(popup.getByTestId('action-buffer-save')).toBeVisible()
  await frame(popup, 3)
  expect(await badge()).toBe('●')
  // Nothing of the buffer is stored while armed: no clip in IndexedDB.
  const stored = () => sw.evaluate(async () => (await indexedDB.databases()).map((d) => d.name))
  await popup.close()

  await page.bringToFront()
  for (let i = 0; i < 8; i++) {
    await page.click('#fail')
    await page.waitForTimeout(500)
    if (i % 3 === 0) await frame(page)
  }
  const clipsDb = (await stored()).includes('yoda-clips')
  if (clipsDb) {
    const n = await sw.evaluate(
      () =>
        new Promise<number>((resolve) => {
          const q = indexedDB.open('yoda-clips')
          q.onsuccess = () => {
            const db = q.result
            if (!db.objectStoreNames.contains('clips')) return resolve(0)
            const c = db.transaction('clips').objectStore('clips').count()
            c.onsuccess = () => resolve(c.result)
          }
        }),
    )
    expect(n).toBe(0)
  }

  // Save: the editor opens on a draft with the buffer's segment(s).
  const again = await openPopup(tabId)
  await expect(again.getByTestId('action-buffer-save')).toBeVisible()
  await frame(again, 3)
  const editorP = context.waitForEvent('page')
  await again.getByTestId('action-buffer-save').click()
  const editor = await editorP
  await editor.bringToFront()
  await expect(editor.getByTestId('editor-buffer')).toBeVisible()
  await expect(editor.getByTestId('editor-buffer-part-0')).toBeVisible()
  const duration = await editor.getByTestId('editor-video').evaluate(async (v: HTMLVideoElement) => {
    if (!Number.isFinite(v.duration) || v.readyState < 1) await new Promise((r) => v.addEventListener('loadedmetadata', r, { once: true }))
    return v.duration
  })
  // A standalone WebM with its duration written in: about the 4 s recorded.
  expect(Number.isFinite(duration)).toBe(true)
  expect(duration).toBeGreaterThan(2)
  await frame(editor, 3)
  // Saving disarmed it.
  expect(await badge()).toBe('')

  await editor.getByTestId('report-title').locator('input').fill('ย้อนหลัง: กดบันทึกแล้วขึ้น Error 500')
  await editor.getByTestId('report-actual').locator('textarea:not([readonly])').fill('Error 500')
  await expect(editor.getByTestId('review-file-buffer')).toBeVisible()
  await editor.getByTestId('review-confirm').locator('input').check()
  await frame(editor, 2)
  await editor.getByTestId('report-send').click()
  await expect(editor.getByTestId('report-sent')).toBeVisible()
  await frame(editor, 4)

  const [got] = yoda.reports
  const parts = got!.files.filter((f) => /^buffer-\d+\.webm$/.test(f.name))
  expect(parts.length).toBeGreaterThanOrEqual(1)
  expect(got!.report.attachments.filter((a) => a.role === 'buffer').map((a) => a.name)).toEqual(parts.map((p) => p.name))
  for (const p of parts) {
    expect(p.type).toBe('video/webm')
    // A WebM (EBML header) of real frames.
    expect([...p.bytes.subarray(0, 4)]).toEqual([0x1a, 0x45, 0xdf, 0xa3])
    expect(p.bytes.length).toBeGreaterThan(2000)
  }
  // The handed-over clips are gone once the draft held them.
  if ((await stored()).includes('yoda-clips')) {
    const left = await sw.evaluate(
      () =>
        new Promise<number>((resolve) => {
          const q = indexedDB.open('yoda-clips')
          q.onsuccess = () => {
            const c = q.result.transaction('clips').objectStore('clips').count()
            c.onsuccess = () => resolve(c.result)
          }
        }),
    )
    expect(left).toBe(0)
  }
})

test('segments rotate in a real browser: two standalone WebM parts, each playable, sent as buffer-1 and buffer-2', async ({ context, yoda, app, sw, openPopup, connect, tabIdOf }) => {
  yoda.rules = [{ pattern: `http://localhost:${new URL(app.url).port}/*`, projectId: LAB, environment: 'uat', production: false, source: 'app_url', build: null }]
  await connect()
  const page = await context.newPage()
  await page.goto(app.url)
  const tabId = await tabIdOf(app.url)
  // The click grants tabCapture; then re-armed with 2 s segments (honoured by the e2e build only).
  const popup = await openPopup(tabId)
  await popup.getByTestId('action-buffer-arm').click()
  await expect(popup.getByTestId('action-buffer-stop')).toBeVisible({ timeout: 15_000 })
  await popup.getByTestId('action-buffer-stop').click()
  await expect(popup.getByTestId('action-buffer-arm')).toBeVisible()
  expect(await sw.evaluate((id) => chrome.action.getBadgeText({ tabId: id }), tabId)).toBe('')
  const r = await popup.evaluate(async (id) => {
    const { profiles } = (await chrome.storage.local.get('profiles')) as { profiles: { id: string }[] }
    return chrome.runtime.sendMessage({ type: 'buffer.arm', tabId: id, profileId: profiles[0]!.id, segmentMs: 2000 })
  }, tabId)
  expect(r).toEqual({ ok: true })
  await popup.close()
  await page.bringToFront()
  for (let i = 0; i < 11; i++) {
    await page.click('#fail')
    await page.waitForTimeout(500)
  }
  const again = await openPopup(tabId)
  const editorP = context.waitForEvent('page')
  await again.getByTestId('action-buffer-save').click()
  const editor = await editorP
  await editor.bringToFront()
  await expect(editor.getByTestId('editor-buffer-part-1')).toBeVisible()
  const durationOf = () =>
    editor.getByTestId('editor-video').evaluate(async (v: HTMLVideoElement) => {
      if (!Number.isFinite(v.duration) || v.readyState < 1) await new Promise((r) => v.addEventListener('loadedmetadata', r, { once: true }))
      return v.duration
    })
  // The previous part is a complete 2 s segment; the current one what was recorded since.
  const first = await durationOf()
  expect(first).toBeGreaterThan(1.5)
  expect(first).toBeLessThan(3)
  await editor.getByTestId('editor-buffer-part-1').click()
  expect(Number.isFinite(await durationOf())).toBe(true)

  await editor.getByTestId('report-title').locator('input').fill('ย้อนหลังสองช่วง')
  await editor.getByTestId('review-confirm').locator('input').check()
  await editor.getByTestId('report-send').click()
  await expect(editor.getByTestId('report-sent')).toBeVisible()
  const parts = yoda.reports[0]!.files.filter((f) => /^buffer-\d+\.webm$/.test(f.name))
  expect(parts.map((p) => p.name)).toEqual(['buffer-1.webm', 'buffer-2.webm'])
  for (const p of parts) expect([...p.bytes.subarray(0, 4)]).toEqual([0x1a, 0x45, 0xdf, 0xa3])
})

test('the replay buffer is not offered on a page no rule maps, nor on production', async ({ context, yoda, app, openPopup, connect, tabIdOf }) => {
  await connect()
  const page = await context.newPage()
  await page.goto(app.url)
  const popup = await openPopup(await tabIdOf(app.url))
  await expect(popup.getByTestId('action-screenshot')).toBeEnabled()
  // Video yes (not production), the buffer no (not mapped).
  await expect(popup.getByTestId('action-record')).toBeVisible()
  await expect(popup.getByTestId('action-buffer-arm')).toHaveCount(0)
  await popup.close()

  yoda.rules = [{ pattern: `${app.url}/*`, projectId: LAB, environment: 'production', production: true, source: 'gitlab', build: null }]
  const prod = await openPopup(await tabIdOf(app.url))
  await expect(prod.getByTestId('popup-production')).toBeVisible()
  await expect(prod.getByTestId('action-buffer-arm')).toHaveCount(0)
})
