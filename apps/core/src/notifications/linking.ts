import { randomInt } from 'node:crypto'
import type { ChannelLinkCode, LinkableChannel } from '@yoda/shared'
import { and, count, eq, gte, lt, ne, sql } from 'drizzle-orm'
import type { Config } from '../config.js'
import type { Db, Tx } from '../db/client.js'
import { channelLinkAttempts, channelLinkCodes, channelLinks } from '../db/schema.js'
import { runWork, type WorkCtx, type WorkDeps } from '../work/context.js'
import { notify } from './service.js'

/** Base32 without the look-alikes 0, O, 1 and I: 32 symbols, so 8 of them give 2^40 codes. */
const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'
const CODE_LENGTH = 8
export const LINK_CODE_TTL_MS = 15 * 60_000
/** One chat account may send this many invalid codes per window; then its codes are ignored until it passes. */
export const ACCOUNT_ATTEMPTS = { max: 5, windowMs: 15 * 60_000 }
/** A channel-wide ceiling on invalid codes (a flood from many accounts): past it, no code is accepted for a while. */
export const CHANNEL_ATTEMPTS = { max: 200, windowMs: 10 * 60_000 }
const ATTEMPT_RETENTION_MS = 24 * 60 * 60_000
/** `LINK-XXXXXXXX`, case and the `LINK-` prefix optional (Telegram's start parameter carries the bare code). */
const CODE_RE = new RegExp(`^(?:LINK-)?([${ALPHABET}]{${CODE_LENGTH}})$`)

export type LinkDeps = { db: Db; config: Config; now?: () => Date }

function randomCode(): string {
  let s = ''
  for (let i = 0; i < CODE_LENGTH; i++) s += ALPHABET[randomInt(ALPHABET.length)]
  return `LINK-${s}`
}

/** The canonical `LINK-XXXXXXXX` for what a person typed, or null when it cannot be a code. */
export function normalizeCode(text: string): string | null {
  const m = text.trim().toUpperCase().match(CODE_RE)
  return m ? `LINK-${m[1]}` : null
}

/**
 * A new one-time link code for the person and channel, valid 15 minutes; it replaces any earlier code of
 * theirs for that channel. Telegram's `deepLink` opens the bot with the code as its start parameter.
 */
export async function createLinkCode(deps: LinkDeps, me: { id: string }, channel: LinkableChannel): Promise<ChannelLinkCode> {
  const expiresAt = new Date((deps.now?.() ?? new Date()).getTime() + LINK_CODE_TTL_MS)
  const code = await deps.db.transaction(async (tx) => {
    // Serialize code requests per person and channel, so two quick clicks still leave one active code.
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`link-code:${me.id}:${channel}`}))`)
    await tx.delete(channelLinkCodes).where(and(eq(channelLinkCodes.personId, me.id), eq(channelLinkCodes.channel, channel)))
    for (;;) {
      const candidate = randomCode()
      const [row] = await tx
        .insert(channelLinkCodes)
        .values({ code: candidate, personId: me.id, channel, expiresAt })
        .onConflictDoNothing()
        .returning({ code: channelLinkCodes.code })
      if (row) return row.code
    }
  })
  const bot = deps.config.telegramBotUsername
  const instructions =
    channel === 'telegram' && bot ? { deepLink: `https://t.me/${bot}?start=${code.slice('LINK-'.length)}`, botUsername: bot } : {}
  return { code, expiresAt: expiresAt.toISOString(), instructions }
}

const CHANNEL_NAMES: Record<LinkableChannel, string> = { line: 'LINE', telegram: 'Telegram' }

/**
 * Binds `externalId` (a LINE user id, a Telegram chat id) to the person who requested `code`. The code must be
 * unused, unexpired and for this channel; it is used up either way. An account linked to someone else moves:
 * whoever sends the code holds the account. The person it moved away from is told in the portal (and logged).
 */
