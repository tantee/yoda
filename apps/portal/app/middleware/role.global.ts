import { homeFor, isStaffPath } from '~/utils/nav'

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
  if (!user.isStaff && isStaffPath(to.path)) return navigateTo('/requests')
  if (to.path.startsWith('/admin') && !user.isAdmin) return navigateTo(homeFor(user))
})
