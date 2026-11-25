import { z } from 'zod'
import { NotificationKind } from './notifications.js'

/** Channels outside the portal. Each is on only when configured in env and enabled by an admin. */
export const ChannelName = z.enum(['email', 'line', 'telegram'])
export type ChannelName = z.infer<typeof ChannelName>

/** Kinds a requester may receive (and choose channels for); staff choose for every kind. */
export const REQUESTER_KINDS: readonly NotificationKind[] = ['request_update', 'secretary_message']

/** A person's channel choice per kind. A missing kind means the role default (`defaultChannels`). */
export const NotificationPrefs = z
  .object({ kinds: z.record(NotificationKind, z.array(ChannelName).max(ChannelName.options.length)) })
  .strict()
export type NotificationPrefs = z.infer<typeof NotificationPrefs>

/** Role defaults: staff get email for assignments, pending proposals and discussions; requesters for their requests. */
export function defaultChannels(kind: NotificationKind, isStaff: boolean): ChannelName[] {
  const kinds: readonly NotificationKind[] = isStaff ? ['task_assigned', 'proposal_pending', 'discussion'] : ['request_update']
  return kinds.includes(kind) ? ['email'] : []
}

export const ChannelStatus = z.object({ name: ChannelName, configured: z.boolean(), enabled: z.boolean() })
export type ChannelStatus = z.infer<typeof ChannelStatus>

export const ChannelSettingsPatch = z
  .object({ email: z.boolean().optional(), line: z.boolean().optional(), telegram: z.boolean().optional() })
  .strict()
export type ChannelSettingsPatch = z.infer<typeof ChannelSettingsPatch>

/** `available`: configured and admin-enabled. Email counts as linked when the person has an email address. */
export const MyChannels = z.object({
  available: z.array(ChannelName),
  linked: z.object({ email: z.boolean(), line: z.boolean(), telegram: z.boolean() }),
})
export type MyChannels = z.infer<typeof MyChannels>

/** `GET /me/notification-prefs`: the kinds this person may choose for, the effective choice per kind, their channels. */
export const MyNotificationPrefs = z.object({
  kinds: z.array(NotificationKind),
  prefs: NotificationPrefs,
  channels: MyChannels,
})
export type MyNotificationPrefs = z.infer<typeof MyNotificationPrefs>

/** Channels linked to a chat account (LINE user id, Telegram chat id) through a one-time code. */
export const LinkableChannel = z.enum(['line', 'telegram'])
export type LinkableChannel = z.infer<typeof LinkableChannel>

/**
 * `POST /me/channel-links/:channel/code`: a one-time code (`LINK-XXXXXXXX`, 15 minutes). LINE: send it to the
 * official account (the portal shows its add-friend link from its own config); Telegram: open `deepLink`
 * (`t.me/<bot>?start=…`) or send the code to the bot.
 */
export const ChannelLinkCode = z.object({
  code: z.string(),
  expiresAt: z.string(),
  instructions: z.object({ deepLink: z.string().optional(), botUsername: z.string().optional() }),
})
export type ChannelLinkCode = z.infer<typeof ChannelLinkCode>
