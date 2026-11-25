import type { FastifyInstance } from 'fastify'
import { and, eq } from 'drizzle-orm'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { buildApp, type AppDeps } from '../src/app.js'
import { loadConfig } from '../src/config.js'
import { channelLinkAttempts, channelLinkCodes, channelLinks, notificationChannelSettings, notificationDeliveries, notificationPrefs, notifications } from '../src/db/schema.js'
import { InlineJobQueue, NOTIFY_RETRY_LIMIT } from '../src/jobs/queue.js'
import { deliver } from '../src/notifications/deliver.js'
import { linkWithCode } from '../src/notifications/linking.js'
import { channelsFor } from '../src/notifications/prefs.js'
import { notify, notifyTaskAssigned } from '../src/notifications/service.js'
import { runWork } from '../src/work/context.js'
import { FakeLine, lineSignature, startFakeLine } from './fake-line.js'
import { FakeTelegram, startFakeTelegram } from './fake-telegram.js'
import { resetDb, testDb, testDeps } from './helpers.js'
import { auth, login, type Who } from './support.js'

// Fakes: obviously not real credentials; asserted absent from logs, errors and API responses.
const CREDS = {
  lineChannelAccessToken: 'test-line-access-token',
  lineChannelSecret: 'test-line-channel-secret',
  telegramBotToken: 'test-telegram-bot-token',
  telegramBotUsername: 'yoda_test_bot',
  telegramWebhookSecret: 'test-telegram-webhook-secret',
}
const LINE_USER = 'U0000000000000000000000000000test'
const CODE_RE = /^LINK-[A-HJ-NP-Z2-9]{8}$/
/** Well-formed, but never issued. */
const WRONG_CODE = 'LINK-AAAAAAAA'

let line: FakeLine
let tg: FakeTelegram
let deps: AppDeps
let app: FastifyInstance
let boss: Who
let dev: Who
let warn: ReturnType<typeof vi.spyOn>
let error: ReturnType<typeof vi.spyOn>

beforeEach(async () => {
  const db = await testDb()
  await resetDb(db)
  line = await startFakeLine()
  tg = await startFakeTelegram()
  line.requireToken(CREDS.lineChannelAccessToken)
  tg.requireToken(CREDS.telegramBotToken)
  const base = await testDeps()
  deps = await testDeps({
    config: { ...base.config, ...CREDS, lineApiUrl: line.url, telegramApiUrl: tg.url, bootstrapAdmins: ['boss'] },
    jobs: new InlineJobQueue(),
  })
  app = await buildApp(deps)
  boss = await login(app, 'boss')
  dev = await login(app, 'dev', { staff: true })
  warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
  error = vi.spyOn(console, 'error').mockImplementation(() => {})
})
afterEach(async () => {
  warn.mockRestore()
  error.mockRestore()
  await app.close()
  await line.stop()
  await tg.stop()
})

const db = () => deps.db
const enable = (on: Partial<{ lineEnabled: boolean; telegramEnabled: boolean }>) =>
  db().update(notificationChannelSettings).set(on).where(eq(notificationChannelSettings.id, 1))
const linkOf = async (personId: string, channel: string) =>
  (await db().select().from(channelLinks).where(and(eq(channelLinks.personId, personId), eq(channelLinks.channel, channel))))[0]

async function newCode(who: Who, channel: 'line' | 'telegram') {
  const res = await app.inject({ method: 'POST', url: `/me/channel-links/${channel}/code`, headers: auth(who) })
  expect(res.statusCode).toBe(200)
  return res.json() as { code: string; expiresAt: string; instructions: { deepLink?: string } }
}

function lineWebhook(events: unknown[], secret = CREDS.lineChannelSecret) {
  const body = JSON.stringify({ destination: 'Utest', events })
  return app.inject({
    method: 'POST',
    url: '/webhooks/line',
    headers: { 'content-type': 'application/json; charset=utf-8', 'x-line-signature': lineSignature(secret, body) },
    payload: body,
  })
}
const lineText = (text: string, userId = LINE_USER) => ({
  type: 'message',
  replyToken: `reply-${Math.random().toString(36).slice(2)}`,
  source: { type: 'user', userId },
  message: { type: 'text', id: '1', text },
})

