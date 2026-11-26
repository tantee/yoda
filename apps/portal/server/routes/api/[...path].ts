// Runtime proxy to core: the target comes from NUXT_CORE_URL at runtime, not at build time.
// Core reads the client's address, scheme and host from the X-Forwarded-* headers set here (it trusts them from one
// internal hop only): the address the portal saw is appended, so a browser cannot pick its own for core's rate
// limits and audit log; the scheme decides whether the setup and recovery cookies are `Secure`.
export default defineEventHandler((event) => {
  const { coreUrl } = useRuntimeConfig(event)
  const path = event.path.replace(/^\/api/, '') || '/'
  return proxyRequest(event, `${String(coreUrl).replace(/\/+$/, '')}${path}`, { headers: forwardedHeaders(event) })
})

// X-Forwarded-Proto and -Host are passed on as they arrive when an outer reverse proxy set them, else derived here.
// With no outer proxy a browser could send its own; that only changes its own request: a claimed https makes its
// cookies Secure (stricter), and a claimed host only matters to the Origin check and the localhost rule for TOTP,
// which also needs the saved public URL to be localhost. The client address is different: the portal always
// appends the peer it saw, and core believes only YODA_TRUSTED_PROXY_HOPS entries from the right.
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
