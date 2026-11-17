import { NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { requireContext } from '@/lib/geo-context';
import { requirePermission } from '@/lib/authorization';
import { apiErrorResponse } from '@/lib/api-error';
import { queuePrioritySwitch } from '@/lib/queue-priority-switch';
import { readQueueHealth } from '@/lib/queue-health';
import { HEALTH_RULE_AR, healthAlerts } from '@/lib/queue-health-words';
import { readRecalibration } from '@/lib/queue-recalibration';

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
    const now = new Date();
    const [health, weekly] = await Promise.all([
      readQueueHealth(db, { companyId, storeId }, { workHoursStart: country.workHoursStart, workHoursEnd: country.workHoursEnd, weekendDays: country.weekendDays, timezone: country.timezone }, now),
      readRecalibration(db, { companyId, storeId }, country.timezone, now),
    ]);
    // the weekly recalibration is a NOTE only (what moved over the last 14 days, and its rule): it changes nothing the pull uses
    return NextResponse.json({ enabled: true, health, alerts: healthAlerts(health), rule: HEALTH_RULE_AR, ...(weekly ? { weekly: weekly.note } : {}) });
  } catch (error) {
    return apiErrorResponse(error);
  }
}
