import { NextResponse } from 'next/server';
import { requireContext } from '@/lib/geo-context';
import { requirePermission } from '@/lib/authorization';
import { apiErrorResponse } from '@/lib/api-error';
import { getCompanyAnalytics } from '@/lib/analytics';
import { readLimit } from '@/lib/numeric-input';
import { REPORT_TTL_MS, heavyOnce } from '@/lib/heavy-lane';

/**
 * GET /api/finance/profitability?from=&to=&limit=
 *
 * What each product earned, and what it cost to earn it.
 *
 * It used to sum `orders.totalRevenue` and `orders.netProfit` — a family of
 * financial-snapshot columns that nothing in the system has ever written.
 * Zero of a hundred and fifty-two orders carried a value, so every product
 * reported a revenue of zero, which is presumably why no screen was ever
 * pointed at it.
 *
 * It now asks the same function the dashboard asks. One profit calculation,
 * reading the columns that actually hold money, split across an order's
 * lines so a product is credited with what it sold rather than with whatever
 * happened to be first on the order.
 */
export async function GET(req: Request) {
  try {
    const { companyId, storeId } = await requireContext();
    await requirePermission('finance.view');

    const { searchParams } = new URL(req.url);
    const startDate = searchParams.get('from') || undefined;
    const endDate = searchParams.get('to') || undefined;
    /*
     * HOW MANY PRODUCTS THE REPORT SHOWS — THE SHARED READER, NOT A HAND.
     *
     * It read `Math.min(parseInt(get('limit') || '20', 10) || 20, 100)`, which
     * had the two faults `0aea050` named and this endpoint was left out of:
     *
     *   · `|| 20` is a falsy guard, so **`?limit=0` silently became 20** —
     *     the one request that asks for nothing answered with the default;
     *   · there was NO LOWER CLAMP, so **`?limit=-5` reached `.slice(0, -5)`
     *     and dropped the last five products from a profit report** — no
     *     crash, no write, a quietly wrong answer.
     *
     * Clamped rather than refused, by the rule `0aea050` settled: the number
     * is written nowhere and only selects which rows are looked at.
     */
    const limit = readLimit(searchParams, 20, 100);

    // In the reports lane and kept a minute (H2, cause 6 of the hang — 18/11), keyed by the company, the store and the span asked. The key is the
    // summary door's own (`../summary/route.ts`): the two ask the engine the same question, so one computation answers both.
    const filter = startDate && endDate ? { startDate, endDate } : { period: 'all' as const };
    const key = ['finance-analytics', companyId, storeId, startDate && endDate ? `${startDate}~${endDate}` : 'all'].join('|');
    const analytics = await heavyOnce(key, REPORT_TTL_MS, () => getCompanyAnalytics({ companyId, storeId }, filter));

    const products = (analytics.productStats ?? [])
      .filter((p: { deliveredOrders: number }) => p.deliveredOrders > 0)
      .sort((a: { netProfit: number }, b: { netProfit: number }) => b.netProfit - a.netProfit)
      .slice(0, limit)
      .map((p: {
        id: string; name: string; sku: string;
        totalOrders: number; deliveredOrders: number;
        revenue: number; cogs: number; shippingCost: number;
        netProfit: number; profitMargin: number;
      }) => ({
        productId: p.id,
        name: p.name,
        sku: p.sku,
        ordersCount: p.totalOrders,
        deliveredOrders: p.deliveredOrders,
        // Units are not tracked per product in the delivered aggregate; the
        // order count is the honest figure here rather than a guess.
        quantitySold: p.deliveredOrders,
        revenue: p.revenue.toFixed(2),
        cogs: p.cogs.toFixed(2),
        shippingCost: p.shippingCost.toFixed(2),
        netProfit: p.netProfit.toFixed(2),
        profitMargin: p.profitMargin,
      }));

    return NextResponse.json({ products });
  } catch (error) {
    return apiErrorResponse(error);
  }
}
