import { NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { requireContext } from '@/lib/geo-context';
import { requirePermission } from '@/lib/authorization';
import { apiErrorResponse } from '@/lib/api-error';
import { getDateRange } from '@/lib/analytics';
import { endOfLocalDay, localDayKey, startOfLocalDay } from '@/lib/local-day';
import { readScorecard, type Grain } from '@/lib/agent-scorecard';
import { REPORT_TTL_MS, heavyOnce } from '@/lib/heavy-lane';

/** The window when none is asked: the last seven days, today included — and no window is longer than this many days (a scorecard row is a day or a week, not a quarter). */
const DEFAULT_DAYS = 7;
const MAX_DAYS = 31;

/**
 * GET /api/performance/scorecard?startDate=&endDate=&grain=day|week — the agent scorecard (step G1 of Confirmation Center v2).
 *
 * One row per agent per day (or week): claims, unique confirmations, the confirmation rate on unique orders, the median time to the first attempt, the quick-release share, the
 * attempts logged, the upsell rate and the delivery rate of her mature confirmations — each with its base and its «قاعدة الاحتساب» (`agent-scorecard.ts`). Read only.
 *
 * The key is the team table's, `team.monitor`, asked before anything is read, and the refusal is the team table's own words. Agents and counts only — no customer field —
 * and the rows are by day then by name: there is no parameter that ranks people.
 */
export async function GET(req: Request) {
  try {
    const { companyId, storeId, country } = await requireContext();
    await requirePermission('team.monitor');

    const { searchParams } = new URL(req.url);
    const now = new Date();
    const grain: Grain = searchParams.get('grain') === 'week' ? 'week' : 'day';
    const asked = { startDate: searchParams.get('startDate') || undefined, endDate: searchParams.get('endDate') || undefined };
    let { start, end } = asked.startDate && asked.endDate ? getDateRange(asked) : {};
    if (!start || !end || isNaN(start.getTime()) || isNaN(end.getTime())) {
      const from = new Date(now);
      from.setDate(from.getDate() - (DEFAULT_DAYS - 1));
      start = startOfLocalDay(localDayKey(from))!;
      end = endOfLocalDay(localDayKey(now))!;
    }
    // never more than MAX_DAYS: the start is pulled forward, the end is the asked one
    const floor = new Date(end.getTime() - MAX_DAYS * 86_400_000);
    if (start.getTime() < floor.getTime()) start = floor;

    const calendar = {
      workHoursStart: country.workHoursStart,
      workHoursEnd: country.workHoursEnd,
      weekendDays: country.weekendDays,
      timezone: country.timezone,
    };
    /*
     * IN THE REPORTS LANE, ONE ANSWER A MINUTE PER QUESTION (H2, cause 8 of the hang — 18/11). Up to 4 × 50,000 + 100,000 rows were read on the
     * site's main pool for every opening of the board. Now they run on the reports' own pool (`heavyOnce` → `runInHeavyLane`), two people asking the
     * same window share one computation, and the answer is kept `REPORT_TTL_MS`. The key names the question completely — company, store, the window
     * and the grain — and never the reader: the key above was already asked of him.
     */
    const key = ['score-card', companyId, storeId, start.toISOString(), end.toISOString(), grain].join('|');
    const card = await heavyOnce(key, REPORT_TTL_MS, () => readScorecard(db, { companyId, storeId, start: start!, end: end!, calendar, grain }, now));
    return NextResponse.json({
      grain,
      window: { start: start.toISOString(), end: end.toISOString(), timezone: country.timezone },
      deliveryMaturityDays: 7,
      ...card,
    });
  } catch (error) {
    return apiErrorResponse(error);
  }
}