function tgWebhook(update: unknown, secret: string | null = CREDS.telegramWebhookSecret) {
  return app.inject({
    method: 'POST',
    url: '/webhooks/telegram',
    headers: secret === null ? {} : { 'x-telegram-bot-api-secret-token': secret },
    payload: update as object,
  })
}
const tgStart = (arg: string, chatId = 777001) => ({
  update_id: 1,
  message: { message_id: 1, chat: { id: chatId, type: 'private' }, from: { id: chatId }, text: `/start ${arg}` },
})

describe('link codes', () => {
  it('a code is LINK- plus 8 base32 characters, valid 15 minutes; Telegram gets a deep link', async () => {
    await enable({ lineEnabled: true, telegramEnabled: true })
    const l = await newCode(dev, 'line')
    expect(l.code).toMatch(CODE_RE)
    const minutes = (Date.parse(l.expiresAt) - Date.now()) / 60_000
    expect(minutes).toBeGreaterThan(14)
    expect(minutes).toBeLessThanOrEqual(15)
    const t = await newCode(dev, 'telegram')
    expect(t.instructions.deepLink).toBe(`https://t.me/yoda_test_bot?start=${t.code.slice('LINK-'.length)}`)
  })

  it('a new code replaces the old one', async () => {
    await enable({ lineEnabled: true })
    const first = await newCode(dev, 'line')
    const second = await newCode(dev, 'line')
    const rows = await db().select().from(channelLinkCodes).where(eq(channelLinkCodes.personId, dev.id))
    expect(rows.map((r) => r.code)).toEqual([second.code])
    expect((await lineWebhook([lineText(first.code)])).statusCode).toBe(200)
    expect(await linkOf(dev.id, 'line')).toBeUndefined()
  })

  it('a channel that is not enabled, or not linkable, gives no code', async () => {
    const off = await app.inject({ method: 'POST', url: '/me/channel-links/line/code', headers: auth(dev) })
    expect(off.statusCode).toBe(422)
    expect(off.json()).toEqual({ error: 'channel_unavailable' })
    const email = await app.inject({ method: 'POST', url: '/me/channel-links/email/code', headers: auth(dev) })
    expect(email.statusCode).toBe(404)
    expect((await app.inject({ method: 'POST', url: '/me/channel-links/line/code' })).statusCode).toBe(401)
  })
})

