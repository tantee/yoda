import type { KnowledgeSearchHit, Me } from '@yoda/shared'
import { and, eq, inArray, isNull, or, sql, type SQL } from 'drizzle-orm'
import { AiFailed, AiRefused, type AiGateway } from '../ai/gateway.js'
import type { Db } from '../db/client.js'
import { knowledgeEntries, people } from '../db/schema.js'
import { canSeeProject } from '../work/queries.js'
import { entryColumns, toEntry, visibleTo, workItemProject } from './service.js'

/** Reciprocal rank fusion constant. */
const RRF_K = 60
/** Candidates taken from each ranking. */
const PER_RANKING = 50
/** `word_similarity` threshold for `<%`: short Thai queries score ~0.57 against a containing word run. */
const TRIGRAM_THRESHOLD = 0.3
const SNIPPET_CHARS = 300

export type SearchQuery = { query: string; projectId?: string; workItemId?: string; limit?: number; forAi?: boolean }

type Ranked = { entryId: string; text: string }

/**
 * Hybrid search over current (non-superseded) entries visible to `me`. Scope: with a work item or project,
 * that project's entries plus department entries; otherwise everything visible. Ranking fuses trigram
 * `word_similarity` over chunks (and title/body of entries not chunked yet) with cosine distance over chunk
 * embeddings when `ai` can embed the query. `forAi` drops noAi entries, entries of noAi attachments and all
 * entries of noAi projects.
 */
export async function searchKnowledge(
  db: Db,
  me: Me,
  q: SearchQuery,
  ai?: Pick<AiGateway, 'embed'> | null,
): Promise<KnowledgeSearchHit[]> {
  const query = q.query.trim()
  const limit = Math.min(Math.max(q.limit ?? 10, 1), 50)
  if (!query || !me.isStaff) return []

  let projectId = q.projectId ?? null
  if (q.workItemId) {
    const wp = await workItemProject(db, q.workItemId)
    if (!wp || (projectId && projectId !== wp)) return []
    projectId = wp
  }
  if (projectId && !(await canSeeProject(db, me, projectId))) return []

  const conds: (SQL | undefined)[] = [isNull(knowledgeEntries.supersededAt), visibleTo(me)]
  if (projectId) conds.push(or(isNull(knowledgeEntries.projectId), sql`${knowledgeEntries.projectId} = ${projectId}`))
  if (q.forAi) {
    conds.push(
      sql`not ${knowledgeEntries.noAi}`,
      sql`not exists (select 1 from attachments a where a.id = ${knowledgeEntries.attachmentId} and a.no_ai)`,
      sql`not exists (select 1 from projects p where p.id = ${knowledgeEntries.projectId} and p.no_ai)`,
    )
  }
  const cand = sql`cand as (
    select ${knowledgeEntries.id} as id, ${knowledgeEntries.title} as title, ${knowledgeEntries.body} as body
    from ${knowledgeEntries} where ${and(...conds)}
  )`

  const vector = await embedQuery(ai, projectId, query)

  const { trigram, cosine } = await db.transaction(async (tx) => {
    await tx.execute(sql`select set_config('pg_trgm.word_similarity_threshold', ${String(TRIGRAM_THRESHOLD)}, true)`)
    const trigram = await tx.execute<{ entry_id: string; text: string; sim: number }>(sql`
      with ${cand},
      hits as (
        select c.entry_id, c.text, word_similarity(${query}::text, c.text) as sim
        from knowledge_chunks c join cand on cand.id = c.entry_id
        where ${query}::text <% c.text
        union all
        select cand.id, cand.title || E'\n\n' || cand.body, word_similarity(${query}::text, cand.title || E'\n\n' || cand.body)
        from cand
        where not exists (select 1 from knowledge_chunks c where c.entry_id = cand.id)
          and (${query}::text <% cand.title or ${query}::text <% cand.body)
      ),
      top as (select * from hits order by sim desc limit ${PER_RANKING})
      select distinct on (entry_id) entry_id, text, sim from top order by entry_id, sim desc
    `)
    const cosine = vector
      ? await tx.execute<{ entry_id: string; text: string; dist: number }>(sql`
          with ${cand},
          top as (
            select c.entry_id, c.text, c.embedding <=> ${`[${vector.join(',')}]`}::vector as dist
            from knowledge_chunks c join cand on cand.id = c.entry_id
            where c.embedding is not null
            order by dist limit ${PER_RANKING}
          )
          select distinct on (entry_id) entry_id, text, dist from top order by entry_id, dist
        `)
      : []
    return { trigram: [...trigram], cosine: [...cosine] }
  })

  const rankings: Ranked[][] = [
    trigram.sort((a, b) => Number(b.sim) - Number(a.sim)).map((r) => ({ entryId: r.entry_id, text: r.text })),
    cosine.sort((a, b) => Number(a.dist) - Number(b.dist)).map((r) => ({ entryId: r.entry_id, text: r.text })),
  ]
  const fused = new Map<string, { score: number; snippet: string }>()
  for (const ranking of rankings) {
    ranking.forEach((r, i) => {
      const cur = fused.get(r.entryId)
      const add = 1 / (RRF_K + i + 1)
      // Snippet comes from the first ranking that found the entry (trigram first: it shows the matched text).
      if (cur) cur.score += add
      else fused.set(r.entryId, { score: add, snippet: r.text.slice(0, SNIPPET_CHARS) })
    })
  }
  const top = [...fused.entries()].sort((a, b) => b[1].score - a[1].score).slice(0, limit)
  if (!top.length) return []

  const rows = await db
    .select(entryColumns)
    .from(knowledgeEntries)
    .leftJoin(people, eq(people.id, knowledgeEntries.createdBy))
    .where(inArray(knowledgeEntries.id, top.map(([id]) => id)))
  const byId = new Map(rows.map((r) => [r.id, toEntry(r)]))
  return top.flatMap(([id, f]) => {
    const e = byId.get(id)
    return e ? [{ ...e, score: f.score, snippet: f.snippet }] : []
  })
}

/** Query vector, or null when there is no embedding model or the call is refused / fails. */
async function embedQuery(
  ai: Pick<AiGateway, 'embed'> | null | undefined,
  projectId: string | null,
  query: string,
): Promise<number[] | null> {
  if (!ai) return null
  try {
    const v = await ai.embed({ projectId, texts: [query] })
    return v?.[0] ?? null
  } catch (err) {
    if (err instanceof AiRefused || err instanceof AiFailed) return null
    throw err
  }
}
