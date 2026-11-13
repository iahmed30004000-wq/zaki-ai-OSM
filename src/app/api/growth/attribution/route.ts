import { NextResponse } from 'next/server';
import { requireContext } from '@/lib/geo-context';
import { requirePermission } from '@/lib/authorization';
import { apiErrorResponse } from '@/lib/api-error';
import { getDateRange, type DateFilter } from '@/lib/analytics';
import { attributionTotals, channelPerformance, moderatorPerformance } from '@/lib/attribution-performance';
import { REPORT_TTL_MS, heavyOnce } from '@/lib/heavy-lane';

/**
 * GET /api/growth/attribution?period=&startDate=&endDate=
 *
 * Who brought the business and what became of it — by moderator, and by the
 * channel the order came through. One request for both, on one window, so
 * the two halves of the screen can never be describing different weeks.
 */
export async function GET(req: Request) {
  try {
    const { companyId, storeId } = await requireContext();
    await requirePermission('reports.view');

    const q = new URL(req.url).searchParams;
    const filter: DateFilter = {
      period: (q.get('period') as DateFilter['period']) || undefined,
      startDate: q.get('startDate') || undefined,
      endDate: q.get('endDate') || undefined,
    };
    const { start, end } = getDateRange(filter);
    const scope = { companyId, storeId, start, end };

    // One computation per question, in the reports' lane (`lib/heavy-lane.ts`): fourteen grouped counts that the board, the dashboard
    // and every open tab would otherwise start again, in front of everybody else's queries. Nothing here depends on who asks.
    const key = ['attribution', companyId, storeId, start?.toISOString() ?? '', end?.toISOString() ?? ''].join('|');
    const [moderators, channels] = await heavyOnce(key, REPORT_TTL_MS, () =>
      Promise.all([moderatorPerformance(scope), channelPerformance(scope)])
    );

    return NextResponse.json({
      moderators,
      channels,
      // The totals line is a row like any other — and its two rates have
      // denominators the rows cannot be added up to produce.
      totals: {
        moderators: attributionTotals(moderators),
        channels: attributionTotals(channels),
      },
      window: { start: start?.toISOString() ?? null, end: end?.toISOString() ?? null },
      definitions: {
        brought: 'الطلبات المنسوبة إليه والتي أُنشئت خلال المدة',
        confirmationRate: 'المؤكد ÷ ما وصل إلى قرار — ما زال قيد العمل لا يُحسب',
        deliveryRate: 'الموصَّل ÷ المؤكد — طلب لم يُؤكَّد لم يكن للمندوب أن يوصّله',
        revenue: 'المحصَّل فعلاً حيث نعرفه، وإجمالي الطلب حيث لا نعرفه — نفس تعريف شاشة الأرباح',
        revenuePerOrder: 'ما يساويه طلب واحد جاء منه، بعد كل شيء',
      },
    });
  } catch (error) {
    return apiErrorResponse(error);
  }
}
