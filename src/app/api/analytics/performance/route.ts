import { apiErrorResponse } from '@/lib/api-error';
import { requireContext } from '@/lib/geo-context';
import { requirePermission } from '@/lib/authorization';
import { answerAnalytics } from '@/lib/analytics-answer';

/**
 * GET /api/analytics/performance — the PERFORMANCE BOARD's numbers.
 *
 * Its own key: «عرض التقارير» (`reports.view`), the key of the board
 * (`/growth/performance`). The same builder and the same projection as the
 * dashboard's answer — money still leaves only with `finance.view`, a
 * colleague's numbers only with the key of a screen that shows them — so the
 * two boards never disagree about one figure. Only the DOOR differs: a person
 * who may open the board but not the dashboard (an accountant with
 * `reports.view` and no `dashboard.view`) reads it here, and a person who
 * holds neither is refused at both.
 */
export async function GET(req: Request) {
  try {
    const { companyId, storeId, user } = await requireContext();
    await requirePermission('reports.view');
    return await answerAnalytics(req, { companyId, storeId, user }, 'analytics-performance');
  } catch (error: any) {
    return apiErrorResponse(error);
  }
}
