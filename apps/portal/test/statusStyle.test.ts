import { readFileSync } from 'node:fs'
import {
  AgentRunState,
  DiscussionState,
  Health,
  IssueSyncStatus,
  KnowledgeStatus,
  MergeRequestState,
  PipelineStatus,
  Priority,
  ProposalState,
  RequestStatus,
  TaskState,
  TaskType,
  WorkItemState,
} from '@yoda/shared'
import { describe, expect, it } from 'vitest'
import { PRIORITY_STYLE, STATUS_STYLES, STATUS_TONES, priorityStyle, statusStyle, type StatusKind } from '../app/utils/statusStyle'

/** Every status domain and the full set of values it can take (shared zod enums where they exist). */
const DOMAINS: Record<StatusKind, readonly string[]> = {
  workItem: WorkItemState.options,
  task: TaskState.options,
  taskType: TaskType.options,
  step: ['done', 'current', 'pending'],
  request: RequestStatus.options,
  health: Health.options,
  aiStatus: ['drafting', 'failed'],
  aiDraft: ['low', 'normal'],
  waiting: ['runner', 'ai'],
  run: AgentRunState.options,
  runner: ['active', 'paused', 'revoked'],
  sync: IssueSyncStatus.options,
  pipeline: PipelineStatus.options,
  mr: MergeRequestState.options,
  discussion: DiscussionState.options,
  brief: ['pending', 'ready', 'failed'],
  proposal: ProposalState.options,
  knowledge: KnowledgeStatus.options,
  project: ['active', 'archived'],
  yesNo: ['yes', 'no'],
}

function lookup(o: Record<string, unknown>, key: string): unknown {
  return key.split('.').reduce<unknown>((acc, k) => (acc && typeof acc === 'object' ? (acc as Record<string, unknown>)[k] : undefined), o)
}
const load = (f: string) => JSON.parse(readFileSync(new URL(`../i18n/locales/${f}`, import.meta.url), 'utf8'))
const th = load('th.json')
const en = load('en.json')

describe('statusStyle mapping', () => {
  it('has exactly the known domains', () => {
    expect(Object.keys(STATUS_STYLES).sort()).toEqual(Object.keys(DOMAINS).sort())
  })

  for (const [kind, values] of Object.entries(DOMAINS) as [StatusKind, readonly string[]][]) {
    it(`covers every ${kind} value with a tone, a marker and a translated label`, () => {
      expect(Object.keys(STATUS_STYLES[kind]).sort()).toEqual([...values].sort())
      for (const v of values) {
        const s = statusStyle(kind, v)
        expect(STATUS_TONES).toContain(s.tone)
        expect(s.labelKey).toBe(`chip.${kind}.${v}`)
        expect(typeof lookup(th, s.labelKey), `th ${s.labelKey}`).toBe('string')
        expect(typeof lookup(en, s.labelKey), `en ${s.labelKey}`).toBe('string')
      }
    })
  }

  it('follows the proposal table for representative values', () => {
    expect(statusStyle('task', 'proposed')).toMatchObject({ tone: 'warning' })
    expect(statusStyle('request', 'waiting_for_you')).toMatchObject({ tone: 'warning', icon: 'mdi-hand-wave-outline' })
    expect(statusStyle('health', 'blocked')).toMatchObject({ tone: 'error' })
    expect(statusStyle('run', 'running')).toMatchObject({ tone: 'info', spinner: true })
    expect(statusStyle('workItem', 'cancelled')).toMatchObject({ tone: 'neutral', icon: 'mdi-close-circle-outline' })
    expect(statusStyle('aiStatus', 'drafting')).toMatchObject({ tone: 'ai', spinner: true })
  })

  it('falls back to a neutral style for an unknown value instead of throwing', () => {
    expect(statusStyle('task', 'mystery')).toEqual({ tone: 'neutral', labelKey: 'chip.task.mystery' })
  })
})

describe('priorityStyle', () => {
  it('covers every priority with a glyph and the existing label', () => {
    expect(Object.keys(PRIORITY_STYLE).sort()).toEqual([...Priority.options].sort())
    for (const p of Priority.options) {
      expect(priorityStyle(p).icon).toMatch(/^mdi-/)
      expect(priorityStyle(p).labelKey).toBe(`priority.${p}`)
    }
    expect(priorityStyle('urgent')).toMatchObject({ icon: 'mdi-chevron-double-up', color: 'error' })
  })
})
