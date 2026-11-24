import { existsSync } from 'node:fs'
import { readdir, readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { isDeepStrictEqual } from 'node:util'
import { validateTemplate, WorkflowTemplateDef } from '@yoda/shared'
import { desc, eq } from 'drizzle-orm'
import type { Db, Tx } from '../db/client.js'
import { workflowTemplates } from '../db/schema.js'

// src/workflow/seed.ts (dev/test: ./templates) or dist/server.js (built: ./workflow/templates).
const defaultDir = ['./templates/', './workflow/templates/']
  .map((p) => fileURLToPath(new URL(p, import.meta.url)))
  .find((p) => existsSync(p)) as string

export async function seedTemplates(db: Db, dir: string = defaultDir): Promise<void> {
  const files = (await readdir(dir)).filter((f) => f.endsWith('.json')).sort()
  const defs: WorkflowTemplateDef[] = []
  const problems: string[] = []
  for (const file of files) {
    const parsed = WorkflowTemplateDef.safeParse(JSON.parse(await readFile(`${dir}/${file}`, 'utf8')))
    if (!parsed.success) {
      problems.push(`${file}: ${parsed.error.message}`)
      continue
    }
    problems.push(...validateTemplate(parsed.data).map((p) => `${file}: ${p}`))
    defs.push(parsed.data)
  }
  if (problems.length) throw new Error(`Invalid workflow templates:\n${problems.join('\n')}`)

  for (const def of defs) {
    await db.transaction(async (tx) => {
      const latest = await latestTemplate(tx, def.key)
      if (latest && isDeepStrictEqual(latest.definition, def)) return
      await tx
        .insert(workflowTemplates)
        .values({ key: def.key, version: (latest?.version ?? 0) + 1, definition: def })
    })
  }
}

export async function latestTemplate(
  db: Db | Tx,
  key: string,
): Promise<{ id: string; version: number; definition: WorkflowTemplateDef } | null> {
  const [row] = await db
    .select()
    .from(workflowTemplates)
    .where(eq(workflowTemplates.key, key))
    .orderBy(desc(workflowTemplates.version))
    .limit(1)
  if (!row) return null
  return { id: row.id, version: row.version, definition: row.definition as WorkflowTemplateDef }
}
