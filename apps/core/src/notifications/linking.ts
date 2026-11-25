import { randomInt } from 'node:crypto'
import type { ChannelLinkCode, LinkableChannel } from '@yoda/shared'
import { and, eq, ne, sql } from 'drizzle-orm'
import type { Config } from '../config.js'
import type { Db, Tx } from '../db/client.js'
import { channelLinkCodes, channelLinks } from '../db/schema.js'

/** Base32 without the look-alikes 0, O, 1 and I: 32 symbols, so 6 of them give 2^30 codes. */
const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'
const CODE_LENGTH = 6
export const LINK_CODE_TTL_MS = 15 * 60_000
/** `LINK-XXXXXX`, case and the `LINK-` prefix optional (Telegram's start parameter carries the bare code). */
const CODE_RE = new RegExp(`^(?:LINK-)?([${ALPHABET}]{${CODE_LENGTH}})$`)

export type LinkDeps = { db: Db; config: Config; now?: () => Date }

function randomCode(): string {
  let s = ''
  for (let i = 0; i < CODE_LENGTH; i++) s += ALPHABET[randomInt(ALPHABET.length)]
  return `LINK-${s}`
}

/** The canonical `LINK-XXXXXX` for what a person typed, or null when it cannot be a code. */
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

/**
 * Binds `externalId` (a LINE user id, a Telegram chat id) to the person who requested `code`. The code must be
 * unused, unexpired and for this channel; it is used up either way. An account linked to someone else moves:
 * whoever sends the code holds the account.
 */
export async function consumeLinkCode(
  tx: Tx,
  channel: LinkableChannel,
  code: string,
  externalId: string,
  now: Date = new Date(),
): Promise<'linked' | 'invalid'> {
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
  for (const m of moved) console.info(`channel-links: a ${channel} account moved from person ${m.personId} to ${row.personId}`)
  await tx
    .insert(channelLinks)
    .values({ personId: row.personId, channel, externalId })
    .onConflictDoUpdate({ target: [channelLinks.personId, channelLinks.channel], set: { externalId, linkedAt: now } })
  return 'linked'
}

export async function unlinkPerson(db: Db | Tx, personId: string, channel: LinkableChannel): Promise<void> {
  await db.delete(channelLinks).where(and(eq(channelLinks.personId, personId), eq(channelLinks.channel, channel)))
}

/** The provider says the account is gone (LINE unfollow, Telegram bot blocked): drop whichever link holds it. */
export async function unlinkExternal(db: Db | Tx, channel: LinkableChannel, externalId: string): Promise<void> {
  await db.delete(channelLinks).where(and(eq(channelLinks.channel, channel), eq(channelLinks.externalId, externalId)))
}