describe('LINE webhook', () => {
  beforeEach(() => enable({ lineEnabled: true }))

  it('a signed text event with a fresh code links the user and replies through the reply API', async () => {
    const { code } = await newCode(dev, 'line')
    const ev = lineText(`  ${code.toLowerCase()} `)
    const res = await lineWebhook([ev])
    expect(res.statusCode).toBe(200)
    expect(await linkOf(dev.id, 'line')).toMatchObject({ externalId: LINE_USER })
    await vi.waitFor(() => expect(line.replies).toHaveLength(1))
    expect(line.replies[0]!.replyToken).toBe(ev.replyToken)
    expect(line.replies[0]!.text).toContain('Linked')
    expect(line.requests[0]!.authorization).toBe(`Bearer ${CREDS.lineChannelAccessToken}`)
    const me = (await app.inject({ url: '/me/notification-prefs', headers: auth(dev) })).json()
    expect(me.channels.linked.line).toBe(true)
  })

  it('a bad or missing signature is 401 and binds nothing', async () => {
    const { code } = await newCode(dev, 'line')
    expect((await lineWebhook([lineText(code)], 'wrong-secret-value')).statusCode).toBe(401)
    const unsigned = await app.inject({
      method: 'POST',
      url: '/webhooks/line',
      headers: { 'content-type': 'application/json' },
      payload: JSON.stringify({ events: [lineText(code)] }),
    })
    expect(unsigned.statusCode).toBe(401)
    expect(await linkOf(dev.id, 'line')).toBeUndefined()
    expect(line.requests).toHaveLength(0)
    // The body is signed byte for byte: re-serialized JSON with the same meaning does not verify.
    const body = JSON.stringify({ events: [lineText(code)] })
    const tampered = await app.inject({
      method: 'POST',
      url: '/webhooks/line',
      headers: { 'content-type': 'application/json', 'x-line-signature': lineSignature(CREDS.lineChannelSecret, body) },
      payload: `${body} `,
    })
    expect(tampered.statusCode).toBe(401)
    expect(await linkOf(dev.id, 'line')).toBeUndefined()
  })

  it('a code used twice: the second is invalid and the first link stays', async () => {
    const { code } = await newCode(dev, 'line')
    await lineWebhook([lineText(code)])
    await lineWebhook([lineText(code, 'U0000000000000000000000000other')])
    await vi.waitFor(() => expect(line.replies).toHaveLength(2))
    expect(line.replies[1]!.text).toContain('invalid or expired')
    expect(await linkOf(dev.id, 'line')).toMatchObject({ externalId: LINE_USER })
  })

  it('an expired code is invalid', async () => {
    const { code } = await newCode(dev, 'line')
    await db().update(channelLinkCodes).set({ expiresAt: new Date(Date.now() - 1000) }).where(eq(channelLinkCodes.code, code))
    await lineWebhook([lineText(code)])
    await vi.waitFor(() => expect(line.replies).toHaveLength(1))
    expect(line.replies[0]!.text).toContain('invalid or expired')
    expect(await linkOf(dev.id, 'line')).toBeUndefined()
  })

  it('a Telegram code sent on LINE is invalid', async () => {
    await enable({ telegramEnabled: true })
    const { code } = await newCode(dev, 'telegram')
    await lineWebhook([lineText(code)])
    expect(await linkOf(dev.id, 'line')).toBeUndefined()
  })

  it('a LINE account linked to someone else moves to the person who sent the code', async () => {
    const { code } = await newCode(dev, 'line')
    await lineWebhook([lineText(code)])
    const other = await login(app, 'other', { staff: true })
    const second = await newCode(other, 'line')
    await lineWebhook([lineText(second.code)])
    expect(await linkOf(dev.id, 'line')).toBeUndefined()
    expect(await linkOf(other.id, 'line')).toMatchObject({ externalId: LINE_USER })
    // The displaced person is told in the portal (once), in case it was not them.
    const told = await db().select().from(notifications).where(eq(notifications.personId, dev.id))
    expect(told).toMatchObject([{ kind: 'secretary_message', link: '/settings/notifications' }])
    expect(told[0]!.title).toContain('LINE')
    expect(await db().select().from(notifications).where(eq(notifications.personId, other.id))).toEqual([])
  })

  it('relinking your own account tells nobody', async () => {
    await lineWebhook([lineText((await newCode(dev, 'line')).code)])
    await lineWebhook([lineText((await newCode(dev, 'line')).code)])
    expect(await db().select().from(notifications)).toEqual([])
  })

  it('after 5 invalid codes in 15 minutes a LINE user is ignored, even with a valid code', async () => {
    for (let i = 0; i < 5; i++) await lineWebhook([lineText(WRONG_CODE)])
    await vi.waitFor(() => expect(line.replies).toHaveLength(5))
    const { code } = await newCode(dev, 'line')
    expect((await lineWebhook([lineText(code)])).statusCode).toBe(200)
    expect(await linkOf(dev.id, 'line')).toBeUndefined()
    // Not consumed: the code still works for another account.
    const [row] = await db().select().from(channelLinkCodes).where(eq(channelLinkCodes.code, code))
    expect(row!.usedAt).toBeNull()
    await new Promise((r) => setTimeout(r, 50))
    expect(line.replies).toHaveLength(5)
    await lineWebhook([lineText(code, 'U0000000000000000000000000other')])
    expect(await linkOf(dev.id, 'line')).toMatchObject({ externalId: 'U0000000000000000000000000other' })
    // Attempts older than 15 minutes no longer count.
    await db().update(channelLinkAttempts).set({ at: new Date(Date.now() - 16 * 60_000) })
    await lineWebhook([lineText((await newCode(boss, 'line')).code)])
    expect(await linkOf(boss.id, 'line')).toMatchObject({ externalId: LINE_USER })
  })

  it('a parallel burst of invalid codes from one account records at most 5 attempts', async () => {
    const results = await Promise.all(Array.from({ length: 20 }, () => linkWithCode(deps, 'line', WRONG_CODE, LINE_USER)))
    expect(results.filter((r) => r === 'invalid')).toHaveLength(5)
    expect(results.filter((r) => r === 'throttled')).toHaveLength(15)
    const rows = await db().select().from(channelLinkAttempts).where(eq(channelLinkAttempts.externalId, LINE_USER))
    expect(rows).toHaveLength(5)
  })

  it('200 invalid attempts on a channel in 10 minutes refuse every code for a while, with a warning', async () => {
    await db().insert(channelLinkAttempts).values(Array.from({ length: 200 }, (_, i) => ({ channel: 'line', externalId: `Uflood${i}` })))
    const { code } = await newCode(dev, 'line')
    await lineWebhook([lineText(code)])
    expect(await linkOf(dev.id, 'line')).toBeUndefined()
    expect(JSON.stringify(warn.mock.calls)).toContain('link codes refused')
    // Telegram is counted separately.
    await enable({ telegramEnabled: true })
    await tgWebhook(tgStart((await newCode(dev, 'telegram')).code))
    expect(await linkOf(dev.id, 'telegram')).toBeDefined()
  })

  it('a redelivered unfollow older than the current link leaves it alone', async () => {
    const { code } = await newCode(dev, 'line')
    await lineWebhook([lineText(code)])
    const unfollow = (timestamp: number, isRedelivery: boolean) => ({
      type: 'unfollow',
      timestamp,
      webhookEventId: `ev-${timestamp}`,
      deliveryContext: { isRedelivery },
      source: { type: 'user', userId: LINE_USER },
    })
    await lineWebhook([unfollow(Date.now() - 60_000, true)])
    expect(await linkOf(dev.id, 'line')).toBeDefined()
    await lineWebhook([unfollow(Date.now(), false)])
    expect(await linkOf(dev.id, 'line')).toBeUndefined()
  })

  it('follow replies with instructions; unfollow unlinks; other text is ignored', async () => {
    await lineWebhook([{ type: 'follow', replyToken: 'reply-follow', source: { type: 'user', userId: LINE_USER } }])
    await vi.waitFor(() => expect(line.replies).toHaveLength(1))
    expect(line.replies[0]!.text).toContain('/settings/notifications')
    const { code } = await newCode(dev, 'line')
    await lineWebhook([lineText(code)])
    expect(await linkOf(dev.id, 'line')).toBeDefined()
    await lineWebhook([lineText('hello')])
    const res = await lineWebhook([{ type: 'unfollow', source: { type: 'user', userId: LINE_USER } }])
    expect(res.statusCode).toBe(200)
    expect(await linkOf(dev.id, 'line')).toBeUndefined()
    await new Promise((r) => setTimeout(r, 50))
    expect(line.replies).toHaveLength(2)
  })

  it('verification only (empty events) answers 200', async () => {
    expect((await lineWebhook([])).statusCode).toBe(200)
  })
})

