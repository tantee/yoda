import type { MeCounts } from '@yoda/shared'
import { throttledLoader } from '~/utils/throttledLoader'

let loader: ((opts?: { force?: boolean }) => Promise<void>) | null = null

/**
 * The rail and bottom-nav badges (`GET /me/counts`). `refresh()` always reloads (call it after an action);
 * `refreshIfStale()` (navigation, timer) skips when the last load finished under 20 s ago. Requests in flight
 * are shared.
 */
export function useCounts() {
  const counts = useState<MeCounts | null>('meCounts', () => null)
  if (!loader) {
    // Created in a component's setup, so the API client is bound to the Nuxt app.
    const api = useApi()
    loader = throttledLoader(async () => {
      try {
        counts.value = await api<MeCounts>('/me/counts')
      } catch {
        // badges keep their last value
      }
    }, 20000)
  }
  const load = loader
  return {
    counts,
    refresh: () => load({ force: true }),
    refreshIfStale: () => load(),
  }
}
