import { forbiddenFor } from '~/utils/nav'

export default defineNuxtRouteMiddleware(async (to) => {
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
  // A page the user may not open: say so instead of a silent redirect. The server enforces access regardless.
  const need = forbiddenFor(user, to.path)
  if (need) return navigateTo({ path: '/forbidden', query: { need } }, { replace: true })
})
