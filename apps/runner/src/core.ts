import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport, StreamableHTTPError } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js'
import {
  AvailableTask,
  KnowledgeSearchHit,
  RunnerCapability,
  type AskHumanInput,
  type ClaimInput,
  type ListTasksInput,
  type OpenMrInput,
  type ProgressInput,
  type ReleaseInput,
  type RunRef,
  type SearchInput,
  type SubmitInput,
  type WriteKnowledgeInput,
} from '@yoda/shared'
import { z } from 'zod'
import { mcpUrl, type RunnerConfig } from './config.js'

/** Repositories and the branch of a run, as `get_context_pack` returns them (core: knowledge/context-pack.ts). */
export const RunCode = z.object({
  repos: z.array(
    z.object({
      repoId: z.string(),
      path: z.string(),
      webUrl: z.string(),
      defaultBranch: z.string().nullable(),
      issueIid: z.number().int().nullable(),
      issueUrl: z.string().nullable(),
    }),
  ),
  branch: z.string(),
})
export type RunCode = z.infer<typeof RunCode>

const Lease = z.object({ leaseExpiresAt: z.string() })
const Entry = z.object({ entryId: z.string() })

/** Success bodies of core's MCP tools (Task 6 contract). */
const Outputs = {
  list_available_tasks: z.object({ tasks: z.array(AvailableTask) }),
  claim_task: Lease.extend({ runId: z.string() }),
  heartbeat: Lease,
  // `capability` is the template task's (null without one); optional for a core that does not send it yet.
  get_context_pack: z.object({
    text: z.string(),
    code: RunCode,
    capability: z.union([RunnerCapability, z.literal('draft-text')]).nullable().optional(),
  }),
  search_knowledge: z.object({ hits: z.array(KnowledgeSearchHit) }),
  write_knowledge: Entry,
  post_progress: Entry,
  open_merge_request: z.object({ mrIid: z.number().int(), url: z.string() }),
  submit_result: z.object({ outcome: z.enum(['accepted', 'already_done', 'task_unavailable']) }),
  ask_human: z.object({ discussionId: z.string() }),
  release_task: z.object({ released: z.literal(true) }),
}
type ToolName = keyof typeof Outputs
type Output<N extends ToolName> = z.infer<(typeof Outputs)[N]>

/**
 * A tool call core refused (`{ code, reason? }` with `isError`), or `unauthorized` when core rejects the token
 * (revoked runner, wrong token), or `bad_response` when the reply does not match the contract.
 */
export class McpToolError extends Error {
  override name = 'McpToolError'
  constructor(
    readonly code: string,
    readonly reason?: string,
  ) {
    super(reason ? `${code}: ${reason}` : code)
  }
}

const ErrorBody = z.object({ code: z.string(), reason: z.string().optional() })

function translate(err: unknown): unknown {
  if (err instanceof StreamableHTTPError && err.code === 401) return new McpToolError('unauthorized')
  return err
}

/** Core's runner protocol over MCP: one typed method per tool. */
export class CoreClient {
  constructor(private readonly client: Client) {}

  /** Connects over an existing transport (tests use the SDK's in-memory pair). */
  static async over(transport: Transport): Promise<CoreClient> {
    const client = new Client({ name: 'yoda-runner', version: '0.0.0' })
    try {
      await client.connect(transport)
    } catch (err) {
      throw translate(err)
    }
    return new CoreClient(client)
  }

  close(): Promise<void> {
    return this.client.close()
  }

  private async call<N extends ToolName>(name: N, args: object): Promise<Output<N>> {
    let result
    try {
      result = await this.client.callTool({ name, arguments: args as Record<string, unknown> })
    } catch (err) {
      throw translate(err)
    }
    const content = Array.isArray(result.content) ? result.content : []
    const first = content[0] as { type?: string; text?: string } | undefined
    let body: unknown
    try {
      body = first?.type === 'text' && typeof first.text === 'string' ? JSON.parse(first.text) : undefined
    } catch {
      body = undefined
    }
    if (result.isError) {
      const e = ErrorBody.safeParse(body)
      throw e.success ? new McpToolError(e.data.code, e.data.reason) : new McpToolError('bad_response', `${name} failed`)
    }
    const parsed = Outputs[name].safeParse(body)
    if (!parsed.success) throw new McpToolError('bad_response', `${name} returned an unexpected body`)
    return parsed.data as Output<N>
  }

  listAvailableTasks = (input: ListTasksInput = {}) => this.call('list_available_tasks', input)
  claimTask = (input: ClaimInput) => this.call('claim_task', input)
  heartbeat = (input: RunRef) => this.call('heartbeat', input)
  getContextPack = (input: RunRef) => this.call('get_context_pack', input)
  searchKnowledge = (input: SearchInput) => this.call('search_knowledge', input)
  writeKnowledge = (input: WriteKnowledgeInput) => this.call('write_knowledge', input)
  postProgress = (input: ProgressInput) => this.call('post_progress', input)
  openMergeRequest = (input: OpenMrInput) => this.call('open_merge_request', input)
  submitResult = (input: SubmitInput) => this.call('submit_result', input)
  askHuman = (input: AskHumanInput) => this.call('ask_human', input)
  releaseTask = (input: ReleaseInput) => this.call('release_task', input)
}

/** Connects to `<coreUrl>/mcp` with the runner token as a bearer header. */
export function connectCore(cfg: Pick<RunnerConfig, 'coreUrl' | 'token'>): Promise<CoreClient> {
  const transport = new StreamableHTTPClientTransport(new URL(mcpUrl(cfg)), {
    requestInit: { headers: { Authorization: `Bearer ${cfg.token}` } },
  })
  return CoreClient.over(transport)
}
