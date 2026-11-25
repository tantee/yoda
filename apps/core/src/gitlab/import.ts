import { ISSUE_BEGIN, ISSUE_END } from './issue-section.js'

export const MAX_TITLE_CHARS = 200
export const MAX_DESCRIPTION_CHARS = 10_000

/** Issue text is untrusted: no HTML comments (so it can never fake or break the portal's markers). */
const stripMarkers = (s: string) => s.replace(/<!--|-->/g, '')

const clip = (s: string, n: number) => {
  const chars = Array.from(s)
  return chars.length > n ? `${chars.slice(0, n - 1).join('')}…` : s
}

/** A section the portal wrote into the issue (e.g. for another work item) is not part of the original request. */
function withoutOwnedSection(body: string): string {
  let out = body
  for (;;) {
    const e = out.indexOf(ISSUE_END)
    if (e < 0) return out
    const b = out.lastIndexOf(ISSUE_BEGIN, e)
    out = b < 0 ? out.slice(0, e) + out.slice(e + ISSUE_END.length) : out.slice(0, b) + out.slice(e + ISSUE_END.length)
  }
}

/** Title and description of a work item made from a GitLab issue (description prefixed with the issue URL). */
export function importedText(issue: { title: string; description: string; web_url: string; iid: number }, path: string): { title: string; description: string } {
  const title = clip(stripMarkers(issue.title).replace(/\s+/g, ' ').trim(), MAX_TITLE_CHARS) || `${path}#${issue.iid}`
  const body = stripMarkers(withoutOwnedSection(issue.description)).trim()
  const head = stripMarkers(issue.web_url).trim()
  const description = clip(body ? `${head}\n\n${body}` : head, MAX_DESCRIPTION_CHARS)
  return { title, description }
}
