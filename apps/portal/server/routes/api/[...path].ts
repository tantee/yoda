// Runtime proxy to core: the target comes from NUXT_CORE_URL at runtime, not at build time.
export default defineEventHandler((event) => {
  const { coreUrl } = useRuntimeConfig(event)
  const path = event.path.replace(/^\/api/, '') || '/'
  return proxyRequest(event, `${String(coreUrl).replace(/\/+$/, '')}${path}`)
})
