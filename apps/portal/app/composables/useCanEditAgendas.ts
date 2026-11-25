import type { AgendaPermissions } from '@yoda/shared'

/**
 * Agendas are edited by admins and by PMs of any project (the server enforces; this only hides the controls).
 * Asked of the server on mount and whenever `me` changes (one cheap call, no per-project scan).
 */
export function useCanEditAgendas() {
  const { me } = useMe()
  const api = useApi()
  const allowed = useState<{ personId: string; canEdit: boolean } | null>('agenda-permissions', () => null)
  async function load() {
    const id = me.value?.id
    if (!id || me.value?.isAdmin) return
    try {
      const res = await api<AgendaPermissions>('/agendas/permissions')
      if (me.value?.id === id) allowed.value = { personId: id, canEdit: res.canEdit }
    } catch {
      // Controls stay hidden; the server would refuse anyway.
    }
  }
  onMounted(() => {
    void load()
  })
  watch(() => me.value?.id, () => void load())
  return computed(() => !!me.value?.isAdmin || (allowed.value?.personId === me.value?.id && !!allowed.value?.canEdit))
}
