import {
  CONFIRMATION_REFUSED, DELIVERED_SHIPPING, SHIPPING_GONE, rateOf, whereDelivered,
} from './order-state';
import { db } from './db';
import { calculateRealProfit } from './financial';
import { commissionByUserForOrders, commissionCostForOrders } from './commission';
import { AiBusinessContext } from './ai';
import { endOfLocalDay, startOfLocalDay } from './local-day';
import { notSuperseded } from './superseded';

export interface DateFilter {
  period?: 'today' | 'yesterday' | '7d' | '30d' | 'month' | 'last_month' | 'all';
  startDate?: string;
  endDate?: string;
}

// Hard safety clamp: any computed window wider than 90 days is reduced to the
// last 90 days server-side. This bounds every aggregate query below via the
// orders_companyId_createdAt_idx and keeps memory/CPU predictable. 'all' is
// clamped internally to 90 days too (the frontend keeps sending 'all').
// The one exception is the dashboard and its loss panel, which pass
// `reportRange(filter)` explicitly — see that function.
const MAX_WINDOW_DAYS = 90;

/**
 * These counts used to be read from the LEGACY merged `status` column, with
 * a whitelist per number. Two things were wrong with that, and they made
 * every figure on this screen quietly smaller than the truth:
 *
 *   1. Neither the courier feed nor the door-side partial-delivery recorder
 *      writes that column, so an order delivered either way was invisible to
 *      every count that read it — while the revenue beside it, read from
 *      shippingStatus, could see it. That is how a delivery rate came to
 *      divide one column by another and pass 100%.
 *   2. The whitelists disagreed with each other inside this one file: the
 *      company-wide "rejected" counted a failed delivery as a confirmation
 *      refusal; the per-product one did not.
 *
 * Every count below now reads the two real columns, through the shared
 * definitions in order-state.ts.
 */

/** The earliest moment any analytics query may reach back to. */
function windowStart(): Date {
  const min = new Date();
  min.setHours(0, 0, 0, 0);
  min.setDate(min.getDate() - MAX_WINDOW_DAYS);
  return min;
}

/** An explicit start, pulled forward if it reaches past the safety window. */
function clampStart(start: Date): Date {
  const min = windowStart();
  return start < min ? min : start;
}

/**
 * THE WINDOW IMMEDIATELY BEFORE THIS ONE, THE SAME LENGTH.
 *
 * Derived from `getDateRange` rather than switched on `period` a second
 * time, because two switches on the same enum drift: somebody adds a
 * period to one of them and the comparison quietly keeps answering for a
 * different span than the figure it sits under.
 *
 * «الكل» has no previous — the whole history has nothing before it — and
 * `last_month` is already a comparison, so neither gets one. Both return
 * null, and a card with no previous simply does not draw the line.
 */
export function previousRange(filter: DateFilter): { start: Date; end: Date } | null {
  if ((filter.period ?? 'all') === 'all') return null;
  const { start, end } = getDateRange(filter);
  if (!start || !end) return null;
  const span = end.getTime() - start.getTime();
  if (span <= 0) return null;
  // Ends one millisecond before this window opens, so no order is counted
  // in both halves of a comparison.
  const prevEnd = new Date(start.getTime() - 1);
  return { start: new Date(prevEnd.getTime() - span), end: prevEnd };
}

/**
 * «الكل» MEANS ALL OF IT — on the dashboard, and only there.
 *
 * The owner, 23/10, over a dashboard that said «الكل» and counted 12,449 of
 * 17,328 orders: «الكل مش اخر 90 يوم». The 90-day safety window stays on
 * `getDateRange` itself, which a dozen other screens call and some of them
 * (landing analytics) read as a real span.
 *
 * WHO ASKS FOR THE WHOLE HISTORY: `/api/analytics` (the dashboard tiles) and
 * `/api/analytics/loss` (the loss panel on the same page, so the two never
 * disagree about what «الكل» counted). Each passes this range EXPLICITLY.
 * `getCompanyAnalytics` itself still defaults to `getDateRange`, so the
 * finance summary, the profitability report and the AI summaries keep the
 * window they were written against — widening them was nobody's request.
 *
 * IT IS NOT FREE. Sections 1–2 of the engine are GROUP BYs, but section 3
 * reads one row per order LINE and then every order of those lines into
 * memory. Over the whole history that is tens of thousands of rows, which is
 * why the dashboard refreshes «الكل» every two minutes, not every thirty
 * seconds.
 *
 * An explicit pair of dates is still a window, clamped as before.
 */
