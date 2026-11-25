import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { eq } from 'drizzle-orm'
import Fastify, { type FastifyBaseLogger, type FastifyInstance } from 'fastify'
import { Writable } from 'node:stream'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { buildApp, LOGGER_OPTIONS, type AppDeps } from '../src/app.js'
import { people, projectMembers, projects, runners, tasks, workItems } from '../src/db/schema.js'
import { InlineJobQueue } from '../src/jobs/queue.js'
import { createMcpServer } from '../src/mcp/server.js'
import { meFromPerson } from '../src/runners/records.js'
import { newRunnerToken } from '../src/runners/tokens.js'
import { latestTemplate } from '../src/workflow/seed.js'
import { resetDb, testDb, testDeps } from './helpers.js'
import { login, makeApp } from './support.js'

const TOOLS = [
  'list_available_tasks',
  'claim_task',
  'heartbeat',
  'get_context_pack',
  'search_knowledge',
  'write_knowledge',
  'post_progress',
  'open_merge_request',
  'submit_result',
  'ask_human',
  'release_task',
]

let app: FastifyInstance
let url: URL
let ownerId: string
let taskId: string
const clients: Client[] = []

async function addRunner(name: string): Promise<{ id: string; token: string }> {
  const db = await testDb()
  const { token, hash, prefix } = newRunnerToken()
  const [r] = await db
    .insert(runners)
    .values({
      name,
      kind: 'server',
      ownerId,
      accountType: 'api-key',
      capabilities: ['code-change'],
      mode: 'unattended',
      maxConcurrent: 2,
      tokenHash: hash,
      tokenPrefix: prefix,
      createdBy: ownerId,
    })
    .returning()
  return { id: r!.id, token }
}

async function connect(token?: string): Promise<Client> {
  const transport = new StreamableHTTPClientTransport(url, {
    requestInit: token ? { headers: { authorization: `Bearer ${token}` } } : {},
  })
  const client = new Client({ name: 'mcp-test', version: '0.0.0' })
  clients.push(client)
  await client.connect(transport)
  return client
}

type ToolOut = { isError: boolean; body: Record<string, unknown> }

async function call(client: Client, name: string, args: Record<string, unknown>): Promise<ToolOut> {
  const res = (await client.callTool({ name, arguments: args })) as { isError?: boolean; content: { type: string; text: string }[] }
  expect(res.content).toHaveLength(1)
  expect(res.content[0]!.type).toBe('text')
  return { isError: res.isError === true, body: JSON.parse(res.content[0]!.text) }
}

async function ok(client: Client, name: string, args: Record<string, unknown>): Promise<Record<string, unknown>> {
  const out = await call(client, name, args)
  expect(out, `${name} → ${JSON.stringify(out.body)}`).toMatchObject({ isError: false })
  return out.body
}

beforeEach(async () => {
  const db = await testDb()
  await resetDb(db)
  app = await makeApp()
  const [owner] = await db
    .insert(people)
    .values({ keycloakSub: 'sub-dev', username: 'dev', displayName: 'dev', lastSeenStaff: true })
    .returning()
  ownerId = owner!.id
  const [p] = await db.insert(projects).values({ name: 'Lab', autonomy: 'auto-assign' }).returning()
  await db.insert(projectMembers).values({ projectId: p!.id, personId: ownerId, roles: ['DEV'] })
  const templateId = (await latestTemplate(db, 'bug-fix'))!.id
  const [w] = await db
    .insert(workItems)
    .values({ projectId: p!.id, templateId, title: 'Fix lab report', ownerId, currentStepKey: 'dev' })
    .returning()
  const [t] = await db
    .insert(tasks)
    .values({ workItemId: w!.id, projectId: p!.id, stepKey: 'dev', attempt: 1, type: 'ai', role: 'DEV', executor: 'ai', state: 'open', templateTaskKey: 'implement' })
    .returning()
  taskId = t!.id
  await app.listen({ port: 0, host: '127.0.0.1' })
  const addr = app.server.address() as { port: number }
  url = new URL(`http://127.0.0.1:${addr.port}/mcp`)
})

afterEach(async () => {
  await Promise.all(clients.splice(0).map((c) => c.close().catch(() => {})))
  await (app.deps.jobs as InlineJobQueue).drain()
  await app.close()
})

