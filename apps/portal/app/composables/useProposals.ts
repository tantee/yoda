import type { Proposal, Todo } from '@yoda/shared'

/**
 * Proposals for chat action cards. Staff only: requesters cannot list proposals, so their cards show no
 * detail. `decidable` comes from /me/todo, which lists exactly the pending proposals this person may decide.
 */
export function useProposals() {
  const { me } = useMe()
  const api = useApi()
  const byId = useState<Record<string, Proposal>>('chatProposals', () => ({}))
  const decidable = useState<string[]>('chatDecidable', () => [])
  let seq = 0

  async function refresh() {
    if (!me.value?.isStaff) return
    const mine = ++seq
    try {
      const [list, todo] = await Promise.all([api<Proposal[]>('/proposals'), api<Todo>('/me/todo')])
      if (mine !== seq) return
      byId.value = Object.fromEntries(list.map(p => [p.id, p]))
      decidable.value = todo.proposals.map(p => p.id)
    } catch {
      // cards fall back to showing no state
    }
  }

  return { byId, decidable, refresh }
}
