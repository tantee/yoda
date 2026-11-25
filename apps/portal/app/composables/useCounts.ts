import type { MeCounts } from '@yoda/shared'

/** The rail and bottom-nav badges (`GET /me/counts`); the layout loads and refreshes them. */
export function useCounts() {
  const counts = useState<MeCounts | null>('meCounts', () => null)
  let seq = 0
  async function refresh() {
    const mine = ++seq
    try {
      const c = await useApi()<MeCounts>('/me/counts')
      if (mine === seq) counts.value = c
    } catch {
      // badges keep their last value
    }
  }
  return { counts, refresh }
}
