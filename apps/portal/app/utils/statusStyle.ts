import type { Priority } from '@yoda/shared'

/**
 * The one state → look mapping (proposal §6.5). Every status, health and AI chip in the portal goes through
 * `statusStyle()` (usually via `StatusChip`), so colour, marker and wording stay consistent.
 * Tones are theme colours: `<tone>` for text, `<tone>-soft` for the background, `<tone>-dot` for the dot.
 */
export const STATUS_TONES = ['success', 'warning', 'error', 'info', 'neutral', 'ai'] as const
export type StatusTone = (typeof STATUS_TONES)[number]

export interface StatusStyle {
  tone: StatusTone
  /** An icon instead of the dot. */
  icon?: string
  /** A small spinner instead of the dot (still in progress). */
  spinner?: boolean
  /** i18n key of the chip label: `chip.<kind>.<value>`. */
  labelKey: string
}

type Look = Omit<StatusStyle, 'labelKey'>
const dot = (tone: StatusTone): Look => ({ tone })
const icon = (tone: StatusTone, name: string): Look => ({ tone, icon: name })
const spin = (tone: StatusTone): Look => ({ tone, spinner: true })

const LOOKS = {
  workItem: { active: dot('info'), done: dot('success'), cancelled: icon('neutral', 'mdi-close-circle-outline') },
  task: {
    proposed: dot('warning'),
    open: dot('neutral'),
    in_progress: dot('info'),
    submitted: dot('warning'),
    accepted: dot('success'),
    rejected: dot('error'),
  },
  taskType: {
    ai: icon('ai', 'mdi-creation-outline'),
    human: icon('neutral', 'mdi-account-outline'),
    review: icon('info', 'mdi-eye-check-outline'),
    approval: icon('info', 'mdi-check-decagram-outline'),
  },
  step: { done: dot('success'), current: dot('info'), pending: dot('neutral') },
  request: {
    submitted: dot('neutral'),
    in_progress: dot('info'),
    waiting_for_you: icon('warning', 'mdi-hand-wave-outline'),
    done: dot('success'),
    cancelled: dot('neutral'),
  },
  health: { on_track: dot('success'), at_risk: dot('warning'), blocked: dot('error') },
  aiStatus: { drafting: spin('ai'), failed: icon('error', 'mdi-alert-circle-outline') },
  aiDraft: { low: icon('warning', 'mdi-gauge-low'), normal: icon('ai', 'mdi-creation-outline') },
  waiting: { runner: icon('neutral', 'mdi-server-network-outline'), ai: icon('ai', 'mdi-creation-outline') },
  run: {
    running: spin('info'),
    succeeded: icon('success', 'mdi-check'),
    failed: icon('error', 'mdi-alert-circle-outline'),
    expired: icon('warning', 'mdi-timer-sand-complete'),
    parked: icon('warning', 'mdi-help-circle-outline'),
    released: icon('neutral', 'mdi-undo'),
  },
  runner: { active: dot('success'), paused: icon('warning', 'mdi-pause'), revoked: icon('neutral', 'mdi-cancel') },
  sync: { synced: dot('success'), failed: dot('error'), pending: dot('neutral') },
  pipeline: {
    success: icon('success', 'mdi-check'),
    failed: icon('error', 'mdi-alert-circle-outline'),
    running: spin('info'),
    pending: icon('neutral', 'mdi-clock-outline'),
    canceled: icon('neutral', 'mdi-cancel'),
    none: dot('neutral'),
  },
  mr: { opened: dot('info'), merged: icon('success', 'mdi-source-merge'), closed: dot('neutral') },
  discussion: {
    open: dot('info'),
    scheduled: icon('info', 'mdi-calendar-text-outline'),
    decided: dot('success'),
    withdrawn: dot('neutral'),
  },
  brief: { pending: spin('ai'), ready: dot('success'), failed: icon('warning', 'mdi-alert-outline') },
  proposal: { pending: dot('warning'), accepted: dot('success'), rejected: dot('error'), superseded: dot('neutral') },
  knowledge: { draft: dot('neutral'), confirmed: dot('success') },
  project: { active: dot('info'), archived: dot('neutral') },
  yesNo: { yes: dot('success'), no: dot('neutral') },
} as const satisfies Record<string, Record<string, Look>>

export type StatusKind = keyof typeof LOOKS
export type StatusValue<K extends StatusKind> = keyof (typeof LOOKS)[K] & string

export const STATUS_STYLES = Object.fromEntries(
  Object.entries(LOOKS).map(([kind, values]) => [
    kind,
    Object.fromEntries(Object.entries(values).map(([v, look]) => [v, { ...look, labelKey: `chip.${kind}.${v}` }])),
  ]),
) as { [K in StatusKind]: Record<StatusValue<K>, StatusStyle> }

/**
 * Who reads the chip. Requesters keep the wording they had before the refresh until the requester glossary is
 * reviewed (Task 6): their task and request labels come from the older `task.state.*` / `requests.status.*` keys.
 */
export type StatusAudience = 'staff' | 'requester'
const REQUESTER_LABELS: Partial<Record<StatusKind, string>> = { task: 'task.state', request: 'requests.status' }

/** The look of one state; an unknown value (a newer core) shows neutral with its raw key. */
export function statusStyle(kind: StatusKind, value: string, audience: StatusAudience = 'staff'): StatusStyle {
  const style = (STATUS_STYLES[kind] as Record<string, StatusStyle>)[value] ?? { tone: 'neutral', labelKey: `chip.${kind}.${value}` }
  const requesterKey = audience === 'requester' ? REQUESTER_LABELS[kind] : undefined
  return requesterKey ? { ...style, labelKey: `${requesterKey}.${value}` } : style
}

/** Priority is not a chip: a glyph and a word in text colour, so mostly-normal lists stay quiet. */
export interface PriorityStyle {
  icon: string
  /** A theme colour, or undefined for secondary text. */
  color?: 'error' | 'warning'
  /** Extra classes for the word (weight, emphasis). */
  class: string
  labelKey: string
}

export const PRIORITY_STYLE: Record<Priority, PriorityStyle> = {
  urgent: { icon: 'mdi-chevron-double-up', color: 'error', class: 'font-weight-semibold', labelKey: 'priority.urgent' },
  high: { icon: 'mdi-chevron-up', color: 'warning', class: 'font-weight-medium', labelKey: 'priority.high' },
  normal: { icon: 'mdi-equal', class: 'text-medium-emphasis', labelKey: 'priority.normal' },
  low: { icon: 'mdi-chevron-down', class: 'text-placeholder', labelKey: 'priority.low' },
}

export function priorityStyle(p: Priority): PriorityStyle {
  return PRIORITY_STYLE[p] ?? PRIORITY_STYLE.normal
}
