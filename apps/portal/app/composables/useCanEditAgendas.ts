import type { Project, ProjectDetail } from '@yoda/shared'

/** Agendas are edited by admins and by PMs of any project (the server enforces; this only hides the controls). */
export function useCanEditAgendas() {
  const { me } = useMe()
  const api = useApi()
  const isPm = ref(false)
  onMounted(async () => {
    if (!me.value || me.value.isAdmin) return
    try {
      const projects = await api<Project[]>('/projects')
      const details = await Promise.all(projects.map(p => api<ProjectDetail>(`/projects/${p.id}`).catch(() => null)))
      isPm.value = details.some(p => p?.members.some(m => m.personId === me.value?.id && m.roles.includes('PM')))
    } catch {
      isPm.value = false
    }
  })
  return computed(() => !!me.value?.isAdmin || isPm.value)
}
