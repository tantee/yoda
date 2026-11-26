import { describe, expect, it } from 'vitest'
import AiDraft from '../app/components/AiDraft.vue'
import EmptyState from '../app/components/EmptyState.vue'
import ErrorState from '../app/components/ErrorState.vue'
import PageHeader from '../app/components/PageHeader.vue'
import PriorityMark from '../app/components/PriorityMark.vue'
import StatusChip from '../app/components/StatusChip.vue'
import StepTrack from '../app/components/StepTrack.vue'
import { errorKind } from '../app/utils/stateView'
import { stepProgress } from '../app/utils/steps'
import { render } from './support/render'

const count = (html: string, needle: string) => html.split(needle).length - 1
const steps = (statuses: ('done' | 'current' | 'pending')[]) =>
  statuses.map((status, i) => ({ key: `s${i}`, name: { th: `ขั้น ${i + 1}`, en: `Step ${i + 1}` }, status }))

describe('StatusChip', () => {
  it('renders the mapped label with its tone and the value as data', async () => {
    const html = await render(StatusChip, { kind: 'task', value: 'submitted' })
    expect(html).toContain('chip.task.submitted')
    expect(html).toContain('status-chip--warning')
    expect(html).toContain('data-value="submitted"')
    expect(html).toContain('status-chip__dot')
  })
  it('uses an icon or a spinner where the mapping says so', async () => {
    expect(await render(StatusChip, { kind: 'request', value: 'waiting_for_you' })).toContain('mdi-hand-wave-outline')
    expect(await render(StatusChip, { kind: 'run', value: 'running' })).toContain('v-progress-circular')
  })
  it('renders the plain requester label in requester views', async () => {
    const html = await render(StatusChip, { kind: 'task', value: 'open', audience: 'requester' })
    expect(html).toContain('chip.requesterTask.open')
    expect(html).not.toContain('chip.task.open')
  })
  it('takes a label override and keeps the full text as a title for ellipsis', async () => {
    const long = 'ซิงก์ไม่สำเร็จ: ไม่พบโปรเจกต์ที่ระบุใน GitLab กรุณาตรวจสอบสิทธิ์'
    const html = await render(StatusChip, { kind: 'sync', value: 'failed', label: long })
    expect(html).toContain(long)
    expect(html).toContain(`title="${long}"`)
    expect(html).not.toContain('chip.sync.failed')
  })
})

describe('PriorityMark', () => {
  it('shows the glyph and word', async () => {
    const html = await render(PriorityMark, { priority: 'urgent' })
    expect(html).toContain('mdi-chevron-double-up')
    expect(html).toContain('priority.urgent')
    expect(html).toContain('text-error')
  })
})

describe('stepProgress', () => {
  it('counts the current step 1-based', () => {
    expect(stepProgress(steps(['done', 'done', 'done', 'current', 'pending', 'pending']))).toEqual({ n: 4, total: 6, index: 3 })
  })
  it('treats all done as finished and none started as step 1', () => {
    expect(stepProgress(steps(['done', 'done']))).toEqual({ n: 2, total: 2, index: -1 })
    expect(stepProgress(steps(['pending', 'pending']))).toEqual({ n: 0, total: 2, index: -1 })
    expect(stepProgress([])).toEqual({ n: 0, total: 0, index: -1 })
  })
})

