import type { ChannelName, NotificationKind } from '@yoda/shared'
import { and, eq, ne, or } from 'drizzle-orm'
import type { Config } from '../config.js'
import type { Db } from '../db/client.js'
import { channelLinks, notificationDeliveries, notifications, people } from '../db/schema.js'
import type { JobRun } from '../jobs/queue.js'
import { ChannelError, createChannels, type ChannelDeps, type ChannelTarget } from './channels/index.js'
import { channelsFor } from './prefs.js'

export type DeliverDeps = ChannelDeps & { db: Db; config: Config }

async function target(db: Db, personId: string, channel: ChannelName): Promise<ChannelTarget> {
  if (channel === 'email') {
    const [p] = await db.select({ email: people.email }).from(people).where(eq(people.id, personId))
    return { personId, email: p?.email ?? undefined }
  }
  const [link] = await db
    .select({ externalId: channelLinks.externalId })
    .from(channelLinks)
    .where(and(eq(channelLinks.personId, personId), eq(channelLinks.channel, channel)))
  return { personId, externalId: link?.externalId }
}

/**
 * Upserts the outcome row for one channel. A `sent` row is never overwritten: a slower, failed attempt from an
 * overlapping run must not make a delivered message look failed (and get it sent again).
 */
export async function recordDelivery(
  db: Db,
  notificationId: string,
  channel: ChannelName,
  outcome: { state: 'sent' | 'failed' | 'skipped'; errorCode: string | null; permanent?: boolean },
) {
  const set = { state: outcome.state, errorCode: outcome.errorCode, permanent: outcome.permanent ?? false }
  await db
    .insert(notificationDeliveries)
    .values({ notificationId, channel, ...set })
    .onConflictDoUpdate({
      target: [notificationDeliveries.notificationId, notificationDeliveries.channel],
      set: { ...set, at: new Date() },
      setWhere: ne(notificationDeliveries.state, 'sent'),
    })
}

/**
 * `notify-deliver` job: sends the notification on each of the person's current channels that has no `sent`
 * row and no permanent failure yet, recording each outcome in its own row. Throws, so the queue retries the
 * job, only while a transient failure remains and attempts are left; a retry skips channels already settled,
 * so a permanent failure is never retried because another channel failed transiently. Logs carry the channel
 * and code only.
 *
 * Delivery is at least once: a crash (or a lost provider response) after the provider accepted a message but
 * before its `sent` row is written sends it again on the retry. Providers offer no idempotency key we can use
 * for every channel, so a rare duplicate is accepted over a lost message.
 */
export async function deliver(deps: DeliverDeps, notificationId: string, run?: Pick<JobRun, 'isFinalAttempt'>): Promise<void> {
  const [n] = await deps.db.select().from(notifications).where(eq(notifications.id, notificationId))
  if (!n) return
  const wanted = await channelsFor(deps.db, deps.config, n.personId, n.kind as NotificationKind)
  if (!wanted.length) return
  // Settled: delivered, or failed in a way no retry can fix.
  const done = await deps.db
    .select({ channel: notificationDeliveries.channel })
    .from(notificationDeliveries)
    .where(
      and(
        eq(notificationDeliveries.notificationId, n.id),
        or(eq(notificationDeliveries.state, 'sent'), and(eq(notificationDeliveries.state, 'failed'), eq(notificationDeliveries.permanent, true))),
      ),
    )
  const channels = createChannels(deps)
  const msg = { title: n.title, body: n.body, url: `${deps.config.portalUrl}${n.link ?? ''}` }
  let transient = 0
  for (const name of wanted) {
    if (done.some((d) => d.channel === name)) continue
    const channel = channels[name]
    if (!channel) {
      await recordDelivery(deps.db, n.id, name, { state: 'skipped', errorCode: 'not_available' })
      continue
    }
    try {
      await channel.send(await target(deps.db, n.personId, name), msg)
      await recordDelivery(deps.db, n.id, name, { state: 'sent', errorCode: null })
    } catch (err) {
      const e = err instanceof ChannelError ? err : new ChannelError('send_failed', false)
      await recordDelivery(deps.db, n.id, name, { state: 'failed', errorCode: e.code, permanent: e.permanent })
      console.warn(`notify-deliver: ${name} failed (${e.code})${e.permanent ? ', permanent' : ''}`)
      if (!e.permanent) transient++
    }
  }
  if (transient && !run?.isFinalAttempt) throw new Error(`notify-deliver: ${transient} transient failure(s), retrying`)
  if (transient) console.warn(`notify-deliver: giving up after the final attempt`)
}
