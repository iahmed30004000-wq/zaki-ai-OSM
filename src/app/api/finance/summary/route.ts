import { NextResponse } from 'next/server';
import { apiErrorResponse } from '@/lib/api-error';
import { db } from '@/lib/db';
import { requireContext } from '@/lib/geo-context';
import { requirePermission } from '@/lib/authorization';
import { getCompanyAnalytics } from '@/lib/analytics';
import { REPORT_TTL_MS, heavyOnce } from '@/lib/heavy-lane';

/**
 * GET /api/finance/summary?from=&to=
 *
 * The money, aggregated on the server — no raw orders sent to a browser.
 *
 * This used to SUM stored columns: totalRevenue, grossProfit, netProfit,
 * productCost, packagingCost, advertisingCost, otherCost, subtotal,
 * discount. Not one of them is ever written. On the live database that is
 * zero of a hundred and fifty-five orders for every single one, so this
 * endpoint answered every question with zero and a null margin — and it
 * looked like a company that had sold nothing.
 *
 * It now delegates to the one analytics engine, which reads the columns that
 * ARE written: totalAmount on delivered orders, their shipping, their
 * commissions, their cost of goods, and the company's own expenses. One
 * place computes profit; this endpoint shapes it for its screen.
 */
export async function GET(req: Request) {
  try {
    const { companyId, storeId } = await requireContext();
    await requirePermission('finance.view');
    const { searchParams } = new URL(req.url);

    const from = searchParams.get('from');
    const to = searchParams.get('to');
    const hasRange = Boolean(from && to);

    // In the reports lane and kept a minute (H2, cause 6 of the hang — 18/11), keyed by the company, the store and the span asked — the
    // profitability door's own key (`../profitability/route.ts`), so one computation answers both. The settlement counts below stay live.
    const key = ['finance-analytics', companyId, storeId, hasRange ? `${from}~${to}` : 'all'].join('|');
    const analytics = await heavyOnce(key, REPORT_TTL_MS, () =>
      getCompanyAnalytics(
        { companyId, storeId },
        // An explicit start+end wins over the period in getDateRange, so the
        // range travels without inventing a period name it does not know.
        hasRange ? { startDate: from!, endDate: to! } : { period: 'all' }
      )
    );

    const f = analytics.financials;

    // Settlement is a different question from profit — where the money is,
    // not how much of it is ours — so it is still counted here directly.
    const dateWhere = hasRange
      ? { createdAt: { gte: new Date(from!), lte: new Date(to!) } }
      : {};
    const [settled, pending, refunded] = await Promise.all([
      db.order.count({ where: { companyId, storeId, ...dateWhere, settlementStatus: 'SETTLED' } }),
      db.order.count({
        where: { companyId, storeId, ...dateWhere, settlementStatus: { in: ['PENDING', 'PENDING_COLLECTION'] } },
      }),
      db.order.count({
        where: { companyId, storeId, ...dateWhere, settlementStatus: { in: ['REFUNDED', 'PARTIALLY_REFUNDED'] } },
      }),
    ]);

    const delivered = analytics.ordersCount.delivered;

    return NextResponse.json({
      summary: {
        ordersConfirmed: analytics.ordersCount.confirmed,
        ordersDelivered: delivered,
        // Revenue is what was DELIVERED. A confirmed order that never
        // reached a door is not money; counting it is how a forecast
        // becomes a figure people spend against.
        totalRevenue: f.deliveredRevenue,
        grossProfit: f.grossProfit,
        netProfit: f.netProfit,
        profitMargin: f.profitMargin,
        avgOrderValue: delivered > 0 ? Number((f.deliveredRevenue / delivered).toFixed(2)) : null,
        costs: {
          product: f.costOfGoodsSold,
          shipping: f.shippingCosts,
          commissions: f.commission,
          operational: f.operationalExpenses,
        },
        settlement: { settled, pending, refunded },
      },
      definitions: {
        totalRevenue: 'مجموع مبالغ الطلبات المسلَّمة',
        grossProfit: 'الإيراد المسلَّم − تكلفة البضاعة',
        netProfit: 'الإيراد المسلَّم − البضاعة − الشحن − العمولات − المصاريف التشغيلية',
        profitMargin: 'صافي الربح ÷ الإيراد المسلَّم %',
        avgOrderValue: 'الإيراد المسلَّم ÷ عدد الطلبات المسلَّمة',
      },
    });
  } catch (error: unknown) {
    return apiErrorResponse(error);
  }
}
