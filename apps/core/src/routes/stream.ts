import type { LiveEvent } from '@yoda/shared'
import type { FastifyInstance } from 'fastify'
import { requireStaff } from '../auth/plugin.js'
import { canSeeProject } from '../work/queries.js'

const PING_MS = 25_000

export function streamRoutes(app: FastifyInstance): void {
  const open = new Set<() => void>()

  // Fastify's close waits for connections; end live streams so shutdown doesn't hang.
  app.addHook('preClose', async () => {
    for (const cleanup of [...open]) cleanup()
  })

  app.get('/stream', async (request, reply) => {
    requireStaff(request)
    const { bus, db } = app.deps
    const me = request.me
    const raw = reply.raw
    reply.hijack()
    raw.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    })
    raw.write(': connected\n\n')
    let closed = false
    const writable = () => !closed && !raw.writableEnded && !raw.destroyed
    const unsubscribe = bus.subscribe((e: LiveEvent) => {
      // Serialize deliveries so events keep their publish order.
      chain = chain.then(async () => {
        if (!writable()) return
        try {
          if (!(await canSeeProject(db, me, e.projectId))) return
          if (writable()) raw.write(`event: live\ndata: ${JSON.stringify(e)}\n\n`)
        } catch (err) {
          app.log.error(err, 'stream delivery failed')
        }
      })
    })
    let chain: Promise<void> = Promise.resolve()
    const ping = setInterval(() => {
      if (writable()) raw.write(': ping\n\n')
    }, PING_MS)
    const expiry = setTimeout(() => cleanup(), Math.min(2 ** 31 - 1, Math.max(0, request.tokenExp - Date.now())))

    // Single exit path: expiry, server close, client close and socket errors all end up here.
    function cleanup() {
      closed = true
      unsubscribe()
      clearInterval(ping)
      clearTimeout(expiry)
      open.delete(cleanup)
      if (!raw.writableEnded && !raw.destroyed) raw.end()
    }
    open.add(cleanup)
    raw.on('close', cleanup)
    raw.on('error', cleanup)
    request.raw.on('close', cleanup)
  })
}
