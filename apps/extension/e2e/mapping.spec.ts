import { expect, test } from './fixtures'
import { LAB } from './stub-yoda'

if (process.env.DEMO) test.use({ video: 'on' })

test('a Yoda mapping picks the project; my localhost rule loses to it; the URL tester explains it', async ({ context, yoda, app, openPopup, connect, tabIdOf, frame }) => {
  const port = new URL(app.url).port
  // Yoda maps this app (port-specific) to the lab project.
  yoda.rules = [{ pattern: `http://localhost:${port}/*`, projectId: LAB, environment: 'uat', production: false, source: 'app_url', build: null }]
  const options = await connect()

  // My own rule for every localhost port, to the OPD project.
  await options.getByTestId('rule-add').click()
  await options.getByTestId('rule-pattern').locator('input').fill('http://localhost/*')
  await options.getByTestId('rule-environment').locator('input').fill('dev')
  await frame(options, 3)
  await options.getByTestId('rule-save').click()
  await expect(options.getByTestId('rule-mine')).toContainText('http://localhost/*')
  await expect(options.getByTestId('rule-yoda')).toContainText(`http://localhost:${port}/*`)

  // The tester: the Yoda rule wins, because it names the port.
  await options.getByTestId('tester-url').locator('input').fill(`${app.url}/opd`)
  await expect(options.getByTestId('tester-result')).toContainText('ระบบแล็บ')
  await expect(options.getByTestId('tester-why')).toContainText('a port given')
  await frame(options, 5)
  // SHOTS=<dir>: the screenshots for the PR (docs/design/screenshots/extension/).
  if (process.env.SHOTS) await options.waitForTimeout(800)
  if (process.env.SHOTS) await options.screenshot({ path: `${process.env.SHOTS}/mapping-options.png`, fullPage: true })

  // The popup on the app starts on the mapped project.
  const page = await context.newPage()
  await page.goto(app.url)
  const popup = await openPopup(await tabIdOf(app.url))
  await expect(popup.getByTestId('popup-project')).toContainText('ระบบแล็บ')
  await expect(popup.getByTestId('popup-production')).toHaveCount(0)
  await frame(popup, 4)
})

test('a production mapping: the popup says so, offers no video, and logs start off', async ({ context, yoda, app, openPopup, connect, tabIdOf }) => {
  yoda.rules = [{ pattern: `${app.url}/*`, projectId: LAB, environment: 'production', production: true, source: 'gitlab', build: null }]
  await connect()
  const page = await context.newPage()
  await page.goto(app.url)
  const popup = await openPopup(await tabIdOf(app.url))
  await expect(popup.getByTestId('popup-production')).toBeVisible()
  await expect(popup.getByTestId('action-screenshot')).toBeEnabled()
  await expect(popup.getByTestId('action-record')).toHaveCount(0)
  if (process.env.SHOTS) await popup.waitForTimeout(800)
  if (process.env.SHOTS) await popup.screenshot({ path: `${process.env.SHOTS}/mapping-popup-production.png` })
  await expect(popup.getByTestId('popup-attach-console').locator('input')).not.toBeChecked()
})
