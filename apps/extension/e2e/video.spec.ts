import { expect, test } from './fixtures'

if (process.env.DEMO) test.use({ video: 'on' })

test('record a clip of the tab, stop, and send it', async ({ context, yoda, app, openPopup, connect, tabIdOf }) => {
  await connect()
  const page = await context.newPage()
  await page.goto(app.url)
  const tabId = await tabIdOf(app.url)

  // Record: the popup asks for tabCapture in the click, the worker starts the offscreen recorder.
  const popup = await openPopup(tabId)
  await expect(popup.getByTestId('action-record')).toBeEnabled()
  const closed = popup.waitForEvent('close')
  await popup.getByTestId('action-record').click()
  await Promise.race([closed, expect(popup.getByTestId('popup-error')).toHaveCount(0, { timeout: 15_000 }).then(() => closed)])
  await page.bringToFront()
  for (let i = 0; i < 6; i++) {
    await page.click('#fail')
    await page.waitForTimeout(400)
  }

  // Stop from the popup: the editor opens on a draft with the clip.
  const again = await openPopup(tabId)
  await expect(again.getByTestId('popup-recording')).toBeVisible()
  const editorP = context.waitForEvent('page')
  await again.getByTestId('action-stop').click()
  const editor = await editorP
  await expect(editor.getByTestId('editor-video')).toBeVisible()
  const duration = await editor.getByTestId('editor-video').evaluate(async (v: HTMLVideoElement) => {
    if (!Number.isFinite(v.duration) || v.readyState < 1) await new Promise((r) => v.addEventListener('loadedmetadata', r, { once: true }))
    return v.duration
  })
  // The duration is written into the file (fix-webm-duration): seekable, about the 2.4 s recorded.
  expect(Number.isFinite(duration)).toBe(true)
  expect(duration).toBeGreaterThan(1)

  await editor.getByTestId('report-title').locator('input').fill('วิดีโอ: เลื่อนคิวแล้วขึ้น Error 500')
  await editor.getByTestId('report-actual').locator('textarea:not([readonly])').fill('Error 500')
  await editor.getByTestId('review-confirm').locator('input').check()
  await editor.getByTestId('report-send').click()
  await expect(editor.getByTestId('report-sent')).toBeVisible()

  const [got] = yoda.reports
  const video = got!.files.find((f) => f.name === 'video.webm')!
  expect(video.type).toBe('video/webm')
  // A WebM (EBML header) of real frames.
  expect([...video.bytes.subarray(0, 4)]).toEqual([0x1a, 0x45, 0xdf, 0xa3])
  expect(video.bytes.length).toBeGreaterThan(2000)
})
