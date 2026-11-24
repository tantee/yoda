import { Me } from '@yoda/shared'
import type { FastifyInstance } from 'fastify'

export function meRoutes(app: FastifyInstance): void {
  app.get('/me', async (request) => Me.parse(request.me))
}
