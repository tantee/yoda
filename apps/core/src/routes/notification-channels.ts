import { ChannelSettingsPatch, LinkableChannel } from '@yoda/shared'
import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { channelNotConfigured, channelUnavailable, invalidPrefs, notFound, requireAdmin, requireSignedIn } from '../auth/plugin.js'
import { createLinkCode, unlinkPerson } from '../notifications/linking.js'
import { availableChannels, channelStatuses, getMyPrefs, patchChannelSettings, setMyPrefs } from '../notifications/prefs.js'
import { configuredChannels } from '../notifications/channels/index.js'

const ChannelParams = z.object({ channel: z.string() })

function linkable(params: unknown): LinkableChannel {
  const parsed = LinkableChannel.safeParse(ChannelParams.parse(params).channel)
  if (!parsed.success) throw notFound()
  return parsed.data
}

/** Own notification prefs (requesters too) and the admin's channel switches. Credentials are never returned. */
export function notificationChannelRoutes(app: FastifyInstance): void {
  // Config is read per request (app.deps.config is the live settings snapshot); only the db is fixed.
  const { db } = app.deps

  app.get('/me/notification-prefs', async (request) => {
    requireSignedIn(request)
    return getMyPrefs(db, app.deps.config, request.me)
  })

  app.put('/me/notification-prefs', async (request) => {
    requireSignedIn(request)
    if (!(await setMyPrefs(db, request.me, request.body))) throw invalidPrefs()
    return getMyPrefs(db, app.deps.config, request.me)
  })

  /** A one-time code to link a LINE or Telegram account; the channel must be configured and enabled. */
  app.post('/me/channel-links/:channel/code', async (request) => {
    requireSignedIn(request)
    const channel = linkable(request.params)
    if (!(await availableChannels(db, configuredChannels(app.deps.config))).includes(channel)) throw channelUnavailable()
    return createLinkCode({ db, config: app.deps.config }, request.me, channel)
  })

  /** Unlinks the person's own account (allowed even when the channel has since been turned off). */
  app.delete('/me/channel-links/:channel', async (request, reply) => {
    requireSignedIn(request)
    await unlinkPerson(db, request.me.id, linkable(request.params))
    return reply.status(204).send()
  })

  app.get('/admin/notification-channels', async (request) => {
    requireAdmin(request)
    return channelStatuses(db, app.deps.config)
  })

  app.patch('/admin/notification-channels', async (request) => {
    requireAdmin(request)
    const body = ChannelSettingsPatch.parse(request.body)
    if (!(await patchChannelSettings(db, app.deps.config, request.me.id, body))) throw channelNotConfigured()
    return channelStatuses(db, app.deps.config)
  })
}
