// Test stand-in for Nuxt's `#imports`: Vue's API plus a `useI18n` that echoes keys with their named values,
// a plain `useState` store and a settable `useRoute`.
import { reactive, ref, type Ref } from 'vue'

export * from 'vue'

export function translate(key: string, named?: Record<string, unknown>): string {
  return named && Object.keys(named).length ? `${key}(${Object.entries(named).map(([k, v]) => `${k}=${String(v)}`).join(',')})` : key
}

export function useI18n() {
  return { t: translate, te: () => true, locale: { value: 'th' } }
}

const states = new Map<string, Ref<unknown>>()
export function useState<T>(key: string, init?: () => T): Ref<T> {
  if (!states.has(key)) states.set(key, ref(init ? init() : undefined))
  return states.get(key) as Ref<T>
}
export function resetStates() {
  states.clear()
}

export const testRoute = reactive({ path: '/' })
export function useRoute() {
  return testRoute
}