describe('Telegram webhook', () => {
  beforeEach(() => enable({ telegramEnabled: true }))

  it('the right secret with /start <code> links the chat and replies with sendMessage', async () => {
    const { code, instructions } = await newCode(dev, 'telegram')
    const start = new URL(instructions.deepLink!).searchParams.get('start')!
    const res = await tgWebhook(tgStart(start))
    expect(res.statusCode).toBe(200)
    expect(await linkOf(dev.id, 'telegram')).toMatchObject({ externalId: '777001' })
    await vi.waitFor(() => expect(tg.messages).toHaveLength(1))
    expect(tg.messages[0]).toMatchObject({ chatId: '777001', parseMode: undefined })
    expect(tg.messages[0]!.text).toContain('Linked')
    expect(tg.requests[0]!.path).toBe(`/bot${CREDS.telegramBotToken}/sendMessage`)
    // The full code works too, once.
    expect(code).toMatch(CODE_RE)
  })

  it('a wrong or missing secret is 401 and binds nothing', async () => {
    const { code } = await newCode(dev, 'telegram')
    expect((await tgWebhook(tgStart(code), 'wrong-telegram-webhook-secret')).statusCode).toBe(401)
    expect((await tgWebhook(tgStart(code), null)).statusCode).toBe(401)
    expect(await linkOf(dev.id, 'telegram')).toBeUndefined()
    expect(tg.requests).toHaveLength(0)
  })

  it('a reused code is invalid', async () => {
    const { code } = await newCode(dev, 'telegram')
    await tgWebhook(tgStart(code))
    await tgWebhook(tgStart(code, 777002))
    await vi.waitFor(() => expect(tg.messages).toHaveLength(2))
    expect(tg.messages[1]).toMatchObject({ chatId: '777002' })
    expect(tg.messages[1]!.text).toContain('invalid or expired')
    expect(await linkOf(dev.id, 'telegram')).toMatchObject({ externalId: '777001' })
  })

  it('the bot being blocked (kicked) unlinks the chat', async () => {
    const { code } = await newCode(dev, 'telegram')
    await tgWebhook(tgStart(code))
    const res = await tgWebhook({
      update_id: 2,
      my_chat_member: { chat: { id: 777001, type: 'private' }, new_chat_member: { status: 'kicked', user: { id: 1 } } },
    })
    expect(res.statusCode).toBe(200)
    expect(await linkOf(dev.id, 'telegram')).toBeUndefined()
  })
})

