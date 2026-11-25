import { describe, expect, it } from 'vitest'
import type { Proposal, TaskWithContext, Todo, TodoWorkItem, WorkItem } from '@yoda/shared'
import {
  byPriority,
  filterTodo,
  priorityChange,
  stepChange,
  taskCrumbs,
  todoCounts,
  todoProjects,
  visibleRows,
  waitingOf,
} from '../app/utils/todo'

const task = (over: Partial<TaskWithContext>): TaskWithContext =>
  ({
    id: 't',
    workItemId: 'w1',
    projectId: 'p1',
    projectName: 'ระบบนัด',
    workItemPriority: 'normal',
    executor: 'human',
    state: 'open',
    assigneeId: null,
    proposedAssigneeId: null,
    proposedAssigneeName: null,
    aiStatus: null,
    capability: null,
    createdAt: '2026-11-20T00:00:00Z',
    viewerIsRequester: false,
    ...over,
  }) as TaskWithContext

const proposal = (over: Partial<Proposal>): Proposal =>
  ({ id: 'pr', kind: 'step_advance', projectId: 'p1', workItemId: 'w1', summary: '', reason: '', payload: {}, ...over }) as Proposal

const item = (over: Partial<WorkItem>): WorkItem => ({ id: 'w3', projectId: 'p2', title: 'x', ...over }) as WorkItem

const ctx = (over: Partial<TodoWorkItem>): TodoWorkItem =>
  ({ id: 'w1', title: 'นัดผ่าน LINE', projectId: 'p1', projectName: 'ระบบนัด', priority: 'normal', targetDate: null, steps: [], ...over })

const todo = (over: Partial<Todo> = {}): Todo => ({
  tasks: [task({ id: 'm1', projectId: 'p1' })],
  confirmations: [task({ id: 'c1', projectId: 'p1' }), task({ id: 'c2', projectId: 'p2', projectName: 'Data Warehouse' })],
  proposals: [proposal({ id: 'pr1', projectId: 'p1' }), proposal({ id: 'pr2', projectId: null, workItemId: null, kind: 'create_work_item' })],
  awaitingAdvance: [item({ id: 'w3', projectId: 'p2' })],
  workItems: {},
  projectNames: { p1: 'ระบบนัด', p2: 'Data Warehouse' },
  ...over,
})

describe('todoCounts', () => {
  it('counts decisions (proposals + items to advance), confirmations and my tasks', () => {
    expect(todoCounts(todo(), null)).toEqual({ all: 6, decisions: 3, confirmations: 2, mine: 1 })
  })
  it('counts only rows of the chosen project; project-less proposals drop out', () => {
    expect(todoCounts(todo(), 'p2')).toEqual({ all: 2, decisions: 1, confirmations: 1, mine: 0 })
  })
})

describe('filterTodo', () => {
  it('shows every section on the "all" tab', () => {
    const v = filterTodo(todo(), { tab: 'all', projectId: null })
    expect(v.decisions.map(d => (d.type === 'advance' ? d.item.id : d.proposal.id))).toEqual(['w3', 'pr1', 'pr2'])
    expect(v.confirmations.map(t => t.id)).toEqual(['c1', 'c2'])
    expect(v.mine.map(t => t.id)).toEqual(['m1'])
  })
  it('a tab keeps only its section', () => {
    const v = filterTodo(todo(), { tab: 'confirmations', projectId: null })
    expect(v.decisions).toEqual([])
    expect(v.mine).toEqual([])
    expect(v.confirmations).toHaveLength(2)
    expect(filterTodo(todo(), { tab: 'mine', projectId: null }).confirmations).toEqual([])
  })
  it('filters by project', () => {
    const v = filterTodo(todo(), { tab: 'all', projectId: 'p1' })
    expect(v.decisions.map(d => (d.type === 'advance' ? d.item.id : d.proposal.id))).toEqual(['pr1'])
    expect(v.confirmations.map(t => t.id)).toEqual(['c1'])
  })
})

describe('byPriority', () => {
  it('sorts by priority, then by waiting time (oldest first), stable otherwise', () => {
    const rows = [
      task({ id: 'n-new', workItemPriority: 'normal', createdAt: '2026-11-22T00:00:00Z' }),
      task({ id: 'u', workItemPriority: 'urgent', createdAt: '2026-11-23T00:00:00Z' }),
      task({ id: 'n-old', workItemPriority: 'normal', createdAt: '2026-11-21T00:00:00Z' }),
      task({ id: 'l', workItemPriority: 'low' }),
      task({ id: 'h', workItemPriority: 'high' }),
    ]
    expect(byPriority(rows).map(t => t.id)).toEqual(['u', 'h', 'n-old', 'n-new', 'l'])
    expect(rows[0]!.id).toBe('n-new') // not mutated
  })
})

