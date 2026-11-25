import { ChannelSettingsPatch } from '@yoda/shared'
import type { FastifyInstance } from 'fastify'
import { channelNotConfigured, invalidPrefs, requireAdmin, requireSignedIn } from '../auth/plugin.js'
import { channelStatuses, getMyPrefs, patchChannelSettings, setMyPrefs } from '../notifications/prefs.js'

/** Own notification prefs (requesters too) and the admin's channel switches. Credentials are never returned. */
export function notificationChannelRoutes(app: FastifyInstance): void {
  const { db, config } = app.deps

  app.get('/me/notification-prefs', async (request) => {
    requireSignedIn(request)
    return getMyPrefs(db, config, request.me)
  })

  app.put('/me/notification-prefs', async (request) => {
    requireSignedIn(request)
    if (!(await setMyPrefs(db, request.me, request.body))) throw invalidPrefs()
    return getMyPrefs(db, config, request.me)
  })

  app.get('/admin/notification-channels', async (request) => {
    requireAdmin(request)
    return channelStatuses(db, config)
  })

  app.patch('/admin/notification-channels', async (request) => {
    requireAdmin(request)
    const body = ChannelSettingsPatch.parse(request.body)
    if (!(await patchChannelSettings(db, config, request.me.id, body))) throw channelNotConfigured()
    return channelStatuses(db, config)
  })
}
