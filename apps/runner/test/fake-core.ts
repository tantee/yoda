import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js'
import type { AvailableTask } from '@yoda/shared'
import { CoreClient, type RunCode } from '../src/core.js'

type Args = Record<string, unknown>
type Body = { error?: { code: string; reason?: string }; body?: unknown }
type Run = { runId: string; taskId: string; state: 'running' | 'parked' | 'succeeded' | 'failed' | 'released' }

export const REPO_ID = '00000000-0000-4000-8000-0000000000a1'
export const BRANCH = 'yoda/abcd1234-demo-change'

export const availableTask = (taskId: string, capability: AvailableTask['capability'] = 'code-change'): AvailableTask => ({
  taskId,
  title: { th: 'งานทดสอบ', en: 'Test task' },
  workItemId: '00000000-0000-4000-8000-0000000000b1',
  workItemTitle: 'Demo item',
  projectName: 'Demo',
  capability,
  stepKey: 'build',
  priority: 'normal',
  createdAt: '2026-11-25T00:00:00.000Z',
})

/**
 * An in-memory stand-in for core's 11 MCP tools (Task 6 shapes), over the SDK's linked in-memory transports.
 * Runs are tracked so heartbeat / submit on an ended or parked run get `run_not_active`, like core.
 */
export class FakeCore {
  calls: { name: string; args: Args }[] = []
  tasks: AvailableTask[] = []
  runs = new Map<string, Run>()
  /** Per-tool override: return an error or a body instead of the default behaviour. */
  override: Record<string, (args: Args) => Body | undefined> = {}
  code: RunCode = {
    repos: [
      {
        repoId: REPO_ID,
        path: 'group/demo',
        webUrl: 'https://gitlab.example.invalid/group/demo',
        defaultBranch: 'main',
        issueIid: 3,
        issueUrl: 'https://gitlab.example.invalid/group/demo/-/issues/3',
      },
    ],
    branch: BRANCH,
  }
  private seq = 0

  named = (name: string) => this.calls.filter((c) => c.name === name)

  /** What an agent's `ask_human` does: core parks the run. */
  park(runId: string): void {
    const run = this.runs.get(runId)
    if (run) run.state = 'parked'
  }

  private live(args: Args): Run | undefined {
    const run = this.runs.get(String(args.runId))
    return run?.state === 'running' ? run : undefined
  }

  private handle(name: string, args: Args): Body {
    const inactive = { error: { code: 'invalid_state', reason: 'run_not_active' } }
    switch (name) {
      case 'list_available_tasks':
        return { body: { tasks: this.tasks.filter((t) => ![...this.runs.values()].some((r) => r.taskId === t.taskId)) } }
      case 'claim_task': {
        const taskId = String(args.taskId)
        if ([...this.runs.values()].some((r) => r.taskId === taskId && r.state === 'running')) {
          return { error: { code: 'invalid_state', reason: 'already_claimed' } }
        }
        const runId = `00000000-0000-4000-8000-${String(++this.seq).padStart(12, '0')}`
        this.runs.set(runId, { runId, taskId, state: 'running' })
        return { body: { runId, leaseExpiresAt: '2026-11-25T00:10:00.000Z' } }
      }
      case 'heartbeat':
        return this.live(args) ? { body: { leaseExpiresAt: '2026-11-25T00:10:00.000Z' } } : inactive
      case 'get_context_pack': {
        const run = this.live(args)
        if (!run) return inactive
        // Core's branch is per work item; give later runs their own so parallel runs in one clone don't collide.
        const n = Number(run.runId.slice(-12))
        const code = { ...this.code, branch: n === 1 ? this.code.branch : `${this.code.branch}-${n}` }
        return { body: { text: '# Task\n\n**Test task**\n\n# Work item\n\n**Demo item** (priority: normal)', code } }
      }
      case 'search_knowledge':
        return { body: { hits: [] } }
      case 'write_knowledge':
      case 'post_progress':
        return this.live(args) ? { body: { entryId: '00000000-0000-4000-8000-0000000000e1' } } : inactive
      case 'open_merge_request':
        return this.live(args) ? { body: { mrIid: 7, url: 'https://gitlab.example.invalid/group/demo/-/merge_requests/7' } } : inactive
      case 'submit_result': {
        const run = this.live(args)
        if (!run) return inactive
        run.state = 'succeeded'
        return { body: { outcome: 'accepted' } }
      }
      case 'ask_human': {
        const run = this.live(args)
        if (!run) return inactive
        run.state = 'parked'
        return { body: { discussionId: '00000000-0000-4000-8000-0000000000d1' } }
      }
      case 'release_task': {
        const run = this.live(args)
        if (!run) return inactive
        run.state = args.failed ? 'failed' : 'released'
        return { body: { released: true } }
      }
      default:
        return { error: { code: 'unknown_tool' } }
    }
  }

  private server(): Server {
    const server = new Server({ name: 'fake-core', version: '0.0.0' }, { capabilities: { tools: {} } })
    server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: [] }))
    server.setRequestHandler(CallToolRequestSchema, async (req) => {
      const name = req.params.name
      const args = (req.params.arguments ?? {}) as Args
      this.calls.push({ name, args })
      const r = this.override[name]?.(args) ?? this.handle(name, args)
      const text = JSON.stringify(r.error ?? r.body)
      return { content: [{ type: 'text' as const, text }], ...(r.error ? { isError: true } : {}) }
    })
    return server
  }

  /** A CoreClient connected to this fake over in-memory transports. */
  async connect(): Promise<CoreClient> {
    const [clientSide, serverSide] = InMemoryTransport.createLinkedPair()
    await this.server().connect(serverSide)
    return CoreClient.over(clientSide)
  }
}