describe('waitingOf', () => {
  it('names what a confirmation waits for', () => {
    expect(waitingOf(task({ executor: 'ai', aiStatus: 'drafting' }))).toBe('drafting')
    expect(waitingOf(task({ executor: 'ai', aiStatus: 'failed' }))).toBe('failed')
    expect(waitingOf(task({ executor: 'ai', capability: 'code-change' }))).toBe('runner')
    expect(waitingOf(task({ executor: 'ai', capability: null }))).toBe('ai')
    expect(waitingOf(task({ state: 'proposed', proposedAssigneeId: 'x', proposedAssigneeName: 'ธนกร' }))).toBe('proposed')
    expect(waitingOf(task({}))).toBe('assignee')
  })
})

describe('stepChange', () => {
  const steps = [
    { key: 'intake', name: { th: 'รับเรื่อง', en: 'Intake' }, status: 'done' as const },
    { key: 'analysis', name: { th: 'วิเคราะห์', en: 'Analysis' }, status: 'pending' as const },
  ]
  it('reads fromStep/toStep from the payload and names them from the item steps', () => {
    expect(stepChange(proposal({ payload: { fromStep: 'intake', toStep: 'analysis' } }), ctx({ steps }))).toEqual({
      from: steps[0]!.name,
      to: steps[1]!.name,
    })
  })
  it('is null without the payload keys or the item', () => {
    expect(stepChange(proposal({ payload: {} }), ctx({ steps }))).toBeNull()
    expect(stepChange(proposal({ payload: { fromStep: 'intake', toStep: 'analysis' } }), undefined)).toBeNull()
  })
})

describe('priorityChange', () => {
  it('pairs the item priority with the proposed one', () => {
    expect(priorityChange(proposal({ kind: 'priority_change', payload: { priority: 'high' } }), ctx({ priority: 'normal' }))).toEqual({
      from: 'normal',
      to: 'high',
    })
    expect(priorityChange(proposal({ kind: 'priority_change', payload: { priority: 'bogus' } }), ctx({}))).toBeNull()
    expect(priorityChange(proposal({ kind: 'priority_change', payload: { priority: 'high' } }), undefined)).toEqual({ from: null, to: 'high' })
  })
})

describe('todoProjects', () => {
  it('lists the projects of the rows, by name (Thai collation)', () => {
    expect(todoProjects(todo({ projectNames: { p1: 'ระบบนัด', p2: 'ข้อมูลกลาง' } }))).toEqual([
      { id: 'p2', name: 'ข้อมูลกลาง' },
      { id: 'p1', name: 'ระบบนัด' },
    ])
  })
  it('falls back to task project names', () => {
    expect(todoProjects(todo({ projectNames: {} })).map(p => p.id).sort()).toEqual(['p1', 'p2'])
  })
})

describe('visibleRows', () => {
  it('shows the first rows until expanded', () => {
    const rows = Array.from({ length: 10 }, (_, i) => i)
    expect(visibleRows(rows, false, 8)).toEqual([0, 1, 2, 3, 4, 5, 6, 7])
    expect(visibleRows(rows, true, 8)).toHaveLength(10)
    expect(visibleRows(rows.slice(0, 9), false, 8)).toHaveLength(8)
  })
})

describe('taskCrumbs', () => {
  const tk = { projectId: 'p1', projectName: 'ระบบนัด', workItemId: 'w1', workItemTitle: 'นัดผ่าน LINE', title: 'ตรวจโค้ด' }
  const t = (k: string) => `[${k}]`
  it('staff: projects › project › work item › task', () => {
    expect(taskCrumbs(tk, { requesterView: false, isStaff: true }, t)).toEqual([
      { label: '[nav.projects]', to: '/projects' },
      { label: 'ระบบนัด', to: '/projects/p1' },
      { label: 'นัดผ่าน LINE', to: '/work-items/w1' },
      { label: 'ตรวจโค้ด' },
    ])
  })
  it('requesters go back to their request, never to the project', () => {
    const c = taskCrumbs(tk, { requesterView: true, isStaff: false }, t)
    expect(c).toEqual([
      { label: '[nav.requests]', to: '/requests' },
      { label: 'นัดผ่าน LINE', to: '/requests/w1' },
      { label: 'ตรวจโค้ด' },
    ])
    expect(JSON.stringify(c)).not.toContain('ระบบนัด')
  })
  it('staff in the requester view go back to their to-do', () => {
    expect(taskCrumbs(tk, { requesterView: true, isStaff: true }, t)).toEqual([{ label: '[nav.todo]', to: '/todo' }, { label: 'ตรวจโค้ด' }])
  })
})
