import type { FastifyInstance } from 'fastify'
import type { LiveEvent, Me } from '@yoda/shared'
import { requireSignedIn } from '../auth/plugin.js'
import { canSeeConversation } from '../chat/service.js'
import type { Db } from '../db/client.js'
import { canSeeProject } from '../work/queries.js'

const PING_MS = 25_000

export function streamRoutes(app: FastifyInstance): void {
  const open = new Set<() => void>()

  // Fastify's close waits for connections; end live streams so shutdown doesn't hang.
  app.addHook('preClose', async () => {
    for (const cleanup of [...open]) cleanup()
  })

  app.get('/stream', async (request, reply) => {
    // Open to requesters too: `deliverable` limits them to their own conversations and person-addressed events.
    requireSignedIn(request)
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
          if (!(await deliverable(db, me, e))) return
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

/**
 * Who receives an event, by its most specific address: a conversation → whoever can see that conversation;
 * a person → only that person; otherwise the project → staff who can see it (requesters never get project events).
 */
async function deliverable(db: Db, me: Me, e: LiveEvent): Promise<boolean> {
  if (e.conversationId) return canSeeConversation(db, me, e.conversationId)
  if (e.personId) return e.personId === me.id
  if (e.projectId) return me.isStaff && canSeeProject(db, me, e.projectId)
  return false
}
