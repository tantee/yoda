import { homeFor, isStaffPath } from '~/utils/nav'

export default defineNuxtRouteMiddleware(async (to) => {
  const { me, refresh } = useMe()
  if (!me.value) await refresh()
  const user = me.value
  if (!user) return
  if (!user.isStaff && isStaffPath(to.path)) return navigateTo('/requests')
  if (to.path.startsWith('/admin') && !user.isAdmin) return navigateTo(homeFor(user))
})
