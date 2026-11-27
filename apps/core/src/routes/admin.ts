import { DepartmentAiSettings, DepartmentAiSettingsPatch, UiConfig } from '@yoda/shared'
import { eq, sql } from 'drizzle-orm'
import type { FastifyInstance } from 'fastify'
import { requireAdmin, requireSignedIn } from '../auth/plugin.js'
import { departmentMonthUsage } from '../ai/gateway.js'
import type { Db } from '../db/client.js'
import { departmentSettings } from '../db/schema.js'

export async function funMode(db: Db): Promise<boolean> {
  const [row] = await db.select({ funMode: departmentSettings.funMode }).from(departmentSettings).where(eq(departmentSettings.id, 1))
  return row?.funMode ?? true
}

async function aiSettings(db: Db): Promise<DepartmentAiSettings> {
  const usage = await departmentMonthUsage(db)
  return DepartmentAiSettings.parse({ aiBudgetUsd: usage.budgetUsd, funMode: await funMode(db), usage })
}

export function adminRoutes(app: FastifyInstance): void {
  app.get('/admin/ai-settings', async (request) => {
    requireAdmin(request)
    return aiSettings(app.deps.db)
  })

  app.patch('/admin/ai-settings', async (request) => {
    requireAdmin(request)
    const body = DepartmentAiSettingsPatch.parse(request.body)
    const values = {
      ...(body.aiBudgetUsd !== undefined && { aiBudgetUsd: body.aiBudgetUsd === null ? null : body.aiBudgetUsd.toFixed(2) }),
      ...(body.funMode !== undefined && { funMode: body.funMode }),
      updatedBy: request.me.id,
      updatedAt: sql`now()`,
    }
    // Upsert: the migration seeds the row, but never fail if it is missing.
    await app.deps.db
      .insert(departmentSettings)
      .values({ id: 1, ...values })
      .onConflictDoUpdate({ target: departmentSettings.id, set: values })
    return aiSettings(app.deps.db)
  })

  // Cosmetic shell settings, read-only for every signed-in user (requesters too).
  app.get('/ui-config', async (request) => {
    requireSignedIn(request)
    return UiConfig.parse({ funMode: await funMode(app.deps.db) })
  })
}