describe('MCP server', () => {
  it('lists exactly the 11 runner tools, with input schemas', async () => {
    const client = await connect((await addRunner('r1')).token)
    const { tools } = await client.listTools()
    expect(tools.map((t) => t.name).sort()).toEqual([...TOOLS].sort())
    const claim = tools.find((t) => t.name === 'claim_task')!
    expect(claim.inputSchema).toMatchObject({ type: 'object', properties: { taskId: { type: 'string', format: 'uuid' } }, required: ['taskId'] })
    expect(tools.find((t) => t.name === 'get_context_pack')!.description).toMatch(/post_progress[\s\S]*submit_result/)
    for (const t of tools) expect(t.description?.length).toBeGreaterThan(10)
  })

  it('works a task end to end: list, claim, context pack, progress, submit', async () => {
    const client = await connect((await addRunner('r1')).token)
    const { tasks: available } = (await ok(client, 'list_available_tasks', {})) as { tasks: { taskId: string }[] }
    expect(available.map((t) => t.taskId)).toEqual([taskId])
    const claimed = await ok(client, 'claim_task', { taskId })
    expect(claimed).toEqual({ runId: expect.any(String), leaseExpiresAt: expect.any(String) })
    const runId = claimed.runId as string
    expect(await ok(client, 'heartbeat', { runId })).toEqual({ leaseExpiresAt: expect.any(String) })
    const pack = await ok(client, 'get_context_pack', { runId })
    expect(Object.keys(pack).sort()).toEqual(['code', 'text'])
    expect(pack.code).toMatchObject({ repos: [], branch: expect.stringMatching(/^yoda\/[0-9a-f]{8}-fix-lab-report$/) })
    expect(pack.text).toContain('Fix lab report')
    expect(await ok(client, 'search_knowledge', { query: 'lab' })).toEqual({ hits: expect.any(Array) })
    expect(await ok(client, 'write_knowledge', { runId, type: 'fact', title: 'Quirk', body: 'dates are dd/mm' })).toEqual({ entryId: expect.any(String) })
    expect(await ok(client, 'post_progress', { runId, note: 'halfway' })).toEqual({ entryId: expect.any(String) })
    expect(await ok(client, 'submit_result', { runId, text: 'Fixed the report', usage: { model: 'fake-model' } })).toEqual({ outcome: 'accepted' })
    const db = await testDb()
    const [row] = await db.select().from(tasks).where(eq(tasks.id, taskId))
    expect(row!.state).toBe('accepted')
    // The run is over: further calls on it are refused, as tool errors.
    expect(await call(client, 'heartbeat', { runId })).toEqual({ isError: true, body: { code: 'invalid_state', reason: 'run_not_active' } })
  })

  it('release_task gives the task back to the queue', async () => {
    const client = await connect((await addRunner('r1')).token)
    const { runId } = (await ok(client, 'claim_task', { taskId })) as { runId: string }
    expect(await ok(client, 'release_task', { runId, reason: 'not today', failed: false })).toEqual({ released: true })
    const { tasks: available } = (await ok(client, 'list_available_tasks', {})) as { tasks: { taskId: string }[] }
    expect(available.map((t) => t.taskId)).toEqual([taskId])
  })

  it('maps bad input to a validation tool error without crashing', async () => {
    const client = await connect((await addRunner('r1')).token)
    const out = await call(client, 'claim_task', { taskId: 'not-a-uuid' })
    expect(out).toEqual({ isError: true, body: { code: 'validation', reason: expect.stringContaining('taskId') } })
    expect(await call(client, 'heartbeat', {})).toEqual({ isError: true, body: { code: 'validation', reason: expect.stringContaining('runId') } })
    // The server is still fine.
    expect((await client.listTools()).tools).toHaveLength(11)
  })

  it('maps HTTP errors to tool errors with code and reason', async () => {
    const client = await connect((await addRunner('r1')).token)
    expect(await call(client, 'claim_task', { taskId: crypto.randomUUID() })).toEqual({ isError: true, body: { code: 'not_found' } })
  })

  it('two runners racing for one task: one wins, one gets invalid_state', async () => {
    const [a, b] = await Promise.all([connect((await addRunner('r1')).token), connect((await addRunner('r2')).token)])
    const outs = await Promise.all([call(a, 'claim_task', { taskId }), call(b, 'claim_task', { taskId })])
    expect(outs.filter((o) => !o.isError)).toHaveLength(1)
    const lost = outs.find((o) => o.isError)!
    expect(lost.body).toMatchObject({ code: 'invalid_state' })
  })

  describe('authentication', () => {
    async function rejected(token?: string): Promise<void> {
      await expect(connect(token)).rejects.toMatchObject({ code: 401 })
    }

    it('refuses a request without a token', async () => {
      await rejected()
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
      })
      expect(res.status).toBe(401)
      expect(await res.json()).toEqual({ jsonrpc: '2.0', error: { code: -32000, message: 'Unauthorized' }, id: null })
    })

    it('refuses a Keycloak token and an unknown runner token', async () => {
      const staff = await login(app, 'pm', { staff: true })
      await rejected(staff.token)
      await rejected(newRunnerToken().token)
    })

    it("refuses a revoked runner's token", async () => {
      const r = await addRunner('r1')
      const db = await testDb()
      await db.update(runners).set({ revokedAt: new Date() }).where(eq(runners.id, r.id))
      await rejected(r.token)
    })

    it('a runner token cannot reach staff routes', async () => {
      const r = await addRunner('r1')
      const res = await app.inject({ url: '/me', headers: { authorization: `Bearer ${r.token}` } })
      expect(res.statusCode).toBe(401)
    })
  })

  it('authenticates before reading the body: an anonymous 2 MB body is 401, not 413', async () => {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: { pad: 'x'.repeat(2 * 1024 * 1024) } }),
    })
    expect(res.status).toBe(401)
    expect(await res.json()).toMatchObject({ error: { code: -32000 } })
  })

  it('answers invalid JSON from a runner with a JSON-RPC parse error', async () => {
    const { token } = await addRunner('r1')
    const res = await fetch(url, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
      body: '{"jsonrpc": "2.0", ',
    })
    expect(res.status).toBe(400)
    expect(await res.json()).toEqual({ jsonrpc: '2.0', error: { code: -32700, message: 'Parse error' }, id: null })
  })

  it('GET and DELETE are 405 in stateless mode', async () => {
    for (const method of ['GET', 'DELETE']) {
      const res = await fetch(url, { method })
      expect(res.status).toBe(405)
      expect(res.headers.get('allow')).toBe('POST')
    }
  })
})

