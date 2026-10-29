import { NextResponse } from 'next/server';
import { projectAnalytics } from '@/lib/analytics-projection';
import { apiErrorResponse } from '@/lib/api-error';
import { requireContext } from '@/lib/geo-context';
import { can, requirePermission } from '@/lib/authorization';
import { getCompanyAnalytics, reportRange, previousRange, DateFilter } from '@/lib/analytics';
import { rateLimit } from '@/lib/rate-limit';
import { db } from '@/lib/db';
import { expensesOf } from '@/lib/expense-scope';
import { countOutcomes } from '@/lib/order-outcome';
import { DELIVERED_SHIPPING, rateOf, whereDelivered } from '@/lib/order-state';
import {
  DOOR_FAILED_SHIPPING,
  DOOR_RETURNED_SHIPPING,
  UNCOLLECTED_SETTLEMENT,
  UNRECORDED_SETTLEMENT,
  doorOutcome,
  trustOf,
  type DoorOutcome,
} from '@/lib/cod-vitals';

/**
 * WHAT THE DOOR DECIDED, FOR ONE WINDOW.
 *
 * Three counts rather than a groupBy so the three sets read as the three
 * facts they are, and so `doorOutcome` — which owns the denominator — is the
 * only place the arithmetic happens.
 */
async function doorFor(where: Record<string, unknown>): Promise<DoorOutcome & { delivered: number; failed: number; returned: number }> {
  const [delivered, failed, returned] = await Promise.all([
    db.order.count({ where: { ...where, ...whereDelivered() } }),
    db.order.count({ where: { ...where, shippingStatus: { in: [...DOOR_FAILED_SHIPPING] } } }),
    db.order.count({ where: { ...where, shippingStatus: { in: [...DOOR_RETURNED_SHIPPING] } } }),
  ]);
  return { delivered, failed, returned, ...doorOutcome({ delivered, failed, returned }) };
}

/** Every shipping status the door has finished with, for a per-product rate. */
const DOOR_DECIDED_SHIPPING = [
  ...DELIVERED_SHIPPING,
  ...DOOR_FAILED_SHIPPING,
  ...DOOR_RETURNED_SHIPPING,
];

export interface ProductReturns {
  productId: string;
  returned: number;
  decided: number;
  /** Whole-number percentage, or null when the door decided nothing for it. */
  rate: number | null;
}

/**
 * WHICH PRODUCT THE CUSTOMER REFUSES AT THE DOOR.
 *
 * Nothing in this system computed it. `productStats` counts rejections — the
 * refusal on the PHONE, before a fee was paid — and stops there, so the
 * expensive half of the same question had no answer anywhere: 22% of parcels
 * that reached a verdict came back, and no screen could say which product
 * they were.
 *
 * Grouped on (productId, orderId) and counted one per pair, exactly the way
 * `getCompanyAnalytics` reads its product stats. Counting LINES instead
 * would make a product ordered twice on one parcel come back twice, and a
 * rate whose numerator and denominator count different things is the defect
 * that put a delivery rate over 100% in this file's history.
 */
async function returnsByProduct(where: Record<string, unknown>): Promise<ProductReturns[]> {
  const [returnedPairs, decidedPairs] = await Promise.all([
    db.orderItem.groupBy({
      by: ['productId', 'orderId'],
      where: { order: { ...where, shippingStatus: { in: [...DOOR_RETURNED_SHIPPING] } } },
    }),
    db.orderItem.groupBy({
      by: ['productId', 'orderId'],
      where: { order: { ...where, shippingStatus: { in: DOOR_DECIDED_SHIPPING } } },
    }),
  ]);

  const tally = new Map<string, { returned: number; decided: number }>();
  const at = (id: string) => {
    const row = tally.get(id) ?? { returned: 0, decided: 0 };
    tally.set(id, row);
    return row;
  };
  for (const p of decidedPairs) at(p.productId).decided++;
  for (const p of returnedPairs) at(p.productId).returned++;

  return [...tally.entries()]
    .map(([productId, v]) => ({ productId, ...v, rate: rateOf(v.returned, v.decided) }))
    // Most parcels back first. By COUNT and not by rate: one product out of
    // three coming back is 33% and one parcel, and thirty out of a hundred
    // and fifty is the money. The rate travels beside each row with its own
    // verdict, which is where a small sample gets refused.
    .sort((a, b) => b.returned - a.returned || (b.rate ?? 0) - (a.rate ?? 0));
}

