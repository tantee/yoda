import type { MyRequest } from '@yoda/shared'
import { forbiddenFor, workItemIdOf } from '~/utils/nav'
import { bootRedirect, isLocalAuthPath } from '~/utils/publicConfig'

export default defineNuxtRouteMiddleware(async (to) => {
  // /setup and /recovery never use Keycloak (useMe reads $keycloak); nor does the boot error screen.
  const { config, bootError } = usePublicConfig()
  const redirect = bootRedirect(to.path, config.value, bootError.value)
  if (redirect) return navigateTo(redirect, { replace: true })
  if (isLocalAuthPath(to.path) || bootError.value) return
  const { me, refresh } = useMe()
  const meError = useState<string>('meError', () => '')
  if (!me.value) {
    try {
      await refresh()
      meError.value = ''
    } catch (e) {
      meError.value = errorKey(e)
      return
    }
  }
  const user = me.value
  if (!user) return
  // A requester following a work item link (e.g. from an email) to their own request: open it as the request.
  const workItemId = user.isStaff ? null : workItemIdOf(to.path)
  if (workItemId) {
    try {
      const mine = await useApi()<MyRequest[]>('/me/requests')
      if (mine.some(r => r.workItemId === workItemId)) return navigateTo(`/requests/${workItemId}`, { replace: true })
    } catch {
      // fall through to the forbidden page
    }
  }
  // A page the user may not open: say so instead of a silent redirect. The server enforces access regardless.
  const need = forbiddenFor(user, to.path)
  if (need) return navigateTo({ path: '/forbidden', query: { need } }, { replace: true })
})
