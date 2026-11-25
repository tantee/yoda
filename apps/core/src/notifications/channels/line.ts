import type { Config } from '../../config.js'
import { postJson, statusError } from './http.js'
import { ChannelError, renderFitted, type Channel, type ChannelDeps } from './index.js'

/** LINE's limit for one text message. */
export const LINE_MAX_TEXT = 5000

/** LINE is configured when both the channel access token (sending) and the channel secret (webhook) are set. */
export function lineConfigured(config: Config): boolean {
  return Boolean(config.lineChannelAccessToken && config.lineChannelSecret)
}

/** One text message through the Messaging API (`push` to a user, or `reply` to a webhook event). */
export async function lineSend(
  deps: Pick<ChannelDeps, 'config' | 'fetch'>,
  path: '/v2/bot/message/push' | '/v2/bot/message/reply',
  target: { to: string } | { replyToken: string },
  text: string,
): Promise<void> {
  const token = deps.config.lineChannelAccessToken
  if (!lineConfigured(deps.config) || !token) throw new ChannelError('not_configured', true)
  const res = await postJson(deps.fetch ?? fetch, 'line', `${deps.config.lineApiUrl}${path}`, { ...target, messages: [{ type: 'text', text }] }, {
    authorization: `Bearer ${token}`,
  })
  if (res.status < 200 || res.status >= 300) throw statusError('line', res.status)
}

export function lineChannel(deps: ChannelDeps): Channel {
  return {
    name: 'line',
    configured: lineConfigured,
    async send(target, msg) {
      if (!target.externalId) throw new ChannelError('not_linked', true)
      await lineSend(deps, '/v2/bot/message/push', { to: target.externalId }, renderFitted(msg, deps.config.portalUrl, LINE_MAX_TEXT))
    },
  }
}
