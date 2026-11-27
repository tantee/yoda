import { createHmac, timingSafeEqual } from 'node:crypto'
import type { FastifyInstance } from 'fastify'
import { HttpError } from '../auth/plugin.js'
import { tokenMatches } from '../gitlab/webhook.js'
import { ChannelError } from '../notifications/channels/index.js'
import { lineConfigured, lineSend } from '../notifications/channels/line.js'
import { telegramConfigured, telegramSend } from '../notifications/channels/telegram.js'
import { and, eq, gte, lte } from 'drizzle-orm'
import { channelLinks } from '../db/schema.js'
import { linkWithCode, normalizeCode, unlinkExternal } from '../notifications/linking.js'

const WEBHOOK_BODY_LIMIT = 1024 * 1024
const unauthorized = () => new HttpError(401, { error: 'unauthorized' })
/** A webhook whose channel has no credentials in env does not exist. */
const off = () => new HttpError(404, { error: 'not_found' })

/** Replies in the chat (th, then en). Only the portal's settings link; nothing about the person. */
const replies = (portalUrl: string) => {
  const settings = `${portalUrl}/settings/notifications`
  return {
    linked: 'เชื่อมบัญชีกับ Yoda แล้ว คุณจะได้รับการแจ้งเตือนที่นี่\nLinked to Yoda. You will get your notifications here.',
    invalid: `รหัสไม่ถูกต้องหรือหมดอายุ ขอรหัสใหม่ได้ที่ ${settings}\nThe code is invalid or expired. Get a new one at ${settings}`,
    instructions: `ขอรหัสเชื่อมบัญชี (LINK-XXXXXXXX) ได้ที่ ${settings} แล้วส่งรหัสมาในแชตนี้\nTo get notifications here, get a link code (LINK-XXXXXXXX) at ${settings} and send it in this chat.`,
  }
}

/** `X-Line-Signature`: base64 HMAC-SHA256 of the raw body keyed by the channel secret, compared in constant time. */
export function lineSignatureMatches(secret: string, raw: Buffer, given: unknown): boolean {
  if (typeof given !== 'string' || !given) return false
  const expected = createHmac('sha256', secret).update(raw).digest()
  const got = Buffer.from(given, 'base64')
  return got.length === expected.length && timingSafeEqual(got, expected)
}

/** The code in a chat message: the whole text, or a `LINK-XXXXXXXX` inside it. */
function codeIn(text: string): string | null {
  return normalizeCode(text) ?? normalizeCode(text.match(/LINK-[A-Z0-9]{8}/i)?.[0] ?? '')
}

type LineEvent = {
  type?: unknown
  /** When the event happened (ms); a redelivery keeps the original time. */
  timestamp?: unknown
  deliveryContext?: { isRedelivery?: unknown }
  replyToken?: unknown
  source?: { type?: unknown; userId?: unknown }
  message?: { type?: unknown; text?: unknown }
}
type TelegramUpdate = {
  message?: { chat?: { id?: unknown; type?: unknown }; text?: unknown }
  my_chat_member?: { chat?: { id?: unknown; type?: unknown }; new_chat_member?: { status?: unknown } }
}

/**
 * Public webhooks for LINE and Telegram. Each is verified before anything is read or bound (LINE: signature over
 * the raw body; Telegram: the secret token header), answers 200 once verified, and sends chat replies in the
 * background so a slow provider never delays the answer. Logs carry error codes only.
 */
