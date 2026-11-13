import { db } from './db';
import { commissionCostForOrders } from './commission';
import { expensesOf } from './expense-scope';
import type { ProfitSummary } from './profit-summary';

/**
 * THE NET PROFIT ON `/finance/profit` — ONE FUNCTION, READ BY THE SCREEN AND BY THE PARTNERS (13/11).
 *
 * «الربح لازم يتم توزيعه وفق هاي النسب — الربح الصافي انا بحكي» (the owner). The shares are cut from the number he sees under
 * «صافي الربح» on the profit screen, so there must be exactly one place that number is made. It was made inline in
 * `GET /api/finance`; a second copy for the partners would have agreed with the first today and drifted on the day a rule changed,
 * which is the defect `every-money-writer-is-known` exists to name. The block below is that inline code MOVED, not rewritten:
 * every query and every line of arithmetic is the one the route had, in the same order, and
 * `api/finance/the-profit-summary-is-pinned.test.ts` — written against the route BEFORE the move — holds the figures.
 *
 * WHAT IT IS, SO THE PARTNERS DO NOT READ MORE INTO IT THAN IT SAYS. Since the beginning, for ONE store: the delivered orders
 * (the legacy `status` column, as the screen has always read it), their cost of goods, their shipping, the commissions the ledger
 * holds for them, and the store's live expenses. There is no period here and no period on the screen.
 */
export async function profitToDate(scope: { companyId: string; storeId: string }) {
  const { companyId, storeId } = scope;

  /*
   * THIS STORE'S EXPENSES, AND THE ONES FROM BEFORE EXPENSES HAD A STORE.
   *
   * This read `where: { companyId }`: every store's profit subtracted every store's expenses. A row that
   * carries a store now counts for that store only; a row with none counts as it always did until the
   * owner runs the backfill (expense-scope.ts). The list keeps the CANCELLED rows, marked; the money does not.
   */
  const expenses = await db.expense.findMany({
    where: expensesOf(companyId, storeId, { withCancelled: true }),
    orderBy: { expenseDate: 'desc' },
  });
  const liveExpenses = expenses.filter((e) => !e.voidedAt);

  const deliveredOrders = await db.order.findMany({
    where: { companyId, storeId, status: 'DELIVERED' },
    select: {
      id: true,
      orderNumber: true,
      totalAmount: true,
      shippingCost: true,
      estimatedCostOfGoods: true,
      deliveredAt: true,
    },
    orderBy: { deliveredAt: 'desc' },
  });

  const totalRevenue = deliveredOrders.reduce((s, o) => s + o.totalAmount, 0);
  const totalCOGS = deliveredOrders.reduce((s, o) => s + o.estimatedCostOfGoods, 0);
  const totalShipping = deliveredOrders.reduce((s, o) => s + o.shippingCost, 0);
  // From the LEDGER — the one commission source. Summing
  // Order.moderatorCommission here gave this screen a different total
  // from the commission screen for the same orders.
  // NOTE: the delivered-order query above still selects on the legacy
  // `status` column, so revenue and commission here are computed over
  // slightly different sets of orders. That mismatch predates this change
  // and is reported, not silently repaired — correcting it moves the
  // revenue figure on this screen.
  const totalCommissions = await commissionCostForOrders({ companyId, storeId, shippingStatus: 'DELIVERED' });
  const totalOperationalExpenses = liveExpenses.reduce((s, e) => s + e.amount, 0);

  const netProfit =
    totalRevenue -
    totalCOGS -
    totalShipping -
    totalCommissions -
    totalOperationalExpenses;

  // Typed against the one shape the screen also uses: a field added
  // here without adding it there is a crash on the screen, so the two
  // lists are the same list.
  const summary: ProfitSummary = {
    totalRevenue: Number(totalRevenue.toFixed(2)),
    totalCOGS: Number(totalCOGS.toFixed(2)),
    totalShipping: Number(totalShipping.toFixed(2)),
    totalCommissions: Number(totalCommissions.toFixed(2)),
    // The two are shown together on the profit screen, so they are
    // added HERE. Added in the browser they disagreed with the books
    // the moment either rule changed on this side.
    shippingAndCommissions: Number((totalShipping + totalCommissions).toFixed(2)),
    totalOperationalExpenses: Number(totalOperationalExpenses.toFixed(2)),
    netProfit: Number(netProfit.toFixed(2)),
    profitMargin: totalRevenue > 0 ? Number(((netProfit / totalRevenue) * 100).toFixed(1)) : 0,
  };

  return { expenses, liveExpenses, deliveredOrders, summary };
}
