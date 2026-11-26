import { computed } from 'vue'
import { useState } from '#imports'

/**
 * The admin fun-mode switch (`GET /ui-config`), shared by the shell. Unknown (not loaded yet, or the load failed)
 * counts as off, so nothing playful ever flashes in when an admin has switched it off.
 */
export function useFunMode() {
  const state = useState<boolean | null>('funMode', () => null)
  const enabled = computed(() => state.value === true)
  function set(on: boolean) {
    state.value = on
  }
  return { enabled, state, set }
}
