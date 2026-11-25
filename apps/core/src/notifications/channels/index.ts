import { ChannelName } from '@yoda/shared'
import type { Config } from '../../config.js'
import { emailChannel, emailConfigured, type MailTransport } from './email.js'

/** Who to reach: the person, their email address (email channel) or their linked LINE / Telegram id. */
export type ChannelTarget = { personId: string; email?: string; externalId?: string }
/** Only the notification's own title and body, plus the absolute portal link. */
export type ChannelMessage = { title: string; body: string; url: string }

export type Channel = {
  name: ChannelName
  configured(config: Config): boolean
  send(target: ChannelTarget, msg: ChannelMessage): Promise<void>
}

/**
 * A failed send. `code` is short and safe to log and store (never a credential, address or provider text).
 * A permanent error (bad recipient, rejected credentials) is never retried; a transient one retries the job.
 */
export class ChannelError extends Error {
  constructor(
    readonly code: string,
    readonly permanent: boolean,
  ) {
    super(code)
    this.name = 'ChannelError'
  }
}

export type ChannelDeps = { config: Config; mailTransport?: MailTransport }

/** Whether each channel has its credentials in env. LINE and Telegram arrive with their channels. */
const CONFIGURED: Record<ChannelName, (config: Config) => boolean> = {
  email: emailConfigured,
  line: () => false,
  telegram: () => false,
}

export function isConfigured(config: Partial<Config>, name: ChannelName): boolean {
  return CONFIGURED[name](config as Config)
}

/** Channels whose credentials are set, in `ChannelName` order. */
export function configuredChannels(config: Partial<Config>): ChannelName[] {
  return ChannelName.options.filter((name) => isConfigured(config, name))
}

/** The channel implementations available to `deliver`. */
export function createChannels(deps: ChannelDeps): Partial<Record<ChannelName, Channel>> {
  return { email: emailChannel(deps) }
}

/** Plain-text message: the notification's title, body and link, then where to change preferences (th + en). */
export function renderText(msg: ChannelMessage, portalUrl: string): string {
  const settings = `${portalUrl}/settings/notifications`
  return [
    msg.title,
    ...(msg.body ? ['', msg.body] : []),
    '',
    msg.url,
    '',
    '--',
    `เปลี่ยนการแจ้งเตือนได้ที่ ${settings}`,
    `Change your notification settings at ${settings}`,
  ].join('\n')
}