export function reportRange(filter: DateFilter): { start?: Date; end?: Date } {
  const allTime = (filter.period || 'all') === 'all' && !(filter.startDate && filter.endDate);
  return allTime ? {} : getDateRange(filter);
}

export function getDateRange(filter: DateFilter): { start?: Date; end?: Date } {
  const now = new Date();
  const period = filter.period || 'all';

  if (filter.startDate && filter.endDate) {
    // A picked day is the WHOLE day, in the reader's own time.
    //
    // "2026-09-21" parses as midnight UTC, so picking a single day used to
    // produce a window of zero width — start and end the same instant — and
    // every figure on the screen came back zero. Worse, the period branches
    // below build their dates in local time, so the two halves of this
    // function disagreed about when a day begins.
    let start = startOfLocalDay(filter.startDate) ?? new Date(filter.startDate);
    const end = endOfLocalDay(filter.endDate) ?? new Date(filter.endDate);
    if (end.getTime() - start.getTime() > MAX_WINDOW_DAYS * 24 * 60 * 60 * 1000) {
      start = clampStart(start);
    }
    return { start, end };
  }

  const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const todayEnd = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 23, 59, 59, 999);

  switch (period) {
    case 'today':
      return { start: todayStart, end: todayEnd };
    case 'yesterday': {
      const yStart = new Date(todayStart);
      yStart.setDate(yStart.getDate() - 1);
      const yEnd = new Date(todayEnd);
      yEnd.setDate(yEnd.getDate() - 1);
      return { start: yStart, end: yEnd };
    }
    case '7d': {
      const d7 = new Date(todayStart);
      d7.setDate(d7.getDate() - 7);
      return { start: d7, end: todayEnd };
    }
    case '30d': {
      const d30 = new Date(todayStart);
      d30.setDate(d30.getDate() - 30);
      return { start: d30, end: todayEnd };
    }
    case 'month': {
      const mStart = new Date(now.getFullYear(), now.getMonth(), 1);
      return { start: mStart, end: todayEnd };
    }
    case 'last_month': {
      const lmStart = new Date(now.getFullYear(), now.getMonth() - 1, 1);
      const lmEnd = new Date(now.getFullYear(), now.getMonth(), 0, 23, 59, 59, 999);
      return { start: lmStart, end: lmEnd };
    }
    case 'all':
    default:
      // "الكل" means the whole safety window, not today. It used to call
      // clampStart(todayStart), and clamping TODAY against a 90-day-ago
      // minimum returns today — so every headline figure on the dashboard
      // was the last 24 hours wearing the label "الكل".
      return { start: windowStart(), end: todayEnd };
  }
}

function round1(n: number): number {
  return Number(n.toFixed(1));
}

function round2(n: number): number {
  return Number(n.toFixed(2));
}

/**
 * scope.storeId = one store's orders; null = every store of the company
 * (company-level reports such as the AI daily summary). Expenses have no
 * store dimension yet and are always company-wide.
 */
