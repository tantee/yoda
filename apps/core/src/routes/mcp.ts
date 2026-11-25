import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import type { FastifyInstance, FastifyReply } from 'fastify'
import { createMcpServer } from '../mcp/server.js'
import { authenticateRunner } from '../runners/records.js'

const MCP_BODY_LIMIT = 1024 * 1024

const rpcError = (reply: FastifyReply, status: number, message: string) =>
  reply.status(status).send({ jsonrpc: '2.0', error: { code: -32000, message }, id: null })

/**
 * `POST /mcp`: the runners' MCP endpoint, in the SDK's stateless Streamable HTTP mode (a new server and
 * transport per request, JSON responses, no sessions). Public to the Keycloak hook: it authenticates with a
 * runner token instead, so a Keycloak token is refused here and a runner token everywhere else.
 */
export function mcpRoutes(app: FastifyInstance): void {
  app.post('/mcp', { config: { public: true }, bodyLimit: MCP_BODY_LIMIT }, async (request, reply) => {
    const rc = await authenticateRunner(app.deps.db, request.headers.authorization)
    if (!rc) return rpcError(reply, 401, 'Unauthorized')

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
      request.log.error({ err }, 'mcp request failed')
      if (!reply.raw.headersSent) {
        reply.raw.writeHead(500, { 'content-type': 'application/json' })
        reply.raw.end(JSON.stringify({ jsonrpc: '2.0', error: { code: -32603, message: 'Internal error' }, id: null }))
      }
    }
  })

  // Stateless: no SSE stream to open and no session to end.
  const notAllowed = async (_req: unknown, reply: FastifyReply) => {
    reply.header('allow', 'POST')
    return rpcError(reply, 405, 'Method not allowed')
  }
  app.get('/mcp', { config: { public: true } }, notAllowed)
  app.delete('/mcp', { config: { public: true } }, notAllowed)
}
