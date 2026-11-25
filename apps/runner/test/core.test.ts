import { createServer, type Server as HttpServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { RunnerConfig } from '../src/config.js'
import { connectCore, McpToolError } from '../src/core.js'
import { TOKEN } from './helpers.js'

const RUN_ID = '00000000-0000-4000-8000-000000000001'
const TASK_ID = '00000000-0000-4000-8000-000000000002'
const calls: { name: string; args: unknown }[] = []
let http: HttpServer
let url: string

/** A tiny stand-in for core's MCP server: bearer check, then canned tool results in the Task 6 shapes. */
function mcpServer(): Server {
  const server = new Server({ name: 'fake-core', version: '0.0.0' }, { capabilities: { tools: {} } })
  const text = (body: unknown, isError = false) => ({ content: [{ type: 'text' as const, text: JSON.stringify(body) }], ...(isError ? { isError } : {}) })
  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: [] }))
  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const { name, arguments: args } = req.params
    calls.push({ name, args })
    switch (name) {
      case 'claim_task':
        return args?.taskId === TASK_ID
          ? text({ runId: RUN_ID, leaseExpiresAt: '2026-11-25T00:10:00.000Z' })
          : text({ code: 'invalid_state', reason: 'already_claimed' }, true)
      case 'list_available_tasks':
        return text({ tasks: [] })
      case 'get_context_pack':
        return text({ text: '# Task', code: { repos: [], branch: 'yoda/abcd1234-x' } })
      case 'heartbeat':
        return text({ code: 'invalid_state', reason: 'run_not_active' }, true)
      case 'submit_result':
        return text({ outcome: 'accepted' })
      case 'release_task':
        return text({ released: true })
      default:
        return text({ code: 'unknown_tool' }, true)
    }
  })
  return server
}

beforeAll(async () => {
  http = createServer(async (req, res) => {
    if (req.headers.authorization !== `Bearer ${TOKEN}`) {
      res.writeHead(401, { 'content-type': 'application/json' }).end('{"jsonrpc":"2.0","error":{"code":-32000,"message":"Unauthorized"},"id":null}')
      return
    }
    if (req.method !== 'POST') {
      res.writeHead(405, { allow: 'POST' }).end()
      return
    }
    const server = mcpServer()
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true })
    res.on('close', () => {
      void transport.close()
      void server.close()
    })
    await server.connect(transport)
    await transport.handleRequest(req, res)
  })
  await new Promise<void>((r) => http.listen(0, '127.0.0.1', r))
  url = `http://127.0.0.1:${(http.address() as AddressInfo).port}`
})
afterAll(() => new Promise<void>((r) => http.close(() => r())))

const cfg = (token = TOKEN) => RunnerConfig.parse({ coreUrl: url, token })

describe('CoreClient', () => {
  it('calls tools with the bearer token and returns their bodies', async () => {
    const core = await connectCore(cfg())
    try {
      expect(await core.claimTask({ taskId: TASK_ID })).toEqual({ runId: RUN_ID, leaseExpiresAt: '2026-11-25T00:10:00.000Z' })
      expect(await core.listAvailableTasks({})).toEqual({ tasks: [] })
      expect(await core.getContextPack({ runId: RUN_ID })).toEqual({ text: '# Task', code: { repos: [], branch: 'yoda/abcd1234-x' } })
      expect(await core.submitResult({ runId: RUN_ID, text: 'done' })).toEqual({ outcome: 'accepted' })
      expect(await core.releaseTask({ runId: RUN_ID, reason: 'stop', failed: false })).toEqual({ released: true })
      expect(calls.find((c) => c.name === 'submit_result')?.args).toEqual({ runId: RUN_ID, text: 'done' })
    } finally {
      await core.close()
    }
  })

  it('turns tool errors into McpToolError with code and reason', async () => {
    const core = await connectCore(cfg())
    try {
      const err = await core.claimTask({ taskId: RUN_ID }).catch((e: unknown) => e)
      expect(err).toBeInstanceOf(McpToolError)
      expect(err).toMatchObject({ code: 'invalid_state', reason: 'already_claimed' })
      await expect(core.heartbeat({ runId: RUN_ID })).rejects.toMatchObject({ code: 'invalid_state', reason: 'run_not_active' })
      await expect(core.postProgress({ runId: RUN_ID, note: 'n' })).rejects.toMatchObject({ code: 'unknown_tool' })
    } finally {
      await core.close()
    }
  })

  it('reports a refused token as unauthorized, without the token', async () => {
    const wrong = 'yoda_rt_WRONGtestonly' // DEV ONLY: test placeholder
    const err = await connectCore(cfg(wrong)).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(McpToolError)
    expect(err).toMatchObject({ code: 'unauthorized' })
    expect(String(err)).not.toContain(wrong)
  })
})