export async function GET(req: Request) {
  try {
    const { companyId, storeId, user } = await requireContext();
    // Canonical gate — analytics access is explicit, not implicit by role
    await requirePermission('analytics.view');

    // Heavy analytics query — rate limit generously (30/min per user) so the
    // dashboard's 30s polling never hits it, but runaway clients are capped.
    const rl = rateLimit(`analytics:${companyId}:${user.id}`, 30, 60 * 1000);
    if (!rl.allowed) {
      return NextResponse.json(
        { errorAr: `طلبات كثيرة جداً. أعد المحاولة بعد ${rl.retryAfterSec} ثانية` },
        { status: 429 }
      );
    }

    const { searchParams } = new URL(req.url);

    const period = (searchParams.get('period') as any) || 'all';
    const startDate = searchParams.get('startDate') || undefined;
    const endDate = searchParams.get('endDate') || undefined;

    const filter: DateFilter = { period, startDate, endDate };
    // «الكل» on the dashboard is the whole history — asked for here, by
    // name, and not by the engine's default (see `reportRange`).
    const analytics = await getCompanyAnalytics({ companyId, storeId }, filter, reportRange(filter));
    // Where every order ended up, in the owner's words — over the WHOLE
    // history, not the period: «how did my orders end» is asked of all of them.
    const outcomes = await countOutcomes(db, { companyId, storeId });

    /**
     * AND THE SAME FIGURES FOR THE WINDOW BEFORE THIS ONE.
     *
     * «٣٧٥ ديناراً» is not information. «٣٧٥، وكانت ٥١٠» is a morning's
     * work. Every number a manager opens this screen for is a comparison
     * they were going to make in their head anyway, usually wrongly.
     *
     * Only the handful the cards show, and only when the period HAS a
     * before: «الكل» has no previous, so the cards simply draw no line.
     */
    const prior = previousRange(filter);

    /**
     * THE COD VITALS — the numbers this screen was missing, and the gate
     * that decides whether the ones it already had may be printed.
     *
     * Computed here rather than inside `getCompanyAnalytics` because that
     * function is the profit engine that four screens and the assistant all
     * read, and none of the others asks these questions. What it owns — the
     * window, the scope, the revenue rule — is reused rather than rebuilt.
     */
    const { start, end } = reportRange(filter);
    const scopeWhere = { companyId, ...(storeId ? { storeId } : {}) };
    const windowWhere = {
      ...scopeWhere,
      ...(start && end ? { createdAt: { gte: start, lte: end } } : {}),
    };

    const [door, priorDoor, productReturns, deliveredCount, costedCount, expenseRows, outstanding, unrecorded] =
      await Promise.all([
        doorFor(windowWhere),
        prior ? doorFor({ ...scopeWhere, createdAt: { gte: prior.start, lte: prior.end } }) : Promise.resolve(null),
        returnsByProduct(windowWhere),

        /**
         * THE COVERAGE OF THE ONE FIELD THE WHOLE PROFIT LINE RESTS ON.
         *
         * Measured on the live database before this was written: cost of
         * goods is recorded on 4 of 119 delivered orders, so the margin the
         * cards printed was 76.93% — revenue with the word «ربح» over it.
         * The count is cheap and it is the difference between a screen that
         * lies confidently and one that says which field to go and fill in.
         */
        db.order.count({ where: { ...windowWhere, ...whereDelivered() } }),
        db.order.count({ where: { ...windowWhere, ...whereDelivered(), estimatedCostOfGoods: { gt: 0 } } }),

        // Expenses have no per-order denominator, so they are not a coverage
        // share. An empty table is still a
        // hole in the net profit, and the screen says so rather than
        // subtracting zero and calling the result net.
        db.expense.count({
          where: { ...expensesOf(companyId, storeId), ...(start && end ? { expenseDate: { gte: start, lte: end } } : {}) },
        }),

        /**
         * THE MONEY DELIVERED AND NOT YET IN OUR HANDS.
         *
         * DELIBERATELY NOT WINDOWED. Money a courier owes us is owed
         * whatever month the order was typed in, and a figure that shrinks
         * when somebody clicks «اليوم» would be read as an exposure that
         * shrank. Every other number on this screen belongs to the chosen
         * period; this one belongs to the shop, and the card says so.
         *
         * The two halves are summed apart because Prisma has no COALESCE
         * aggregate — the same shape, for the same reason, as the delivered
         * revenue in `analytics.ts`, and the same rule: what the door
         * recorded where it recorded anything, the order's total where it
         * did not.
         */
        Promise.all([
          db.order.aggregate({
            where: {
              ...scopeWhere,
              shippingStatus: { in: [...DELIVERED_SHIPPING] },
              settlementStatus: { in: [...UNCOLLECTED_SETTLEMENT] },
              collectedAmount: { not: null },
            },
            _sum: { collectedAmount: true },
            _count: { _all: true },
          }),
          db.order.aggregate({
            where: {
              ...scopeWhere,
              shippingStatus: { in: [...DELIVERED_SHIPPING] },
              settlementStatus: { in: [...UNCOLLECTED_SETTLEMENT] },
              collectedAmount: null,
            },
            _sum: { totalAmount: true },
            _count: { _all: true },
          }),
        ]),

        // Delivered, and nobody wrote down whether the cash came back. Not
        // a debt and not a settlement — a hole, counted so it can be named.
        db.order.count({
          where: {
            ...scopeWhere,
            shippingStatus: { in: [...DELIVERED_SHIPPING] },
            settlementStatus: { in: [...UNRECORDED_SETTLEMENT] },
          },
        }),
      ]);

    const previous = prior
      ? await getCompanyAnalytics({ companyId, storeId }, filter, prior).then((p) => ({
          netProfit: p.financials.netProfit,
          deliveredRevenue: p.financials.deliveredRevenue,
          confirmationRate: p.rates.confirmationRate,
          deliveryRate: p.rates.deliveryRate,
          orders: p.ordersCount.total,
          returnRate: priorDoor?.returnRate ?? null,
        }))
      : null;

    const [collected, uncollected] = outstanding;
    const outstandingMoney =
      Number(collected._sum.collectedAmount || 0) + Number(uncollected._sum.totalAmount || 0);

    /*
     * THE MONEY LEAVES ONLY FOR SOMEBODY ALLOWED TO SEE MONEY.
     *
     * This route is gated on `analytics.view`, which the engine resolves
     * to `reports.view` — and a MODERATOR holds that. So the payload was
     * handing a salesperson the company's `netProfit`, `grossProfit`,
     * `profitMargin`, `costOfGoodsSold`, `commission` and
     * `operationalExpenses`.
     *
     * The dashboard never SHOWED them those cards: it wraps every
     * financial tile in `canFinance`, which reads `finance.view`. So the
     * rule was already decided and already written down — on the client,
     * where it is a decoration. «A control hidden in the UI but permitted
     * by the API is not a permission.»
     *
     * Verified as `sara@bioderma.com` (MODERATOR, no `finance.view`):
     * `GET /api/analytics?period=today` answered 200 with the whole
     * `financials` object.
     *
     * The COUNTS stay. How many orders were confirmed or delivered is
     * this person's own work, and the rates are what the screen is for.
     */
    const maySeeMoney = can(user, 'finance.view');

    return NextResponse.json({
      // Money in every shape — products, rankings, colleagues' sales and
      // commission, the AI context — and colleagues' names, each to its own
      // key; the latest orders with their customers' phones to nobody. See
      // analytics-projection.ts.
      ...projectAnalytics(analytics as unknown as Record<string, unknown>, user),
      outcomes,
      previous: maySeeMoney
        ? previous
        : previous && (({ netProfit, deliveredRevenue, ...p }) => p)(previous as typeof previous & { deliveredRevenue?: unknown }),
      vitals: {
        door: {
          delivered: door.delivered,
          failed: door.failed,
          returned: door.returned,
          decided: door.decided,
          returnRate: door.returnRate,
          failureRate: door.failureRate,
        },
        // The verdict travels with the figures it governs, so no screen has
        // to remember which of them rest on a cost.
        cost: trustOf({ present: costedCount, population: deliveredCount, subject: 'كلفة البضاعة' }),
        expenses: { rows: expenseRows },
        // Keyed by product id and NOT joined to a name here: `productStats`
        // in the same payload already carries every product's name, and
        // sending it twice is how one screen comes to show a product under
        // two spellings.
        returnsByProduct: productReturns,
        outstanding: {
          orders: collected._count._all + uncollected._count._all,
          // The money still out with couriers is money: the tile showing it
          // is behind «عرض المالية» on the screen, and now here too.
          ...(maySeeMoney ? { money: Math.round(outstandingMoney * 100) / 100 } : {}),
          unrecordedOrders: unrecorded,
        },
      },
    });
  } catch (error: any) {
    return apiErrorResponse(error);
  }
}
