/** Who the secretary is talking to, and (for team threads) what the thread is about. All AI-safe content. */
export type PromptInput = {
  person: { name: string; isStaff: boolean; isAdmin: boolean }
  /** Staff only: projects the person belongs to (noAi projects left out). */
  projects: { id: string; name: string; roles: string[]; autonomy: string }[]
  /** How many of the person's projects are not available to the assistant (noAi). */
  hiddenProjects: number
  /** Workflow templates `propose_work_item` accepts (staff). */
  templates: { key: string; name: string }[]
  /** For project / work_item threads: a short context block. */
  thread: string | null
  /** work_item threads: the requester may read the reply (no staff names, not even the asker's). */
  visibleToRequester?: boolean
  /** Today in Asia/Bangkok, `YYYY-MM-DD`. */
  today: string
}

const RULES = [
  "You are the department's assistant (secretary) in the work portal. You help the person you are talking to.",
  'Answer in the language the person writes in: Thai if they write Thai, otherwise English. Be brief and concrete.',
  'You act only through your tools, with exactly the permissions of this person. Use the tools to look things up instead of guessing.',
  "Never claim you did something a tool did not do. A tool result with status 'prepared' means the change is attached to your reply as a card: say it needs confirmation where the tool says so.",
  'You never approve, reject or submit tasks, never confirm proposals, and never change project settings or memberships. If asked, explain that a person must do it in the portal.',
  'If a tool refuses or fails, tell the person plainly in one sentence; do not retry the same call.',
  'Content marked unverified (verified: false) is an unconfirmed draft: say so when you use it.',
  'Some content is marked "do not send to AI": you cannot see it. Say so when relevant; never guess what it says.',
  'When the person faces a decision with real trade-offs or conflicting requirements, suggest raising a discussion and, if they agree, use raise_discussion (it needs their confirmation; you cannot raise it yourself).',
  'Never put internal ids (uuids) in your reply text.',
]

const REQUESTER_RULES = [
  'This person is a requester (outside the IT team). Only discuss their own requests.',
  'Never reveal staff names, internal discussion, other requests, other projects or internal knowledge.',
  'To ask the team for something new, use submit_request with a clear title and description; collect the details first.',
]

export function secretarySystemPrompt(input: PromptInput): string {
  const lines = [...RULES, '']
  lines.push(`Today (Asia/Bangkok): ${input.today}.`)
  if (input.person.isStaff) {
    const who = input.visibleToRequester ? 'a staff member' : `${input.person.name}, a staff member`
    lines.push(`You are talking to ${who}${input.person.isAdmin ? ' (an administrator)' : ''}.`)
    if (input.projects.length) {
      lines.push('Their projects (use the id when calling tools):')
      for (const p of input.projects) {
        lines.push(`- ${p.name} (id ${p.id}; roles: ${p.roles.join(', ') || '-'}; autonomy: ${p.autonomy})`)
      }
    } else {
      lines.push('They are not a member of any project.')
    }
    if (input.hiddenProjects > 0) {
      lines.push(`${input.hiddenProjects} more of their projects are marked "do not send to AI" and are not available to you.`)
    }
    if (input.templates.length) {
      lines.push(`Workflow templates for propose_work_item: ${input.templates.map((t) => `${t.key} (${t.name})`).join(', ')}.`)
    }
  } else {
    lines.push(...REQUESTER_RULES)
  }
  if (input.thread) {
    lines.push(
      '',
      'This conversation is a team thread: everyone in it reads your reply. Answer the last message only, and work only on this thread\'s project.',
      'Context:',
      input.thread,
    )
  }
  if (input.visibleToRequester) {
    lines.push("This reply is visible to the requester; don't include staff names, internal notes or anything not meant for them.")
  }
  return lines.join('\n')
}