export async function getCompanyAnalytics(
  scope: { companyId: string; storeId: string | null },
  filter: DateFilter = {},
  /**
   * An explicit window, overriding the filter's.
   *
   * Used to run this same function over the PREVIOUS period: the
   * comparison must be computed by the code that computes the figure, or
   * the two will drift apart the first time an aggregate changes. Passing
   * a window is the whole extension — no second aggregation exists.
   *
   * An EMPTY window (`{}`, what `reportRange` answers for «الكل») means no
   * date condition at all — the dashboard's whole history.
   */
  window?: { start?: Date; end?: Date }
) {
  const { companyId, storeId } = scope;
  const { start, end } = window ?? getDateRange(filter);

  const dateFilter =
    start && end
      ? {
          createdAt: {
            gte: start,
            lte: end,
          },
        }
      : {};

  const baseWhere = { companyId, ...(storeId ? { storeId } : {}), ...dateFilter };
  /*
   * THE ORDERS THAT COUNT AS SALES. A replaced order — taken back from a
   * courier company, or cancelled at the courier for a change to the goods —
   * is not a second order of the same customer, and the replacement now
   * carries its moderator and campaign; counting both is two confirmations
   * and one return for one sale (src/lib/superseded.ts).
   *
   * ONLY THE COUNTS read this. The delivered figures, the revenue and the
   * commission below keep `baseWhere`: a replaced order is never delivered,
   * so it adds nothing to them, and no money figure on this screen is
   * allowed to move with a reading of history.
   */
  const countedWhere = { ...baseWhere, ...notSuperseded };

  // ─── 1. Status breakdown: two GROUP BYs over the two real columns ───
  const [confirmationGroups, shippingGroups] = await Promise.all([
    db.order.groupBy({ by: ['confirmationStatus'], where: countedWhere, _count: { _all: true } }),
    db.order.groupBy({ by: ['shippingStatus'], where: countedWhere, _count: { _all: true } }),
  ]);

  const confirmationCount = new Map<string, number>();
  let totalOrders = 0;
  for (const g of confirmationGroups) {
    confirmationCount.set(g.confirmationStatus, g._count._all);
    totalOrders += g._count._all;
  }
  const shippingCount = new Map<string, number>();
  for (const g of shippingGroups) shippingCount.set(g.shippingStatus, g._count._all);

  const sumOf = (counts: Map<string, number>, keys: readonly string[]) =>
    keys.reduce((sum, k) => sum + (counts.get(k) || 0), 0);

  const newOrders = confirmationCount.get('NEW') || 0;
  const contactingOrders = confirmationCount.get('IN_PROGRESS') || 0;
  const noAnswerOrders = sumOf(confirmationCount, ['NO_ANSWER', 'FOLLOW_UP_REQUIRED']);
  // Ever confirmed: it stays true after the warehouse packs it and after the
  // courier delivers it, which is what a delivery rate must be measured against.
  const confirmedOrders = confirmationCount.get('CONFIRMED') || 0;
  const postponedOrders = confirmationCount.get('POSTPONED') || 0;
  // A confirmation refusal only. A parcel that came back is not a moderator
  // refusing to confirm, and counting it as one blames the wrong step.
  const rejectedOrders = sumOf(confirmationCount, CONFIRMATION_REFUSED);
  const shippedOrders = sumOf(shippingCount, SHIPPING_GONE);
  const deliveredOrders = sumOf(shippingCount, DELIVERED_SHIPPING);

  // Out of what was DECIDED. Dividing by every order counts the ones nobody
  // has looked at yet as failures, so the rate fell whenever intake sped up
  // — it measured the size of the queue, not the quality of the work.
  const decidedOrders = confirmedOrders + rejectedOrders;
  const confirmationRate = rateOf(confirmedOrders, decidedOrders) ?? 0;
  const deliveryRate = rateOf(deliveredOrders, confirmedOrders) ?? 0;

  // ─── 2. Delivered-order financial aggregates + expenses (SUM in PostgreSQL) ───
  //
  // Read from `shippingStatus`, not from the legacy combined `status`. There
  // are two paths that deliver an order — the shipping transition and the
  // door-side partial-delivery recorder — and only the first kept the legacy
  // column in step. So a delivery recorded at the door contributed nothing
  // to revenue at all, and a PARTIAL one could not contribute even in
  // principle: its status has no legacy spelling.
  //
  // Revenue is what was COLLECTED where that is known. A partial delivery is
  // exactly the case where the order's total and the money taken differ, and
  // it is the money taken that is revenue.
  const deliveredWhere = { ...baseWhere, ...whereDelivered() };

  const [deliveredAgg, collectedAgg, expensesAgg, commissionCost] = await Promise.all([
    db.order.aggregate({
      where: deliveredWhere,
      _sum: {
        totalAmount: true,
        estimatedCostOfGoods: true,
        shippingCost: true,
      },
      _count: { _all: true },
    }),
    // COALESCE has no Prisma aggregate, so the two halves are summed apart:
    // orders where the door recorded a figure, and orders where it did not.
    Promise.all([
      db.order.aggregate({
        where: { ...deliveredWhere, collectedAmount: { not: null } },
        _sum: { collectedAmount: true },
      }),
      db.order.aggregate({
        where: { ...deliveredWhere, collectedAmount: null },
        _sum: { totalAmount: true },
      }),
    ]),
    db.expense.aggregate({
      where: {
        companyId,
        ...(start && end ? { expenseDate: { gte: start, lte: end } } : {}),
      },
      _sum: { amount: true },
    }),
    // ── The commission the profit line subtracts, read from the LEDGER ──
    // It used to be the sum of Order.moderatorCommission: a figure written
    // at ORDER CREATION from a per-user rate, on the selling price, knowing
    // nothing about the rules, their dates or their store. Two engines were
    // live and the wrong one was on the dashboard. This is the same money
    // the commission screen shows and a payout would pay.
    commissionCostForOrders(deliveredWhere),
  ]);

  const totalExpenses = expensesAgg._sum.amount || 0;
  const [withCollected, withoutCollected] = collectedAgg;
  const deliveredRevenue =
    Number(withCollected._sum.collectedAmount || 0) + Number(withoutCollected._sum.totalAmount || 0);

  // calculateRealProfit works on an order list; feeding it the pre-aggregated
  // sums reproduces the exact same arithmetic (and rounding) without loading rows.
  const profitBreakdown = calculateRealProfit({
    deliveredOrders: [
      {
        sellingPrice: 0,
        totalAmount: deliveredRevenue,
        quantity: deliveredAgg._count._all || 1,
        shippingCost: deliveredAgg._sum.shippingCost || 0,
        commission: commissionCost,
        estimatedCostOfGoods: deliveredAgg._sum.estimatedCostOfGoods || 0,
      },
    ],
    operationalExpenses: totalExpenses,
  });

  // ─── 3. Product stats, read from the order LINES ───
  //
  // Grouping on orders.productId counts a whole order against its first
  // product: an order holding a cream and a serum put both its revenue and
  // its delivery under the cream, and the serum looked like it never sold.
  // The lines are where the products actually are, so each one is counted
  // with its own quantity and its own share of the money.
  const lineGroups = await db.orderItem.groupBy({
    by: ['productId', 'orderId'],
    where: { order: countedWhere },
    _sum: { lineTotal: true, quantity: true },
  });

  // The status and the costs belong to the ORDER; a line inherits them, and
  // the order's costs are split across its lines by their share of value so
  // the parts still add back up to the whole.
  const orderIds = Array.from(new Set(lineGroups.map((g) => g.orderId)));
  const orderRows = orderIds.length
    ? await db.order.findMany({
        where: { id: { in: orderIds } },
        select: {
          id: true, confirmationStatus: true, shippingStatus: true,
          totalAmount: true, collectedAmount: true,
          estimatedCostOfGoods: true, shippingCost: true,
        },
      })
    : [];
  const orderOf = new Map(orderRows.map((o) => [o.id, o]));

  // Each order's total line value, to allocate its costs proportionally —
  // and how many rows that allocation has to cover, for the order that has
  // no value to allocate BY.
  const orderLineValue = new Map<string, number>();
  const orderGroupCount = new Map<string, number>();
  for (const g of lineGroups) {
    orderLineValue.set(g.orderId, (orderLineValue.get(g.orderId) ?? 0) + Number(g._sum.lineTotal ?? 0));
    orderGroupCount.set(g.orderId, (orderGroupCount.get(g.orderId) ?? 0) + 1);
  }

  const productGroups = lineGroups.map((g) => {
    const order = orderOf.get(g.orderId);
    const share = (() => {
      const whole = orderLineValue.get(g.orderId) ?? 0;
      // THE SHARES OF ONE ORDER ADD UP TO EXACTLY ONE, VALUE OR NO VALUE.
      //
      // Value cannot be the key when there is no value: a line of 0 out of a
      // whole of 0 is 0/0. What the fallback protects is that division — and
      // the order it was written for has ONE row, where the whole order is
      // that row and a share of 1 is simply correct.
      //
      // But `1` is per ROW, and an order with two products got 1 twice: its
      // shipping cost, its cost of goods AND its collected money were each
      // posted to the product table twice over. A zero whole is reachable —
      // the order PATCH schema takes `unitPrice` `min(0)`, the price box
      // carries `min={0}`, and an order discount that meets a line's
      // subtotal writes `lineTotal` 0 — so the two-product case is live in
      // code even with no such row on this database today (measured
      // 2026-10-07: 56 orders, every one of them a single product group).
      //
      // Split equally instead. One row still gets 1/1 = 1, so the case the
      // fallback was written for answers exactly as it did; N rows get 1/N,
      // which sums to the one whole order the comment above promises.
      if (whole <= 0) return 1 / (orderGroupCount.get(g.orderId) ?? 1);
      return Number(g._sum.lineTotal ?? 0) / whole;
    })();
    return {
      productId: g.productId,
      confirmationStatus: order?.confirmationStatus ?? 'NEW',
      shippingStatus: order?.shippingStatus ?? 'NOT_READY',
      _count: { _all: 1 },
      _sum: {
        // What was actually collected where the door recorded it — the same
        // rule the headline revenue uses. A partial delivery is exactly the
        // case where the two differ, so the product table could never add
        // back up to the number above it.
        totalAmount: Number(order?.collectedAmount ?? order?.totalAmount ?? 0) * share,
        estimatedCostOfGoods: (Number(order?.estimatedCostOfGoods ?? 0)) * share,
        shippingCost: (Number(order?.shippingCost ?? 0)) * share,
      },
    };
  });

  const productIds = Array.from(new Set(productGroups.map((g) => g.productId)));
  const products = productIds.length
    ? await db.product.findMany({
        where: { id: { in: productIds }, companyId },
        select: { id: true, name: true, sku: true, image: true },
      })
    : [];
  const productInfo = new Map(products.map((p) => [p.id, p]));

  const productsMap = new Map<
    string,
    {
      id: string;
      name: string;
      sku: string;
      image: string | null;
      totalOrders: number;
      confirmedOrders: number;
      deliveredOrders: number;
      rejectedOrders: number;
      revenue: number;
      cogs: number;
      shippingCost: number;
      netProfit: number;
      profitMargin: number;
    }
  >();

  for (const g of productGroups) {
    if (!productsMap.has(g.productId)) {
      const info = productInfo.get(g.productId);
      productsMap.set(g.productId, {
        id: g.productId,
        name: info?.name || 'منتج محذوف',
        image: info?.image || null,
        sku: info?.sku || 'N/A',
        totalOrders: 0,
        confirmedOrders: 0,
        deliveredOrders: 0,
        rejectedOrders: 0,
        revenue: 0,
        cogs: 0,
        shippingCost: 0,
        netProfit: 0,
        profitMargin: 0,
      });
    }
    const p = productsMap.get(g.productId)!;
    p.totalOrders += g._count._all;
    if (g.confirmationStatus === 'CONFIRMED') p.confirmedOrders += g._count._all;
    if ((CONFIRMATION_REFUSED as readonly string[]).includes(g.confirmationStatus)) p.rejectedOrders += g._count._all;
    if ((DELIVERED_SHIPPING as readonly string[]).includes(g.shippingStatus)) {
      p.deliveredOrders += g._count._all;
      p.revenue += g._sum.totalAmount || 0;
      p.cogs += g._sum.estimatedCostOfGoods || 0;
      p.shippingCost += g._sum.shippingCost || 0;
    }
  }

  const productStats = Array.from(productsMap.values()).map((p) => {
    const netProfit = p.revenue - p.cogs - p.shippingCost;
    const profitMargin = p.revenue > 0 ? (netProfit / p.revenue) * 100 : 0;
    return {
      ...p,
      netProfit: round2(netProfit),
      profitMargin: round1(profitMargin),
    };
  });

  const mostRequestedProduct = [...productStats].sort((a, b) => b.totalOrders - a.totalOrders)[0];
  const mostConfirmedProduct = [...productStats].sort(
    (a, b) => b.confirmedOrders - a.confirmedOrders
  )[0];
  const mostDeliveredProduct = [...productStats].sort(
    (a, b) => b.deliveredOrders - a.deliveredOrders
  )[0];
  const mostProfitableProduct = [...productStats].sort((a, b) => b.netProfit - a.netProfit)[0];
  const highestRejectionProduct = [...productStats]
    .filter((p) => p.totalOrders >= 1)
    .sort(
      (a, b) => b.rejectedOrders / (b.totalOrders || 1) - a.rejectedOrders / (a.totalOrders || 1)
    )[0];

  // ─── 4. Moderator leaderboard: GROUP BY (moderatorId, status) ───
  const moderatorGroups = await db.order.groupBy({
    by: ['moderatorId', 'confirmationStatus', 'shippingStatus'],
    where: { ...countedWhere, moderatorId: { not: null } },
    _count: { _all: true },
    _sum: {
      totalAmount: true,
    },
  });

  // Commission per person comes from the LEDGER, not from a sum of
  // Order.moderatorCommission. The column was written at creation from a
  // per-user rate that knew nothing about the commission rules; grouping it
  // here produced a leaderboard that disagreed with the commission screen
  // for the same people in the same month.
    // Scoped on `shippingStatus`, which is the column the ledger itself
    // accrues on (`accrueForOrder` refuses anything but DELIVERED there).
    // The legacy combined `status` is NOT synced by every path that
    // delivers an order — the courier webhook writes `shippingStatus` alone
    // — so filtering on it here would silently drop the commission on every
    // order a courier feed delivered.
  const commissionByUser = await commissionByUserForOrders({ ...baseWhere, shippingStatus: 'DELIVERED' });

  const moderatorIds = Array.from(
    new Set(moderatorGroups.map((g) => g.moderatorId).filter((id): id is string => !!id))
  );
  const moderators = moderatorIds.length
    ? await db.user.findMany({
        where: { id: { in: moderatorIds }, companyId },
        select: { id: true, name: true, email: true },
      })
    : [];
  const moderatorInfo = new Map(moderators.map((m) => [m.id, m]));

  const moderatorsMap = new Map<
    string,
    {
      id: string;
      name: string;
      email: string;
      totalOrders: number;
      confirmedOrders: number;
      rejectedOrders: number;
      deliveredOrders: number;
      sales: number;
      commissions: number;
      confirmationRate: number;
      deliveryRate: number;
    }
  >();

  for (const g of moderatorGroups) {
    if (!g.moderatorId) continue;
    if (!moderatorsMap.has(g.moderatorId)) {
      const info = moderatorInfo.get(g.moderatorId);
      moderatorsMap.set(g.moderatorId, {
        id: g.moderatorId,
        name: info?.name || 'Unknown',
        email: info?.email || 'N/A',
        totalOrders: 0,
        confirmedOrders: 0,
        rejectedOrders: 0,
        deliveredOrders: 0,
        sales: 0,
        commissions: 0,
        confirmationRate: 0,
        deliveryRate: 0,
      });
    }
    const m = moderatorsMap.get(g.moderatorId)!;
    m.totalOrders += g._count._all;
    if (g.confirmationStatus === 'CONFIRMED') m.confirmedOrders += g._count._all;
    if ((CONFIRMATION_REFUSED as readonly string[]).includes(g.confirmationStatus)) m.rejectedOrders += g._count._all;
    if ((DELIVERED_SHIPPING as readonly string[]).includes(g.shippingStatus)) {
      m.deliveredOrders += g._count._all;
      m.sales += g._sum.totalAmount || 0;
    }
  }

  const moderatorLeaderboard = Array.from(moderatorsMap.values())
    .map((m) => ({
      ...m,
      sales: round2(m.sales),
      commissions: round2(commissionByUser.get(m.id) ?? 0),
      confirmationRate: m.totalOrders > 0 ? round1((m.confirmedOrders / m.totalOrders) * 100) : 0,
      deliveryRate:
        m.confirmedOrders > 0 ? round1((m.deliveredOrders / m.confirmedOrders) * 100) : 0,
    }))
    .sort((a, b) => b.confirmedOrders - a.confirmedOrders);

  const topModerator = moderatorLeaderboard[0];

  // ─── 5. Recent orders: bounded take:10 (the dashboard renders only the first 8) ───
  const orders = await db.order.findMany({
    where: baseWhere,
    include: {
      product: { select: { id: true, name: true, sku: true, image: true } },
      customer: { select: { id: true, fullName: true, phone: true, city: true } },
      moderator: { select: { id: true, name: true, email: true } },
      offer: { select: { id: true, name: true } },
    },
    orderBy: { createdAt: 'desc' },
    take: 10,
  });

  // ─── 6. AI Business Context ───
  const aiContext: AiBusinessContext = {
    period: filter.period || 'all',
    total_orders: totalOrders,
    confirmed_orders: confirmedOrders,
    rejected_orders: rejectedOrders,
    postponed_orders: postponedOrders,
    delivered_orders: deliveredOrders,
    confirmation_rate: round1(confirmationRate),
    delivery_rate: round1(deliveryRate),
    revenue: profitBreakdown.deliveredRevenue,
    production_cost: profitBreakdown.costOfGoodsSold,
    shipping_cost: profitBreakdown.shippingCosts,
    commission: profitBreakdown.commission,
    operational_expenses: profitBreakdown.operationalExpenses,
    net_profit: profitBreakdown.netProfit,
    profit_margin: profitBreakdown.profitMargin,
    top_demanded_product: mostRequestedProduct?.name || 'N/A',
    top_profitable_product: mostProfitableProduct?.name || 'N/A',
    top_moderator: topModerator?.name || 'N/A',
    highest_rejection_product: highestRejectionProduct?.name || 'N/A',
  };

  return {
    period: filter.period || 'all',
    ordersCount: {
      total: totalOrders,
      new: newOrders,
      contacting: contactingOrders,
      noAnswer: noAnswerOrders,
      confirmed: confirmedOrders,
      postponed: postponedOrders,
      rejected: rejectedOrders,
      // What the confirmation rate is actually out of — so the caption under
      // it can say the truth instead of the order total.
      decided: decidedOrders,
      shipped: shippedOrders,
      delivered: deliveredOrders,
    },
    rates: {
      confirmationRate: round1(confirmationRate),
      deliveryRate: round1(deliveryRate),
    },
    financials: profitBreakdown,
    productStats,
    rankings: {
      mostRequested: mostRequestedProduct,
      mostConfirmed: mostConfirmedProduct,
      mostDelivered: mostDeliveredProduct,
      mostProfitable: mostProfitableProduct,
      highestRejection: highestRejectionProduct,
    },
    moderatorLeaderboard,
    topModerator,
    aiContext,
    orders,
  };
}
