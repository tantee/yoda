import { describe, expect, it } from 'vitest'
import type { PersonLoad, ProjectListItem, ProjectStatusSummary, WorkflowTemplateSummary, WorkItem } from '@yoda/shared'
import {
  filterWorkItems,
  formatWeekRange,
  isoWeekRange,
  itemSteps,
  knowledgePreview,
  loadBars,
  pageCount,
  projectRows,
  workItemFilterOptions,
} from '../app/utils/projects'

const project = (over: Partial<ProjectListItem>): ProjectListItem => ({
  id: crypto.randomUUID(),
  name: 'P',
  description: '',
  status: 'active',
  noAi: false,
  autonomy: 'propose',
  aiBudgetUsd: null,
  createdAt: '2026-11-01T00:00:00Z',
  pmNames: [],
  memberCount: 0,
  lastActivityAt: null,
  ...over,
})

const summary = (projectId: string, over: Partial<ProjectStatusSummary> = {}): ProjectStatusSummary => ({
  projectId,
  name: 'P',
  health: 'on_track',
  reasons: [],
  activeItems: 0,
  overdueItems: 0,
  openDiscussions: 0,
  countsByStep: {},
  stepNames: {},
  aiSpendUsd: 0,
  aiBudgetUsd: null,
  ...over,
})

describe('projectRows', () => {
  it('joins status summaries by id and splits active from archived', () => {
    const a = project({ name: 'ข', status: 'active' })
    const b = project({ name: 'ก', status: 'active' })
    const c = project({ name: 'ค', status: 'archived' })
    const rows = projectRows([a, b, c], [summary(a.id, { health: 'at_risk', activeItems: 3, overdueItems: 1 })])
    expect(rows.active.map(r => r.project.id)).toEqual([a.id, b.id])
    expect(rows.archived.map(r => r.project.id)).toEqual([c.id])
    expect(rows.active[0]!.status).toMatchObject({ health: 'at_risk', activeItems: 3, overdueItems: 1 })
    expect(rows.active[1]!.status).toBeNull()
  })
})

const tpl: WorkflowTemplateSummary = {
  key: 'feature',
  version: 2,
  name: { th: 'ฟีเจอร์', en: 'Feature' },
  steps: [
    { key: 'intake', name: { th: 'รับเรื่อง', en: 'Intake' } },
    { key: 'dev', name: { th: 'พัฒนา', en: 'Dev' } },
    { key: 'close', name: { th: 'ปิดงาน', en: 'Close' } },
  ],
}
const tplOld: WorkflowTemplateSummary = { ...tpl, version: 1, steps: [{ key: 'intake', name: { th: 'รับ', en: 'In' } }] }

const item = (over: Partial<WorkItem>): WorkItem => ({
  id: crypto.randomUUID(),
  projectId: 'p',
  title: 'งาน',
  description: '',
  templateKey: 'feature',
  templateVersion: 2,
  currentStepKey: 'dev',
  priority: 'normal',
  targetDate: null,
  ownerId: 'o1',
  ownerName: 'สมชาย',
  requesterId: null,
  requesterName: null,
  state: 'active',
  awaitingAdvance: false,
  openDiscussions: 0,
  createdAt: '2026-11-01T00:00:00Z',
  updatedAt: '2026-11-01T00:00:00Z',
  ...over,
})

describe('itemSteps', () => {
  it('uses the item template version and marks done / current / pending', () => {
    expect(itemSteps([tplOld, tpl], item({})).map(s => s.status)).toEqual(['done', 'current', 'pending'])
    expect(itemSteps([tplOld, tpl], item({ templateVersion: 1, currentStepKey: 'intake' })).map(s => s.key)).toEqual(['intake'])
  })
  it('marks every step done for a done item and returns nothing for an unknown template', () => {
    expect(itemSteps([tpl], item({ state: 'done', currentStepKey: null })).map(s => s.status)).toEqual(['done', 'done', 'done'])
    expect(itemSteps([tpl], item({ templateKey: 'x' }))).toEqual([])
  })
})

