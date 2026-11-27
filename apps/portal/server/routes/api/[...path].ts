import { forwardedHeaders, trustedHops } from '../../utils/forwarded'

// Runtime proxy to core: the target comes from NUXT_CORE_URL at runtime, not at build time. Core reads the
// client's address, scheme and host from the X-Forwarded-* headers set here (server/utils/forwarded.ts): with
// YODA_TRUSTED_PROXY_HOPS = 1 the host is the portal's own Host and an incoming https is honoured (upgrade only);
// with more, the reverse proxy's scheme and host are passed on.
export default defineEventHandler((event) => {
  const { coreUrl } = useRuntimeConfig(event)
  const path = event.path.replace(/^\/api/, '') || '/'
  const headers = forwardedHeaders({
    peer: event.node.req.socket.remoteAddress ?? '',
    encrypted: (event.node.req.socket as { encrypted?: boolean }).encrypted === true,
    headers: {
      forwardedFor: getRequestHeader(event, 'x-forwarded-for'),
      forwardedProto: getRequestHeader(event, 'x-forwarded-proto'),
      forwardedHost: getRequestHeader(event, 'x-forwarded-host'),
      host: getRequestHeader(event, 'host'),
    },
    hops: trustedHops(process.env.YODA_TRUSTED_PROXY_HOPS),
  })
  return proxyRequest(event, `${String(coreUrl).replace(/\/+$/, '')}${path}`, { headers })
})
