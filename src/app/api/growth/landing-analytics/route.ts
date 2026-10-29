import { NextResponse } from 'next/server';
import { requireContext } from '@/lib/geo-context';
import { requirePermission } from '@/lib/authorization';
import { apiErrorResponse } from '@/lib/api-error';
import { getDateRange, type DateFilter } from '@/lib/analytics';
import { landingAnalytics, pageVerdicts } from '@/lib/landing-analytics';

/**
 * GET /api/growth/landing-analytics — the landing pages of the selected
 * store, for the performance screen's date window.
 *
 * Two gates: the performance screen's own (reports.view)
 * AND landing_pages.view — it is marketing data, and a confirmation
 * supervisor who can open the performance screen for the team tables has no
 * business reading it.
 */
export async function GET(req: Request) {
  try {
    const { companyId, storeId } = await requireContext();
    await requirePermission('reports.view');
    await requirePermission('landing_pages.view');

    const q = new URL(req.url).searchParams;
    const filter: DateFilter = {
      period: (q.get('period') as DateFilter['period']) || undefined,
      startDate: q.get('startDate') || undefined,
      endDate: q.get('endDate') || undefined,
    };
    const { start, end } = getDateRange(filter);
    const now = new Date();
    /**
     * THE SAME WINDOW ANSWERS BOTH QUESTIONS.
     *
     * «كيف تعمل صفحاتي» and «أيُّ نسختين تغلب» are read at the same moment
     * by the same person under the same date filter and the same two
     * permission gates. A second endpoint would be a second place for the
     * window to be computed differently.
     */
    const [data, verdicts] = await Promise.all([
      landingAnalytics({ companyId, storeId, start: start ?? now, end: end ?? now }),
      pageVerdicts({ companyId, storeId, start: start ?? now, end: end ?? now }),
    ]);
    return NextResponse.json({ ...data, verdicts });
  } catch (error) {
    return apiErrorResponse(error);
  }
}
