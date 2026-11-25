import { NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { requireContext } from '@/lib/geo-context';
import { requirePermission } from '@/lib/authorization';
import { apiErrorResponse } from '@/lib/api-error';
import { queuePrioritySwitch } from '@/lib/queue-priority-switch';
import { readQueueHealth } from '@/lib/queue-health';
import { HEALTH_RULE_AR, healthAlerts, unstaffedLine } from '@/lib/queue-health-words';
import { readRecalibration } from '@/lib/queue-recalibration';
import { REPORT_TTL_MS, heavyOnce } from '@/lib/heavy-lane';
import { readUnstaffedOrders } from '@/lib/routing-health';

/**
 * GET /api/confirmation/health — THE SUPERVISOR'S BOARD OF THE QUEUE'S HEALTH (step D2 of Confirmation Center v2): the backlog, what is due now, the oldest wait, what entered and what
 * closed today, and the alerts those numbers raise. Read-only: it writes nothing. OFF unless the owner turned «أولوية الطابور» on — then it answers \`{ enabled: false }\` and reads nothing.
 * Needs \`confirmation.supervise\`. No customer field is read: only counts and ages.
 */
export async function GET() {
  try {
    const { companyId, storeId, country } = await requireContext();
    await requirePermission('confirmation.supervise');
    if (!(await queuePrioritySwitch(db, companyId)).enabled) return NextResponse.json({ enabled: false });
    /*
     * ONE ANSWER A MINUTE PER STORE, IN THE REPORTS LANE (H2, cause 7 of the hang — 18/11). The board refreshes every two minutes for every supervisor
     * who has it open; the same store's counts are now computed once and kept `REPORT_TTL_MS` (60 s), on the reports' own pool. The key is the company
     * and the store — never the reader, never the clock. The switch above stays live. The job that raises the alerts (`jobs/definitions/queue-health.ts`)
     * runs in its own process and keeps reading fresh: this cache helps the door only.
     */
    const [health, weekly] = await heavyOnce(['queue-health', companyId, storeId].join('|'), REPORT_TTL_MS, async () => {
      const now = new Date();
      const cal = { workHoursStart: country.workHoursStart, workHoursEnd: country.workHoursEnd, weekendDays: country.weekendDays, timezone: country.timezone };
      const [h, w, unstaffed] = await Promise.all([
        readQueueHealth(db, { companyId, storeId }, cal, now),
        readRecalibration(db, { companyId, storeId }, country.timezone, now),
        // «طلبات بلا موظفة» (request Q5b, 21/11): only when a routing rule is in force for the store — otherwise the key is absent and the board is as before.
        readUnstaffedOrders(db, { companyId, storeId }, cal, now),
      ]);
      return [unstaffed === undefined ? h : { ...h, unstaffed }, w] as const;
    });
    // the weekly recalibration is a NOTE only (what moved over the last 14 days, and its rule): it changes nothing the pull uses
    // «طلبات بلا موظفة» (request Q5c): the board's line, in the server's words — only while a routing rule is in force (otherwise no key, as before).
    const unstaffed = unstaffedLine(health.unstaffed);
    return NextResponse.json({ enabled: true, health, alerts: healthAlerts(health), rule: HEALTH_RULE_AR, ...(weekly ? { weekly: weekly.note } : {}), ...(unstaffed ? { unstaffed } : {}) });
  } catch (error) {
    return apiErrorResponse(error);
  }
}
