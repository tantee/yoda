// Test stand-in for Nuxt's `#imports`: Vue's API plus a `useI18n` that echoes keys with their named values.
export * from 'vue'

export function translate(key: string, named?: Record<string, unknown>): string {
  return named && Object.keys(named).length ? `${key}(${Object.entries(named).map(([k, v]) => `${k}=${String(v)}`).join(',')})` : key
}

export function useI18n() {
  return { t: translate, te: () => true, locale: { value: 'th' } }
}
