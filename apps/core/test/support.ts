import type { FastifyInstance } from 'fastify'
import type { SeqEventEntry, WorkItemEventsPage } from '@yoda/shared'
import { buildApp, type AppDeps } from '../src/app.js'
import { signToken } from './jwt.js'
import { testDeps } from './helpers.js'

export async function makeApp(overrides: Partial<AppDeps> = {}): Promise<FastifyInstance> {
  const deps = await testDeps(overrides)
  return buildApp({ ...deps, config: { ...deps.config, bootstrapAdmins: ['boss'] } })
}

export type Who = { token: string; id: string }

/** Signs in (creating the person via /me). `staff` puts the user in the staff group. */
export async function login(
  app: FastifyInstance,
  username: string,
  opts: { staff?: boolean; name?: string } = {},
): Promise<Who> {
  const token = await signToken({
    sub: `sub-${username}`,
    preferred_username: username,
    name: opts.name ?? username,
    groups: opts.staff ? ['/it-dev'] : [],
  })
  const res = await app.inject({ url: '/me', headers: { authorization: `Bearer ${token}` } })
  return { token, id: res.json().id }
}

export const auth = (w: Who) => ({ authorization: `Bearer ${w.token}` })

/**
 * `propose` projects gate each step advance behind a PM-confirmed proposal. Accepts the work item's pending
 * `step_advance` proposal as `pm` (a PM or admin), if any; returns whether one was accepted.
 */
export async function acceptStepAdvance(app: FastifyInstance, pm: Who, workItemId: string): Promise<boolean> {
  const res = await app.inject({ url: '/proposals?state=pending', headers: auth(pm) })
  if (res.statusCode !== 200) throw new Error(`GET /proposals → ${res.statusCode}`)
  const p = (res.json() as { id: string; workItemId: string | null; kind: string }[]).find(
    (x) => x.workItemId === workItemId && x.kind === 'step_advance',
  )
  if (!p) return false
  const dec = await app.inject({
    method: 'POST',
    url: `/proposals/${p.id}/decide`,
    headers: auth(pm),
    payload: { decision: 'accept' },
  })
  if (dec.statusCode !== 200) throw new Error(`accept step_advance → ${dec.statusCode} ${dec.body}`)
  return true
}

/** A work item's whole timeline, oldest first, read page by page from `GET /work-items/:id/events`. */
export async function timelineOf(app: FastifyInstance, who: Who, workItemId: string, kind: 'all' | 'key' = 'all'): Promise<SeqEventEntry[]> {
  const all: SeqEventEntry[] = []
  let before: number | null | undefined
  do {
    const query = `?limit=100&kind=${kind}${before ? `&before=${before}` : ''}`
    const res = await app.inject({ method: 'GET', url: `/work-items/${workItemId}/events${query}`, headers: auth(who) })
    if (res.statusCode !== 200) throw new Error(`timeline ${res.statusCode}`)
    const page = res.json() as WorkItemEventsPage
    all.push(...page.events)
    before = page.nextBefore
  } while (before)
  return all.reverse()
}
