import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { toJsonSchemaCompat } from '@modelcontextprotocol/sdk/server/zod-json-schema-compat.js'
import { CallToolRequestSchema, ListToolsRequestSchema, type CallToolResult, type Tool } from '@modelcontextprotocol/sdk/types.js'
import {
  AskHumanInput,
  ClaimInput,
  ListTasksInput,
  OpenMrInput,
  ProgressInput,
  ReleaseInput,
  RunRef,
  SearchInput,
  SubmitInput,
  WriteKnowledgeInput,
} from '@yoda/shared'
import type { FastifyBaseLogger } from 'fastify'
import { z, ZodError } from 'zod'
import type { AppDeps } from '../app.js'
import { HttpError } from '../auth/plugin.js'
import { claimTask, heartbeat, listAvailableTasks, releaseRun, type RunnerCtx } from '../runners/claims.js'
import { openMergeRequest } from '../runners/merge-requests.js'
import { askHuman, getContextPack, postProgress, searchForRunner, submitResult, writeKnowledge } from '../runners/work.js'

type ToolDef<S extends z.AnyZodObject> = {
  description: string
  input: S
  run: (input: z.infer<S>) => Promise<unknown>
}

const tool = <S extends z.AnyZodObject>(t: ToolDef<S>) => t as unknown as ToolDef<z.AnyZodObject>

/**
 * The runner tools, bound to one authenticated runner. Every result is JSON (see the Task 6 report for the
 * shapes the runner relies on); names and shapes are a contract with `@yoda/runner`.
 */
function runnerTools(deps: AppDeps, rc: RunnerCtx): Record<string, ToolDef<z.AnyZodObject>> {
  return {
    list_available_tasks: tool({
      description:
        'List tasks you may claim now, most urgent first (at most 20). Optionally narrow by capability. Returns { tasks }.',
      input: ListTasksInput,
      run: async (i) => ({ tasks: await listAvailableTasks(deps, rc, i) }),
    }),
    claim_task: tool({
      description:
        'Claim a task to work on it. Returns { runId, leaseExpiresAt }. Keep the lease alive with heartbeat (every minute); every other run tool takes the runId.',
      input: ClaimInput,
      run: async (i) => {
        const { run } = await claimTask(deps, rc, i.taskId)
        return { runId: run.id, leaseExpiresAt: run.leaseExpiresAt }
      },
    }),
    heartbeat: tool({
      description: 'Extend the lease of your run. Call it about once a minute while you work. Returns { leaseExpiresAt }.',
      input: RunRef,
      run: (i) => heartbeat(deps, rc, i.runId),
    }),
    get_context_pack: tool({
      description:
        'Get everything known about the run\'s task: the task, the work item, knowledge and the code (repos, issues, the branch to push). Returns { text, code }. Read text first. When done, report with post_progress and finish with submit_result (or ask_human / release_task).',
      input: RunRef,
      run: async (i) => {
        const { text, code } = await getContextPack(deps, rc, i.runId)
        return { text, code }
      },
    }),
    search_knowledge: tool({
      description: 'Search the knowledge base (facts, documents, decisions) your owner can see. Returns { hits }.',
      input: SearchInput,
      run: async (i) => ({ hits: await searchForRunner(deps, rc, i) }),
    }),
    write_knowledge: tool({
      description:
        'Save a fact, memory, document or progress note on the run\'s work item, as a draft for people to confirm. Returns { entryId }.',
      input: WriteKnowledgeInput,
      run: async (i) => ({ entryId: await writeKnowledge(deps, rc, i) }),
    }),
    post_progress: tool({
      description: 'Post a short progress note on the run (also extends its lease). Returns { entryId }.',
      input: ProgressInput,
      run: async (i) => ({ entryId: await postProgress(deps, rc, i) }),
    }),
    open_merge_request: tool({
      description:
        'After pushing your branch (never the default branch), ask core to open the merge request into the repo\'s default branch. Returns { mrIid, url }.',
      input: OpenMrInput,
      run: (i) => openMergeRequest(deps, rc, i),
    }),
    submit_result: tool({
      description:
        'Finish the run with your result: what you did, and the merge request when there is one. Report model usage when known. Returns { outcome }.',
      input: SubmitInput,
      run: (i) => submitResult(deps, rc, i),
    }),
    ask_human: tool({
      description:
        'Stop and ask a person when you cannot go on without a decision. Give up to 5 options when you have them. Ends the run. Returns { discussionId }.',
      input: AskHumanInput,
      run: async (i) => ({ discussionId: await askHuman(deps, rc, i) }),
    }),
    release_task: tool({
      description:
        'Give the task back without a result. Set failed: true when you tried and could not do it. Ends the run. Returns { released: true }.',
      input: ReleaseInput,
      run: async (i) => {
        await releaseRun(deps, rc, i)
        return { released: true }
      },
    }),
  }
}

const text = (body: unknown, isError = false): CallToolResult => ({
  content: [{ type: 'text', text: JSON.stringify(body) }],
  ...(isError ? { isError: true } : {}),
})

function zodReason(err: ZodError): string {
  return err.issues
    .slice(0, 5)
    .map((i) => (i.path.length ? `${i.path.join('.')}: ${i.message}` : i.message))
    .join('; ')
}

/**
 * A stateless MCP server for one request of one authenticated runner. Tool inputs are validated here (not by
 * the SDK) so that every failure is a tool error `{ code, reason? }`: `validation` for bad input, the HttpError
 * code (with its reason) for refusals, and `internal` for anything else, logged without request details.
 */
export function createMcpServer(deps: AppDeps, rc: RunnerCtx, log: FastifyBaseLogger): Server {
  const tools = runnerTools(deps, rc)
  const server = new Server({ name: 'yoda-core', version: '1.0.0' }, { capabilities: { tools: {} } })
  const listed: Tool[] = Object.entries(tools).map(([name, t]) => ({
    name,
    description: t.description,
    inputSchema: toJsonSchemaCompat(t.input) as Tool['inputSchema'],
  }))
  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: listed }))
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params
    const t = Object.hasOwn(tools, name) ? tools[name] : undefined
    if (!t) return text({ code: 'unknown_tool' }, true)
    const parsed = t.input.safeParse(args ?? {})
    if (!parsed.success) return text({ code: 'validation', reason: zodReason(parsed.error) }, true)
    try {
      return text(await t.run(parsed.data))
    } catch (err) {
      if (err instanceof HttpError) {
        const { error, reason } = err.body
        return text(reason ? { code: error, reason } : { code: error }, true)
      }
      if (err instanceof ZodError) return text({ code: 'validation', reason: zodReason(err) }, true)
      // Name, message and stack only: a driver error's own fields (a query's params) may carry tool input.
      const e = err instanceof Error ? err : new Error(String(err))
      log.error({ err: { name: e.name, message: e.message, stack: e.stack }, tool: name, runnerId: rc.runner.id }, 'mcp tool failed')
      return text({ code: 'internal' }, true)
    }
  })
  return server
}
