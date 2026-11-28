import { DefectReportView } from '@yoda/shared'
import { eq } from 'drizzle-orm'
import type { Db, Tx } from '../db/client.js'
import { defectReports, people } from '../db/schema.js'

/** The defect card's data (`WorkItemDetail.defect`): the real text, also for a sensitive report; null when none. */
export async function defectView(db: Db | Tx, workItemId: string): Promise<DefectReportView | null> {
  const [r] = await db
    .select({ d: defectReports, name: people.displayName })
    .from(defectReports)
    .innerJoin(people, eq(people.id, defectReports.reportedBy))
    .where(eq(defectReports.workItemId, workItemId))
  if (!r) return null
  const { d } = r
  return DefectReportView.parse({
    kind: d.kind,
    severity: d.severity,
    description: d.description,
    steps: d.steps,
    expected: d.expected,
    actual: d.actual,
    page: { url: d.pageUrl, title: d.pageTitle, ...(d.route ? { route: d.route } : {}) },
    build: d.build ?? null,
    backendBuilds: d.backendBuilds,
    client: d.client,
    capturedAt: d.capturedAt.toISOString(),
    reportedBy: { id: d.reportedBy, displayName: r.name },
    source: d.source,
    productionSite: d.productionSite,
    textMayContainPatientData: d.textMayContainPatientData,
    sensitive: d.sensitive,
  })
}