describe('filterWorkItems', () => {
  const today = '2026-11-26'
  const items = [
    item({ title: 'แจ้งเตือน SMS', priority: 'urgent', targetDate: '2026-11-20', ownerId: 'a' }),
    item({ title: 'รายงานแล็บ', priority: 'low', currentStepKey: 'intake', ownerId: 'b' }),
    item({ title: 'ปิดแล้ว', state: 'done', currentStepKey: null, targetDate: '2026-11-01' }),
    item({ title: 'ยกเลิก', state: 'cancelled' }),
  ]
  const titles = (f: Parameters<typeof filterWorkItems>[1]) => filterWorkItems(items, f, today).map(w => w.title)

  it('defaults to active items only, most urgent first', () => {
    expect(titles({})).toEqual(['แจ้งเตือน SMS', 'รายงานแล็บ'])
  })
  it('filters by state, step, priority, owner, overdue and search text', () => {
    expect(titles({ state: 'all' })).toHaveLength(4)
    expect(titles({ state: 'done' })).toEqual(['ปิดแล้ว'])
    expect(titles({ step: 'intake' })).toEqual(['รายงานแล็บ'])
    expect(titles({ priority: 'urgent' })).toEqual(['แจ้งเตือน SMS'])
    expect(titles({ ownerId: 'b' })).toEqual(['รายงานแล็บ'])
    expect(titles({ overdue: true })).toEqual(['แจ้งเตือน SMS'])
    // A done item past its date is not overdue.
    expect(titles({ state: 'all', overdue: true })).toEqual(['แจ้งเตือน SMS'])
    expect(titles({ q: ' sms ' })).toEqual(['แจ้งเตือน SMS'])
  })
  it('lists owners and steps for the filter menus', () => {
    const opts = workItemFilterOptions(items, [tpl])
    expect(opts.owners.map(o => o.id).sort()).toEqual(['a', 'b', 'o1'].sort())
    expect(opts.steps.map(s => s.key)).toEqual(['intake', 'dev', 'close'])
  })
})

describe('isoWeekRange / formatWeekRange', () => {
  it('gives Monday to Sunday of an ISO week', () => {
    expect(isoWeekRange('2026-W48')).toEqual({ start: '2026-11-23', end: '2026-11-29' })
    expect(isoWeekRange('2026-W01')).toEqual({ start: '2025-12-29', end: '2026-01-04' })
    expect(isoWeekRange('bad')).toBeNull()
  })
  it('formats the range in Thai (BE) and English', () => {
    expect(formatWeekRange('2026-W48', 'th')).toBe('23–29 พ.ย. 2569')
    expect(formatWeekRange('2026-W48', 'en')).toBe('23–29 Nov 2026')
    expect(formatWeekRange('2026-W49', 'th')).toBe('30 พ.ย. – 6 ธ.ค. 2569')
    expect(formatWeekRange('2026-W01', 'en')).toBe('29 Dec 2025 – 4 Jan 2026')
  })
})

describe('loadBars', () => {
  const p = (name: string, openTasks: number): PersonLoad => ({ personId: name, name, roles: [], openTasks, inProgressTasks: 0, todayAssigned: 0 })
  it('scales to the busiest person and flags heavy loads', () => {
    const bars = loadBars([p('a', 5), p('b', 2), p('c', 0)])
    expect(bars.map(b => b.percent)).toEqual([100, 40, 0])
    expect(bars.map(b => b.heavy)).toEqual([true, false, false])
  })
  it('handles nobody having work', () => {
    expect(loadBars([p('a', 0)]).map(b => b.percent)).toEqual([0])
  })
})

describe('knowledge helpers', () => {
  it('strips Markdown into a one-line preview', () => {
    expect(knowledgePreview('# หัวข้อ\n\n- **ข้อ** หนึ่ง [ลิงก์](http://example.org)\n`code`', 200)).toBe('หัวข้อ ข้อ หนึ่ง ลิงก์ code')
    expect(knowledgePreview('a'.repeat(10), 4)).toBe('aaaa…')
  })
  it('counts pages', () => {
    expect(pageCount(0, 10)).toBe(1)
    expect(pageCount(10, 10)).toBe(1)
    expect(pageCount(11, 10)).toBe(2)
  })
})
