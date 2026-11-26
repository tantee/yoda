import { onScopeDispose, watch, type Ref } from 'vue'
import { ignoreKey, keyCode, konamiStep } from '~/utils/funMode'

type KeyTarget = Pick<EventTarget, 'addEventListener' | 'removeEventListener'>

/**
 * Listens for the Konami code while `enabled` is true (fun mode) and calls `onMatch`; nothing is listening while it
 * is off. Keys typed into fields are ignored. Purely local: no request is made.
 */
export function useKonami(enabled: Ref<boolean>, onMatch: () => void, target: () => KeyTarget | undefined = () => (typeof window === 'undefined' ? undefined : window)) {
  let buffer: string[] = []
  const onKey = (e: Event) => {
    const k = e as KeyboardEvent
    if (ignoreKey(k)) return
    const step = konamiStep(buffer, keyCode(k))
    buffer = step.buffer
    if (step.matched) onMatch()
  }
  let bound: KeyTarget | undefined
  const unbind = () => {
    bound?.removeEventListener('keydown', onKey)
    bound = undefined
    buffer = []
  }
  watch(enabled, (on) => {
    unbind()
    if (!on) return
    bound = target()
    bound?.addEventListener('keydown', onKey)
  }, { immediate: true })
  onScopeDispose(unbind)
}