export function channelWebhookRoutes(app: FastifyInstance): void {
  // Config is read per request (app.deps.config is the live settings snapshot); only the db is fixed.
  const { db } = app.deps

  const background = (channel: string, send: () => Promise<void>) => {
    void send().catch((err) => {
      const code = err instanceof ChannelError ? err.code : 'reply_failed'
      console.warn(`channel-webhooks: ${channel} reply failed (${code})`)
    })
  }

  const linkedSince = async (userId: string, at: Date) =>
    (
      await db
        .select({ personId: channelLinks.personId })
        .from(channelLinks)
        .where(and(eq(channelLinks.channel, 'line'), eq(channelLinks.externalId, userId), gte(channelLinks.linkedAt, at)))
    ).length > 0

  // Scoped so the raw-body JSON parser applies to this route only.
  void app.register(async (scope) => {
    scope.addContentTypeParser('application/json', { parseAs: 'buffer', bodyLimit: WEBHOOK_BODY_LIMIT }, (_req, body, done) => done(null, body))
    scope.post(
      '/webhooks/line',
      {
        config: { public: true },
        bodyLimit: WEBHOOK_BODY_LIMIT,
        onRequest: async (request) => {
          if (!lineConfigured(app.deps.config)) throw off()
          if (!request.headers['x-line-signature']) throw unauthorized()
        },
      },
      async (request) => {
        const config = app.deps.config
        // Again here: the settings may have changed while the body was read.
        if (!lineConfigured(config)) throw off()
        const raw = request.body
        if (!Buffer.isBuffer(raw) || !lineSignatureMatches(config.lineChannelSecret!, raw, request.headers['x-line-signature'])) throw unauthorized()
        let events: LineEvent[]
        try {
          const parsed = JSON.parse(raw.toString('utf8')) as { events?: unknown }
          events = Array.isArray(parsed.events) ? (parsed.events as LineEvent[]) : []
        } catch {
          throw new HttpError(400, { error: 'bad_request' })
        }
        const text = replies(config.portalUrl)
        for (const ev of events) {
          const userId = ev.source?.type === 'user' && typeof ev.source.userId === 'string' ? ev.source.userId : null
          if (!userId) continue
          const replyToken = typeof ev.replyToken === 'string' ? ev.replyToken : null
          const reply = (msg: string) => replyToken && background('line', () => lineSend(app.deps, '/v2/bot/message/reply', { replyToken }, msg))
          const at = typeof ev.timestamp === 'number' ? new Date(ev.timestamp) : null
          if (ev.type === 'unfollow') {
            // Only links made before the unfollow: a late redelivery must not undo a newer link.
            if (at) await db.delete(channelLinks).where(and(eq(channelLinks.channel, 'line'), eq(channelLinks.externalId, userId), lte(channelLinks.linkedAt, at)))
            else await unlinkExternal(db, 'line', userId)
          } else if (ev.type === 'follow') {
            reply(text.instructions)
          } else if (ev.type === 'message' && ev.message?.type === 'text' && typeof ev.message.text === 'string') {
            const code = codeIn(ev.message.text)
            if (!code) continue
            // A redelivered code message whose link already happened (we answered, LINE did not hear it).
            if (ev.deliveryContext?.isRedelivery === true && at && (await linkedSince(userId, at))) continue
            const result = await linkWithCode(app.deps, 'line', code, userId)
            if (result !== 'throttled') reply(result === 'linked' ? text.linked : text.invalid)
          }
        }
        return {}
      },
    )
  })

  app.post(
    '/webhooks/telegram',
    {
      config: { public: true },
      bodyLimit: WEBHOOK_BODY_LIMIT,
      // Before the body is read; the secret and the headers are never logged or echoed.
      onRequest: async (request) => {
        const config = app.deps.config
        if (!telegramConfigured(config)) throw off()
        if (!tokenMatches(config.telegramWebhookSecret, request.headers['x-telegram-bot-api-secret-token'])) throw unauthorized()
      },
    },
    async (request) => {
      const update = (request.body ?? {}) as TelegramUpdate
      const text = replies(app.deps.config.portalUrl)
      const member = update.my_chat_member
      if (member?.new_chat_member?.status === 'kicked' && member.chat?.id !== undefined) {
        await unlinkExternal(db, 'telegram', String(member.chat.id))
        return {}
      }
      const msg = update.message
      // Private chats only: a group's chat id would send one person's notifications to everyone in it.
      if (!msg || msg.chat?.type !== 'private' || msg.chat.id === undefined || typeof msg.text !== 'string') return {}
      const chatId = String(msg.chat.id)
      // `/start <code>` from the deep link, or the code typed into the chat.
      const start = msg.text.trim().match(/^\/start(?:@\w+)?(?:\s+(\S+))?$/)
      if (start && !start[1]) {
        background('telegram', () => telegramSend(app.deps, chatId, text.instructions))
        return {}
      }
      const code = codeIn(start ? start[1]! : msg.text)
      if (!code) {
        if (start) background('telegram', () => telegramSend(app.deps, chatId, text.invalid))
        return {}
      }
      const result = await linkWithCode(app.deps, 'telegram', code, chatId)
      if (result !== 'throttled') background('telegram', () => telegramSend(app.deps, chatId, result === 'linked' ? text.linked : text.invalid))
      return {}
    },
  )
}
