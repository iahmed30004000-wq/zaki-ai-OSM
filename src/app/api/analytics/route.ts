import { apiErrorResponse } from '@/lib/api-error';
import { requireContext } from '@/lib/geo-context';
import { requirePermission } from '@/lib/authorization';
import { answerAnalytics } from '@/lib/analytics-answer';

/**
 * GET /api/analytics — the DASHBOARD's numbers.
 *
 * Asks «عرض التقارير» (`reports.view`) and nothing else. It used to ask
 * `analytics.view`, which the engine resolved to `reports.view`: one door with
 * two names. The name is gone; the door is not wider. `dashboard.view` opens
 * the dashboard SCREEN and is held by nearly every role (confirmation agents,
 * follow-up agents, the warehouse), so asking it here would have handed the
 * company's numbers to people who get a 403 today — the owner's ruling,
 * 29/10 (independent review of #82): no widening. A holder of `dashboard.view`
 * without `reports.view` still gets a refusal, and the screen SAYS so.
 * The performance board has its own answer, `GET /api/analytics/performance`.
 */
export async function GET(req: Request) {
  try {
    const { companyId, storeId, user } = await requireContext();
    await requirePermission('reports.view');
    return await answerAnalytics(req, { companyId, storeId, user }, 'analytics');
  } catch (error: any) {
    return apiErrorResponse(error);
  }
}
