import {
  Priority,
  Proposal,
  WorkItemCreate,
  type Me,
  type ProposalDecision,
  type ProposalKind,
  type ProposalState,
} from '@yoda/shared'
import { and, desc, eq, inArray, isNull, or, sql, type SQL } from 'drizzle-orm'
import { commentRequired, forbidden, HttpError, invalidState, notFound, projectRequired } from '../auth/plugin.js'
import type { Db, Tx } from '../db/client.js'
import { people, projectMembers, projects, proposals, workItems } from '../db/schema.js'
import { notifyProposalPending } from '../notifications/service.js'
import { lockProject } from '../projects/access.js'
import { recordEvent, type WorkCtx } from '../work/context.js'
import {
  applyStepAdvance,
  createWorkItem,
  isPmOrAdmin,
  lockItem,
  memberRoles,
  stepAdvanceReady,
  type WorkItemRow,
} from '../work/engine.js'

type Conn = Db | Tx
type ProposalRow = typeof proposals.$inferSelect

export type ProposalCreate = {
  projectId: string | null
  workItemId: string | null
  kind: ProposalKind
  summary: string
  reason: string
  payload: Record<string, unknown>
  onBehalfOf: string | null
}

/**
 * Records a pending decision for the project's PMs. `createdByKind` is the context's actor kind. A
 * `create_work_item` proposal takes its project from the payload when not given. Project-less proposals
 * (intake from chat before a project is chosen) record no event: events belong to a project.
 */
export async function createProposal(ctx: WorkCtx, input: ProposalCreate): Promise<string> {
  const payloadProject = typeof input.payload.projectId === 'string' ? input.payload.projectId : null
  const projectId = input.projectId ?? (input.kind === 'create_work_item' ? payloadProject : null)
  const [row] = await ctx.tx
    .insert(proposals)
    .values({
      projectId,
      workItemId: input.workItemId,
      kind: input.kind,
      summary: input.summary,
      reason: input.reason,
      payload: input.payload,
      createdByKind: ctx.actorKind,
      onBehalfOf: input.onBehalfOf,
    })
    .returning({ id: proposals.id })
  const id = row!.id
  // A guard rail's reason travels with the proposal: on its timeline event and in the PMs' notification.
  const guard = typeof input.payload.guard === 'string' ? input.payload.guard : null
  const guardDetail = typeof input.payload.guardDetail === 'string' ? input.payload.guardDetail : null
  if (projectId) {
    await recordEvent(ctx, {
      type: 'proposal.created',
      projectId,
      workItemId: input.workItemId,
      taskId: null,
      payload: {
        proposalId: id,
        kind: input.kind,
        ...(guard ? { guard } : {}),
        ...(guardDetail ? { guardDetail } : {}),
      },
    })
  }
  await notifyProposalPending(ctx, {
    id,
    projectId,
    workItemId: input.workItemId,
    kind: input.kind,
    summary: input.summary,
    reason: guard ? input.reason : '',
    onBehalfOf: input.onBehalfOf,
  })
  return id
}

/** Marks the work item's pending proposals (of `kind`, or all) superseded (caller holds the work item lock). */
export async function supersedePending(ctx: WorkCtx, workItemId: string, kind?: ProposalKind): Promise<void> {
  const rows = await ctx.tx
    .update(proposals)
    .set({ state: 'superseded', decidedAt: sql`now()` })
    .where(
      and(
        eq(proposals.workItemId, workItemId),
        eq(proposals.state, 'pending'),
        kind ? eq(proposals.kind, kind) : undefined,
      ),
    )
    .returning()
  rows.sort((a, b) => a.id.localeCompare(b.id))
  for (const p of rows) await recordDecision(ctx, p, 'proposal.superseded')
}

async function recordDecision(
  ctx: WorkCtx,
  p: Pick<ProposalRow, 'id' | 'projectId' | 'workItemId' | 'kind'>,
  type: 'proposal.accepted' | 'proposal.rejected' | 'proposal.superseded',
): Promise<void> {
  if (!p.projectId) return
  await recordEvent(ctx, {
    type,
    projectId: p.projectId,
    workItemId: p.workItemId,
    taskId: null,
    payload: { proposalId: p.id, kind: p.kind },
  })
}

async function isPmAnywhere(tx: Conn, personId: string): Promise<boolean> {
  const [row] = await tx
    .select({ id: projectMembers.projectId })
    .from(projectMembers)
    .where(and(eq(projectMembers.personId, personId), sql`'PM' = any(${projectMembers.roles})`))
    .limit(1)
  return !!row
}

/**
 * Deciders: admins; PMs of the proposal's project (for a project-less proposal, of the chosen `target`
 * project); and for `create_work_item`, the person it was made on behalf of. Others get 403 when they could
 * see the proposal (project members; for project-less ones, PMs of any project), 404 otherwise.
 */
