import { createHash } from 'node:crypto'

/** The portal owns only the text between these markers in an issue body. */
export const ISSUE_BEGIN = '<!-- yoda:begin -->'
export const ISSUE_END = '<!-- yoda:end -->'
/** Hidden marker on every note the portal posts, so the webhook can skip its own notes without asking GitLab. */
export const PORTAL_NOTE_MARKER = '<!-- yoda:portal-note -->'
/**
 * Hidden marker that finds the issue again if its creation response was lost (createIssue is not retried).
 * GitLab's issue search splits text into words, so the marker carries one searchable word (`yodawi` + the id's
 * hex digits). Issues created before the word was added hold `<!-- yoda:work-item:<id> -->`; both forms start
 * with `markerPrefix`, which is what identifies the work item.
 */
export const workItemMarker = (workItemId: string) => `<!-- yoda:work-item:${workItemId} ${markerWord(workItemId)} -->`
const markerWord = (workItemId: string) => `yodawi${workItemId.replace(/-/g, '').toLowerCase()}`
const markerPrefix = (workItemId: string) => `<!-- yoda:work-item:${workItemId}`
/** What `GitLabClient.findIssueByMarker` searches for and then confirms in the issue body. */
export const markerQuery = (workItemId: string) => ({ search: markerWord(workItemId), contains: markerPrefix(workItemId) })

export const MAX_DOC_CHARS = 6000

export const HEADINGS = {
  requirements: 'ข้อกำหนด / Requirements',
  design: 'การออกแบบ / Design',
  decisions: 'การตัดสินใจ / Decisions',
  testCases: 'กรณีทดสอบ / Test cases',
  related: 'งานที่เกี่ยวข้อง / Related issues',
  originalRequest: 'คำขอเดิม (ยังไม่ผ่านการทบทวน) / Original request (not reviewed)',
  defect: 'รายงานข้อบกพร่อง / Defect report',
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
  /** A Yoda Reporter report: severity, build and browser only. Its text is the description (or the withheld marker); no media. */
  defect?: IssueDefect | null
}

export type IssueDefect = {
  severity: string
  build: { repo?: string; branch?: string; commit?: string; env?: string } | null
  client: { browser: string; browserVersion: string; os: string; osVersion: string }
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
  if (input.defect) lines.push(...defectLines(input.defect, link), '')
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

function defectLines(d: IssueDefect, link: string): string[] {
  const b = d.build
  const build = b ? [b.repo, b.branch && `branch ${b.branch}`, b.commit && `commit ${b.commit}`, b.env && `env ${b.env}`].filter(Boolean).join(' · ') : ''
  const c = d.client
  return [
    `### ${HEADINGS.defect}`,
    '',
    `- ความรุนแรง / Severity: ${oneLine(d.severity)}`,
    `- บิลด์ / Build: ${build ? oneLine(build) : 'ไม่ทราบ / unknown'}`,
    `- เบราว์เซอร์ / Browser: ${oneLine(`${c.browser} ${c.browserVersion} · ${c.os} ${c.osVersion}`)}`,
    `- ภาพ วิดีโอ และ log อยู่ในพอร์ทัลเท่านั้น / Screenshots, video and logs stay in the portal: [เปิด / Open](${link})`,
  ]
}

/** Removes HTML comment markers until none remain (a single pass could reassemble one, e.g. `<!<!---->--`). */
export function stripCommentMarkers(text: string): string {
  let s = text
  let prev: string
  do {
    prev = s
    s = s.replace(/<!--|-->/g, '')
  } while (s !== prev)
  return s
}

const WORK_ITEM_MARKER = /<!-- yoda:work-item:([0-9a-f-]{36})(?: yodawi[0-9a-f]{32})? -->/

/**
 * Start/end offsets of the owned section (end exclusive), or null when there is no well-formed pair. A pair is an
 * end marker and the nearest begin before it, with no other marker between them. The pair holding `marker` (the
 * work item's hidden marker) wins; otherwise the last pair.
 */
function findSection(body: string, marker: string | null): [number, number] | null {
  const pairs: [number, number][] = []
  let from = 0
  let prevEnd = 0
  for (;;) {
    const e = body.indexOf(ISSUE_END, from)
    if (e < 0) break
    const b = body.lastIndexOf(ISSUE_BEGIN, e)
    if (b >= prevEnd && b >= 0) pairs.push([b, e + ISSUE_END.length])
    prevEnd = e + ISSUE_END.length
    from = prevEnd
  }
  if (!pairs.length) return null
  const own = marker ? pairs.filter(([b, e]) => body.slice(b, e).includes(marker)) : []
  return own.at(-1) ?? pairs.at(-1)!
}

/** The marker prefix of the section's work item, which also matches the older marker form in issue bodies. */
const markerOf = (section: string) => {
  const id = section.match(WORK_ITEM_MARKER)?.[1]
  return id ? markerPrefix(id) : null
}

/** Replaces the owned section; without markers, appends it after the developer's text. */
export function mergeSection(body: string, section: string): string {
  const at = findSection(body, markerOf(section))
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
  const at = findSection(oldBody, markerOf(section))
  const next = parts(section)
  if (!at) return [...next.keys()]
  const prev = parts(oldBody.slice(at[0], at[1]))
  return [...next.keys()].filter((k) => prev.get(k) !== next.get(k))
}
