import type { FastifyInstance } from 'fastify'
import { eq } from 'drizzle-orm'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { buildApp, type AppDeps } from '../src/app.js'
import type { Db } from '../src/db/client.js'
import { notificationChannelSettings, notificationDeliveries, notificationPrefs, notifications, people } from '../src/db/schema.js'
import { InlineJobQueue } from '../src/jobs/queue.js'
import type { MailMessage, MailTransport } from '../src/notifications/channels/email.js'
import { deliver, recordDelivery } from '../src/notifications/deliver.js'
import { channelsFor } from '../src/notifications/prefs.js'
import { notifyTaskAssigned, notify } from '../src/notifications/service.js'
import { runWork } from '../src/work/context.js'
import { resetDb, testDb, testDeps } from './helpers.js'
import { auth, login, type Who } from './support.js'

const SMTP = {
  smtpHost: 'smtp.example.org',
  smtpPort: 587,
  smtpSecure: false,
  smtpUser: 'yoda',
  smtpPassword: 'test-smtp-password', // fake; asserted absent from logs
  mailFrom: 'Yoda <yoda@example.org>',
}

/** Records every message; `fail` makes the next N sends throw `err`. */
function fakeTransport() {
  const sent: MailMessage[] = []
  const state = { fail: 0, err: null as unknown }
  const transport: MailTransport = {
    async sendMail(m) {
      if (state.fail > 0) {
        state.fail--
        throw state.err
      }
      sent.push(m)
    },
  }
  return { sent, state, transport }
}

async function person(db: Db, name: string, opts: { staff?: boolean; email?: string | null } = {}): Promise<string> {
  const [p] = await db
    .insert(people)
    .values({
      keycloakSub: `sub-${name}`,
      username: name,
      displayName: name,
      email: opts.email === undefined ? `${name}@example.org` : opts.email,
      lastSeenStaff: opts.staff ?? false,
    })
    .returning()
  return p!.id
}

const enable = (db: Db, on: Partial<{ emailEnabled: boolean; lineEnabled: boolean; telegramEnabled: boolean }>) =>
  db.update(notificationChannelSettings).set(on).where(eq(notificationChannelSettings.id, 1))

let db: Db
let mail: ReturnType<typeof fakeTransport>
let deps: AppDeps
let warn: ReturnType<typeof vi.spyOn>

beforeEach(async () => {
  db = await testDb()
  await resetDb(db)
  mail = fakeTransport()
  const base = await testDeps()
  deps = await testDeps({ config: { ...base.config, ...SMTP }, mailTransport: mail.transport, jobs: new InlineJobQueue() })
  warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
})
afterEach(() => warn.mockRestore())

const drain = () => (deps.jobs as InlineJobQueue).drain()

async function assignTask(personId: string, taskId = crypto.randomUUID()) {
  await runWork(deps, { id: null, kind: 'system' }, (ctx) =>
    notifyTaskAssigned(ctx, { taskId, workItemId: crypto.randomUUID(), role: 'DEV', personId, taskTitle: 'แก้รายงาน' }),
  )
  await drain()
  const [n] = await db.select().from(notifications).where(eq(notifications.personId, personId))
  return n!
}

describe('channelsFor', () => {
  it('excludes email without SMTP config, and when an admin has not enabled it', async () => {
    const dev = await person(db, 'dev', { staff: true })
    const bare = await testDeps()
    await enable(db, { emailEnabled: true })
    expect(await channelsFor(db, bare.config, dev, 'task_assigned')).toEqual([])
    expect(await channelsFor(db, deps.config, dev, 'task_assigned')).toEqual(['email'])
    await enable(db, { emailEnabled: false })
    expect(await channelsFor(db, deps.config, dev, 'task_assigned')).toEqual([])
  })

  it('follows role defaults, the person’s choice, and needs an email address', async () => {
    await enable(db, { emailEnabled: true })
    const dev = await person(db, 'dev', { staff: true })
    const req = await person(db, 'req')
    const noMail = await person(db, 'nomail', { staff: true, email: null })
    expect(await channelsFor(db, deps.config, dev, 'work_item_stuck')).toEqual([])
    expect(await channelsFor(db, deps.config, req, 'request_update')).toEqual(['email'])
    expect(await channelsFor(db, deps.config, req, 'task_assigned')).toEqual([])
    expect(await channelsFor(db, deps.config, noMail, 'task_assigned')).toEqual([])
    await db.insert(notificationPrefs).values({ personId: dev, kinds: { task_assigned: [], work_item_stuck: ['email'] } })
    expect(await channelsFor(db, deps.config, dev, 'task_assigned')).toEqual([])
    expect(await channelsFor(db, deps.config, dev, 'work_item_stuck')).toEqual(['email'])
  })
})

