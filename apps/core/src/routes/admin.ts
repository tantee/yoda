import { DepartmentAiSettings, DepartmentAiSettingsPatch } from '@yoda/shared'
import { sql } from 'drizzle-orm'
import type { FastifyInstance } from 'fastify'
import { requireAdmin } from '../auth/plugin.js'
import { departmentMonthUsage } from '../ai/gateway.js'
import type { Db } from '../db/client.js'
import { departmentSettings } from '../db/schema.js'

async function aiSettings(db: Db): Promise<DepartmentAiSettings> {
  const usage = await departmentMonthUsage(db)
  return DepartmentAiSettings.parse({ aiBudgetUsd: usage.budgetUsd, usage })
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
      aiBudgetUsd: body.aiBudgetUsd === null ? null : body.aiBudgetUsd.toFixed(2),
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
}
