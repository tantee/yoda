import { CAPTURE_CAPS, ConsoleEntry, NetworkEntry, type Attachment, type DefectBuild } from '@yoda/shared'

/**
 * A captured log file (untrusted page data): each entry is validated with the shared schema, invalid ones are
 * dropped and counted, and at most CAPTURE_CAPS.entries are kept. Messages stay plain strings: the card renders
 * them as text only.
 */
export function parseLog(text: string, kind: 'console'): { entries: ConsoleEntry[]; dropped: number }
export function parseLog(text: string, kind: 'network'): { entries: NetworkEntry[]; dropped: number }
export function parseLog(text: string, kind: 'console' | 'network'): { entries: (ConsoleEntry | NetworkEntry)[]; dropped: number } {
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch {
    return { entries: [], dropped: 0 }
  }
  const list = Array.isArray(raw) ? raw : []
  const schema = kind === 'console' ? ConsoleEntry : NetworkEntry
  const entries: (ConsoleEntry | NetworkEntry)[] = []
  let dropped = 0
  for (const e of list) {
    const r = schema.safeParse(e)
    if (!r.success) dropped++
    else if (entries.length < CAPTURE_CAPS.entries) entries.push(r.data)
    else dropped++
  }
  return { entries, dropped }
}

/** One line for a build: `repo · branch · commit · env`, the commit shortened; empty parts left out. */
export function buildLine(build: DefectBuild | null | undefined): string {
  if (!build) return ''
  const commit = build.commit ? build.commit.slice(0, 12) : ''
  return [build.repo, build.branch, commit, build.env].filter((x) => !!x && String(x).trim()).join(' · ')
}

const ORDER: Record<string, number> = { screenshot: 0, screenshot_full: 1, video: 2, buffer: 3, console: 4, network: 5 }

/** Screenshots, then video and buffer, then logs; files without a role last; by name within a role (buffer-2 before buffer-10). */
export function orderAttachments<T extends Pick<Attachment, 'role' | 'fileName'>>(list: T[]): T[] {
  return [...list].sort((a, b) => (ORDER[a.role ?? ''] ?? 9) - (ORDER[b.role ?? ''] ?? 9) || a.fileName.localeCompare(b.fileName, undefined, { numeric: true }))
}

const partNo = (fileName: string) => Number(/(\d+)/.exec(fileName)?.[1] ?? Number.MAX_SAFE_INTEGER)

/**
 * The replay buffer's parts, in playing order (buffer-1.webm, buffer-2.webm, …, by number, not by text), without
 * the ones retention removed. The card plays them back to back.
 */
export function bufferPlaylist<T extends Pick<Attachment, 'role' | 'fileName'> & { purgedAt?: string | null }>(list: T[]): T[] {
  return list.filter((a) => a.role === 'buffer' && !a.purgedAt).sort((a, b) => partNo(a.fileName) - partNo(b.fileName) || a.fileName.localeCompare(b.fileName))
}

/** The GitLab commit link for a build, when its repo is one of the project's linked repos. */
export function commitUrl(build: DefectBuild | null | undefined, repos: { pathWithNamespace: string; webUrl: string }[]): string | null {
  if (!build?.repo || !build.commit || !/^[0-9a-f]{7,40}$/i.test(build.commit)) return null
  const repo = repos.find((r) => r.pathWithNamespace === build.repo)
  return repo ? `${repo.webUrl.replace(/\/+$/, '')}/-/commit/${build.commit}` : null
}

/** A page URL is opened only when it is http(s); anything else stays text. */
export function safeHttpUrl(url: string): string | null {
  try {
    const u = new URL(url)
    return u.protocol === 'http:' || u.protocol === 'https:' ? u.toString() : null
  } catch {
    return null
  }
}
