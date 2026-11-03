import { NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { requireContext } from '@/lib/geo-context';
import { getPermissionScope } from '@/lib/authorization';
import { apiError } from '@/lib/api-error';
import { orderListQuery } from '@/lib/order-list-query';
import { maySeeOrderCost } from '@/lib/order-projection';
import { orderSummary, stateCounts } from '@/lib/order-list-summary';

/**
 * GET /api/orders/summary — the counts above the orders list and the cards beside them.
 *
 * Takes the list's own query string and asks the list's own question (`orderListQuery`), so every figure here is a figure
 * about rows this person can open — never a count of the orders her envelope leaves out.
 *
 *   · `counts` — how many of the filtered orders are in each state, with the STATE filter itself left out: a chip says what
 *     pressing it would show, and with the state applied every other chip would read zero. ONE grouped query on the three
 *     columns the state is derived from (`deriveCoreState`), folded here into states — not one count per state.
 *   · `cards` — the filtered set exactly as the list shows it (state included): how many, their total and the average.
 *     The profit only for whoever the list itself hands an order's profit to (`maySeeOrderCost`, the same check
 *     `projectOrder` makes): without it it is neither asked of the database nor sent.
 *
 * No names, phones or addresses — figures only — so nothing here is a customer leaving the building.
 */
export async function GET(req: Request) {
  try {
    const { user, companyId, storeId, country } = await requireContext();
    if (!getPermissionScope(user, 'orders.view')) {
      return NextResponse.json({ error: 'Forbidden: missing required permission orders.view', errorAr: 'لا تملك صلاحية عرض الطلبات.' }, { status: 403 });
    }
    const { searchParams } = new URL(req.url);

    const listed = orderListQuery({ user, companyId, storeId }, searchParams);
    if (!listed.ok) return NextResponse.json({ error: listed.error, errorAr: listed.error }, { status: 400 });

    const withoutState = new URLSearchParams(searchParams);
    withoutState.delete('status');
    const chipped = orderListQuery({ user, companyId, storeId }, withoutState);
    if (!chipped.ok) return NextResponse.json({ error: chipped.error, errorAr: chipped.error }, { status: 400 });

    const withProfit = maySeeOrderCost(user);
    const [groups, totals] = await Promise.all([
      db.order.groupBy({
        by: ['confirmationStatus', 'shippingStatus', 'claimedById'],
        where: chipped.where,
        _count: { _all: true },
      }),
      db.order.aggregate({
        where: listed.where,
        _count: withProfit ? { _all: true, netProfit: true } : { _all: true },
        _sum: withProfit ? { totalAmount: true, netProfit: true } : { totalAmount: true },
      }),
    ]);

    const counts = stateCounts(groups as Parameters<typeof stateCounts>[0]);
    return NextResponse.json({
      counts: counts.states,
      countsTotal: counts.total,
      cards: orderSummary(totals as Parameters<typeof orderSummary>[0], { withProfit, minorUnit: country.minorUnit }),
      currency: { code: country.currencyCode, minorUnit: country.minorUnit },
    });
  } catch (error) {
    const { body, status } = apiError(error);
    return NextResponse.json(body, { status });
  }
}
