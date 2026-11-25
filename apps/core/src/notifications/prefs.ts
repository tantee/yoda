import {
  ChannelName,
  defaultChannels,
  MyNotificationPrefs,
  NotificationKind,
  NotificationPrefs,
  REQUESTER_KINDS,
  type ChannelSettingsPatch,
  type ChannelStatus,
  type MyChannels,
} from '@yoda/shared'
import { eq, sql } from 'drizzle-orm'
import type { Config } from '../config.js'
import type { Db, Tx } from '../db/client.js'
import { channelLinks, notificationChannelSettings, notificationPrefs, people } from '../db/schema.js'
import { configuredChannels, isConfigured } from './channels/index.js'

type Q = Db | Tx
type SettingsRow = typeof notificationChannelSettings.$inferSelect

const ENABLED_COLUMN = { email: 'emailEnabled', line: 'lineEnabled', telegram: 'telegramEnabled' } as const

async function settingsRow(q: Q): Promise<SettingsRow | undefined> {
  const [row] = await q.select().from(notificationChannelSettings).where(eq(notificationChannelSettings.id, 1))
  return row
}

/** Channels both configured (env) and enabled by an admin. */
async function availableChannels(q: Q, configured: readonly ChannelName[]): Promise<ChannelName[]> {
  if (!configured.length) return []
  const row = await settingsRow(q)
  return configured.filter((name) => row?.[ENABLED_COLUMN[name]] === true)
}

type PersonInfo = { email: string | null; isStaff: boolean }

async function personInfo(q: Q, personId: string): Promise<PersonInfo | null> {
  const [row] = await q
    .select({
      email: people.email,
      isStaff: sql<boolean>`(${people.isAdmin} or coalesce(${people.staffOverride}, ${people.lastSeenStaff}))`,
    })
    .from(people)
    .where(eq(people.id, personId))
  return row ?? null
}

async function linkedChannels(q: Q, personId: string, email: string | null): Promise<MyChannels['linked']> {
  const links = await q.select({ channel: channelLinks.channel }).from(channelLinks).where(eq(channelLinks.personId, personId))
  const has = (c: string) => links.some((l) => l.channel === c)
  return { email: Boolean(email), line: has('line'), telegram: has('telegram') }
}

async function storedKinds(q: Q, personId: string): Promise<NotificationPrefs['kinds']> {
  const [row] = await q.select({ kinds: notificationPrefs.kinds }).from(notificationPrefs).where(eq(notificationPrefs.personId, personId))
  return row?.kinds ?? {}
}

/** The kinds a person may receive outside the portal and choose channels for. */
export const choosableKinds = (isStaff: boolean): NotificationKind[] =>
  isStaff ? [...NotificationKind.options] : [...REQUESTER_KINDS]

/**
 * The channels a notification of `kind` goes out on for this person: their choice (or the role default)
 * ∩ admin-enabled ∩ configured ∩ linked. `configured` comes from config (`configuredChannels`).
 */
export async function resolveChannels(q: Q, configured: readonly ChannelName[], personId: string, kind: NotificationKind): Promise<ChannelName[]> {
  const available = await availableChannels(q, configured)
  if (!available.length) return []
  const person = await personInfo(q, personId)
  if (!person || !choosableKinds(person.isStaff).includes(kind)) return []
  const chosen = (await storedKinds(q, personId))[kind] ?? defaultChannels(kind, person.isStaff)
  if (!chosen.length) return []
  const linked = await linkedChannels(q, personId, person.email)
  return available.filter((name) => chosen.includes(name) && linked[name])
}

export function channelsFor(db: Q, config: Config, personId: string, kind: NotificationKind): Promise<ChannelName[]> {
  return resolveChannels(db, configuredChannels(config), personId, kind)
}

/** The person's prefs with every choosable kind filled in (stored choice, else the role default). */
export async function getMyPrefs(db: Db, config: Config, me: { id: string; isStaff: boolean }): Promise<MyNotificationPrefs> {
  const kinds = choosableKinds(me.isStaff)
  const stored = await storedKinds(db, me.id)
  const person = await personInfo(db, me.id)
  return MyNotificationPrefs.parse({
    kinds,
    prefs: { kinds: Object.fromEntries(kinds.map((k) => [k, stored[k] ?? defaultChannels(k, me.isStaff)])) },
    channels: {
      available: await availableChannels(db, configuredChannels(config)),
      linked: await linkedChannels(db, me.id, person?.email ?? null),
    },
  })
}

/**
 * Replaces the person's stored choices. Returns false (→ 422) when the body is not valid prefs or names a
 * kind this person may not choose (requesters: `request_update` and `secretary_message` only).
 */
export async function setMyPrefs(db: Db, me: { id: string; isStaff: boolean }, body: unknown): Promise<boolean> {
  const parsed = NotificationPrefs.safeParse(body)
  if (!parsed.success) return false
  const allowed = choosableKinds(me.isStaff)
  const entries = Object.entries(parsed.data.kinds) as [NotificationKind, ChannelName[]][]
  if (entries.some(([k]) => !allowed.includes(k))) return false
  const kinds = Object.fromEntries(entries.map(([k, v]) => [k, [...new Set(v)]]))
  await db
    .insert(notificationPrefs)
    .values({ personId: me.id, kinds })
    .onConflictDoUpdate({ target: notificationPrefs.personId, set: { kinds, updatedAt: sql`now()` } })
  return true
}

export async function channelStatuses(db: Db, config: Config): Promise<ChannelStatus[]> {
  const row = await settingsRow(db)
  return ChannelName.options.map((name) => ({
    name,
    configured: isConfigured(config, name),
    enabled: row?.[ENABLED_COLUMN[name]] === true,
  }))
}

/** Applies the admin's switches. Returns false (→ 422) when it would enable a channel that is not configured. */
export async function patchChannelSettings(db: Db, config: Config, actorId: string, patch: ChannelSettingsPatch): Promise<boolean> {
  const set: Partial<Record<(typeof ENABLED_COLUMN)[ChannelName], boolean>> = {}
  for (const name of ChannelName.options) {
    const on = patch[name]
    if (on === undefined) continue
    if (on && !isConfigured(config, name)) return false
    set[ENABLED_COLUMN[name]] = on
  }
  const values = { ...set, updatedBy: actorId, updatedAt: sql`now()` }
  // Upsert: the migration seeds the row, but never fail if it is missing.
  await db
    .insert(notificationChannelSettings)
    .values({ id: 1, ...values })
    .onConflictDoUpdate({ target: notificationChannelSettings.id, set: values })
  return true
}
