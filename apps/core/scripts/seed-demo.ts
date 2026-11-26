// DEV ONLY: fills a *demo* database with realistic Thai hospital IT data for screenshots and design work.
// Never run it against a real database: it refuses unless the database name ends with `_demo`, and with
// --reset it TRUNCATES every data table of that database first. All names, URLs and tokens are fake
// (example.org / example.test placeholders); nothing here is a real person or credential.
//
//   docker exec amberjack-postgres-1 psql -U yoda -d yoda -c 'create database yoda_demo'   # once
//   cd apps/core
//   DATABASE_URL=postgres://yoda:yoda@localhost:5432/yoda_demo ./node_modules/.bin/tsx src/db/migrate.ts
//   DATABASE_URL=postgres://yoda:yoda@localhost:5432/yoda_demo ./node_modules/.bin/tsx \
//     --env-file-if-exists=../../.env scripts/seed-demo.ts --reset
//
// People are matched to Keycloak by `sub`: the subs of the dev realm users `somchai`, `nurse1` and (optional)
// `dev1` are read from the local dev Keycloak's admin API (DEV ONLY admin/admin, KEYCLOAK_ADMIN_URL, default
// http://localhost:18080). Without Keycloak they get placeholder subs and a first login would create new rows.
// Work items are driven through the real work engine (runWork, createWorkItem, submitTask, proposals,
// runners, discussions, knowledge) so the data is consistent; jobs are dropped (no AI calls are made), and
// timestamps are back-dated afterwards so timelines look lived-in.
import { randomUUID } from 'node:crypto'
import type { Me, TaskResult } from '@yoda/shared'
import { and, asc, eq, inArray, isNull, sql } from 'drizzle-orm'
import { loadConfig } from '../src/config.js'
import { createDb, type Db } from '../src/db/client.js'
import {
  agentRuns,
  aiCalls,
  channelLinks,
  conversationReads,
  conversations,
  departmentSettings,
  discussionResponses,
  discussions,
  events,
  knowledgeEntries,
  mergeRequests,
  messages,
  notificationChannelSettings,
  notificationPrefs,
  notifications,
  people,
  projectMembers,
  projectRepos,
  projects,
  proposals,
  runners,
  runnerSettings,
  tasks,
  workItemRepos,
  workItems,
} from '../src/db/schema.js'
import { LiveBus } from '../src/live/bus.js'
import { runWork, type WorkDeps, type WorkCtx } from '../src/work/context.js'
import {
  assignTask,
  cancelWorkItem,
  confirmTask,
  createWorkItem,
  failAiTask,
  patchWorkItem,
  startTask,
  submitAiResult,
  submitRunnerResult,
  submitTask,
} from '../src/work/engine.js'
import { decideProposal, createProposal } from '../src/proposals/service.js'
import { createDiscussion, decideDiscussion, respond } from '../src/discussions/service.js'
import { createAgenda, putAgendaItems } from '../src/discussions/agendas.js'
import { createEntry, confirmEntry } from '../src/knowledge/service.js'
import { claimTask } from '../src/runners/claims.js'
import { endRun, meFromPerson } from '../src/runners/records.js'
import { newRunnerToken } from '../src/runners/tokens.js'
import { branchFor } from '../src/runners/work.js'
import { seedTemplates } from '../src/workflow/seed.js'
import { isoWeek } from '../src/status/weekly.js'

// ---------------------------------------------------------------- safety

