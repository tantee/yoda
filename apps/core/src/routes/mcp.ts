import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import type { FastifyError, FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import { createMcpServer } from '../mcp/server.js'
import type { RunnerCtx } from '../runners/claims.js'
import { authenticateRunner } from '../runners/records.js'

const MCP_BODY_LIMIT = 1024 * 1024
const PARSE_ERRORS = new Set(['FST_ERR_CTP_INVALID_JSON_BODY', 'FST_ERR_CTP_EMPTY_JSON_BODY'])

const rpcError = (reply: FastifyReply, status: number, code: number, message: string) =>
  reply.status(status).send({ jsonrpc: '2.0', error: { code, message }, id: null })

/**
 * `POST /mcp`: the runners' MCP endpoint, in the SDK's stateless Streamable HTTP mode (a new server and
 * transport per request, JSON responses, no sessions). Public to the Keycloak hook: it authenticates with a
 * runner token instead, so a Keycloak token is refused here and a runner token everywhere else.
 */
export function mcpRoutes(app: FastifyInstance): void {
  app.decorateRequest('runner', null)

  app.post(
    '/mcp',
    {
      config: { public: true },
      bodyLimit: MCP_BODY_LIMIT,
      // Before the body is read: an unauthenticated caller never gets it parsed (or a 413 instead of a 401).
      onRequest: async (request, reply) => {
        const rc = await authenticateRunner(app.deps.db, request.headers.authorization)
        // The unread body is not drained: close the connection after the answer.
        if (!rc) return rpcError(reply.header('connection', 'close'), 401, -32000, 'Unauthorized')
        request.runner = rc
      },
      errorHandler: (err: FastifyError, request, reply) => {
        if (PARSE_ERRORS.has(err.code) || err instanceof SyntaxError) return rpcError(reply, 400, -32700, 'Parse error')
        const status = err.statusCode
        if (status && status >= 400 && status < 500) return rpcError(reply, status, -32600, 'Invalid Request')
        request.log.error({ err: { name: err.name, message: err.message, stack: err.stack } }, 'mcp request failed')
        return rpcError(reply, 500, -32603, 'Internal error')
      },
    },
    async (request, reply) => {
      const rc = request.runner!
      const server = createMcpServer(app.deps, rc, request.log)
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true })
      // The transport writes the response itself.
      reply.hijack()
      reply.raw.on('close', () => {
        void transport.close()
        void server.close()
      })
      try {
        await server.connect(transport)
        await transport.handleRequest(request.raw, reply.raw, request.body)
      } catch (err) {
        const e = err instanceof Error ? err : new Error(String(err))
        request.log.error({ err: { name: e.name, message: e.message, stack: e.stack } }, 'mcp request failed')
        if (!reply.raw.headersSent) {
          reply.raw.writeHead(500, { 'content-type': 'application/json' })
          reply.raw.end(JSON.stringify({ jsonrpc: '2.0', error: { code: -32603, message: 'Internal error' }, id: null }))
        } else if (!reply.raw.writableEnded) {
          reply.raw.end()
        }
      }
    },
  )

  // Stateless: no SSE stream to open and no session to end.
  const notAllowed = async (_req: FastifyRequest, reply: FastifyReply) => {
    reply.header('allow', 'POST')
    return rpcError(reply, 405, -32000, 'Method not allowed')
  }
  app.get('/mcp', { config: { public: true } }, notAllowed)
  app.delete('/mcp', { config: { public: true } }, notAllowed)
}

declare module 'fastify' {
  interface FastifyRequest {
    /** The authenticated runner of a `/mcp` request. */
    runner: RunnerCtx | null
  }
}
