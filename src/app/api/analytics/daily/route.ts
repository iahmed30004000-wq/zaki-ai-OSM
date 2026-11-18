import { NextResponse } from 'next/server';
import { apiErrorResponse } from '@/lib/api-error';
import { requireContext } from '@/lib/geo-context';
import { requirePermission } from '@/lib/authorization';
import { rateLimit } from '@/lib/rate-limit';
import { REPORT_TTL_MS, heavyOnce } from '@/lib/heavy-lane';
import { MAX_SERIES_DAYS, dailySeries, seriesSpan } from '@/lib/daily-series';

/**
 * GET /api/analytics/daily?from=YYYY-MM-DD&to=YYYY-MM-DD — the orders of each day, for the dashboard's one chart.
 *
 * «عرض التقارير» (`reports.view`), the same key as the dashboard's own answer: a person who may read the dashboard's numbers may read
 * them day by day, and nobody else gets a wider door. The days are the STORE's days (its own clock, `country.timezone`), counted on
 * the day each event happened (see `lib/daily-series.ts`). Counts only — no amount leaves here.
 *
 * `from` and `to` are both required and inclusive; a span of more than 92 days is refused with a sentence, never shortened. It runs in
 * the reports' lane and is shared between tabs for a minute, like every other report; the key holds the company, the store and the
 * days — never a person.
 */
export async function GET(req: Request) {
  try {
    const { companyId, storeId, user, country } = await requireContext();
    await requirePermission('reports.view');

    const rl = rateLimit(`analytics-daily:${companyId}:${user.id}`, 30, 60 * 1000);
    if (!rl.allowed) {
      return NextResponse.json({ errorAr: `طلبات كثيرة جداً. أعد المحاولة بعد ${rl.retryAfterSec} ثانية` }, { status: 429 });
    }

    const params = new URL(req.url).searchParams;
    const from = params.get('from');
    const to = params.get('to');
    const span = seriesSpan(from, to, country.timezone);
    if (!span.ok) {
      return NextResponse.json(
        {
          errorAr:
            span.reason === 'too-long'
              ? `المدة أطول من ${MAX_SERIES_DAYS} يوماً. اختر مدة أقصر.`
              : 'حدّد يوم البداية ويوم النهاية بالترتيب (سنة-شهر-يوم).',
        },
        { status: 400 },
      );
    }

    const key = ['daily', companyId, storeId, from, to].join('|');
    const series = await heavyOnce(key, REPORT_TTL_MS, () => dailySeries({ companyId, storeId }, span, country.timezone));

    return NextResponse.json({ ...series, from, to, timezone: country.timezone });
  } catch (error) {
    return apiErrorResponse(error);
  }
}