describe('unlinking from the portal', () => {
  it('DELETE removes the link', async () => {
    await enable({ telegramEnabled: true })
    const { code } = await newCode(dev, 'telegram')
    await tgWebhook(tgStart(code))
    const res = await app.inject({ method: 'DELETE', url: '/me/channel-links/telegram', headers: auth(dev) })
    expect(res.statusCode).toBe(204)
    expect(await linkOf(dev.id, 'telegram')).toBeUndefined()
    expect((await app.inject({ method: 'DELETE', url: '/me/channel-links/telegram', headers: auth(dev) })).statusCode).toBe(204)
  })
})

describe('LINE and Telegram delivery', () => {
  const drain = () => (deps.jobs as InlineJobQueue).drain()

  async function linkBoth(who: Who, chatId = 777001) {
    await enable({ lineEnabled: true, telegramEnabled: true })
    await lineWebhook([lineText((await newCode(who, 'line')).code)])
    await tgWebhook(tgStart((await newCode(who, 'telegram')).code, chatId))
    await db().insert(notificationPrefs).values({ personId: who.id, kinds: { task_assigned: ['line', 'telegram'] } })
    await vi.waitFor(() => expect(line.replies.length + tg.messages.length).toBe(2))
    line.requests.length = 0
    tg.requests.length = 0
  }

  async function assignTask(personId: string) {
    await runWork(deps, { id: null, kind: 'system' }, (ctx) =>
      notifyTaskAssigned(ctx, { taskId: crypto.randomUUID(), workItemId: crypto.randomUUID(), role: 'DEV', personId, taskTitle: 'แก้รายงาน' }),
    )
    await drain()
    const [n] = await db().select().from(notifications).where(eq(notifications.personId, personId))
    return n!
  }

  it('a linked person with task_assigned on LINE and Telegram gets both, with the absolute link', async () => {
    await linkBoth(dev)
    expect(await channelsFor(db(), deps.config, dev.id, 'task_assigned')).toEqual(['line', 'telegram'])
    const n = await assignTask(dev.id)
    expect(line.pushes).toEqual([{ to: LINE_USER, text: expect.stringContaining(`http://localhost:3000${n.link}`) }])
    expect(line.requests[0]!.authorization).toBe(`Bearer ${CREDS.lineChannelAccessToken}`)
    expect(tg.messages).toEqual([{ chatId: '777001', text: expect.stringContaining(`http://localhost:3000${n.link}`), parseMode: undefined }])
    expect(tg.messages[0]!.text.startsWith(n.title)).toBe(true)
    const rows = await db().select().from(notificationDeliveries)
    expect(rows.map((r) => [r.channel, r.state]).sort()).toEqual([['line', 'sent'], ['telegram', 'sent']])
  })

  it('long messages are cut to each channel’s limit and keep the link', async () => {
    await linkBoth(dev)
    await runWork(deps, { id: null, kind: 'system' }, (ctx) =>
      notify(ctx, { personId: dev.id, kind: 'task_assigned', title: 'ยาว', body: 'ก'.repeat(9000), link: '/todo/x', dedupeKey: 'long' }),
    )
    await drain()
    expect(line.pushes[0]!.text.length).toBeLessThanOrEqual(5000)
    expect(tg.messages[0]!.text.length).toBeLessThanOrEqual(4096)
    expect(line.pushes[0]!.text).toContain('http://localhost:3000/todo/x')
    expect(tg.messages[0]!.text).toContain('http://localhost:3000/todo/x')
  })

  it('LINE 500 on every attempt: failed and transient (retried 6 times), Telegram sent once', async () => {
    await linkBoth(dev)
    line.failNext(500, NOTIFY_RETRY_LIMIT + 1)
    const n = await assignTask(dev.id)
    expect(line.requests.filter((r) => r.path === '/v2/bot/message/push')).toHaveLength(NOTIFY_RETRY_LIMIT + 1)
    expect(tg.messages).toHaveLength(1)
    const rows = await db().select().from(notificationDeliveries).where(eq(notificationDeliveries.notificationId, n.id))
    expect(rows.find((r) => r.channel === 'line')).toMatchObject({ state: 'failed', errorCode: 'line_500', permanent: false })
    expect(rows.find((r) => r.channel === 'telegram')).toMatchObject({ state: 'sent' })
  })

  it('Telegram 403 blocked: permanent, never retried, link removed', async () => {
    await linkBoth(dev)
    tg.failNext(403, 3, 'Forbidden: bot was blocked by the user')
    line.failNext(503, 1)
    const n = await assignTask(dev.id)
    expect(tg.requests).toHaveLength(1)
    // LINE retried after its transient failure; the blocked Telegram channel was not tried again.
    expect(line.pushes).toHaveLength(2)
    const rows = await db().select().from(notificationDeliveries).where(eq(notificationDeliveries.notificationId, n.id))
    expect(rows.find((r) => r.channel === 'telegram')).toMatchObject({ state: 'failed', errorCode: 'telegram_blocked', permanent: true })
    expect(rows.find((r) => r.channel === 'line')).toMatchObject({ state: 'sent' })
    expect(await linkOf(dev.id, 'telegram')).toBeUndefined()
    expect(await linkOf(dev.id, 'line')).toBeDefined()
  })

  for (const [status, description] of [
    [403, 'Forbidden: user is deactivated'],
    [403, 'Forbidden: bot was kicked from the private chat'],
    [400, 'Bad Request: chat not found'],
  ] as const) {
    it(`Telegram ${status} "${description}": permanent and unlinked`, async () => {
      await linkBoth(dev)
      tg.failNext(status, 3, description)
      const n = await assignTask(dev.id)
      expect(tg.requests).toHaveLength(1)
      const rows = await db().select().from(notificationDeliveries).where(eq(notificationDeliveries.notificationId, n.id))
      expect(rows.find((r) => r.channel === 'telegram')).toMatchObject({ state: 'failed', permanent: true })
      expect(await linkOf(dev.id, 'telegram')).toBeUndefined()
    })
  }

  it('400/401 are permanent; 429 is transient', async () => {
    await linkBoth(dev)
    line.failNext(401, 3)
    tg.failNext(429, NOTIFY_RETRY_LIMIT + 1, 'Too Many Requests: retry after 1')
    const n = await assignTask(dev.id)
    expect(line.requests).toHaveLength(1)
    expect(tg.requests).toHaveLength(NOTIFY_RETRY_LIMIT + 1)
    const rows = await db().select().from(notificationDeliveries).where(eq(notificationDeliveries.notificationId, n.id))
    expect(rows.find((r) => r.channel === 'line')).toMatchObject({ errorCode: 'line_401', permanent: true })
    expect(rows.find((r) => r.channel === 'telegram')).toMatchObject({ errorCode: 'telegram_429', permanent: false })
    // A 401 does not mean the person blocked anyone: both stay linked.
    expect(await linkOf(dev.id, 'telegram')).toBeDefined()
  })
})