export async function consumeLinkCode(
  ctx: WorkCtx,
  channel: LinkableChannel,
  code: string,
  externalId: string,
  now: Date = new Date(),
): Promise<'linked' | 'invalid'> {
  const { tx } = ctx
  const canonical = normalizeCode(code)
  if (!canonical) return 'invalid'
  const [row] = await tx
    .select()
    .from(channelLinkCodes)
    .where(eq(channelLinkCodes.code, canonical))
    .for('update')
  if (!row || row.channel !== channel || row.usedAt !== null || row.expiresAt.getTime() <= now.getTime()) return 'invalid'
  await tx.update(channelLinkCodes).set({ usedAt: now }).where(eq(channelLinkCodes.code, canonical))
  const moved = await tx
    .delete(channelLinks)
    .where(and(eq(channelLinks.channel, channel), eq(channelLinks.externalId, externalId), ne(channelLinks.personId, row.personId)))
    .returning({ personId: channelLinks.personId })
  for (const m of moved) {
    console.info(`channel-links: a ${channel} account moved from person ${m.personId} to ${row.personId}`)
    await notify(ctx, {
      personId: m.personId,
      kind: 'secretary_message',
      title: `บัญชี ${CHANNEL_NAMES[channel]} ที่คุณเชื่อมไว้ถูกเชื่อมกับผู้ใช้อื่นแล้ว`,
      body: `คุณจะไม่ได้รับการแจ้งเตือนทาง ${CHANNEL_NAMES[channel]} อีก หากคุณไม่ได้ทำเอง โปรดแจ้งผู้ดูแลระบบ และเชื่อมบัญชีใหม่ได้ที่หน้าตั้งค่าการแจ้งเตือน`,
      link: '/settings/notifications',
      dedupeKey: `channel-link-moved:${channel}:${now.toISOString()}`,
    })
  }
  await tx
    .insert(channelLinks)
    .values({ personId: row.personId, channel, externalId })
    .onConflictDoUpdate({ target: [channelLinks.personId, channelLinks.channel], set: { externalId, linkedAt: now } })
  return 'linked'
}

const lastFloodWarning: Partial<Record<LinkableChannel, number>> = {}

/** Why a chat account may not try a code now: too many invalid codes from it, or from everyone on the channel. */
async function throttled(db: Db | Tx, channel: LinkableChannel, externalId: string, now: Date): Promise<'account' | 'channel' | null> {
  const since = (ms: number) => new Date(now.getTime() - ms)
  const [mine] = await db
    .select({ n: count() })
    .from(channelLinkAttempts)
    .where(and(eq(channelLinkAttempts.channel, channel), eq(channelLinkAttempts.externalId, externalId), gte(channelLinkAttempts.at, since(ACCOUNT_ATTEMPTS.windowMs))))
  if (mine!.n >= ACCOUNT_ATTEMPTS.max) return 'account'
  const [all] = await db
    .select({ n: count() })
    .from(channelLinkAttempts)
    .where(and(eq(channelLinkAttempts.channel, channel), gte(channelLinkAttempts.at, since(CHANNEL_ATTEMPTS.windowMs))))
  if (all!.n >= CHANNEL_ATTEMPTS.max) {
    // Once a minute per channel and process, so a flood does not flood the log too.
    if ((lastFloodWarning[channel] ?? 0) < now.getTime() - 60_000) {
      lastFloodWarning[channel] = now.getTime()
      console.warn(`channel-links: ${channel} link codes refused: ${all!.n} invalid attempts in ${CHANNEL_ATTEMPTS.windowMs / 60_000} minutes`)
    }
    return 'channel'
  }
  return null
}

/**
 * A code sent from a chat account, as the webhooks see it. Throttled accounts (and the whole channel during a
 * flood) are ignored: the code is not looked at or used up, and no reply is sent (`'throttled'`). Each invalid
 * code counts against the account and the channel.
 */
export async function linkWithCode(
  deps: WorkDeps,
  channel: LinkableChannel,
  code: string,
  externalId: string,
  now: Date = new Date(),
): Promise<'linked' | 'invalid' | 'throttled'> {
  return runWork(deps, { id: null, kind: 'system' }, async (ctx) => {
    const { tx } = ctx
    // One account's codes are checked one at a time, so a parallel burst cannot slip past the account limit
    // (the check and the attempt insert share this transaction and lock).
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`link-attempt:${channel}:${externalId}`}))`)
    if (await throttled(tx, channel, externalId, now)) return 'throttled'
    const result = await consumeLinkCode(ctx, channel, code, externalId, now)
    if (result === 'invalid') {
      await tx.insert(channelLinkAttempts).values({ channel, externalId, at: now })
      await tx.delete(channelLinkAttempts).where(lt(channelLinkAttempts.at, new Date(now.getTime() - ATTEMPT_RETENTION_MS)))
    }
    return result
  })
}

export async function unlinkPerson(db: Db | Tx, personId: string, channel: LinkableChannel): Promise<void> {
  await db.delete(channelLinks).where(and(eq(channelLinks.personId, personId), eq(channelLinks.channel, channel)))
}

/** The provider says the account is gone (LINE unfollow, Telegram bot blocked): drop whichever link holds it. */
export async function unlinkExternal(db: Db | Tx, channel: LinkableChannel, externalId: string): Promise<void> {
  await db.delete(channelLinks).where(and(eq(channelLinks.channel, channel), eq(channelLinks.externalId, externalId)))
}
