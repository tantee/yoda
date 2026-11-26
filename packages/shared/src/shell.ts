import { z } from 'zod'

/**
 * `GET /me/counts`: the rail badges. Staff get their to-do, unread chat threads and open discussions waiting
 * for their vote; requesters only ever get counts of their own requests and questions.
 */
export const StaffCounts = z.object({
  todo: z.number().int().min(0),
  chat: z.number().int().min(0),
  discussions: z.number().int().min(0),
})
export type StaffCounts = z.infer<typeof StaffCounts>

export const RequesterCounts = z.object({
  requests: z.number().int().min(0),
  answers: z.number().int().min(0),
})
export type RequesterCounts = z.infer<typeof RequesterCounts>

export const MeCounts = z.union([StaffCounts, RequesterCounts])
export type MeCounts = z.infer<typeof MeCounts>

export const SEARCH_MIN_LENGTH = 2
export const SEARCH_LIMIT = 10

export const SearchQuery = z.object({ q: z.string().trim().min(SEARCH_MIN_LENGTH).max(200) })

export const SearchResultType = z.enum(['project', 'work_item', 'person', 'request'])
export type SearchResultType = z.infer<typeof SearchResultType>

/** One jump-box hit: what it is, its title, a short context line and the portal route that opens it. */
export const SearchResult = z.object({
  type: SearchResultType,
  id: z.string().uuid(),
  title: z.string(),
  subtitle: z.string().nullable(),
  route: z.string(),
})
export type SearchResult = z.infer<typeof SearchResult>