async function requireCanDecide(tx: Tx, me: Me, p: ProposalRow, target: string | null): Promise<void> {
  if (me.isAdmin) return
  if (p.kind === 'create_work_item' && p.onBehalfOf === me.id) return
  if (target && (await isPmOrAdmin(tx, me, target))) return
  const sees = p.projectId ? (await memberRoles(tx, p.projectId, me.id)) !== null : await isPmAnywhere(tx, me.id)
  if (!sees) throw notFound()
  // A PM deciding a project-less proposal decides as PM of the project they choose.
  throw !p.projectId && !target ? projectRequired() : forbidden()
}

async function setState(
  ctx: WorkCtx,
  p: ProposalRow,
  state: ProposalState,
  me: Me | null,
  note: string | null,
  extra: { projectId?: string; workItemId?: string } = {},
): Promise<void> {
  await ctx.tx
    .update(proposals)
    .set({ state, decidedBy: me?.id ?? null, decisionNote: note, decidedAt: sql`now()`, ...extra })
    .where(eq(proposals.id, p.id))
  const type = state === 'accepted' ? 'proposal.accepted' : state === 'rejected' ? 'proposal.rejected' : 'proposal.superseded'
  await recordDecision(ctx, { ...p, ...extra }, type)
}

/** A person as `Me` (staff from the override or the last seen token), e.g. whom a proposal was made for. */
export async function personAsMe(tx: Conn, id: string): Promise<Me | null> {
  const [row] = await tx.select().from(people).where(eq(people.id, id))
  if (!row) return null
  return {
    id: row.id,
    username: row.username,
    displayName: row.displayName,
    email: row.email,
    isStaff: row.isAdmin || (row.staffOverride ?? row.lastSeenStaff),
    isAdmin: row.isAdmin,
  }
}

export type DecideResult = { superseded: boolean }

/**
 * Accepts or rejects a pending proposal. Locks (in order) the target project in share mode for
 * `create_work_item`, the work item when there is one, then the proposal row; a non-pending proposal → 409.
 * When an accepted proposal no longer applies (work item cancelled / done, step already advanced), it is
 * marked `superseded` and `{ superseded: true }` is returned: the caller commits, then answers 409.
 */
export async function decideProposal(ctx: WorkCtx, me: Me, id: string, decision: ProposalDecision): Promise<DecideResult> {
  const { tx } = ctx
  // project_id / work_item_id only change on accepting a create_work_item proposal, which the row lock
  // below serialises (a concurrent decider then finds it no longer pending).
  const [ref] = await tx.select().from(proposals).where(eq(proposals.id, id))
  if (!ref) throw notFound()
  const target = ref.kind === 'create_work_item' ? (ref.projectId ?? decision.projectId ?? null) : ref.projectId
  // Cheap check before taking any lock (re-checked under the locks below): non-deciders never wait on rows.
  await requireCanDecide(tx, me, ref, target)
  // A proposal's project is fixed; choosing another one is a client error, not silently ignored.
  if (ref.projectId && decision.projectId && decision.projectId !== ref.projectId) {
    throw new HttpError(422, { error: 'invalid_state' })
  }
  if (ref.kind === 'create_work_item' && target && decision.decision === 'accept') await lockProject(tx, target, 'share')
  const item: WorkItemRow | null = ref.workItemId ? await lockItem(tx, ref.workItemId) : null
  const [p] = await tx.select().from(proposals).where(eq(proposals.id, id)).for('update')
  if (!p) throw notFound()
  await requireCanDecide(tx, me, p, target)
  if (p.state !== 'pending') throw invalidState()
  const note = decision.note?.trim() ? decision.note.trim() : null

  if (decision.decision === 'reject') {
    // The item stays on its finished step; the PM says why, and may advance it later (advanceWorkItem).
    if (p.kind === 'step_advance' && !note) throw commentRequired()
    await setState(ctx, p, 'rejected', me, note)
    return { superseded: false }
  }

  const payload = (p.payload ?? {}) as Record<string, unknown>
  switch (p.kind) {
    case 'step_advance': {
      if (!item) throw invalidState()
      const status =
        typeof payload.toStep === 'string' ? await stepAdvanceReady(tx, item, payload.fromStep, payload.toStep) : null
      if (!status) {
        await setState(ctx, p, 'superseded', null, null)
        return { superseded: true }
      }
      // Accepted before advancing, so the following step's proposal can be created meanwhile.
      await setState(ctx, p, 'accepted', me, note)
      await applyStepAdvance(ctx, item, status)
      return { superseded: false }
    }
    case 'priority_change': {
      const to = Priority.safeParse(payload.priority)
      if (!item || !to.success) throw invalidState()
      if (item.state !== 'active') {
        await setState(ctx, p, 'superseded', null, null)
        return { superseded: true }
      }
      await tx.update(workItems).set({ priority: to.data, updatedAt: sql`now()` }).where(eq(workItems.id, item.id))
      await recordEvent(ctx, {
        type: 'work_item.priority_changed',
        projectId: item.projectId,
        workItemId: item.id,
        taskId: null,
        payload: { from: item.priority, to: to.data, proposalId: p.id },
      })
      await setState(ctx, p, 'accepted', me, note)
      return { superseded: false }
    }
    case 'create_work_item': {
      if (!target) throw projectRequired()
      const requested = typeof payload.requesterId === 'string' ? payload.requesterId : undefined
      // Created as the person it was proposed for when they may create work items there; otherwise (e.g. a
      // requester's intake) by the deciding PM, with that person as the requester.
      const behalf = p.onBehalfOf ? await personAsMe(tx, p.onBehalfOf) : null
      const behalfCanCreate = !!behalf && (behalf.isAdmin || (await memberRoles(tx, target, behalf.id)) !== null)
      const creator = behalfCanCreate ? behalf! : me
      const input = WorkItemCreate.parse({
        title: payload.title,
        description: payload.description ?? '',
        templateKey: payload.templateKey,
        priority: payload.priority ?? 'normal',
        requesterId: requested ?? (behalf && !behalfCanCreate ? behalf.id : undefined),
      })
      const workItemId = await createWorkItem(ctx, creator, target, input)
      await setState(ctx, p, 'accepted', me, note, { projectId: target, workItemId })
      return { superseded: false }
    }
  }
  throw invalidState()
}