describe('StepTrack', () => {
  it('renders one segment per step, styled by status, with a text label', async () => {
    const html = await render(StepTrack, { steps: steps(['done', 'done', 'done', 'current', 'pending', 'pending']) })
    expect(count(html, 'step-track__seg ')).toBe(6)
    expect(count(html, 'step-track__seg--done')).toBe(3)
    expect(count(html, 'step-track__seg--current')).toBe(1)
    expect(count(html, 'step-track__seg--pending')).toBe(2)
    expect(html).toContain('aria-current="step"')
    expect(html).toContain('stepTrack.short(n=4,total=6,name=ขั้น 4)')
  })
  it('renders fewer segments for shorter templates', async () => {
    const html = await render(StepTrack, { steps: steps(['current', 'pending', 'pending']) })
    expect(count(html, 'step-track__seg ')).toBe(3)
  })
  it('uses the plain-language label when asked, with the requester glossary for known steps', async () => {
    const html = await render(StepTrack, { steps: steps(['done', 'current', 'pending']), plain: true })
    expect(html).toMatch(/<b[^>]*>ขั้น 2<\/b>\s*stepTrack\.plain\(n=2,total=3\)/)
    const known = steps(['done', 'done', 'done', 'current', 'pending', 'pending']).map((s, i) => ({ ...s, key: ['intake', 'ba', 'sa', 'dev', 'qc', 'close'][i]! }))
    const plain = await render(StepTrack, { steps: known, plain: true })
    expect(plain).toMatch(/<b[^>]*>requests\.step\.dev<\/b>\s*stepTrack\.plain\(n=4,total=6\)/)
    expect(plain).toContain('aria-label="requests.step.dev stepTrack.plain(n=4,total=6)"')
  })
})

describe('EmptyState', () => {
  it('shows the title, text, optional secondary line and actions', async () => {
    const html = await render(EmptyState, { title: 'ไม่มีงานรอคุณ', text: 'งานใหม่จะมาที่นี่', secondary: 'Quiet, the inbox is.' }, { default: '<button>go</button>' })
    expect(html).toContain('ไม่มีงานรอคุณ')
    expect(html).toContain('งานใหม่จะมาที่นี่')
    expect(html).toContain('Quiet, the inbox is.')
    expect(html).toContain('<button>go</button>')
  })
  it('omits the secondary line when not given', async () => {
    expect(await render(EmptyState, { title: 'x' })).not.toContain('empty-state__secondary')
  })
})

describe('errorKind / ErrorState', () => {
  it('tells network failures from server errors', () => {
    expect(errorKind({ statusCode: 500 })).toEqual({ kind: 'server', status: 500 })
    expect(errorKind(new TypeError('Failed to fetch'))).toEqual({ kind: 'network', status: null })
    expect(errorKind({ statusCode: 404 })).toEqual({ kind: 'other', status: 404 })
  })
  it('renders the server message and a retry button', async () => {
    const html = await render(ErrorState, { error: { statusCode: 502 } })
    expect(html).toContain('stateView.errorTitle')
    expect(html).toContain('stateView.errorServer(status=502)')
    expect(html).toContain('stateView.retry')
  })
})

describe('AiDraft', () => {
  it('labels the block, flags low confidence and lists missing points', async () => {
    const html = await render(AiDraft, { confidence: 'low', missing: ['จำนวนผู้ใช้', 'วันเริ่มใช้งาน'] }, { default: '<p>body</p>' })
    expect(html).toContain('aiDraft.label')
    expect(html).toContain('chip.aiDraft.low')
    expect(html).toContain('จำนวนผู้ใช้')
    expect(html).toContain('<p>body</p>')
  })
  it('shows provenance after a person edits and no warning without gaps', async () => {
    const html = await render(AiDraft, { editedBy: 'วราภรณ์' })
    expect(html).toContain('aiDraft.editedBy(name=วราภรณ์)')
    expect(html).not.toContain('ai-draft__missing')
    expect(html).not.toContain('chip.aiDraft.low')
  })
})

describe('PageHeader', () => {
  it('renders the title as the page heading with meta, actions and tabs slots', async () => {
    const html = await render(PageHeader, { title: 'แจ้งเตือนนัดผ่าน SMS' }, { meta: 'META', actions: 'ACTIONS', tabs: 'TABS', context: 'CTX' })
    expect(html).toMatch(/<h1[^>]*>\s*แจ้งเตือนนัดผ่าน SMS/)
    for (const s of ['META', 'ACTIONS', 'TABS', 'CTX']) expect(html).toContain(s)
  })
})
