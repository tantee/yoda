import { describe, expect, it } from 'vitest'
import { AskHumanInput, ClaimInput, EventType, RunnerCreate, RunnerPatch, RunUsage, SubmitInput, WorkingHours } from '../src/index.js'

const base = {
  name: 'Build box',
  kind: 'server',
  accountType: 'api-key',
  capabilities: ['code-change'],
  mode: 'unattended',
  maxConcurrent: 2,
  workingHours: null,
}

describe('runner schemas', () => {
  it('accepts a valid runner', () => {
    expect(RunnerCreate.safeParse(base).success).toBe(true)
    expect(RunnerCreate.safeParse({ ...base, ownerId: crypto.randomUUID() }).success).toBe(true)
  })
  it('rejects empty capabilities and more than 4 concurrent runs', () => {
    expect(RunnerCreate.safeParse({ ...base, capabilities: [] }).success).toBe(false)
    expect(RunnerCreate.safeParse({ ...base, maxConcurrent: 5 }).success).toBe(false)
    expect(RunnerCreate.safeParse({ ...base, name: '' }).success).toBe(false)
    expect(RunnerCreate.safeParse({ ...base, name: 'x'.repeat(81) }).success).toBe(false)
  })
  it('requires working hours to end after they start', () => {
    const wh = { days: [1, 2, 3], start: '09:00', end: '17:00' }
    expect(RunnerCreate.safeParse({ ...base, workingHours: wh }).success).toBe(true)
    expect(RunnerCreate.safeParse({ ...base, workingHours: { ...wh, end: '09:00' } }).success).toBe(false)
    expect(RunnerCreate.safeParse({ ...base, workingHours: { ...wh, end: '08:00' } }).success).toBe(false)
    expect(WorkingHours.safeParse({ ...wh, days: [] }).success).toBe(false)
    expect(WorkingHours.safeParse({ ...wh, days: [7] }).success).toBe(false)
    expect(WorkingHours.safeParse({ ...wh, start: '9:00' }).success).toBe(false)
    expect(WorkingHours.safeParse({ ...wh, end: '24:00' }).success).toBe(false)
    expect(WorkingHours.safeParse({ ...wh, end: '17:60' }).success).toBe(false)
    expect(WorkingHours.safeParse({ ...wh, end: '23:59' }).success).toBe(true)
  })
  it('patches a subset of fields', () => {
    expect(RunnerPatch.safeParse({ paused: true }).success).toBe(true)
    expect(RunnerPatch.safeParse({ maxConcurrent: 0 }).success).toBe(false)
  })
  it('validates MCP tool inputs', () => {
    expect(ClaimInput.safeParse({ taskId: 'nope' }).success).toBe(false)
    expect(ClaimInput.safeParse({ taskId: crypto.randomUUID() }).success).toBe(true)
    const runId = crypto.randomUUID()
    expect(AskHumanInput.safeParse({ runId, question: 'q', details: '', options: ['a', 'b', 'c', 'd', 'e', 'f'] }).success).toBe(false)
    expect(SubmitInput.safeParse({ runId, text: 'done', usage: { model: 'm', costUsd: 1001 } }).success).toBe(false)
    expect(RunUsage.safeParse({ model: 'm', inputTokens: 10, outputTokens: 5, costUsd: 0.1 }).success).toBe(true)
  })
  it('knows the run events', () => {
    expect(EventType.options).toEqual(expect.arrayContaining(['run.claimed', 'run.expired', 'run.parked', 'gitlab.mr_requested']))
  })
})
