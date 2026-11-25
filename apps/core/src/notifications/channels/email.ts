import { createTransport } from 'nodemailer'
import type { Config } from '../../config.js'
import { ChannelError, renderText, type Channel, type ChannelDeps } from './index.js'

export type MailMessage = { from: string; to: string; subject: string; text: string }
/** The part of a nodemailer transport the email channel uses; tests inject a fake through `deps.mailTransport`. */
export type MailTransport = { sendMail(msg: MailMessage): Promise<unknown> }

/** Email is configured when an SMTP host and a sender address are set (user / password are optional). */
export function emailConfigured(config: Config): boolean {
  return Boolean(config.smtpHost && config.mailFrom)
}

export function createMailTransport(config: Config): MailTransport {
  return createTransport({
    host: config.smtpHost,
    port: config.smtpPort,
    secure: config.smtpSecure,
    auth: config.smtpUser ? { user: config.smtpUser, pass: config.smtpPassword ?? '' } : undefined,
    connectionTimeout: 10_000,
    greetingTimeout: 10_000,
    socketTimeout: 20_000,
  })
}

/** Nodemailer error codes that a retry cannot fix (bad credentials, rejected recipient, bad message). */
const PERMANENT_CODES = new Set(['EAUTH', 'EENVELOPE', 'EMESSAGE', 'ENOAUTH', 'ECONFIG'])

/**
 * Maps a transport error to a ChannelError carrying only nodemailer's code (or `smtp_<status>`): the error's
 * message may hold the server's reply, addresses or credentials, so it is dropped.
 */
export function toChannelError(err: unknown): ChannelError {
  const e = err as { code?: unknown; responseCode?: unknown }
  const code = typeof e?.code === 'string' && /^[A-Z][A-Z_]{1,31}$/.test(e.code) ? e.code : null
  const status = typeof e?.responseCode === 'number' ? e.responseCode : null
  // An SMTP 5xx reply is final; 4xx is "try again later".
  const permanent = status !== null ? status >= 500 : code !== null && PERMANENT_CODES.has(code)
  return new ChannelError(code ?? (status !== null ? `smtp_${status}` : 'smtp_error'), permanent)
}

const oneLine = (s: string) => s.replace(/[\r\n]+/g, ' ').trim()

export function emailChannel(deps: ChannelDeps): Channel {
  let transport = deps.mailTransport
  return {
    name: 'email',
    configured: emailConfigured,
    async send(target, msg) {
      if (!emailConfigured(deps.config)) throw new ChannelError('not_configured', true)
      if (!target.email) throw new ChannelError('no_address', true)
      transport ??= createMailTransport(deps.config)
      try {
        await transport.sendMail({
          from: deps.config.mailFrom!,
          to: target.email,
          subject: oneLine(msg.title),
          text: renderText(msg, deps.config.portalUrl),
        })
      } catch (err) {
        throw toChannelError(err)
      }
    },
  }
}