describe('email delivery', () => {
  beforeEach(() => enable(db, { emailEnabled: true }))

  it('default staff prefs: a task_assigned email goes out with an absolute link', async () => {
    const dev = await person(db, 'dev', { staff: true })
    const n = await assignTask(dev)
    expect(mail.sent).toHaveLength(1)
    const m = mail.sent[0]!
    expect(m).toMatchObject({ to: 'dev@example.org', from: SMTP.mailFrom, subject: n.title })
    expect(m.text).toContain(`http://localhost:3000${n.link}`)
    const rows = await db.select().from(notificationDeliveries)
    expect(rows).toMatchObject([{ notificationId: n.id, channel: 'email', state: 'sent', errorCode: null }])
  })

  it('a requester’s request_update holds only the notification text, link and settings footer', async () => {
    const req = await person(db, 'req')
    await runWork(deps, { id: null, kind: 'system' }, (ctx) =>
      notify(ctx, { personId: req, kind: 'request_update', title: 'คำขอของคุณเสร็จสมบูรณ์แล้ว', body: 'ขอรายงาน', link: '/requests', dedupeKey: 'r1' }),
    )
    await drain()
    expect(mail.sent).toHaveLength(1)
    expect(mail.sent[0]!.subject).toBe('คำขอของคุณเสร็จสมบูรณ์แล้ว')
    expect(mail.sent[0]!.text).toBe(
      [
        'คำขอของคุณเสร็จสมบูรณ์แล้ว',
        '',
        'ขอรายงาน',
        '',
        'http://localhost:3000/requests',
        '',
        '--',
        'เปลี่ยนการแจ้งเตือนได้ที่ http://localhost:3000/settings/notifications',
        'Change your notification settings at http://localhost:3000/settings/notifications',
      ].join('\n'),
    )
  })

  it('no job when no channel applies (kind off by default)', async () => {
    const dev = await person(db, 'dev', { staff: true })
    const send = vi.spyOn(deps.jobs, 'send')
    await runWork(deps, { id: null, kind: 'system' }, (ctx) =>
      notify(ctx, { personId: dev, kind: 'work_item_stuck', title: 't', body: '', link: null, dedupeKey: null }),
    )
    expect(send).not.toHaveBeenCalled()
  })

  it('a transient failure retries 3 times, then the row is failed with a code; logs carry no secret or address', async () => {
    const dev = await person(db, 'dev', { staff: true })
    mail.state.fail = 3
    mail.state.err = Object.assign(new Error(`connect ECONNREFUSED as yoda:${SMTP.smtpPassword} for dev@example.org`), { code: 'ECONNECTION' })
    const n = await assignTask(dev)
    expect(mail.sent).toHaveLength(0)
    const [row] = await db.select().from(notificationDeliveries)
    expect(row).toMatchObject({ notificationId: n.id, channel: 'email', state: 'failed', errorCode: 'ECONNECTION' })
    const logged = JSON.stringify(warn.mock.calls)
    expect(warn).toHaveBeenCalled()
    expect(logged).toContain('ECONNECTION')
    expect(logged).not.toContain(SMTP.smtpPassword)
    expect(logged).not.toContain('dev@example.org')
    // The portal notification is unaffected.
    expect(n.readAt).toBeNull()
  })

  it('a transient failure that recovers on retry sends once', async () => {
    const dev = await person(db, 'dev', { staff: true })
    mail.state.fail = 1
    mail.state.err = Object.assign(new Error('timeout'), { code: 'ETIMEDOUT' })
    await assignTask(dev)
    expect(mail.sent).toHaveLength(1)
    expect(await db.select().from(notificationDeliveries)).toMatchObject([{ state: 'sent', errorCode: null }])
  })

  it('a permanent failure (recipient rejected) is not retried', async () => {
    const dev = await person(db, 'dev', { staff: true })
    mail.state.fail = 3
    mail.state.err = Object.assign(new Error('550 mailbox unavailable'), { code: 'EENVELOPE', responseCode: 550 })
    await assignTask(dev)
    expect(mail.state.fail).toBe(2)
    expect(await db.select().from(notificationDeliveries)).toMatchObject([{ state: 'failed', errorCode: 'EENVELOPE' }])
  })

  it('a permanent failure is never retried, even when the job runs again', async () => {
    const dev = await person(db, 'dev', { staff: true })
    mail.state.fail = 3
    mail.state.err = Object.assign(new Error('535 auth failed'), { code: 'EAUTH', responseCode: 535 })
    const n = await assignTask(dev)
    expect(mail.state.fail).toBe(2)
    // Another channel failing transiently re-runs the job: the permanently failed channel stays settled.
    await deliver(deps, n.id)
    expect(mail.state.fail).toBe(2)
    expect(await db.select().from(notificationDeliveries)).toMatchObject([{ state: 'failed', errorCode: 'EAUTH', permanent: true }])
  })

  it('a sent row is never downgraded by an overlapping failed run', async () => {
    const dev = await person(db, 'dev', { staff: true })
    const n = await assignTask(dev)
    // An overlapping, slower run that failed must not overwrite the delivered row.
    await recordDelivery(db, n.id, 'email', { state: 'failed', errorCode: 'ETIMEDOUT' })
    expect(await db.select().from(notificationDeliveries)).toMatchObject([{ state: 'sent', errorCode: null, permanent: false }])
  })

  it('the job running twice sends one email', async () => {
    const dev = await person(db, 'dev', { staff: true })
    const n = await assignTask(dev)
    await deliver(deps, n.id)
    await deliver(deps, n.id)
    expect(mail.sent).toHaveLength(1)
  })
})

