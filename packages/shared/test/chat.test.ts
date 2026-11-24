import { it, expect } from 'vitest'
import { ActionCard, ConversationCreate, MessageCreate, ProjectRole, TemplateTask, LiveEvent, ProposalDecision } from '../src/index.js'

const id = '11111111-1111-4111-8111-111111111111'

it('MessageCreate trims and rejects blank text', () => {
  expect(MessageCreate.parse({ text: '  hi  ' })).toEqual({ text: 'hi', attachmentIds: [] })
  expect(MessageCreate.safeParse({ text: '   ' }).success).toBe(false)
})

it('MessageCreate rejects 11 attachment ids', () => {
  expect(MessageCreate.safeParse({ text: 'x', attachmentIds: Array(11).fill(id) }).success).toBe(false)
  expect(MessageCreate.safeParse({ text: 'x', attachmentIds: Array(10).fill(id) }).success).toBe(true)
})

it('ConversationCreate requires the matching target', () => {
  expect(ConversationCreate.safeParse({ kind: 'project' }).success).toBe(false)
  expect(ConversationCreate.safeParse({ kind: 'work_item' }).success).toBe(false)
  expect(ConversationCreate.safeParse({ kind: 'project', projectId: id }).success).toBe(true)
  expect(ConversationCreate.safeParse({ kind: 'work_item', workItemId: id }).success).toBe(true)
})

it('ActionCard rejects unknown types', () => {
  expect(ActionCard.safeParse({ type: 'nope' }).success).toBe(false)
  expect(ActionCard.safeParse({ type: 'proposal', proposalId: id }).success).toBe(true)
})

it('REQUESTER is a template role but not a project role', () => {
  const task = {
    key: 'a', type: 'human', role: 'REQUESTER',
    title: { th: 'ก', en: 'a' }, instructions: { th: 'ก', en: 'a' },
  }
  expect(TemplateTask.safeParse(task).success).toBe(true)
  expect(ProjectRole.safeParse('REQUESTER').success).toBe(false)
})

it('ProposalDecision accepts an optional projectId; LiveEvent allows null projectId', () => {
  expect(ProposalDecision.safeParse({ decision: 'accept', projectId: id }).success).toBe(true)
  expect(ProposalDecision.safeParse({ decision: 'maybe' }).success).toBe(false)
  expect(LiveEvent.safeParse({ type: 'proposal.created', projectId: null, workItemId: null, taskId: null, conversationId: null, personId: id }).success).toBe(true)
})

it('mentionsSecretary matches @ai / @ผู้ช่วย case-insensitively, not inside words', async () => {
  const { mentionsSecretary } = await import('../src/index.js')
  expect(mentionsSecretary('@ai ช่วยสรุป')).toBe(true)
  expect(mentionsSecretary('ช่วยด้วย @AI')).toBe(true)
  expect(mentionsSecretary('@ผู้ช่วย สรุปให้หน่อย')).toBe(true)
  expect(mentionsSecretary('ถาม @Ai, ช่วยที')).toBe(true)
  expect(mentionsSecretary('ทีมช่วยดูหน่อย')).toBe(false)
  expect(mentionsSecretary('mail me at x@aid.com')).toBe(false)
  expect(mentionsSecretary('@aiden please check')).toBe(false)
})
