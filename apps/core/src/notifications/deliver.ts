import type { ChannelName, NotificationKind } from '@yoda/shared'
import { and, eq } from 'drizzle-orm'
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

async function record(db: Db, notificationId: string, channel: ChannelName, state: 'sent' | 'failed' | 'skipped', errorCode: string | null) {
  const values = { notificationId, channel, state, errorCode }
  await db
    .insert(notificationDeliveries)
    .values(values)
    .onConflictDoUpdate({ target: [notificationDeliveries.notificationId, notificationDeliveries.channel], set: { state, errorCode, at: new Date() } })
}

/**
 * `notify-deliver` job: sends the notification on each of the person's current channels that has no `sent`
 * row yet (so a re-run never sends twice), recording each outcome in its own row. Throws, so the queue retries
 * the job, only while a transient failure remains and attempts are left. Logs carry the channel and code only.
 */
export async function deliver(deps: DeliverDeps, notificationId: string, run?: Pick<JobRun, 'isFinalAttempt'>): Promise<void> {
  const [n] = await deps.db.select().from(notifications).where(eq(notifications.id, notificationId))
  if (!n) return
  const wanted = await channelsFor(deps.db, deps.config, n.personId, n.kind as NotificationKind)
  if (!wanted.length) return
  const done = await deps.db
    .select({ channel: notificationDeliveries.channel })
    .from(notificationDeliveries)
    .where(and(eq(notificationDeliveries.notificationId, n.id), eq(notificationDeliveries.state, 'sent')))
  const channels = createChannels(deps)
  const msg = { title: n.title, body: n.body, url: `${deps.config.portalUrl}${n.link ?? ''}` }
  let transient = 0
  for (const name of wanted) {
    if (done.some((d) => d.channel === name)) continue
    const channel = channels[name]
    if (!channel) {
      await record(deps.db, n.id, name, 'skipped', 'not_available')
      continue
    }
    try {
      await channel.send(await target(deps.db, n.personId, name), msg)
      await record(deps.db, n.id, name, 'sent', null)
    } catch (err) {
      const e = err instanceof ChannelError ? err : new ChannelError('send_failed', false)
      await record(deps.db, n.id, name, 'failed', e.code)
      console.warn(`notify-deliver: ${name} failed (${e.code})${e.permanent ? ', permanent' : ''}`)
      if (!e.permanent) transient++
    }
  }
  if (transient && !run?.isFinalAttempt) throw new Error(`notify-deliver: ${transient} transient failure(s), retrying`)
  if (transient) console.warn(`notify-deliver: giving up after the final attempt`)
}
