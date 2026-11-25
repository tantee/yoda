// Liveness for the container healthcheck: the portal server answers (core's readiness is checked on core).
export default defineEventHandler(() => ({ status: 'ok' }))
