import { createHash } from 'node:crypto'

/** The portal owns only the text between these markers in an issue body. */
export const ISSUE_BEGIN = '<!-- yoda:begin -->'
export const ISSUE_END = '<!-- yoda:end -->'
/** Hidden marker that finds the issue again if its creation response was lost (createIssue is not retried). */
export const workItemMarker = (workItemId: string) => `<!-- yoda:work-item:${workItemId} -->`

export const MAX_DOC_CHARS = 6000

export const HEADINGS = {
  requirements: 'ข้อกำหนด / Requirements',
  design: 'การออกแบบ / Design',
  decisions: 'การตัดสินใจ / Decisions',
  testCases: 'กรณีทดสอบ / Test cases',
  related: 'งานที่เกี่ยวข้อง / Related issues',
  originalRequest: 'คำขอเดิม (ยังไม่ผ่านการทบทวน) / Original request (not reviewed)',
} as const
const SUMMARY = 'สรุป / Summary'

export type IssueSectionInput = {
  workItem: { id: string; title: string }
  projectName: string
  portalUrl: string
  requirements: string | null
  /** The work item's description, shown only for templates without a requirements (BA) step. */
  originalRequest?: string | null
  design: string | null
  decisions: { question: string; decision: string }[]
  testCases: string | null
  siblings: { path: string; iid: number | null; url: string | null }[]
  feedback: string | null
  /** This issue's own number, once known (for the `Closes #<iid>` note). */
  iid?: number | null
}

/** Content never carries HTML comments, so it cannot fake or break the markers. */
const clean = (s: string) => s.replace(/<!--/g, '&lt;!--').replace(/-->/g, '--&gt;').trim()
const oneLine = (s: string) => clean(s).replace(/\s*\n\s*/g, ' ')

function clip(text: string, more: string): string {
  const t = clean(text)
  if (t.length <= MAX_DOC_CHARS) return t
  return `${t.slice(0, MAX_DOC_CHARS)}\n\n… ([ดูต่อในพอร์ทัล / continued in the portal](${more}))`
}

const NONE = '_ยังไม่มี / none yet_'

/** Deterministic Markdown for the owned section, markers included. No people's names are rendered. */
export function renderIssueSection(input: IssueSectionInput): string {
  const link = `${input.portalUrl.replace(/\/+$/, '')}/work-items/${input.workItem.id}`
  const doc = (t: string | null) => (t && t.trim() ? clip(t, link) : NONE)
  const lines: string[] = [ISSUE_BEGIN, workItemMarker(input.workItem.id), `## ${oneLine(input.workItem.title)}`, '']
  lines.push(`โครงการ / Project: ${oneLine(input.projectName)} · [เปิดในพอร์ทัล / Open in the portal](${link})`, '')
  if (input.feedback && input.feedback.trim()) {
    lines.push(`**ขอให้แก้ไข / Changes requested:** ${clip(input.feedback, link)}`, '')
  }
  if (input.originalRequest && input.originalRequest.trim()) {
    lines.push(`### ${HEADINGS.originalRequest}`, '', doc(input.originalRequest), '')
  } else lines.push(`### ${HEADINGS.requirements}`, '', doc(input.requirements), '')
  lines.push(`### ${HEADINGS.design}`, '', doc(input.design), '')
  lines.push(`### ${HEADINGS.decisions}`, '')
  if (input.decisions.length) {
    for (const d of input.decisions) lines.push(`- **${oneLine(d.question)}** — ${oneLine(d.decision)}`)
  } else lines.push(NONE)
  lines.push('')
  lines.push(`### ${HEADINGS.testCases}`, '', doc(input.testCases), '')
  lines.push(`### ${HEADINGS.related}`, '')
  if (input.siblings.length) {
    for (const s of input.siblings) {
      lines.push(s.iid !== null && s.url ? `- [${s.path}#${s.iid}](${s.url})` : `- ${s.path} (ยังไม่สร้าง / not created yet)`)
    }
  } else lines.push(NONE)
  lines.push('', '---', '')
  const ref = input.iid ? `Closes #${input.iid}` : 'Closes #<เลข issue นี้ / this issue number>'
  lines.push(`MR ของงานนี้ต้องมี \`${ref}\` ในคำอธิบาย / Merge requests for this work must include \`${ref}\` in their description.`)
  lines.push(ISSUE_END)
  return lines.join('\n')
}

/** Start/end offsets of the owned section (end exclusive), or null when the markers are missing. */
function findSection(body: string): [number, number] | null {
  // The last begin marker and the end after it: a stray end marker in the developer's text comes before it.
  const b = body.lastIndexOf(ISSUE_BEGIN)
  if (b < 0) return null
  const e = body.indexOf(ISSUE_END, b)
  if (e < 0) return null
  return [b, e + ISSUE_END.length]
}

/** Replaces the owned section; without markers, appends it after the developer's text. */
export function mergeSection(body: string, section: string): string {
  const at = findSection(body)
  if (at) return body.slice(0, at[0]) + section + body.slice(at[1])
  const rest = body.trimEnd()
  return rest ? `${rest}\n\n${section}` : section
}

export function sectionHash(section: string): string {
  return createHash('sha256').update(section).digest('hex')
}

function parts(section: string): Map<string, string> {
  const out = new Map<string, string>()
  const chunks = section.split(/^### /m)
  out.set(SUMMARY, chunks[0] ?? '')
  for (const c of chunks.slice(1)) {
    const nl = c.indexOf('\n')
    const heading = nl < 0 ? c : c.slice(0, nl)
    // The closing note belongs to the last section's text; strip it so a new iid does not count as content.
    out.set(heading.trim(), (nl < 0 ? '' : c.slice(nl)).split('\n---\n')[0]!)
  }
  return out
}

/** Headings whose content differs between the section in `oldBody` and `section` (all of them if none was found). */
export function changedSections(oldBody: string, section: string): string[] {
  const at = findSection(oldBody)
  const next = parts(section)
  if (!at) return [...next.keys()]
  const prev = parts(oldBody.slice(at[0], at[1]))
  return [...next.keys()].filter((k) => prev.get(k) !== next.get(k))
}