describe('secrets and errors', () => {
  it('logs, errors and API responses never contain either token, including Telegram’s token in the URL', async () => {
    await enable({ lineEnabled: true, telegramEnabled: true })
    const { code } = await newCode(dev, 'telegram')
    await tgWebhook(tgStart(code))
    await lineWebhook([lineText((await newCode(dev, 'line')).code)])
    await db().insert(notificationPrefs).values({ personId: dev.id, kinds: { task_assigned: ['line', 'telegram'] } })
    // Both providers unreachable: fetch fails with errors that may carry the request URL.
    const down = { ...deps, jobs: new InlineJobQueue(), config: { ...deps.config, lineApiUrl: 'http://127.0.0.1:9', telegramApiUrl: 'http://127.0.0.1:9' } }
    const [n] = await runWork(down, { id: null, kind: 'system' }, async (ctx) => {
      await notifyTaskAssigned(ctx, { taskId: crypto.randomUUID(), workItemId: crypto.randomUUID(), role: 'DEV', personId: dev.id, taskTitle: 't' })
      return ctx.tx.select().from(notifications).where(eq(notifications.personId, dev.id))
    })
    let thrown: unknown
    try {
      await deliver(down, n!.id)
    } catch (err) {
      thrown = err
    }
    expect(thrown).toBeInstanceOf(Error)
    const rows = await db().select().from(notificationDeliveries)
    expect(rows.map((r) => r.errorCode).sort()).toEqual(['line_unreachable', 'telegram_unreachable'])
    const admin = await app.inject({ url: '/admin/notification-channels', headers: auth(boss) })
    const mine = await app.inject({ url: '/me/notification-prefs', headers: auth(dev) })
    const seen = [JSON.stringify(warn.mock.calls), JSON.stringify(error.mock.calls), String(thrown), (thrown as Error).stack, admin.body, mine.body, JSON.stringify(rows)].join('\n')
    expect(warn).toHaveBeenCalled()
    for (const secret of Object.values(CREDS).filter((v) => v !== CREDS.telegramBotUsername)) expect(seen).not.toContain(secret)
    expect(admin.json()).toEqual([
      { name: 'email', configured: false, enabled: false },
      { name: 'line', configured: true, enabled: true },
      { name: 'telegram', configured: true, enabled: true },
    ])
  })

  it('a failed webhook reply logs only a code', async () => {
    await enable({ telegramEnabled: true })
    tg.failNext(401, 1)
    const { code } = await newCode(dev, 'telegram')
    await tgWebhook(tgStart(code))
    await vi.waitFor(() => expect(warn).toHaveBeenCalled())
    const logged = JSON.stringify(warn.mock.calls) + JSON.stringify(error.mock.calls)
    expect(logged).toContain('telegram_401')
    expect(logged).not.toContain(CREDS.telegramBotToken)
  })
})

