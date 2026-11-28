import { expect, test } from './fixtures'

// `pnpm --filter @yoda/extension demo` records this flow (test-results/**/video.webm); docs/design/screenshots/extension/
// demo-mvp.gif was recorded the same way against the demo stack.
if (process.env.DEMO) test.use({ video: 'on' })

test('connect, arm, reproduce, screenshot, mosaic, send', async ({ context, extensionId, yoda, app, openPopup }) => {
  // 1. Connect through the real auth window (spike finding 3): the stub's approve page redirects back.
  const options = await context.newPage()
  await options.goto(`chrome-extension://${extensionId}/src/options/index.html`)
  await options.getByTestId('connect-url').locator('input').fill(yoda.url)
  const authWindow = context.waitForEvent('page')
  await options.getByTestId('connect-submit').click()
  await (await authWindow).getByTestId('connect-approve').click()
  await expect(options.getByTestId('profile-row')).toContainText('Yoda ทดสอบ')

  // 2. The app, armed capture, the failing action.
  const page = await context.newPage()
  await page.goto(app.url)
  const tabId = await options.evaluate(async (u) => (await chrome.tabs.query({ url: `${u}/*` }))[0]!.id!, app.url)
  const popup = await openPopup(tabId)
  await expect(popup.getByTestId('action-screenshot')).toBeEnabled()
  await popup.getByTestId('action-arm').click()
  await expect(popup.getByTestId('popup-capture')).toContainText(/log/)
  await page.bringToFront()
  await page.click('#fail')
  await page.waitForTimeout(1200)

  // 3. Screenshot: the editor opens on the draft.
  const editorP = context.waitForEvent('page')
  await popup.getByTestId('action-screenshot').click()
  const editor = await editorP
  const canvas = editor.getByTestId('editor-canvas')
  await expect(canvas).toBeVisible()
  await expect(editor.getByTestId('report-project')).toContainText('ระบบนัดหมาย OPD')

  // 4. A mosaic rectangle over the patient band, and one brush stroke; 5. an arrow and a step number.
  const natural = await canvas.evaluate((c: HTMLCanvasElement) => c.width)
  // Measured per action: picking a tool shows a hint line that moves the canvas.
  const at = async (x: number, y: number) => {
    const box = (await canvas.boundingBox())!
    const s = box.width / natural
    return [box.x + x * s, box.y + y * s] as const
  }
  const drag = async (from: [number, number], to: [number, number]) => {
    await editor.mouse.move(...(await at(...from)))
    await editor.mouse.down()
    await editor.mouse.move(...(await at(...to)), { steps: 6 })
    await editor.mouse.up()
  }
  // The striped patient card spans about y 62..214 of the capture (header 42 px, padding 20).
  const mosaic = { x: 40, y: 80, w: 600, h: 96 }
  await editor.getByTestId('tool-mosaic').click()
  await drag([mosaic.x, mosaic.y], [mosaic.x + mosaic.w, mosaic.y + mosaic.h])
  await editor.getByTestId('tool-mosaic-brush').click()
  await drag([700, 100], [900, 160])
  await editor.getByTestId('tool-arrow').click()
  await drag([500, 300], [300, 230])
  await editor.getByTestId('tool-step').click()
  await editor.mouse.click(...(await at(280, 220)))

  // 6. The form, the check, send.
  await editor.getByTestId('report-title').locator('input').fill('เลื่อนคิวแล้วขึ้น Error 500')
  await editor.getByTestId('report-step-0').locator('input').fill('กดเลื่อนคิว')
  await editor.getByTestId('report-actual').locator('textarea:not([readonly])').fill('Error 500')
  await expect(editor.getByTestId('report-send')).toBeDisabled()
  await editor.getByTestId('review-confirm').locator('input').check()
  await editor.getByTestId('report-send').click()
  await expect(editor.getByTestId('report-sent')).toBeVisible()
  await expect(editor.getByTestId('report-link')).toHaveAttribute('href', /\/work-items\//)

  // What Yoda received.
  expect(yoda.reports).toHaveLength(1)
  const [got] = yoda.reports
  expect(got!.report.build).toMatchObject({ commit: 'abc1234', source: 'meta' })
  expect(got!.idempotencyKey).toMatch(/^[0-9a-f-]{36}$/)
  const file = (name: string) => got!.files.find((f) => f.name === name)!
  expect(JSON.parse(file('console.json').bytes.toString()).map((e: { message: string }) => e.message)).toContain('boom')
  expect(JSON.parse(file('network.json').bytes.toString()).map((e: { status: number }) => e.status)).toContain(500)

  // The uploaded PNG is block-uniform inside the mosaic rectangle (decoded in a page).
  if (process.env.E2E_SAVE) (await import('node:fs')).writeFileSync(process.env.E2E_SAVE, file('screenshot.png').bytes)
  const png = file('screenshot.png').bytes.toString('base64')
  // The PNG has the canvas's pixel size, so canvas units address it directly.
  // The mosaic grid starts at the rectangle; a 6 px patch inside its first block (allowing for pointer rounding)
  // must be one colour, while a patch of the stripes outside every mask has two.
  const uniformAt = (x: number, y: number) =>
    editor.evaluate(
      async ({ png, x, y }) => {
        const bmp = await createImageBitmap(await (await fetch(`data:image/png;base64,${png}`)).blob())
        const ctx = new OffscreenCanvas(bmp.width, bmp.height).getContext('2d')!
        ctx.drawImage(bmp, 0, 0)
        const d = ctx.getImageData(x, y, 6, 6).data
        for (let i = 4; i < d.length; i += 4) for (let k = 0; k < 3; k++) if (Math.abs(d[i + k]! - d[k]!) > 1) return false
        return true
      },
      { png, x, y },
    )
  expect(await uniformAt(mosaic.x + 3, mosaic.y + 3)).toBe(true)
  expect(await uniformAt(1000, 120)).toBe(false)
})