describe('preference and channel routes', () => {
  let app: FastifyInstance
  let boss: Who
  let staff: Who
  let requester: Who

  beforeEach(async () => {
    app = await buildApp({ ...deps, config: { ...deps.config, bootstrapAdmins: ['boss'] } })
    boss = await login(app, 'boss')
    staff = await login(app, 'dev', { staff: true })
    requester = await login(app, 'req')
  })
  afterEach(() => app.close())

  const put = (who: Who, payload: unknown) =>
    app.inject({ method: 'PUT', url: '/me/notification-prefs', headers: auth(who), payload: payload as object })
  const patch = (who: Who, payload: unknown) =>
    app.inject({ method: 'PATCH', url: '/admin/notification-channels', headers: auth(who), payload: payload as object })

  it('GET returns the effective defaults, the kinds the person may choose and their channels', async () => {
    await enable(db, { emailEnabled: true })
    const s = (await app.inject({ url: '/me/notification-prefs', headers: auth(staff) })).json()
    expect(s.kinds).toContain('budget_alert')
    expect(s.prefs.kinds.task_assigned).toEqual(['email'])
    expect(s.prefs.kinds.work_item_stuck).toEqual([])
    expect(s.channels).toEqual({ available: ['email'], linked: { email: false, line: false, telegram: false } })
    const r = (await app.inject({ url: '/me/notification-prefs', headers: auth(requester) })).json()
    expect(r.kinds).toEqual(['request_update', 'secretary_message'])
    expect(r.prefs.kinds).toEqual({ request_update: ['email'], secretary_message: [] })
  })

  it('PUT stores the choice; an unknown kind or channel is 422', async () => {
    const ok = await put(staff, { kinds: { task_assigned: [], discussion: ['email'] } })
    expect(ok.statusCode).toBe(200)
    expect(ok.json().prefs.kinds).toMatchObject({ task_assigned: [], discussion: ['email'], proposal_pending: ['email'] })
    const [row] = await db.select().from(notificationPrefs).where(eq(notificationPrefs.personId, staff.id))
    expect(row!.kinds).toEqual({ task_assigned: [], discussion: ['email'] })
    for (const payload of [{ kinds: { nope: ['email'] } }, { kinds: { task_assigned: ['sms'] } }, { kinds: 'x' }, {}]) {
      expect((await put(staff, payload)).statusCode).toBe(422)
    }
  })

  it('requesters may only choose for request_update and secretary_message', async () => {
    expect((await put(requester, { kinds: { request_update: [], secretary_message: ['email'] } })).statusCode).toBe(200)
    expect((await put(requester, { kinds: { task_assigned: ['email'] } })).statusCode).toBe(422)
  })

  it('admin reads channel status and enables a configured channel; an unconfigured one is 422', async () => {
    const get = await app.inject({ url: '/admin/notification-channels', headers: auth(boss) })
    expect(get.statusCode).toBe(200)
    expect(get.json()).toEqual([
      { name: 'email', configured: true, enabled: false },
      { name: 'line', configured: false, enabled: false },
      { name: 'telegram', configured: false, enabled: false },
    ])
    const on = await patch(boss, { email: true })
    expect(on.statusCode).toBe(200)
    expect(on.json()[0]).toEqual({ name: 'email', configured: true, enabled: true })
    expect((await patch(boss, { line: true })).statusCode).toBe(422)
    expect((await patch(boss, { telegram: false })).statusCode).toBe(200)
    const [row] = await db.select().from(notificationChannelSettings)
    expect(row).toMatchObject({ emailEnabled: true, lineEnabled: false, updatedBy: boss.id })
    expect(JSON.stringify(get.json())).not.toContain(SMTP.smtpPassword)
  })

  it('a non-admin PATCH is 403', async () => {
    for (const who of [staff, requester]) {
      expect((await patch(who, { email: true })).statusCode).toBe(403)
      expect((await app.inject({ url: '/admin/notification-channels', headers: auth(who) })).statusCode).toBe(403)
    }
    const [row] = await db.select().from(notificationChannelSettings)
    expect(row!.emailEnabled).toBe(false)
  })
})
