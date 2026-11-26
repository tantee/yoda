// Runtime proxy to core: the target comes from NUXT_CORE_URL at runtime, not at build time.
// Core reads the client's address, scheme and host from the X-Forwarded-* headers set here (it trusts them from one
// internal hop only): the address the portal saw is appended, so a browser cannot pick its own for core's rate
// limits and audit log; the scheme decides whether the setup and recovery cookies are `Secure`.
export default defineEventHandler((event) => {
  const { coreUrl } = useRuntimeConfig(event)
  const path = event.path.replace(/^\/api/, '') || '/'
  return proxyRequest(event, `${String(coreUrl).replace(/\/+$/, '')}${path}`, { headers: forwardedHeaders(event) })
})

function forwardedHeaders(event: Parameters<typeof getRequestHeader>[0]): Record<string, string> {
  const peer = event.node.req.socket.remoteAddress ?? ''
  const prior = getRequestHeader(event, 'x-forwarded-for')
  const encrypted = (event.node.req.socket as { encrypted?: boolean }).encrypted === true
  return {
    'x-forwarded-for': prior ? `${prior}, ${peer}` : peer,
    'x-forwarded-proto': getRequestHeader(event, 'x-forwarded-proto') ?? (encrypted ? 'https' : 'http'),
    'x-forwarded-host': getRequestHeader(event, 'x-forwarded-host') ?? getRequestHeader(event, 'host') ?? '',
  }
}
