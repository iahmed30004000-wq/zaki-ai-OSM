import { NextRequest, NextResponse } from 'next/server';
import { requireContext } from '@/lib/geo-context';
import { requirePermission } from '@/lib/authorization';
import { apiErrorResponse } from '@/lib/api-error';
import { maySeeCost } from '@/lib/cost-visibility';
import { exitMonthAnswer, exitMonthShown, resolveExitMonth } from '@/lib/stock-exit-report';

/**
 * GET /api/inventory/exits/month?month=YYYY-MM (inventory.view) — the month's exits of THIS store: what left for good, why, who
 * asked, who approved, and — for a holder of `costs.view` only — its value at cost (`lib/stock-exit-report.ts`).
 *
 * THE MONTH: the store's month (the country's time zone). No `month` is this month; a malformed month → 400 `INVALID_MONTH`; a
 * month still to come → 400 `MONTH_IN_FUTURE`. The answer is a report: computed in the reports lane, once per (company, store,
 * month) — not per person — and only then cut to what this person may read. Reading only; nothing here touches money.
 */
export async function GET(request: NextRequest) {
  try {
    const { user, companyId, storeId, country } = await requireContext();
    await requirePermission('inventory.view');

    const when = resolveExitMonth(new URL(request.url).searchParams.get('month'), new Date(), country.timezone);
    if (!when.ok) return NextResponse.json({ error: when.errorAr, errorAr: when.errorAr, code: when.code }, { status: 400 });

    const answer = await exitMonthAnswer({ companyId, storeId, timeZone: country.timezone, minorUnit: country.minorUnit, when });
    return NextResponse.json(exitMonthShown(answer, maySeeCost(user)));
  } catch (error) {
    return apiErrorResponse(error);
  }
}
