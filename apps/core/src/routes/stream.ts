import type { ServerResponse } from 'node:http'
import type { LiveEvent } from '@yoda/shared'
import type { FastifyInstance } from 'fastify'
import { requireStaff } from '../auth/plugin.js'
import { canSeeProject } from '../work/queries.js'

const PING_MS = 25_000

export function streamRoutes(app: FastifyInstance): void {
  const open = new Set<ServerResponse>()

  // Fastify's close waits for connections; end live streams so shutdown doesn't hang.
  app.addHook('onClose', async () => {
    for (const res of open) res.end()
    open.clear()
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
    open.add(raw)

    let closed = false
    // Serialize deliveries so events keep their publish order.
    let chain: Promise<void> = Promise.resolve()
    const unsubscribe = bus.subscribe((e: LiveEvent) => {
      chain = chain.then(async () => {
        if (closed) return
        try {
          if (!(await canSeeProject(db, me, e.projectId))) return
          if (!closed) raw.write(`event: live\ndata: ${JSON.stringify(e)}\n\n`)
        } catch (err) {
          app.log.error(err, 'stream delivery failed')
        }
      })
    })
    const ping = setInterval(() => raw.write(': ping\n\n'), PING_MS)
    const expiry = setTimeout(() => raw.end(), Math.max(0, request.tokenExp - Date.now()))

    const cleanup = () => {
      closed = true
      unsubscribe()
      clearInterval(ping)
      clearTimeout(expiry)
      open.delete(raw)
    }
    raw.on('close', cleanup)
    request.raw.on('close', cleanup)
  })
}
