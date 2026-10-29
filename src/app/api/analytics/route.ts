import { apiErrorResponse } from '@/lib/api-error';
import { requireContext } from '@/lib/geo-context';
import { requirePermission } from '@/lib/authorization';
import { answerAnalytics } from '@/lib/analytics-answer';

/**
 * GET /api/analytics — the DASHBOARD's numbers.
 *
 * Its own key: «عرض لوحة التحكم» (`dashboard.view`), the key of the screen
 * that draws them. It used to ask `analytics.view`, which the engine resolved
 * to `reports.view` — so the dashboard's API and the performance board's API
 * were one door with two names. The performance board has its own now:
 * `GET /api/analytics/performance`, on `reports.view`.
 */
export async function GET(req: Request) {
  try {
    const { companyId, storeId, user } = await requireContext();
    await requirePermission('dashboard.view');
    return await answerAnalytics(req, { companyId, storeId, user }, 'analytics');
  } catch (error: any) {
    return apiErrorResponse(error);
  }
}