describe('config', () => {
  const env = { DATABASE_URL: 'postgres://x', OIDC_ISSUER: 'http://issuer.test', OIDC_CLIENT_ID: 'c', S3_ACCESS_KEY: 'k', S3_SECRET_KEY: 's' }

  it('reads the LINE and Telegram env with API defaults; a short webhook secret is refused', () => {
    const c = loadConfig({
      ...env,
      LINE_CHANNEL_ACCESS_TOKEN: CREDS.lineChannelAccessToken,
      LINE_CHANNEL_SECRET: CREDS.lineChannelSecret,
      TELEGRAM_BOT_TOKEN: CREDS.telegramBotToken,
      TELEGRAM_BOT_USERNAME: '@yoda_test_bot',
      TELEGRAM_WEBHOOK_SECRET: CREDS.telegramWebhookSecret,
    })
    expect(c).toMatchObject({ lineApiUrl: 'https://api.line.me', telegramApiUrl: 'https://api.telegram.org', telegramBotUsername: 'yoda_test_bot' })
    expect(() => loadConfig({ ...env, TELEGRAM_WEBHOOK_SECRET: 'short' })).toThrow(/TELEGRAM_WEBHOOK_SECRET/)
  })

  it('without the env the channels are not configured: admins cannot enable them and the webhooks are off', async () => {
    const bare = await testDeps({ jobs: new InlineJobQueue() })
    const off = await buildApp({ ...bare, config: { ...bare.config, bootstrapAdmins: ['boss'] } })
    try {
      const admin = await login(off, 'boss')
      const status = (await off.inject({ url: '/admin/notification-channels', headers: auth(admin) })).json()
      expect(status.filter((s: { name: string }) => s.name !== 'email')).toEqual([
        { name: 'line', configured: false, enabled: false },
        { name: 'telegram', configured: false, enabled: false },
      ])
      for (const name of ['line', 'telegram']) {
        const res = await off.inject({ method: 'PATCH', url: '/admin/notification-channels', headers: auth(admin), payload: { [name]: true } })
        expect(res.statusCode).toBe(422)
      }
      expect((await off.inject({ method: 'POST', url: '/webhooks/line', headers: { 'x-line-signature': 'x' }, payload: {} })).statusCode).toBe(404)
      expect((await off.inject({ method: 'POST', url: '/webhooks/telegram', headers: { 'x-telegram-bot-api-secret-token': 'x' }, payload: {} })).statusCode).toBe(404)
      // Even with a stale "enabled" row and a link, an unconfigured channel is never used.
      await enable({ lineEnabled: true })
      await db().insert(channelLinks).values({ personId: admin.id, channel: 'line', externalId: LINE_USER })
      await db().insert(notificationPrefs).values({ personId: admin.id, kinds: { task_assigned: ['line'] } })
      expect(await channelsFor(db(), bare.config, admin.id, 'task_assigned')).toEqual([])
    } finally {
      await off.close()
    }
  })
})
