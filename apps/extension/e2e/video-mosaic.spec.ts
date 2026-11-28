import { expect, test } from './fixtures'

if (process.env.DEMO) test.use({ video: 'on' })

test('record a clip, mosaic the patient card for 1–3 s, apply, send', async ({ context, yoda, app, openPopup, connect, tabIdOf, frame }) => {
  await connect()
  const page = await context.newPage()
  await page.goto(app.url)
  const tabId = await tabIdOf(app.url)
  // The patient card in CSS pixels of the captured tab, and the tab's size (the clip is scaled from it).
  const card = await page.evaluate(() => {
    const r = document.getElementById('patient')!.getBoundingClientRect()
    return { x: r.x, y: r.y, w: r.width, h: r.height, vw: innerWidth, vh: innerHeight }
  })

  const popup = await openPopup(tabId)
  await expect(popup.getByTestId('action-record')).toBeEnabled()
  await frame(popup, 3)
  const closed = popup.waitForEvent('close')
  await popup.getByTestId('action-record').click()
  await Promise.race([closed, expect(popup.getByTestId('popup-error')).toHaveCount(0, { timeout: 15_000 }).then(() => closed)])
  await page.bringToFront()
  await frame(page, 2)
  for (let i = 0; i < 10; i++) {
    await page.click('#fail')
    await page.waitForTimeout(500)
  }
  const again = await openPopup(tabId)
  const editorP = context.waitForEvent('page')
  await again.getByTestId('action-stop').click()
  const editor = await editorP
  await editor.bringToFront()

  // 1. Seek to 1 s and drag a region over the card (inset, so it stays on the stripes).
  const player = editor.getByTestId('editor-video')
  await expect(editor.getByTestId('video-overlay')).toBeVisible()
  const vid = await player.evaluate(async (v: HTMLVideoElement) => {
    v.currentTime = 1
    await new Promise((r) => v.addEventListener('seeked', r, { once: true }))
    return { w: v.videoWidth, h: v.videoHeight, duration: v.duration }
  })
  expect(vid.duration).toBeGreaterThan(4.5)
  // Tab capture letterboxes the page into the clip's frame: scale to fit, centred.
  const scale = Math.min(vid.w / card.vw, vid.h / card.vh)
  const ox = (vid.w - card.vw * scale) / 2
  const oy = (vid.h - card.vh * scale) / 2
  const want = { x: ox + (card.x + 20) * scale, y: oy + (card.y + 20) * scale, w: (card.w - 40) * scale, h: (card.h - 40) * scale }
  const box = (await editor.getByTestId('video-overlay').boundingBox())!
  const s = box.width / vid.w
  await editor.mouse.move(box.x + want.x * s, box.y + want.y * s)
  await editor.mouse.down()
  await editor.mouse.move(box.x + (want.x + want.w) * s, box.y + (want.y + want.h) * s, { steps: 8 })
  await editor.mouse.up()
  await expect(editor.getByTestId('video-region-0')).toContainText(/1\.0.+3\.0/)
  await frame(editor, 4)
  const [x, y, w, h, block] = (await editor.getByTestId('video-region-box-0').getAttribute('data-rect'))!.split(',').map(Number) as [number, number, number, number, number]

  // Unapplied regions block Send.
  await editor.getByTestId('report-title').locator('input').fill('วิดีโอ: บัตรผู้ป่วยถูกปิดด้วยโมเสก')
  await editor.getByTestId('review-confirm').locator('input').check()
  await expect(editor.getByTestId('report-mosaic-pending')).toBeVisible()
  await expect(editor.getByTestId('report-send')).toBeDisabled()
  await frame(editor, 3)

  // 2. Apply: the clip is re-encoded with the region burned in.
  await editor.getByTestId('video-apply').click()
  await expect(editor.getByTestId('video-applied')).toBeVisible({ timeout: 90_000 })
  await frame(editor, 4)
  await expect(editor.getByTestId('report-send')).toBeEnabled()
  await editor.getByTestId('report-send').click()
  await expect(editor.getByTestId('report-sent')).toBeVisible()
  await frame(editor, 4)

  // 3. Decode what Yoda received: block-uniform in the region at 2 s, the stripes back at 4 s.
  const [got] = yoda.reports
  const video = got!.files.find((f) => f.name === 'video.webm')!
  expect([...video.bytes.subarray(0, 4)]).toEqual([0x1a, 0x45, 0xdf, 0xa3])
  if (process.env.E2E_SAVE) (await import('node:fs')).writeFileSync(process.env.E2E_SAVE, video.bytes)
  const stdAt = (t: number) =>
    editor.evaluate(
      async ({ b64, t, x, y, w, h, block }) => {
        const v = document.createElement('video')
        v.muted = true
        v.src = URL.createObjectURL(await (await fetch(`data:video/webm;base64,${b64}`)).blob())
        await new Promise((r) => v.addEventListener('loadedmetadata', r, { once: true }))
        if (!Number.isFinite(v.duration)) {
          v.currentTime = 1e9
          await new Promise((r) => v.addEventListener('durationchange', r, { once: true }))
        }
        v.currentTime = t
        await new Promise((r) => v.addEventListener('seeked', r, { once: true }))
        const c = new OffscreenCanvas(v.videoWidth, v.videoHeight)
        const ctx = c.getContext('2d', { willReadFrequently: true })!
        ctx.drawImage(v, 0, 0)
        URL.revokeObjectURL(v.src)
        // Per mosaic block (the grid starts at the region), the largest channel standard deviation, 2 px inside
        // each block so the codec's edge ringing does not count.
        const stds: number[] = []
        const bad: string[] = []
        for (let by = y; by + block <= y + h; by += block)
          for (let bx = x; bx + block <= x + w; bx += block) {
            const d = ctx.getImageData(bx + 2, by + 2, block - 4, block - 4).data
            let worst = 0
            for (let k = 0; k < 3; k++) {
              let sum = 0
              let sq = 0
              const n = d.length / 4
              for (let i = k; i < d.length; i += 4) {
                sum += d[i]!
                sq += d[i]! * d[i]!
              }
              worst = Math.max(worst, Math.sqrt(Math.max(0, sq / n - (sum / n) ** 2)))
            }
            stds.push(worst)
            if (worst >= 6) bad.push(`${bx - x},${by - y}:${worst.toFixed(1)}`)
          }
        return { bad, max: Math.max(...stds), mean: stds.reduce((a, b) => a + b, 0) / stds.length, n: stds.length }
      },
      { b64: video.bytes.toString('base64'), t, x, y, w, h, block },
    )
  const inside = await stdAt(2)
  const after = await stdAt(4)
  expect(inside.n).toBeGreaterThan(10)
  expect(inside.max, `blocks that are not uniform: ${inside.bad.join(' ')}`).toBeLessThan(6)
  expect(after.mean).toBeGreaterThan(20)
})