const DATABASE_URL = process.env.DATABASE_URL ?? ''
const dbName = new URL(DATABASE_URL.replace(/^postgres(ql)?:/, 'http:')).pathname.replace(/^\//, '')
if (!dbName.endsWith('_demo')) {
  console.error(`seed-demo: refusing to run: database "${dbName}" does not end with _demo (DEV ONLY demo seed)`)
  process.exit(1)
}
const RESET = process.argv.includes('--reset')

const config = loadConfig({
  ...process.env,
  DATABASE_URL,
  OIDC_ISSUER: process.env.OIDC_ISSUER || 'http://localhost:18080/realms/yoda',
  OIDC_CLIENT_ID: process.env.OIDC_CLIENT_ID || 'yoda-portal',
  S3_ACCESS_KEY: process.env.S3_ACCESS_KEY || 'unused',
  S3_SECRET_KEY: process.env.S3_SECRET_KEY || 'unused',
  // No outside channels while seeding: notifications stay in the portal.
  SMTP_HOST: '',
  LINE_CHANNEL_ACCESS_TOKEN: '',
  TELEGRAM_BOT_TOKEN: '',
  DAILY_TASK_CAP: '1000',
})
const db: Db = createDb(DATABASE_URL)
const noJobs = { send: async () => {} }
const deps: WorkDeps = { db, bus: new LiveBus(), jobs: noJobs as unknown as WorkDeps['jobs'], config }
const runnerDeps = { ...deps, config: { ...config, runnerLeaseSeconds: 86400 } }

const DAY = 86_400_000
const now = Date.now()
const daysAgo = (d: number) => new Date(now - d * DAY)
/** A Bangkok calendar date `d` days from today (negative = past). */
const bkkDate = (d: number) => new Date(now + d * DAY).toLocaleDateString('en-CA', { timeZone: 'Asia/Bangkok' })
const MODEL = 'anthropic:claude-opus-5-5'
const FAST = 'anthropic:claude-haiku-5-5'

// ---------------------------------------------------------------- people

type Seat = { username: string; name: string; email: string; staff: boolean; admin?: boolean; skills?: string[]; realm?: boolean }
const PEOPLE: Seat[] = [
  { username: 'somchai', name: 'สมชาย ใจดี', email: 'somchai@example.test', staff: true, admin: true, realm: true, skills: ['บริหารโครงการ', 'HIS'] },
  { username: 'dev1', name: 'วิชัย ศรีสุข', email: 'dev1@example.test', staff: true, realm: true, skills: ['Vue', 'Node.js', 'PostgreSQL'] },
  { username: 'pranee', name: 'ปราณี วงศ์สวัสดิ์', email: 'pranee@example.test', staff: true, skills: ['บริหารโครงการ', 'งานบริการผู้ป่วยนอก'] },
  { username: 'anucha', name: 'อนุชา แก้วมณี', email: 'anucha@example.test', staff: true, skills: ['วิเคราะห์ระบบ', 'HL7'] },
  { username: 'kanokwan', name: 'กนกวรรณ ทองดี', email: 'kanokwan@example.test', staff: true, skills: ['วิเคราะห์ความต้องการ', 'งานพยาบาล'] },
  { username: 'thanakorn', name: 'ธนกร พึ่งบุญ', email: 'thanakorn@example.test', staff: true, skills: ['สถาปัตยกรรมระบบ', 'Kubernetes'] },
  { username: 'siriporn', name: 'ศิริพร มีสุข', email: 'siriporn@example.test', staff: true, skills: ['ออกแบบฐานข้อมูล', 'ETL'] },
  { username: 'natthapong', name: 'ณัฐพงษ์ รุ่งเรือง', email: 'natthapong@example.test', staff: true, skills: ['Java', 'HL7 FHIR'] },
  { username: 'pimchanok', name: 'พิมพ์ชนก สายทอง', email: 'pimchanok@example.test', staff: true, skills: ['Vue', 'UX'] },
  { username: 'kittipat', name: 'กิตติภัทร บุญมา', email: 'kittipat@example.test', staff: true, skills: ['Python', 'dbt'] },
  { username: 'waraporn', name: 'วราภรณ์ ชัยมงคล', email: 'waraporn@example.test', staff: true, skills: ['ทดสอบระบบ', 'Playwright'] },
  { username: 'jirayu', name: 'จิรายุ ศักดิ์ดี', email: 'jirayu@example.test', staff: true, skills: ['ทดสอบระบบ'] },
  { username: 'rattana', name: 'รัตนา พรหมมา', email: 'rattana@example.test', staff: true, skills: ['วิเคราะห์ระบบ', 'ทดสอบระบบ'] },
  // Requesters (not in the staff group).
  { username: 'nurse1', name: 'nurse1', email: '', staff: false, realm: true },
  { username: 'malee', name: 'มาลี ศรีวงศ์', email: 'malee@example.test', staff: false },
  { username: 'prasert', name: 'ประเสริฐ อินทรวงศ์', email: 'prasert@example.test', staff: false },
]

async function keycloakSubs(): Promise<Map<string, string>> {
  const base = process.env.KEYCLOAK_ADMIN_URL ?? 'http://localhost:18080'
  const subs = new Map<string, string>()
  try {
    // DEV ONLY: the throwaway dev Keycloak's admin account.
    const tokenRes = await fetch(`${base}/realms/master/protocol/openid-connect/token`, {
      method: 'POST',
      body: new URLSearchParams({ client_id: 'admin-cli', username: 'admin', password: 'admin', grant_type: 'password' }),
    })
    const { access_token } = (await tokenRes.json()) as { access_token: string }
    for (const seat of PEOPLE.filter((p) => p.realm)) {
      const res = await fetch(`${base}/admin/realms/yoda/users?exact=true&username=${seat.username}`, {
        headers: { authorization: `Bearer ${access_token}` },
      })
      const [user] = (await res.json()) as { id: string }[]
      if (user) subs.set(seat.username, user.id)
    }
  } catch (err) {
    console.warn(`seed-demo: Keycloak not reachable (${String(err)}); using placeholder subs`)
  }
  return subs
}

// ---------------------------------------------------------------- helpers

const P: Record<string, typeof people.$inferSelect> = {}
const me = (username: string): Me => meFromPerson(P[username]!)
const work = <T>(username: string | null, fn: (ctx: WorkCtx) => Promise<T>, kind: 'person' | 'system' | 'ai' = 'person') =>
  runWork(deps, { id: username ? P[username]!.id : null, kind: username ? kind : kind === 'person' ? 'system' : kind }, fn)

const PROJECT_PM: Record<string, string> = {}

async function reload(taskId: string) {
  const [t] = await db.select().from(tasks).where(eq(tasks.id, taskId))
  return t!
}

async function activeTasks(workItemId: string) {
  return db
    .select()
    .from(tasks)
    .where(and(eq(tasks.workItemId, workItemId), inArray(tasks.state, ['proposed', 'open', 'in_progress', 'submitted']), isNull(tasks.supersededAt)))
    .orderBy(asc(tasks.createdAt))
}

const usernameOf = (personId: string) => Object.values(P).find((p) => p.id === personId)!.username

// ---------------------------------------------------------------- content

function aiDraft(key: string, title: string): string {
  switch (key) {
    case 'draft-requirements':
      return [
        `## ข้อกำหนดเบื้องต้น: ${title}`,
        '',
        '### วัตถุประสงค์',
        `- ลดขั้นตอนที่ต้องทำด้วยมือในงาน "${title}"`,
        '- ให้ข้อมูลถูกบันทึกครั้งเดียวและส่งต่อไปยัง HIS โดยอัตโนมัติ',
        '',
        '### ผู้ใช้งานหลัก',
        '- พยาบาลประจำหน่วย, เจ้าหน้าที่เวชระเบียน, หัวหน้าหอผู้ป่วย',
        '',
        '### ความต้องการเชิงหน้าที่',
        '1. ค้นหาผู้ป่วยด้วย HN หรือเลขบัตรประชาชน',
        '2. แสดงรายการล่าสุด 30 วันพร้อมสถานะ',
        '3. ส่งออกรายงานเป็น Excel ตามช่วงวันที่',
        '',
        '### คำถามที่ยังเปิดอยู่',
        '- ต้องรองรับผู้ใช้พร้อมกันสูงสุดกี่คน?',
        '- ต้องเก็บประวัติการแก้ไขย้อนหลังกี่ปี?',
      ].join('\n')
    case 'draft-design':
      return [
        `## แบบระบบ: ${title}`,
        '',
        '- Frontend: Nuxt + Vuetify, เข้าผ่าน Portal เดิม',
        '- Backend: บริการ REST แยก, เชื่อม HIS ผ่าน HL7 v2 (ADT, ORM/ORU)',
        '- ฐานข้อมูล: PostgreSQL 17, แยก schema ต่อโมดูล',
        '- การยืนยันตัวตน: Keycloak ของโรงพยาบาล (กลุ่ม it-dev สำหรับผู้ดูแล)',
        '',
        '```mermaid-like',
        'Portal -> API -> PostgreSQL',
        'API -> HIS (HL7 MLLP)',
        '```',
        '',
        '**ความเสี่ยง:** ช่วงเวลา 07:00–09:00 มีโหลดสูงจากการลงทะเบียน OPD',
      ].join('\n')
    case 'draft-tests':
      return [
        `## กรณีทดสอบ: ${title}`,
        '',
        '| # | กรณี | ผลที่คาดหวัง |',
        '|---|------|-------------|',
        '| 1 | ค้นหาด้วย HN ที่มีอยู่ | แสดงข้อมูลผู้ป่วยถูกต้อง |',
        '| 2 | ค้นหาด้วย HN ที่ไม่มี | แสดงข้อความ "ไม่พบผู้ป่วย" |',
        '| 3 | บันทึกซ้ำภายใน 5 วินาที | ระบบไม่สร้างรายการซ้ำ |',
        '| 4 | HIS ไม่ตอบสนอง | เข้าคิวส่งซ้ำ และแจ้งผู้ดูแล |',
      ].join('\n')
    case 'implement':
      return `แก้ไขโค้ดแล้วใน branch ของงาน "${title}"\n\n- เพิ่ม endpoint และหน้าจอใหม่\n- เพิ่ม unit test 14 รายการ (ผ่านทั้งหมด)\n- อัปเดต migration 2 ไฟล์`
    default:
      return `ร่างโดย AI สำหรับ "${title}"`
  }
}

function humanResult(key: string, title: string): string {
  const texts: Record<string, string> = {
    'accept-intake': 'รับเรื่องแล้ว มอบหมายทีมตามบทบาท',
    'accept-bug': 'รับเรื่องแล้ว ยืนยันว่าเป็นข้อผิดพลาดจริง พบได้ทุกเครื่อง',
    'answer-questions': 'ผู้ใช้งานพร้อมกันประมาณ 40 คนในช่วงเช้า เก็บประวัติย้อนหลัง 5 ปีตามนโยบายเวชระเบียนค่ะ',
    'clarify-requirements': 'ปรับข้อกำหนดตามคำตอบของผู้ขอแล้ว เพิ่มเงื่อนไขเรื่องสิทธิ์การเข้าถึงข้อมูลผู้ป่วย',
    'approve-requirements': 'อนุมัติข้อกำหนด',
    'approve-design': 'อนุมัติแบบระบบ',
    'review-code': 'ตรวจโค้ดแล้ว โครงสร้างดี มี test ครบ',
    verify: `ทดสอบ "${title}" บนเครื่อง UAT ครบ 4 กรณี ผ่านทั้งหมด`,
    'approve-release': 'อนุมัติให้ขึ้นระบบจริงคืนวันศุกร์',
    'accept-delivery': 'ตรวจรับงานแล้ว ใช้งานได้ตามที่ขอ ขอบคุณค่ะ',
    close: 'ปิดงาน',
    'close-bug': 'ปิดงาน',
  }
  return texts[key] ?? 'ดำเนินการแล้ว'
}

// ---------------------------------------------------------------- engine driving

/** Completes one active task the way its people (or the AI / a runner) would. */
async function completeTask(taskId: string, title: string, opts: { lowConfidence?: boolean } = {}): Promise<void> {
  let t = await reload(taskId)
  const pm = PROJECT_PM[t.projectId]!
  if (t.state === 'proposed') {
    await work(pm, (ctx) => confirmTask(ctx, me(pm), t.id))
    t = await reload(taskId)
  }
  if (t.executor === 'ai' && !t.assigneeId) {
    if (t.templateTaskKey === 'implement') {
      await runnerSucceeds(t.id, title)
      return
    }
    await work(null, (ctx) =>
      submitAiResult(ctx, t.id, aiDraft(t.templateTaskKey, title), {
        model: MODEL,
        confidence: opts.lowConfidence ? 'low' : 'high',
        missing: opts.lowConfidence ? ['จำนวนผู้ใช้พร้อมกันสูงสุด', 'ระยะเวลาเก็บประวัติการแก้ไข'] : [],
      }),
    'ai')
    return
  }
  if (!t.assigneeId) {
    // No candidate was found: the PM hands it to a member with the role.
    const [m] = await db
      .select({ personId: projectMembers.personId })
      .from(projectMembers)
      .where(and(eq(projectMembers.projectId, t.projectId), sql`${t.role} = any(${projectMembers.roles})`))
    await work(pm, (ctx) => assignTask(ctx, me(pm), t.id, m!.personId))
    t = await reload(taskId)
  }
  const who = usernameOf(t.assigneeId!)
  if (t.state === 'open') await work(who, (ctx) => startTask(ctx, me(who), t.id))
  const decides = t.type === 'review' || t.type === 'approval'
  const result: TaskResult = { text: humanResult(t.templateTaskKey, title), attachmentIds: [], ...(decides ? { decision: 'approve' as const } : {}) }
  await work(who, (ctx) => submitTask(ctx, me(who), t.id, result))
}

async function pendingAdvance(workItemId: string) {
  const [p] = await db
    .select()
    .from(proposals)
    .where(and(eq(proposals.workItemId, workItemId), eq(proposals.kind, 'step_advance'), eq(proposals.state, 'pending')))
  return p
}

/** Drives the item until its current step is `toStep` (its tasks just created) or it is done. */
async function drive(workItemId: string, toStep: string | 'done', opts: { lowConfidence?: boolean } = {}): Promise<void> {
  for (let i = 0; i < 80; i++) {
    const [item] = await db.select().from(workItems).where(eq(workItems.id, workItemId))
    if (!item || item.state !== 'active') return
    if (item.currentStepKey === toStep) return
    const p = await pendingAdvance(workItemId)
    const pm = PROJECT_PM[item.projectId]!
    if (p) {
      await work(pm, (ctx) => decideProposal(ctx, me(pm), p.id, { decision: 'accept' }))
      continue
    }
    const active = await activeTasks(workItemId)
    if (!active.length) throw new Error(`seed-demo: "${item.title}" is stuck on ${item.currentStepKey}`)
    for (const t of active) await completeTask(t.id, item.title, opts)
  }
  throw new Error(`seed-demo: could not drive ${workItemId} to ${toStep}`)
}

async function taskOf(workItemId: string, key: string) {
  const [t] = await db
    .select()
    .from(tasks)
    .where(and(eq(tasks.workItemId, workItemId), eq(tasks.templateTaskKey, key), isNull(tasks.supersededAt)))
    .orderBy(sql`${tasks.attempt} desc`)
    .limit(1)
  return t
}

// ---------------------------------------------------------------- runners

const R: Record<string, typeof runners.$inferSelect> = {}

async function makeRunner(input: {
  key: string
  name: string
  kind: 'server' | 'dev-machine'
  owner: string
  accountType: 'api-key' | 'org-plan' | 'personal-subscription'
  capabilities: ('analyze-repo' | 'code-change' | 'run-tests')[]
  mode: 'on-demand' | 'unattended'
  maxConcurrent?: number
  workingHours?: { days: number[]; start: string; end: string } | null
  paused?: boolean
  revokedDaysAgo?: number
  lastSeenMinutes?: number | null
}) {
  const tok = newRunnerToken()
  const [row] = await db
    .insert(runners)
    .values({
      name: input.name,
      kind: input.kind,
      ownerId: P[input.owner]!.id,
      accountType: input.accountType,
      capabilities: input.capabilities,
      mode: input.mode,
      maxConcurrent: input.maxConcurrent ?? 1,
      workingHours: input.workingHours ?? null,
      paused: input.paused ?? false,
      tokenHash: tok.hash,
      tokenPrefix: tok.prefix,
      revokedAt: input.revokedDaysAgo !== undefined ? daysAgo(input.revokedDaysAgo) : null,
      lastSeenAt: input.lastSeenMinutes == null ? null : new Date(now - input.lastSeenMinutes * 60_000),
      createdBy: P.somchai!.id,
      createdAt: daysAgo(40),
    })
    .returning()
  R[input.key] = row!
}

const rcOf = (key: string) => ({ runner: R[key]!, owner: me(usernameOf(R[key]!.ownerId)) })

/** A runner claims the code-change task and submits a result (succeeded run with usage, branch set). */
async function runnerSucceeds(taskId: string, title: string, runnerKey = 'server'): Promise<void> {
  const rc = rcOf(runnerKey)
  const { run } = await claimTask(runnerDeps, rc, taskId)
  const [t] = await db.select().from(tasks).where(eq(tasks.id, taskId))
  await db.update(agentRuns).set({ branch: branchFor(t!.workItemId, title) }).where(eq(agentRuns.id, run.id))
  await runWork(deps, { id: rc.owner.id, kind: 'ai' }, async (ctx) => {
    await endRun(ctx, run.id, {
      state: 'succeeded',
      event: 'run.succeeded',
      reason: null,
      reopen: false,
      set: { usage: { model: 'anthropic:claude-opus-5-5', inputTokens: 182_000, outputTokens: 21_400, costUsd: 4.37 } },
    })
    await submitRunnerResult(ctx, taskId, aiDraft('implement', title), { model: MODEL, runId: run.id })
  })
}

async function runnerFails(taskId: string, runnerKey: string, state: 'failed' | 'expired', error: string): Promise<void> {
  const rc = rcOf(runnerKey)
  const { run } = await claimTask(runnerDeps, rc, taskId)
  await runWork(deps, { id: rc.owner.id, kind: 'ai' }, (ctx) =>
    endRun(ctx, run.id, { state, event: state === 'failed' ? 'run.failed' : 'run.expired', reason: error, error }),
  )
}

async function runnerRunning(taskId: string, title: string, runnerKey: string): Promise<void> {
  const rc = rcOf(runnerKey)
  const { run } = await claimTask(runnerDeps, rc, taskId)
  const [t] = await db.select().from(tasks).where(eq(tasks.id, taskId))
  await db
    .update(agentRuns)
    .set({
      branch: branchFor(t!.workItemId, title),
      startedAt: new Date(now - 27 * 60_000),
      heartbeatAt: new Date(now - 40_000),
      leaseExpiresAt: new Date(now + 7 * DAY),
    })
    .where(eq(agentRuns.id, run.id))
}

// ---------------------------------------------------------------- reset

async function reset(): Promise<void> {
  const [{ n }] = (await db.execute(sql`select count(*)::int as n from projects`)) as unknown as [{ n: number }]
  if (n > 0 && !RESET) {
    console.error('seed-demo: the demo database already has data; re-run with --reset to wipe and re-seed it')
    process.exit(1)
  }
  if (!RESET) return
  await db.execute(sql`truncate table
    people, projects, agendas, runners, conversations, proposals, notifications, knowledge_entries, attachments,
    ai_calls, discussions, channel_link_codes, channel_link_attempts, gitlab_deliveries, notification_prefs,
    channel_links, events
    restart identity cascade`)
  // Single-row settings tables are emptied by the cascade (their updated_by references people).
  await db.insert(departmentSettings).values({ id: 1 }).onConflictDoNothing()
  await db.insert(runnerSettings).values({ id: 1 }).onConflictDoNothing()
  await db.insert(notificationChannelSettings).values({ id: 1 }).onConflictDoNothing()
  await db.execute(sql`insert into gitlab_settings (id) values (1) on conflict do nothing`)
}

// ---------------------------------------------------------------- the seed

type ItemSpec = {
  key: string
  project: string
  title: string
  description: string
  template: 'software-change' | 'bug-fix'
  priority: 'low' | 'normal' | 'high' | 'urgent'
  requester?: string
  owner?: string
  target?: number | null
  /** Days ago it was created / last touched (timestamps are spread between them). */
  age: [number, number]
  scenario: (id: string, spec: ItemSpec) => Promise<void>
}

const ITEMS = new Map<string, string>()
const SPEC_BY_ID = new Map<string, ItemSpec>()

async function main(): Promise<void> {
  await reset()
  await seedTemplates(db)
  const subs = await keycloakSubs()

  // People ------------------------------------------------------------
  for (const seat of PEOPLE) {
    const sub = subs.get(seat.username) ?? `demo-${seat.username}`
    const [row] = await db
      .insert(people)
      .values({
        keycloakSub: sub,
        username: seat.username,
        displayName: seat.name,
        email: seat.email || null,
        isAdmin: seat.admin ?? false,
        lastSeenStaff: seat.staff,
        skills: seat.skills ?? [],
        createdAt: daysAgo(90),
        lastSeenAt: daysAgo(seat.realm ? 0 : Math.floor(Math.random() * 6)),
      })
      .onConflictDoUpdate({ target: people.keycloakSub, set: { displayName: seat.name, isAdmin: seat.admin ?? false } })
      .returning()
    P[seat.username] = row!
  }

  // Projects ------------------------------------------------------------
  const PROJECTS: {
    key: string
    name: string
    description: string
    autonomy: 'propose' | 'auto-assign'
    budget: string | null
    pm: string
    members: [string, string[]][]
    status?: 'active' | 'archived'
    noAi?: boolean
  }[] = [
    {
      key: 'opd',
      name: 'ระบบนัดหมายผู้ป่วยนอก',
      description: 'ระบบนัดหมายและเลื่อนนัดผู้ป่วยนอก เชื่อมกับ HIS และส่ง SMS/LINE แจ้งเตือนผู้ป่วยล่วงหน้า',
      autonomy: 'propose',
      budget: '50.00',
      pm: 'pranee',
      members: [
        ['somchai', ['PM']],
        ['pranee', ['PM']],
        ['kanokwan', ['BA']],
        ['thanakorn', ['SA']],
        ['dev1', ['DEV']],
        ['pimchanok', ['DEV']],
        ['waraporn', ['QC']],
      ],
    },
    {
      key: 'lab',
      name: 'HIS Lab Interface',
      description: 'เชื่อมต่อผลแล็บจากเครื่องวิเคราะห์ (LIS) เข้าสู่ HIS ผ่าน HL7 v2 ORU^R01 พร้อมแจ้งค่าวิกฤต',
      autonomy: 'auto-assign',
      budget: '30.00',
      pm: 'somchai',
      members: [
        ['somchai', ['PM']],
        ['anucha', ['BA']],
        ['thanakorn', ['SA']],
        ['natthapong', ['DEV']],
        ['dev1', ['DEV']],
        ['jirayu', ['QC']],
      ],
    },
    {
      key: 'nurse',
      name: 'ระบบลงเวลาพยาบาล',
      description: 'ลงเวลาเข้า-ออกเวร แลกเวร และสรุปชั่วโมงทำงานล่วงเวลาของพยาบาลทุกหอผู้ป่วย',
      autonomy: 'propose',
      budget: '25.00',
      pm: 'pranee',
      members: [
        ['somchai', ['PM']],
        ['pranee', ['PM']],
        ['kanokwan', ['BA']],
        ['rattana', ['BA', 'QC']],
        ['siriporn', ['SA', 'DEV']],
        ['pimchanok', ['DEV']],
        ['waraporn', ['QC']],
      ],
    },
    {
      key: 'dw',
      name: 'Data Warehouse',
      description: 'คลังข้อมูลกลางสำหรับรายงานผู้บริหารและตัวชี้วัดคุณภาพ (KPI) จากข้อมูล HIS รายวัน',
      autonomy: 'auto-assign',
      budget: null,
      pm: 'somchai',
      members: [
        ['somchai', ['PM']],
        ['siriporn', ['SA']],
        ['rattana', ['BA']],
        ['kittipat', ['DEV']],
        ['natthapong', ['DEV']],
        ['dev1', ['DEV']],
        ['jirayu', ['QC']],
      ],
    },
    {
      key: 'portal',
      name: 'Portal ผู้ป่วย',
      description: 'เว็บและแอปสำหรับผู้ป่วยดูผลตรวจ นัดหมาย และใบเสร็จออนไลน์',
      autonomy: 'propose',
      budget: '40.00',
      pm: 'somchai',
      members: [
        ['somchai', ['PM']],
        ['anucha', ['BA']],
        ['thanakorn', ['SA']],
        ['pimchanok', ['DEV']],
        ['dev1', ['DEV']],
        ['waraporn', ['QC']],
      ],
    },
    {
      key: 'room',
      name: 'ระบบจองห้องประชุม',
      description: 'โครงการใหม่ ยังไม่มีงาน',
      autonomy: 'propose',
      budget: null,
      pm: 'somchai',
      members: [['somchai', ['PM']]],
    },
    {
      key: 'old',
      name: 'ระบบเวรเปล (เดิม)',
      description: 'ระบบเรียกเวรเปลรุ่นเก่า ปิดโครงการแล้ว',
      autonomy: 'propose',
      budget: null,
      pm: 'somchai',
      members: [['somchai', ['PM']]],
      status: 'archived',
      noAi: true,
    },
  ]
  const PR: Record<string, string> = {}
  for (const p of PROJECTS) {
    const [row] = await db
      .insert(projects)
      .values({
        name: p.name,
        description: p.description,
        autonomy: p.autonomy,
        aiBudgetUsd: p.budget,
        status: p.status ?? 'active',
        noAi: p.noAi ?? false,
        createdBy: P.somchai!.id,
        createdAt: daysAgo(p.key === 'room' ? 2 : 75),
      })
      .returning()
    PR[p.key] = row!.id
    PROJECT_PM[row!.id] = p.pm
    await db.insert(projectMembers).values(p.members.map(([u, roles]) => ({ projectId: row!.id, personId: P[u]!.id, roles })))
  }
  await db.update(departmentSettings).set({ aiBudgetUsd: '20.00', updatedBy: P.somchai!.id }).where(eq(departmentSettings.id, 1))

  // GitLab repos (placeholder example.org URLs; ids 1.. match `pnpm fake-gitlab` with FAKE_GITLAB_PROJECTS).
  const REPOS: [string, number, string][] = [
    ['opd', 1, 'it-dev/opd-appointment'],
    ['opd', 2, 'it-dev/sms-gateway'],
    ['lab', 3, 'it-dev/his-lab-interface'],
    ['dw', 4, 'it-dev/data-warehouse'],
    ['portal', 5, 'it-dev/patient-portal'],
  ]
  const REPO: Record<string, string> = {}
  for (const [pk, gid, path] of REPOS) {
    const [row] = await db
      .insert(projectRepos)
      .values({ projectId: PR[pk]!, gitlabProjectId: gid, pathWithNamespace: path, webUrl: `https://gitlab.example.org/${path}`, defaultBranch: 'main', addedBy: P.somchai!.id, createdAt: daysAgo(60) })
      .returning()
    REPO[path] = row!.id
  }

  // Runners -----------------------------------------------------------
  await makeRunner({ key: 'server', name: 'yoda-runner-01 (เซิร์ฟเวอร์ห้อง IT)', kind: 'server', owner: 'somchai', accountType: 'api-key', capabilities: ['analyze-repo', 'code-change', 'run-tests'], mode: 'unattended', maxConcurrent: 2, lastSeenMinutes: 1 })
  await makeRunner({ key: 'mac', name: 'MacBook ของวิชัย', kind: 'dev-machine', owner: 'dev1', accountType: 'personal-subscription', capabilities: ['code-change'], mode: 'on-demand', lastSeenMinutes: 180 })
  await makeRunner({ key: 'night', name: 'night-runner (นอกเวลา)', kind: 'server', owner: 'somchai', accountType: 'org-plan', capabilities: ['code-change', 'run-tests'], mode: 'unattended', workingHours: { days: [1, 2, 3, 4, 5], start: '18:00', end: '23:30' }, lastSeenMinutes: 900 })
  await makeRunner({ key: 'paused', name: 'ws-natthapong', kind: 'dev-machine', owner: 'natthapong', accountType: 'personal-subscription', capabilities: ['analyze-repo', 'code-change'], mode: 'on-demand', paused: true, lastSeenMinutes: 4000 })
  await makeRunner({ key: 'revoked', name: 'old-ci-runner', kind: 'server', owner: 'somchai', accountType: 'api-key', capabilities: ['run-tests'], mode: 'unattended', revokedDaysAgo: 12, lastSeenMinutes: 20000 })

  // Work items ----------------------------------------------------------
  const S = {
    /** Stops at a step with its tasks freshly created (proposed in `propose` projects). */
    at: (step: string, o: { lowConfidence?: boolean } = {}) => async (id: string) => drive(id, step, o),
  }

  const specs: ItemSpec[] = [
    // --- ระบบนัดหมายผู้ป่วยนอก (propose)
    {
      key: 'opd-sms', project: 'opd', title: 'แจ้งเตือนนัดผ่าน SMS ล่วงหน้า 1 วัน', template: 'software-change', priority: 'high', requester: 'nurse1', target: 14, age: [21, 0.2],
      description: 'ผู้ป่วยลืมนัดบ่อย อยากให้ระบบส่ง SMS แจ้งเตือนก่อนวันนัด 1 วัน พร้อมลิงก์ยืนยันหรือขอเลื่อนนัด',
      scenario: async (id) => {
        await drive(id, 'dev')
        const impl = await taskOf(id, 'implement')
        await runnerRunning(impl!.id, 'แจ้งเตือนนัดผ่าน SMS ล่วงหน้า 1 วัน', 'server')
        const tests = await taskOf(id, 'draft-tests')
        await completeTask(tests!.id, 'แจ้งเตือนนัดผ่าน SMS ล่วงหน้า 1 วัน')
      },
    },
    {
      key: 'opd-reschedule', project: 'opd', title: 'ผู้ป่วยขอเลื่อนนัดเองผ่าน LINE OA', template: 'software-change', priority: 'normal', requester: 'malee', target: 30, age: [9, 1],
      description: 'ให้ผู้ป่วยเลือกวันนัดใหม่ได้เองจาก LINE OA ของโรงพยาบาล โดยจำกัดตามตารางออกตรวจของแพทย์',
      scenario: async (id) => {
        await drive(id, 'ba', { lowConfidence: true })
      },
    },
    {
      key: 'opd-queue-bug', project: 'opd', title: 'หน้าคิวนัดแสดงเวลาผิด 7 ชั่วโมงหลังอัปเดต', template: 'bug-fix', priority: 'urgent', requester: 'nurse1', target: -2, age: [6, 0.5],
      description: 'หลังอัปเดตเมื่อวันจันทร์ หน้าคิวนัด OPD แสดงเวลานัดเป็นเวลา UTC ทำให้ผู้ป่วยมาผิดเวลา',
      scenario: async (id) => {
        await drive(id, 'dev')
        const impl = await taskOf(id, 'implement')
        await runnerSucceeds(impl!.id, 'หน้าคิวนัดแสดงเวลาผิด 7 ชั่วโมงหลังอัปเดต')
        const tests = await taskOf(id, 'draft-tests')
        await completeTask(tests!.id, 'หน้าคิวนัดแสดงเวลาผิด 7 ชั่วโมงหลังอัปเดต')
        // The reviewer asks for changes: implement gets a second attempt with feedback.
        let review = await taskOf(id, 'review-code')
        if (review!.state === 'proposed') await work('pranee', (ctx) => confirmTask(ctx, me('pranee'), review!.id))
        review = await reload(review!.id)
        const who = usernameOf(review.assigneeId!)
        await work(who, (ctx) => startTask(ctx, me(who), review!.id))
        await work(who, (ctx) =>
          submitTask(ctx, me(who), review!.id, { text: 'ยังแปลง timezone ซ้ำสองครั้งในหน้ารายงาน กรุณาใช้ Asia/Bangkok จาก config แทนการบวก 7 ชั่วโมงเอง', attachmentIds: [], decision: 'changes' }),
        )
      },
    },
    {
      key: 'opd-report', project: 'opd', title: 'รายงานสถิติผู้ป่วยไม่มาตามนัดรายเดือน', template: 'software-change', priority: 'low', requester: 'malee', target: 45, age: [3, 0.1],
      description: 'สรุปจำนวนผู้ป่วยที่ไม่มาตามนัด แยกตามคลินิกและแพทย์ ส่งออก Excel ได้',
      scenario: S.at('intake'),
    },
    {
      key: 'opd-doctor', project: 'opd', title: 'ตารางออกตรวจแพทย์ดึงจากระบบ HR อัตโนมัติ', template: 'software-change', priority: 'normal', target: -5, age: [28, 8],
      description: 'ตอนนี้เจ้าหน้าที่ต้องพิมพ์ตารางออกตรวจซ้ำจากระบบ HR ทุกเดือน',
      scenario: async (id) => {
        await drive(id, 'sa')
        const d = await taskOf(id, 'draft-design')
        await completeTask(d!.id, 'ตารางออกตรวจแพทย์ดึงจากระบบ HR อัตโนมัติ')
      },
    },
    {
      key: 'opd-done', project: 'opd', title: 'ปุ่มพิมพ์ใบนัดซ้ำสำหรับเวชระเบียน', template: 'software-change', priority: 'normal', requester: 'nurse1', target: -10, age: [40, 12],
      description: 'เวชระเบียนต้องพิมพ์ใบนัดซ้ำให้ผู้ป่วยที่ทำใบนัดหาย',
      scenario: async (id) => drive(id, 'done'),
    },
    // --- HIS Lab Interface (auto-assign)
    {
      key: 'lab-critical', project: 'lab', title: 'แจ้งเตือนค่าวิกฤต (critical value) ไปยังหอผู้ป่วย', template: 'software-change', priority: 'urgent', requester: 'prasert', target: 3, age: [18, 0.3],
      description: 'เมื่อผล K+ > 6.0 หรือ Hb < 7 ให้แจ้งพยาบาลหอผู้ป่วยทันทีและบันทึกการรับทราบ',
      scenario: async (id) => {
        await drive(id, 'qc')
        const v = await taskOf(id, 'verify')
        const who = usernameOf(v!.assigneeId!)
        await work(who, (ctx) => startTask(ctx, me(who), v!.id))
      },
    },
    {
      key: 'lab-oru', project: 'lab', title: 'รองรับข้อความ ORU^R01 จากเครื่อง Cobas รุ่นใหม่', template: 'software-change', priority: 'high', requester: 'prasert', target: 10, age: [12, 2],
      description: 'ห้องแล็บเปลี่ยนเครื่องวิเคราะห์เป็นรุ่นใหม่ ข้อความ HL7 มี segment เพิ่ม',
      scenario: async (id) => {
        await drive(id, 'dev')
        const impl = await taskOf(id, 'implement')
        await runnerFails(impl!.id, 'server', 'failed', 'run-tests: 3 of 41 tests failed (OBX-5 parsing)')
        await runnerFails(impl!.id, 'night', 'expired', 'lease expired without a heartbeat')
      },
    },
    {
      key: 'lab-dup', project: 'lab', title: 'ผลแล็บซ้ำในประวัติผู้ป่วยเมื่อส่งซ้ำ', template: 'bug-fix', priority: 'high', requester: 'nurse1', target: -1, age: [7, 0.4],
      description: 'ถ้า LIS ส่งข้อความเดิมซ้ำ ผลแล็บจะแสดงสองบรรทัดใน HIS',
      scenario: async (id) => {
        await drive(id, 'close')
      },
    },
    {
      key: 'lab-microbio', project: 'lab', title: 'ส่งผลเพาะเชื้อ (microbiology) แบบ preliminary', template: 'software-change', priority: 'normal', target: 25, age: [10, 6],
      description: 'แพทย์อยากเห็นผลเพาะเชื้อเบื้องต้นก่อนผลสุดท้าย',
      scenario: async (id) => {
        await drive(id, 'ba')
        const d = await taskOf(id, 'draft-requirements')
        await work(null, (ctx) => failAiTask(ctx, d!.id, 'budget_exceeded'))
      },
    },
    {
      key: 'lab-done', project: 'lab', title: 'แปลงหน่วย mg/dL เป็น mmol/L สำหรับ glucose', template: 'bug-fix', priority: 'normal', target: -20, age: [35, 20],
      description: 'ค่าน้ำตาลจากเครื่องใหม่มาในหน่วย mmol/L',
      scenario: async (id) => drive(id, 'done'),
    },
    // --- ระบบลงเวลาพยาบาล (propose)
    {
      key: 'nurse-swap', project: 'nurse', title: 'แลกเวรผ่านมือถือพร้อมอนุมัติหัวหน้าหอ', template: 'software-change', priority: 'high', requester: 'nurse1', target: 7, age: [15, 0.6],
      description: 'พยาบาลขอแลกเวรกันเองในแอป หัวหน้าหออนุมัติ แล้วตารางเวรอัปเดตอัตโนมัติ',
      scenario: async (id) => {
        await drive(id, 'ba')
        const d = await taskOf(id, 'draft-requirements')
        await completeTask(d!.id, 'แลกเวรผ่านมือถือพร้อมอนุมัติหัวหน้าหอ', { lowConfidence: true })
      },
    },
    {
      key: 'nurse-ot', project: 'nurse', title: 'คำนวณค่าล่วงเวลาตามระเบียบใหม่ 2569', template: 'software-change', priority: 'urgent', requester: 'malee', target: -3, age: [25, 7],
      description: 'ระเบียบค่าตอบแทนนอกเวลาเปลี่ยน มีผลตั้งแต่ 1 ต.ค. 2569',
      scenario: async (id) => {
        await drive(id, 'sa')
      },
    },
    {
      key: 'nurse-gps', project: 'nurse', title: 'ลงเวลาด้วย GPS เฉพาะในพื้นที่โรงพยาบาล', template: 'software-change', priority: 'normal', target: null, age: [5, 4],
      description: 'ป้องกันการลงเวลาแทนกันจากนอกโรงพยาบาล',
      scenario: async (id) => {
        // The intake step is done: a step_advance proposal waits for the PM.
        await drive(id, 'intake')
        const t = await taskOf(id, 'accept-intake')
        await completeTask(t!.id, 'ลงเวลาด้วย GPS เฉพาะในพื้นที่โรงพยาบาล')
      },
    },
    {
      key: 'nurse-export', project: 'nurse', title: 'ส่งออกชั่วโมงทำงานให้ฝ่ายการเงิน', template: 'software-change', priority: 'low', requester: 'malee', target: -15, age: [50, 30],
      description: 'การเงินต้องการไฟล์ CSV ทุกสิ้นเดือน',
      scenario: async (id) => {
        await drive(id, 'intake')
        const [item] = await db.select().from(workItems).where(eq(workItems.id, id))
        await work('pranee', (ctx) => cancelWorkItem(ctx, me('pranee'), item!.id))
      },
    },
    {
      key: 'nurse-badge', project: 'nurse', title: 'บัตรพนักงานสแกนเข้าเวรไม่ได้ที่ตึก 3', template: 'bug-fix', priority: 'high', requester: 'nurse1', target: 2, age: [4, 1.5],
      description: 'เครื่องสแกนที่ตึก 3 ไม่ส่งข้อมูลเข้าระบบตั้งแต่เมื่อวาน',
      scenario: S.at('dev'),
    },
    // --- Data Warehouse (auto-assign)
    {
      key: 'dw-kpi', project: 'dw', title: 'Dashboard ระยะเวลารอคอย OPD รายชั่วโมง', template: 'software-change', priority: 'high', target: 5, age: [20, 0.8],
      description: 'ผู้บริหารต้องการดูเวลารอคอยเฉลี่ยแยกตามจุดบริการ',
      scenario: async (id) => {
        await drive(id, 'dev')
        const impl = await taskOf(id, 'implement')
        await runnerSucceeds(impl!.id, 'Dashboard ระยะเวลารอคอย OPD รายชั่วโมง')
        const tests = await taskOf(id, 'draft-tests')
        await completeTask(tests!.id, 'Dashboard ระยะเวลารอคอย OPD รายชั่วโมง')
      },
    },
    {
      key: 'dw-etl', project: 'dw', title: 'ETL รายวันล้มเหลวเมื่อมีผู้ป่วยชื่อยาวเกิน 100 ตัวอักษร', template: 'bug-fix', priority: 'urgent', target: -1, age: [3, 2.5],
      description: 'job ETL คืนวันอาทิตย์ล้ม ข้อมูลวันจันทร์ไม่เข้า',
      scenario: S.at('dev'),
    },
    {
      key: 'dw-ipd', project: 'dw', title: 'ตารางข้อเท็จจริงผู้ป่วยใน (IPD fact table)', template: 'software-change', priority: 'normal', target: 60, age: [14, 9],
      description: 'เพิ่ม fact table สำหรับวันนอน, DRG และค่าใช้จ่าย',
      scenario: S.at('ba'),
    },
    {
      key: 'dw-done', project: 'dw', title: 'รายงานอัตราครองเตียงรายวัน', template: 'software-change', priority: 'normal', target: -25, age: [60, 22],
      description: 'สรุปอัตราครองเตียงแยกตามหอผู้ป่วย',
      scenario: async (id) => drive(id, 'done'),
    },
    // --- Portal ผู้ป่วย (propose)
    {
      key: 'portal-results', project: 'portal', title: 'ผู้ป่วยดูผลตรวจเลือดย้อนหลังในแอป', template: 'software-change', priority: 'normal', requester: 'nurse1', target: 21, age: [11, 3],
      description: 'แสดงผลตรวจเลือด 2 ปีย้อนหลัง พร้อมกราฟแนวโน้มค่าน้ำตาลและไขมัน',
      scenario: async (id) => {
        await drive(id, 'ba')
        const d = await taskOf(id, 'draft-requirements')
        await completeTask(d!.id, 'ผู้ป่วยดูผลตรวจเลือดย้อนหลังในแอป')
      },
    },
    {
      key: 'portal-receipt', project: 'portal', title: 'ดาวน์โหลดใบเสร็จอิเล็กทรอนิกส์ (e-Receipt)', template: 'software-change', priority: 'high', requester: 'prasert', target: 9, age: [16, 1],
      description: 'ใบเสร็จต้องมีลายเซ็นดิจิทัลตามประกาศกรมสรรพากร',
      scenario: async (id) => {
        await drive(id, 'sa')
        const d = await taskOf(id, 'draft-design')
        await completeTask(d!.id, 'ดาวน์โหลดใบเสร็จอิเล็กทรอนิกส์ (e-Receipt)')
        const ap = await taskOf(id, 'approve-design')
        if (ap!.state === 'proposed') await work('somchai', (ctx) => confirmTask(ctx, me('somchai'), ap!.id))
      },
    },
    {
      key: 'portal-login', project: 'portal', title: 'เข้าสู่ระบบด้วย ThaiD', template: 'software-change', priority: 'normal', target: 40, age: [2, 0.05],
      description: 'ลดการลืมรหัสผ่าน ให้ผู้ป่วยยืนยันตัวตนด้วย ThaiD',
      scenario: S.at('intake'),
    },
    {
      key: 'portal-font', project: 'portal', title: 'ตัวอักษรภาษาไทยในหน้าใบนัดตัดคำผิด', template: 'bug-fix', priority: 'low', requester: 'nurse1', target: 12, age: [8, 0.7],
      description: 'คำว่า "โรงพยาบาล" ถูกตัดกลางคำบนมือถือจอเล็ก',
      scenario: async (id) => {
        await drive(id, 'qc')
      },
    },
    {
      key: 'portal-done', project: 'portal', title: 'หน้า FAQ การชำระเงิน', template: 'software-change', priority: 'low', requester: 'nurse1', target: -30, age: [70, 33],
      description: 'รวมคำถามที่พบบ่อยเรื่องสิทธิ์และการชำระเงิน',
      scenario: async (id) => drive(id, 'done'),
    },
  ]

  for (const spec of specs) {
    const owner = spec.owner ?? PROJECT_PM[PR[spec.project]!]!
    const id = await work(owner, (ctx) =>
      createWorkItem(ctx, me(owner), PR[spec.project]!, {
        title: spec.title,
        description: spec.description,
        templateKey: spec.template,
        priority: spec.priority,
        requesterId: spec.requester ? P[spec.requester]!.id : undefined,
      }),
    )
    ITEMS.set(spec.key, id)
    SPEC_BY_ID.set(id, spec)
    if (spec.target !== null && spec.target !== undefined) {
      await work(owner, (ctx) => patchWorkItem(ctx, me(owner), id, { targetDate: bkkDate(spec.target!) }))
    }
    await spec.scenario(id, spec)
  }

  // dev1 (the non-admin dev login) gets work in hand: a taken-over runner task and a code review.
  const oru = await taskOf(ITEMS.get('lab-oru')!, 'implement')
  await work('somchai', (ctx) => assignTask(ctx, me('somchai'), oru!.id, P.dev1!.id))
  await work('dev1', (ctx) => startTask(ctx, me('dev1'), oru!.id))
  const kpiReview = await taskOf(ITEMS.get('dw-kpi')!, 'review-code')
  if (kpiReview && kpiReview.assigneeId !== P.dev1!.id) await work('somchai', (ctx) => assignTask(ctx, me('somchai'), kpiReview.id, P.dev1!.id))

  // A priority change and a requester-made intake proposal (pending) --------
  await work(
    'dev1',
    (ctx) =>
      createProposal(ctx, {
        projectId: PR.opd!,
        workItemId: ITEMS.get('opd-reschedule')!,
        kind: 'priority_change',
        summary: 'ผู้ป่วยขอเลื่อนนัดเองผ่าน LINE OA: normal → high',
        reason: 'ฝ่ายบริการผู้ป่วยแจ้งว่าโทรศัพท์ขอเลื่อนนัดเพิ่มขึ้น 40% ในเดือนนี้',
        payload: { priority: 'high' },
        onBehalfOf: P.dev1!.id,
      }),
    'ai',
  )
  const intakeProposal = await work(
    'nurse1',
    (ctx) =>
      createProposal(ctx, {
        projectId: null,
        workItemId: null,
        kind: 'create_work_item',
        summary: 'ขอเพิ่มช่องบันทึกการแพ้ยาในหน้าคัดกรอง',
        reason: '',
        payload: { title: 'ขอเพิ่มช่องบันทึกการแพ้ยาในหน้าคัดกรอง', description: 'พยาบาลคัดกรองต้องสลับไปอีกหน้าจอเพื่อบันทึกการแพ้ยา อยากให้บันทึกได้ในหน้าคัดกรองเลย', templateKey: 'software-change', priority: 'normal', attachmentIds: [] },
        onBehalfOf: P.nurse1!.id,
      }),
    'ai',
  )
  const projectProposal = await work(
    'somchai',
    (ctx) =>
      createProposal(ctx, {
        projectId: PR.dw!,
        workItemId: null,
        kind: 'create_work_item',
        summary: 'รายงานการใช้ยาปฏิชีวนะ (DDD) รายเดือน',
        reason: '',
        payload: { title: 'รายงานการใช้ยาปฏิชีวนะ (DDD) รายเดือน', description: 'คณะกรรมการ PTC ต้องการตัวชี้วัด DDD/1000 วันนอน', templateKey: 'software-change', priority: 'normal', projectId: PR.dw! },
        onBehalfOf: P.somchai!.id,
      }),
    'ai',
  )

  // GitLab issues and merge requests ------------------------------------
  const issue = async (itemKey: string, path: string, iid: number) => {
    const workItemId = ITEMS.get(itemKey)!
    await db
      .insert(workItemRepos)
      .values({ workItemId, repoId: REPO[path]!, issueIid: iid, issueUrl: `https://gitlab.example.org/${path}/-/issues/${iid}`, syncStatus: 'synced', lastSyncedAt: daysAgo(0.3) })
      .onConflictDoUpdate({
        target: [workItemRepos.workItemId, workItemRepos.repoId],
        set: { issueIid: iid, issueUrl: `https://gitlab.example.org/${path}/-/issues/${iid}`, syncStatus: 'synced', lastSyncedAt: daysAgo(0.3) },
      })
  }
  const mr = async (itemKey: string, path: string, iid: number, state: 'opened' | 'merged' | 'closed', pipeline: 'none' | 'pending' | 'running' | 'success' | 'failed' | 'canceled', title: string) => {
    const workItemId = ITEMS.get(itemKey)!
    await db.insert(mergeRequests).values({
      repoId: REPO[path]!,
      mrIid: iid,
      workItemId,
      title,
      url: `https://gitlab.example.org/${path}/-/merge_requests/${iid}`,
      state,
      sourceBranch: branchFor(workItemId, title).slice(0, 80),
      pipeline,
      createdAt: daysAgo(2),
      updatedAt: daysAgo(0.2),
    })
  }
  await issue('opd-sms', 'it-dev/opd-appointment', 41)
  await issue('opd-sms', 'it-dev/sms-gateway', 7)
  await issue('opd-queue-bug', 'it-dev/opd-appointment', 44)
  await mr('opd-queue-bug', 'it-dev/opd-appointment', 112, 'opened', 'failed', 'fix: แสดงเวลานัดตาม Asia/Bangkok')
  await mr('opd-queue-bug', 'it-dev/opd-appointment', 109, 'closed', 'canceled', 'fix: บวก 7 ชั่วโมงในหน้าคิว (ยกเลิก)')
  await issue('opd-done', 'it-dev/opd-appointment', 30)
  await mr('opd-done', 'it-dev/opd-appointment', 95, 'merged', 'success', 'feat: ปุ่มพิมพ์ใบนัดซ้ำ')
  await issue('lab-critical', 'it-dev/his-lab-interface', 18)
  await mr('lab-critical', 'it-dev/his-lab-interface', 52, 'merged', 'success', 'feat: critical value alert to ward')
  await issue('lab-oru', 'it-dev/his-lab-interface', 21)
  await db.update(workItemRepos).set({ syncStatus: 'failed', syncError: 'gitlab_unavailable' }).where(eq(workItemRepos.workItemId, ITEMS.get('lab-oru')!))
  await issue('lab-dup', 'it-dev/his-lab-interface', 20)
  await mr('lab-dup', 'it-dev/his-lab-interface', 55, 'merged', 'success', 'fix: ignore duplicate ORU by MSH-10')
  await issue('dw-kpi', 'it-dev/data-warehouse', 9)
  await mr('dw-kpi', 'it-dev/data-warehouse', 31, 'opened', 'running', 'feat: OPD waiting time hourly mart')
  await issue('portal-font', 'it-dev/patient-portal', 66)
  await mr('portal-font', 'it-dev/patient-portal', 140, 'merged', 'success', 'fix: Thai line breaking on appointment card')

  // Discussions ---------------------------------------------------------
  const brief = (context: string, options: { key: string; title: string; pros: string; cons: string }[], recommendation: string, recommendedKey: string | null) => ({
    context,
    options,
    recommendation,
    recommendedKey,
    source: 'ai' as const,
    status: 'ready' as const,
    failReason: null,
  })
  const raise = async (by: string, input: Omit<Parameters<typeof createDiscussion>[2], 'requestBrief'>, b: ReturnType<typeof brief> | 'pending' | 'failed' | null) => {
    const id = await work(by, (ctx) => createDiscussion(ctx, me(by), { ...input, requestBrief: false }))
    if (b === 'pending') await db.update(discussions).set({ brief: { context: '', options: input.options ?? [], recommendation: '', recommendedKey: null, source: 'ai', status: 'pending', failReason: null } }).where(eq(discussions.id, id))
    else if (b === 'failed') await db.update(discussions).set({ brief: { context: '', options: [], recommendation: '', recommendedKey: null, source: 'ai', status: 'failed', failReason: 'ai_failed' } }).where(eq(discussions.id, id))
    else if (b) await db.update(discussions).set({ brief: b }).where(eq(discussions.id, id))
    return id
  }

  const dSms = await raise(
    'pranee',
    {
      projectId: PR.opd!,
      workItemId: ITEMS.get('opd-sms')!,
      question: 'ควรส่ง SMS ผ่านผู้ให้บริการรายเดิมหรือย้ายไป LINE OA ทั้งหมด?',
      details: 'ค่า SMS เดือนละประมาณ 18,000 บาท ผู้ป่วยสูงอายุส่วนใหญ่ไม่ได้ใช้ LINE',
      priority: 'high',
      options: [],
    },
    brief(
      'ผู้ป่วยนัด OPD ประมาณ 1,200 รายต่อวัน ร้อยละ 38 อายุเกิน 60 ปี ข้อมูลจากฝ่ายบริการพบว่าผู้ป่วยที่ลงทะเบียน LINE OA มีเพียงร้อยละ 22',
      [
        { key: 'sms', title: 'ใช้ SMS ต่อทั้งหมด', pros: 'ถึงผู้ป่วยทุกกลุ่ม ไม่ต้องเปลี่ยนพฤติกรรม', cons: 'ค่าใช้จ่ายสูงและคงที่' },
        { key: 'line', title: 'ย้ายไป LINE OA ทั้งหมด', pros: 'ฟรี ส่งรูปและลิงก์ยืนยันได้', cons: 'ผู้สูงอายุจำนวนมากจะไม่ได้รับแจ้งเตือน' },
        { key: 'hybrid', title: 'LINE ก่อน ถ้าไม่ได้ลงทะเบียนค่อยส่ง SMS', pros: 'ลดค่า SMS ได้ราว 20% และไม่ทิ้งใคร', cons: 'ต้องดูแลสองช่องทาง' },
      ],
      'แนะนำแบบผสม: ส่ง LINE ให้ผู้ที่ลงทะเบียนแล้ว และส่ง SMS ให้ผู้ที่เหลือ เพราะครอบคลุมผู้ป่วยทุกกลุ่มและลดต้นทุนได้ทันที',
      'hybrid',
    ),
  )
  await work('dev1', (ctx) => respond(ctx, me('dev1'), dSms, { kind: 'vote', optionKey: 'hybrid', text: '' }))
  await work('kanokwan', (ctx) => respond(ctx, me('kanokwan'), dSms, { kind: 'vote', optionKey: 'hybrid', text: '' }))
  await work('waraporn', (ctx) => respond(ctx, me('waraporn'), dSms, { kind: 'vote', optionKey: 'sms', text: '' }))
  await work('kanokwan', (ctx) => respond(ctx, me('kanokwan'), dSms, { kind: 'opinion', text: 'คุยกับหัวหน้าพยาบาล OPD แล้ว ผู้ป่วยกลุ่มโรคเรื้อรังส่วนใหญ่ยังใช้ SMS อยู่ค่ะ', optionKey: undefined }))

  const dOt = await raise(
    'kanokwan',
    {
      projectId: PR.nurse!,
      workItemId: ITEMS.get('nurse-ot')!,
      question: 'ชั่วโมงพักระหว่างเวรนับรวมเป็นชั่วโมงล่วงเวลาหรือไม่?',
      details: 'ระเบียบใหม่เขียนไม่ชัด ฝ่ายการเงินและฝ่ายการพยาบาลตีความต่างกัน',
      priority: 'urgent',
      options: [],
    },
    brief(
      'ระเบียบค่าตอบแทนปี 2569 ข้อ 7 ระบุ "เวลาปฏิบัติงานต่อเนื่อง" แต่ไม่ได้ระบุช่วงพัก',
      [
        { key: 'include', title: 'นับรวม', pros: 'ตรงกับการปฏิบัติจริงในหอผู้ป่วยวิกฤต', cons: 'ค่าใช้จ่ายเพิ่มประมาณ 6%' },
        { key: 'exclude', title: 'ไม่นับรวม', pros: 'ตรงตามตัวอักษรของระเบียบ', cons: 'อาจมีข้อร้องเรียนจากพยาบาล' },
      ],
      'ควรขอความเห็นจากฝ่ายกฎหมายก่อนตัดสิน เพราะกระทบค่าตอบแทนย้อนหลัง',
      null,
    ),
  )

  const dPortal = await raise(
    'anucha',
    {
      projectId: PR.portal!,
      question: 'แอปผู้ป่วยควรทำเป็น PWA หรือ native app?',
      details: 'งบปีนี้ทำได้แบบเดียว',
      priority: 'normal',
      options: [],
    },
    brief(
      'ทีมมีนักพัฒนา Vue 3 คน ไม่มีประสบการณ์ Swift/Kotlin',
      [
        { key: 'pwa', title: 'PWA', pros: 'ใช้ทีมเดิม ออกได้เร็ว', cons: 'การแจ้งเตือนบน iOS จำกัด' },
        { key: 'native', title: 'Native (Flutter)', pros: 'ประสบการณ์ใช้งานดีที่สุด', cons: 'ต้องจ้างเพิ่มและใช้เวลา 6 เดือน' },
      ],
      'เริ่มด้วย PWA แล้วประเมินใหม่หลังใช้งาน 6 เดือน',
      'pwa',
    ),
  )
  await work('somchai', (ctx) => decideDiscussion(ctx, me('somchai'), dPortal, { decision: 'ทำเป็น PWA ก่อน และวัดผลการใช้งานหลัง 6 เดือนก่อนตัดสินเรื่อง native', optionKey: 'pwa' }))

  const dDw = await raise(
    'siriporn',
    { projectId: PR.dw!, question: 'ย้าย ETL จาก cron ไปใช้ Airflow หรือไม่?', details: 'job รายวันมี 34 ตัวและเริ่มพึ่งพากัน', priority: 'normal', options: [] },
    'pending',
  )
  const dLab = await raise(
    'anucha',
    {
      projectId: PR.lab!,
      workItemId: ITEMS.get('lab-oru')!,
      question: 'เก็บข้อความ HL7 ดิบไว้นานเท่าไร?',
      details: 'ปัจจุบันเก็บไม่จำกัด ใช้พื้นที่ 1.2 TB',
      priority: 'high',
      options: [],
    },
    'failed',
  )
  const dRoom = await raise(
    'somchai',
    { question: 'มาตรฐานการตั้งชื่อ branch ของทั้งแผนก', details: 'แต่ละโครงการตั้งชื่อไม่เหมือนกัน', priority: 'low', options: [] },
    brief(
      'มี 5 repo ที่ใช้รูปแบบต่างกัน',
      [
        { key: 'type-slug', title: 'feat/<slug>, fix/<issue>', pros: 'อ่านง่าย คุ้นเคย', cons: 'ไม่ผูกกับงานใน Portal' },
        { key: 'yoda', title: 'yoda/<work-item-id>-<slug>', pros: 'ลิงก์กลับ Portal ได้อัตโนมัติ', cons: 'ยาว' },
      ],
      'ใช้ feat/fix สำหรับงานคน และ yoda/ สำหรับงานที่ runner ทำ',
      'type-slug',
    ),
  )
  await work('somchai', (ctx) => decideDiscussion(ctx, me('somchai'), dRoom, { decision: 'ใช้ feat/<slug> และ fix/<issue> สำหรับงานของคน ส่วน runner ใช้ yoda/<id>-<slug>', optionKey: 'type-slug' }))

  // Agenda: next Monday 10:00 Bangkok, with two discussions scheduled.
  const nextMonday = new Date(now)
  nextMonday.setUTCDate(nextMonday.getUTCDate() + ((8 - nextMonday.getUTCDay()) % 7 || 7))
  nextMonday.setUTCHours(3, 0, 0, 0)
  const agendaId = await work('somchai', (ctx) => createAgenda(ctx.tx, me('somchai'), { title: 'ประชุมทีม IT ประจำสัปดาห์', meetingAt: nextMonday.toISOString() }))
  await work('somchai', (ctx) => putAgendaItems(ctx, me('somchai'), agendaId, { discussionIds: [dOt, dSms] }))
  const pastAgenda = await work('somchai', (ctx) => createAgenda(ctx.tx, me('somchai'), { title: 'ประชุมทบทวนสถาปัตยกรรม', meetingAt: daysAgo(6).toISOString() }))
  void pastAgenda
  void dDw
  void dLab

  // Knowledge ---------------------------------------------------------------
  const k = async (by: string | null, input: Parameters<typeof createEntry>[2], confirm = false) => {
    const id = await work(by, (ctx) => createEntry(ctx, by ? me(by) : null, input), by ? 'person' : 'ai')
    if (confirm) await work('somchai', (ctx) => confirmEntry(ctx, me('somchai'), id))
    return id
  }
  await k('somchai', { scope: 'department', type: 'fact', title: 'ช่วงเวลาห้าม deploy ระบบ HIS', body: 'ห้าม deploy ระหว่าง 07:00–16:00 วันทำการ และช่วงปิดยอดสิ้นเดือน (วันที่ 28–2)', noAi: false })
  await k('somchai', { scope: 'department', type: 'decision', title: 'ใช้ Keycloak กลางสำหรับทุกระบบใหม่', body: 'ระบบใหม่ทุกตัวต้องยืนยันตัวตนผ่าน Keycloak ของโรงพยาบาล ห้ามมีฐานผู้ใช้แยก', noAi: false })
  await k('somchai', { scope: 'department', type: 'document', title: 'มาตรฐาน HL7 v2 ของโรงพยาบาล', body: '## Segment ที่ใช้\n- MSH, PID, PV1, ORC, OBR, OBX\n\n## การเข้ารหัส\nUTF-8 ทุกข้อความ (ระบบเก่า TIS-620 ต้องแปลงที่ interface engine)', noAi: false })
  await k('pranee', { scope: 'project', projectId: PR.opd!, type: 'fact', title: 'จำนวนนัดเฉลี่ยต่อวัน', body: 'OPD มีนัดเฉลี่ย 1,200 รายต่อวัน สูงสุด 1,850 รายในวันจันทร์', noAi: false })
  await k('kanokwan', { scope: 'project', projectId: PR.opd!, type: 'decision', title: 'นัดเลื่อนได้ไม่เกิน 2 ครั้งต่อการนัด', body: 'ตกลงกับฝ่ายบริการผู้ป่วยเมื่อ 3 พ.ย. 2569', noAi: false })
  await k(null, { scope: 'project', projectId: PR.opd!, type: 'memory', title: 'หัวหน้า OPD ชอบรับรายงานเป็น Excel', body: 'จากการคุยในแชตเมื่อสัปดาห์ก่อน', noAi: false, status: 'draft', sourceKind: 'ai' })
  await k('thanakorn', { scope: 'project', projectId: PR.opd!, type: 'document', title: 'แผนผังการเชื่อมต่อ SMS Gateway', body: '```\nPortal → Appointment API → SMS Gateway (REST) → ผู้ให้บริการ\n```\nTimeout 5 วินาที, retry 3 ครั้ง', noAi: false })
  await k('anucha', { scope: 'project', projectId: PR.lab!, type: 'fact', title: 'เครื่อง Cobas ส่ง OBX-5 เป็นทศนิยม 3 ตำแหน่ง', body: '', noAi: false })
  await k('somchai', { scope: 'project', projectId: PR.old!, type: 'document', title: 'สรุปปิดโครงการเวรเปล', body: 'ย้ายไปใช้ระบบใหม่แล้ว เก็บข้อมูลย้อนหลังไว้ 1 ปี', noAi: true })

  // Weekly summaries (latest finished week + this week in progress).
  const thisWeek = isoWeek(new Date(now))
  const lastWeek = isoWeek(new Date(now - 7 * DAY))
  for (const pk of ['opd', 'lab', 'nurse', 'dw', 'portal']) {
    const body = (w: string) =>
      [
        `### สรุปสัปดาห์ ${w}`,
        '',
        '- ปิดงานได้ 2 รายการ ส่งต่อขั้นทดสอบ 1 รายการ',
        '- มีงานเร่งด่วน 1 รายการที่เลยกำหนดเป้าหมาย',
        '- AI ร่างข้อกำหนด 3 ฉบับ (ความมั่นใจต่ำ 1 ฉบับ)',
        '',
        '**สิ่งที่ต้องตัดสินใจ:** ช่องทางแจ้งเตือนผู้ป่วย (รอประชุมวันจันทร์)',
      ].join('\n')
    for (const w of pk === 'portal' ? [lastWeek] : [lastWeek, thisWeek]) {
      await work(null, (ctx) =>
        createEntry(ctx, null, { scope: 'project', projectId: PR[pk]!, type: 'document', title: `สรุปประจำสัปดาห์ ${w} / Weekly summary ${w}`, body: body(w), noAi: false, status: 'draft', sourceKind: 'ai', sourceRef: `weekly:${PR[pk]!}:${w}` }),
      'system')
    }
  }

  // AI usage this month (spend vs. budgets) -------------------------------
  const usage: [string | null, number, string][] = [
    ['opd', 31.4, MODEL],
    ['lab', 26.9, MODEL],
    ['nurse', 8.2, MODEL],
    ['dw', 14.75, MODEL],
    ['portal', 5.1, FAST],
    [null, 3.6, FAST],
  ]
  for (const [pk, total, model] of usage) {
    const n = 12
    const rows = Array.from({ length: n }, (_, i) => ({
      projectId: pk ? PR[pk]! : null,
      job: i % 3 === 0 ? 'fast' : 'draft',
      provider: 'anthropic',
      model: model.split(':')[1]!,
      inputTokens: 20_000 + i * 900,
      outputTokens: 2_500 + i * 120,
      costUsd: (total / n).toFixed(6),
      ok: i !== 5,
      error: i === 5 ? 'overloaded' : null,
      createdAt: daysAgo(i * 1.7),
    }))
    await db.insert(aiCalls).values(rows)
  }

  // Chat --------------------------------------------------------------------
  const [personal] = await db
    .insert(conversations)
    .values({ kind: 'personal', ownerId: P.somchai!.id, title: 'ผู้ช่วย', createdAt: daysAgo(30), lastMessageAt: daysAgo(0.02) })
    .returning()
  const [projThread] = await db
    .insert(conversations)
    .values({ kind: 'project', ownerId: P.pranee!.id, projectId: PR.opd!, title: 'ระบบนัดหมายผู้ป่วยนอก', createdAt: daysAgo(20), lastMessageAt: daysAgo(1) })
    .returning()
  const [itemThread] = await db
    .insert(conversations)
    .values({ kind: 'work_item', ownerId: P.somchai!.id, projectId: PR.lab!, workItemId: ITEMS.get('lab-critical')!, title: 'แจ้งเตือนค่าวิกฤต (critical value) ไปยังหอผู้ป่วย', createdAt: daysAgo(5), lastMessageAt: daysAgo(0.5) })
    .returning()
  const firstEntry = (await db.select({ id: knowledgeEntries.id, title: knowledgeEntries.title }).from(knowledgeEntries).where(and(eq(knowledgeEntries.projectId, PR.opd!), isNull(knowledgeEntries.supersededAt), eq(knowledgeEntries.title, 'จำนวนนัดเฉลี่ยต่อวัน'))).limit(1))[0]!
  const msg = async (conversationId: string, authorKind: 'person' | 'ai' | 'system', author: string | null, text: string, minutesAgo: number, actions: unknown[] = []) => {
    const [m] = await db
      .insert(messages)
      .values({ conversationId, authorKind, authorId: author ? P[author]!.id : null, text, actions, createdAt: new Date(now - minutesAgo * 60_000) })
      .returning()
    return m!
  }
  await msg(personal!.id, 'person', 'somchai', 'สรุปงานที่เลยกำหนดของฉันให้หน่อย', 60 * 26)
  await msg(personal!.id, 'ai', null, 'มีงานที่เลยกำหนด **3 รายการ** ในโครงการที่คุณเป็น PM:\n\n1. หน้าคิวนัดแสดงเวลาผิด 7 ชั่วโมงหลังอัปเดต — ขั้นพัฒนา, โค้ดถูกส่งกลับให้แก้\n2. ตารางออกตรวจแพทย์ดึงจากระบบ HR อัตโนมัติ — ไม่มีความเคลื่อนไหว 8 วัน\n3. ETL รายวันล้มเหลวเมื่อมีผู้ป่วยชื่อยาวเกิน 100 ตัวอักษร — รอมอบหมายนักพัฒนา', 60 * 26 - 1, [
    { type: 'link', label: 'เปิดหน้าสถานะ', to: '/status' },
  ])
  await msg(personal!.id, 'person', 'somchai', 'สร้างงานใหม่ในโครงการ Data Warehouse: รายงานการใช้ยาปฏิชีวนะ (DDD) รายเดือน ให้คณะกรรมการ PTC', 45)
  await msg(personal!.id, 'ai', null, 'เตรียมงานใหม่ให้แล้ว ใช้ขั้นตอน "เปลี่ยนแปลงระบบ" ความสำคัญปกติ กรุณายืนยันในการ์ดด้านล่าง', 44, [{ type: 'proposal', proposalId: projectProposal }])
  await msg(personal!.id, 'person', 'somchai', 'จดไว้ด้วยว่า OPD มีนัดเฉลี่ยวันละ 1,200 ราย', 20)
  await msg(personal!.id, 'ai', null, 'บันทึกเป็นข้อเท็จจริงของโครงการ "ระบบนัดหมายผู้ป่วยนอก" แล้ว (ร่าง รอทีมยืนยัน)', 19, [{ type: 'knowledge_saved', entryId: firstEntry.id, title: firstEntry.title }])
  await msg(personal!.id, 'person', 'somchai', 'เปิดงานแจ้งเตือน SMS ให้ดูหน่อย', 2)
  await msg(personal!.id, 'ai', null, 'งานนี้อยู่ในขั้นพัฒนา runner กำลังเขียนโค้ดอยู่ (เริ่ม 27 นาทีที่แล้ว)', 1, [
    { type: 'work_item_created', workItemId: ITEMS.get('opd-sms')!, title: 'แจ้งเตือนนัดผ่าน SMS ล่วงหน้า 1 วัน' },
  ])
  await msg(projThread!.id, 'person', 'pranee', 'สัปดาห์นี้ใครว่างรับงานรีวิวโค้ดบ้างคะ', 60 * 30)
  await msg(projThread!.id, 'person', 'dev1', 'ผมรับได้ครับ', 60 * 29)
  await msg(projThread!.id, 'ai', null, 'ภาระงานตอนนี้: วิชัย 3 งาน, พิมพ์ชนก 2 งาน', 60 * 29 - 1)
  await msg(itemThread!.id, 'person', 'somchai', 'ผลทดสอบค่าวิกฤตบนหอ 5A เป็นอย่างไรบ้าง', 60 * 13)
  await msg(itemThread!.id, 'ai', null, 'จิรายุเริ่มทดสอบระบบแล้ว ยังไม่มีผลบันทึก', 60 * 12)
  // nurse1's intake chat with a pending request card.
  const [intake] = await db
    .insert(conversations)
    .values({ kind: 'intake', ownerId: P.nurse1!.id, title: 'ผู้ช่วย', createdAt: daysAgo(10), lastMessageAt: daysAgo(0.1) })
    .returning()
  await msg(intake!.id, 'person', 'nurse1', 'สวัสดีค่ะ อยากขอให้เพิ่มช่องบันทึกการแพ้ยาในหน้าคัดกรองค่ะ ตอนนี้ต้องสลับไปอีกหน้าจอ', 60 * 3)
  await msg(intake!.id, 'ai', null, 'รับทราบค่ะ สรุปคำขอให้ดังนี้\n\n**ขอเพิ่มช่องบันทึกการแพ้ยาในหน้าคัดกรอง**\nพยาบาลคัดกรองต้องสลับหน้าจอเพื่อบันทึกการแพ้ยา\n\nส่งให้ทีม IT แล้ว ทีมจะยืนยันและแจ้งความคืบหน้าทางหน้า "คำขอของฉัน"', 60 * 3 - 1, [{ type: 'proposal', proposalId: intakeProposal }])
  await msg(intake!.id, 'person', 'nurse1', 'งานแจ้งเตือน SMS ถึงไหนแล้วคะ', 30)
  await msg(intake!.id, 'ai', null, 'งาน "แจ้งเตือนนัดผ่าน SMS ล่วงหน้า 1 วัน" อยู่ในขั้น **พัฒนา** ค่ะ คาดว่าจะเข้าสู่การทดสอบภายในสัปดาห์หน้า', 29, [
    { type: 'link', label: 'ดูคำขอ', to: `/requests/${ITEMS.get('opd-sms')!}` },
  ])
  await db.insert(conversationReads).values({ conversationId: personal!.id, personId: P.somchai!.id, lastReadSeq: 0 }).onConflictDoNothing()

  // Extra notifications (secretary, budget, discussion) -----------------------
  await db.insert(notifications).values([
    { personId: P.somchai!.id, kind: 'budget_alert', title: 'งบ AI ของ HIS Lab Interface ใช้ไปแล้ว 90%', body: 'ใช้ไป $26.90 จาก $30.00 ในเดือนนี้', link: `/projects/${PR.lab!}`, createdAt: daysAgo(0.4) },
    { personId: P.somchai!.id, kind: 'secretary_message', title: 'สรุปงานเช้านี้', body: 'มีงานรอคุณยืนยัน 6 รายการ และงานเลยกำหนด 3 รายการ', link: '/chat', createdAt: daysAgo(0.1) },
    { personId: P.somchai!.id, kind: 'work_item_stuck', title: 'งานไม่มีความเคลื่อนไหว 8 วัน', body: 'ตารางออกตรวจแพทย์ดึงจากระบบ HR อัตโนมัติ', link: `/work-items/${ITEMS.get('opd-doctor')!}`, createdAt: daysAgo(1), readAt: daysAgo(0.9) },
    { personId: P.nurse1!.id, kind: 'request_update', title: 'คำขอของคุณเข้าสู่ขั้นพัฒนา', body: 'แจ้งเตือนนัดผ่าน SMS ล่วงหน้า 1 วัน', link: `/requests/${ITEMS.get('opd-sms')!}`, createdAt: daysAgo(0.5) },
  ])
  // Mark older notifications read so the bell shows a realistic unread count.
  await db.execute(sql`update notifications set read_at = now() where created_at < now() - interval '2 days' and read_at is null`)

  // Notification channel settings and prefs.
  await db.update(notificationChannelSettings).set({ emailEnabled: true, lineEnabled: true, telegramEnabled: true, updatedBy: P.somchai!.id }).where(eq(notificationChannelSettings.id, 1))
  await db.insert(notificationPrefs).values({ personId: P.somchai!.id, kinds: { task_assigned: ['email', 'telegram'], budget_alert: ['email'], discussion: ['telegram'] } as never })
  await db.insert(channelLinks).values({ personId: P.somchai!.id, channel: 'line', externalId: 'Udemo0000000000000000000000000001', linkedAt: daysAgo(20) })

  // Back-date ------------------------------------------------------------------
  await backdate()
  console.log(`seed-demo: done (${specs.length} work items, ${Object.keys(P).length} people) in ${dbName}`)
}

/** Spreads each work item's events between its spec's age bounds and aligns task / item timestamps. */
async function backdate(): Promise<void> {
  for (const [id, spec] of SPEC_BY_ID) {
    const [startD, endD] = spec.age
    const start = now - startD * DAY
    const end = now - endD * DAY
    const evs = await db.select({ id: events.id }).from(events).where(eq(events.workItemId, id)).orderBy(asc(events.seq))
    const n = evs.length
    for (const [i, e] of evs.entries()) {
      // Business-hours-ish jitter: events of one burst stay a few minutes apart.
      const at = new Date(n > 1 ? start + ((end - start) * i) / (n - 1) : end)
      await db.update(events).set({ createdAt: at }).where(eq(events.id, e.id))
    }
    await db.execute(sql`
      update tasks t set
        created_at = coalesce((select min(e.created_at) from events e where e.task_id = t.id), t.created_at),
        updated_at = coalesce((select max(e.created_at) from events e where e.task_id = t.id), t.updated_at)
      where t.work_item_id = ${id}`)
    await db.update(workItems).set({ createdAt: new Date(start), updatedAt: new Date(end) }).where(eq(workItems.id, id))
    await db.execute(sql`
      update proposals p set created_at = coalesce((select max(e.created_at) from events e where e.payload->>'proposalId' = p.id::text), p.created_at),
        decided_at = case when p.decided_at is null then null else coalesce((select max(e.created_at) from events e where e.payload->>'proposalId' = p.id::text), p.decided_at) end
      where p.work_item_id = ${id}`)
    await db.execute(sql`
      update notifications n set created_at = ${new Date(end).toISOString()}::timestamptz - (random() * ${`${Math.max(startD - endD, 0.1)} days`}::interval)
      where n.link like ${`%${id}%`} and n.kind <> 'budget_alert' and n.kind <> 'secretary_message' and n.kind <> 'work_item_stuck'`)
    await db.execute(sql`
      update knowledge_entries k set created_at = ${new Date(end).toISOString()}::timestamptz where k.work_item_id = ${id}`)
  }
  // Runs: keep the running one fresh, spread finished ones over the last days.
  await db.execute(sql`
    update agent_runs set started_at = now() - interval '2 days' + (random() * interval '1 day'),
      heartbeat_at = now() - interval '1 day', ended_at = now() - interval '1 day' + (random() * interval '3 hours')
    where state <> 'running'`)
  await db.execute(sql`update discussions set created_at = now() - (random() * interval '6 days') - interval '1 day', updated_at = now() - (random() * interval '1 day')`)
  await db.execute(sql`update knowledge_entries set created_at = now() - (random() * interval '20 days') where work_item_id is null and source_ref is null`)
  await db.execute(sql`update proposals set created_at = now() - interval '3 hours' where work_item_id is null`)
  // Weekly summary of last week: written on Monday 08:00.
  await db.execute(sql`update knowledge_entries set created_at = date_trunc('week', now() at time zone 'Asia/Bangkok') at time zone 'Asia/Bangkok' + interval '1 hour' where source_ref like 'weekly:%'`)
  void randomUUID
  void knowledgeEntries
  void discussionResponses
}

main()
  .then(async () => {
    await (db as unknown as { $client: { end(): Promise<void> } }).$client.end()
  })
  .catch(async (err) => {
    console.error(err)
    await (db as unknown as { $client: { end(): Promise<void> } }).$client.end()
    process.exit(1)
  })
