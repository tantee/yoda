import { and, eq } from 'drizzle-orm'
import type { Config } from '../../config.js'
import { channelLinks } from '../../db/schema.js'
import { postJson, statusError } from './http.js'
import { ChannelError, renderFitted, type Channel, type ChannelDeps } from './index.js'

/** Telegram's limit for one message's text. */
export const TELEGRAM_MAX_TEXT = 4096

/** Telegram is configured when the bot token, its username (for the link) and the webhook secret are set. */
export function telegramConfigured(config: Config): boolean {
  return Boolean(config.telegramBotToken && config.telegramBotUsername && config.telegramWebhookSecret)
}

/**
 * `sendMessage` as plain text (no parse mode, so nothing in a title is read as markup). The bot token sits in
 * the URL path: this URL is never logged and errors carry only a code (`postJson`, `statusError`).
 */
export async function telegramSend(deps: Pick<ChannelDeps, 'config' | 'fetch'>, chatId: string, text: string): Promise<void> {
  const token = deps.config.telegramBotToken
  if (!telegramConfigured(deps.config) || !token) throw new ChannelError('not_configured', true)
  const res = await postJson(deps.fetch ?? fetch, 'telegram', `${deps.config.telegramApiUrl}/bot${token}/sendMessage`, {
    chat_id: chatId,
    text,
    link_preview_options: { is_disabled: true },
  })
  if (res.status >= 200 && res.status < 300) return
  const description = (res.body as { description?: unknown } | null)?.description
  if (res.status === 403 && typeof description === 'string' && /blocked/i.test(description)) throw new ChannelError('telegram_blocked', true)
  throw statusError('telegram', res.status)
}

export function telegramChannel(deps: ChannelDeps): Channel {
  return {
    name: 'telegram',
    configured: telegramConfigured,
    async send(target, msg) {
      if (!target.externalId) throw new ChannelError('not_linked', true)
      try {
        await telegramSend(deps, target.externalId, renderFitted(msg, deps.config.portalUrl, TELEGRAM_MAX_TEXT))
      } catch (err) {
        // The person blocked the bot: the chat is gone for good, so unlink it (they can link again later).
        if (err instanceof ChannelError && err.code === 'telegram_blocked' && deps.db) {
          await deps.db
            .delete(channelLinks)
            .where(and(eq(channelLinks.personId, target.personId), eq(channelLinks.channel, 'telegram'), eq(channelLinks.externalId, target.externalId)))
        }
        throw err
      }
    },
  }
}