function toProposal(row: ProposalRow, decidedByName: string | null): Proposal {
  return Proposal.parse({
    id: row.id,
    projectId: row.projectId,
    workItemId: row.workItemId,
    kind: row.kind,
    summary: row.summary,
    reason: row.reason,
    payload: row.payload ?? {},
    state: row.state,
    createdByKind: row.createdByKind,
    onBehalfOfId: row.onBehalfOf,
    decidedById: row.decidedBy,
    decidedByName,
    createdAt: row.createdAt.toISOString(),
    decidedAt: row.decidedAt?.toISOString() ?? null,
  })
}

async function select(db: Conn, where: SQL | undefined): Promise<Proposal[]> {
  const rows = await db
    .select({ p: proposals, name: people.displayName })
    .from(proposals)
    .leftJoin(people, eq(people.id, proposals.decidedBy))
    .where(where)
    .orderBy(desc(proposals.createdAt), desc(proposals.id))
  return rows.map((r) => toProposal(r.p, r.name ?? null))
}

export async function getProposal(db: Conn, id: string): Promise<Proposal> {
  const [p] = await select(db, eq(proposals.id, id))
  if (!p) throw notFound()
  return p
}

const memberProjects = (me: Me) =>
  sql`select ${projectMembers.projectId} from ${projectMembers} where ${projectMembers.personId} = ${me.id}`

/**
 * Staff: proposals of a project they can see (member or admin; 404 otherwise), or without `projectId`, of
 * all their projects plus project-less ones they may decide (admins, PMs) or that were made on their behalf.
 */
export async function listProposals(
  db: Conn,
  me: Me,
  filter: { projectId?: string; state?: ProposalState },
): Promise<Proposal[]> {
  if (!me.isStaff) throw forbidden()
  const state = filter.state ? eq(proposals.state, filter.state) : undefined
  if (filter.projectId) {
    const [project] = await db.select({ id: projects.id }).from(projects).where(eq(projects.id, filter.projectId))
    if (!project) throw notFound()
    if (!me.isAdmin && (await memberRoles(db, filter.projectId, me.id)) === null) throw notFound()
    return select(db, and(eq(proposals.projectId, filter.projectId), state))
  }
  const scope = me.isAdmin
    ? undefined
    : or(
        sql`${proposals.projectId} in (${memberProjects(me)})`,
        (await isPmAnywhere(db, me.id))
          ? isNull(proposals.projectId)
          : and(isNull(proposals.projectId), eq(proposals.onBehalfOf, me.id)),
      )
  return select(db, and(scope, state))
}

/**
 * Pending proposals `me` can decide, for /me/todo. Project proposals follow the confirmations scope (the
 * projects where `me` is PM; admins also PM-less projects); plus `create_work_item` ones made on their
 * behalf, and project-less ones for admins and PMs. Proposals of work items no longer active are left out.
 */
export async function pendingForDecider(db: Conn, me: Me): Promise<Proposal[]> {
  const pmProjects = sql`select pm.project_id from ${projectMembers} pm where pm.person_id = ${me.id} and 'PM' = any(pm.roles)`
  const pmless = sql`select p.id from ${projects} p where not exists (select 1 from ${projectMembers} pm where pm.project_id = p.id and 'PM' = any(pm.roles))`
  const projectScope = me.isAdmin
    ? sql`(${proposals.projectId} in (${pmProjects}) or ${proposals.projectId} in (${pmless}))`
    : sql`${proposals.projectId} in (${pmProjects})`
  const decideProjectless = me.isAdmin || (await isPmAnywhere(db, me.id))
  const rows = await select(
    db,
    and(
      eq(proposals.state, 'pending'),
      or(
        projectScope,
        and(eq(proposals.kind, 'create_work_item'), eq(proposals.onBehalfOf, me.id)),
        decideProjectless ? isNull(proposals.projectId) : undefined,
      ),
      or(
        isNull(proposals.workItemId),
        inArray(
          proposals.workItemId,
          db.select({ id: workItems.id }).from(workItems).where(eq(workItems.state, 'active')),
        ),
      ),
    ),
  )
  return rows.reverse()
}