describe('unexpected errors', () => {
  it('become an internal tool error, logged without the request', async () => {
    const r = await addRunner('r1')
    const db = await testDb()
    const [row] = await db.select().from(runners).where(eq(runners.id, r.id))
    const owner = meFromPerson((await db.select().from(people).where(eq(people.id, ownerId)))[0]!)
    const logged: unknown[] = []
    const log = { error: (...a: unknown[]) => logged.push(a) } as unknown as FastifyBaseLogger
    const dbError = Object.assign(new Error('db down'), { query: 'select secret', params: ['param-value'] })
    const broken = { ...app.deps, db: { select: () => { throw dbError } } } as unknown as AppDeps
    const server = createMcpServer(broken, { runner: row!, owner }, log)
    const [clientSide, serverSide] = InMemoryTransport.createLinkedPair()
    await server.connect(serverSide)
    const client = new Client({ name: 'mcp-test', version: '0.0.0' })
    clients.push(client)
    await client.connect(clientSide)
    expect(await call(client, 'list_available_tasks', {})).toEqual({ isError: true, body: { code: 'internal' } })
    expect(logged).toHaveLength(1)
    expect(JSON.stringify(logged)).toContain('db down')
    expect(JSON.stringify(logged)).not.toMatch(/yoda_rt_|param-value|select secret/)
  })
})

describe('MCP_ENABLED=false', () => {
  it('does not register /mcp', async () => {
    const deps = await testDeps()
    const disabled = await buildApp({ ...deps, config: { ...deps.config, mcpEnabled: false } })
    // Unknown routes are behind the Keycloak hook: signed in, /mcp is simply not there.
    const staff = await login(disabled, 'pm', { staff: true })
    const res = await disabled.inject({ method: 'POST', url: '/mcp', headers: { authorization: `Bearer ${staff.token}` }, payload: {} })
    expect(res.statusCode).toBe(404)
    await disabled.close()
  })
})

describe('logger', () => {
  it('redacts authorization, GitLab token and cookie headers', async () => {
    const lines: string[] = []
    const stream = new Writable({
      write(chunk, _enc, cb) {
        lines.push(String(chunk))
        cb()
      },
    })
    const logged = Fastify({ logger: { ...LOGGER_OPTIONS, stream } })
    logged.log.info({ req: { headers: { authorization: 'Bearer yoda_rt_fake', 'x-gitlab-token': 'fake-secret', cookie: 'sid=fake' } } }, 'hi')
    await logged.close()
    const out = lines.join('')
    expect(out).toContain('hi')
    expect(out).not.toMatch(/yoda_rt_fake|fake-secret|sid=fake/)
  })
})
