import { db } from './db';
import { commissionCostForOrders } from './commission';
import { expensesOf } from './expense-scope';
import { dayRange, localDay } from './eod-report';
import { whereDelivered } from './order-state';
import { revenueOf } from './delivered-revenue';
import { isManualDraftHash } from './manual-statement-rules';
import type { ProfitSummary } from './profit-summary';

/**
 * THE NET PROFIT ON `/finance/profit` — ONE FUNCTION, READ BY THE SCREEN AND BY THE PARTNERS (13/11).
 *
 * «الربح لازم يتم توزيعه وفق هاي النسب — الربح الصافي انا بحكي» (the owner). The shares are cut from the number he sees under
 * «صافي الربح» on the profit screen, so there must be exactly one place that number is made. It was made inline in
 * `GET /api/finance`; a second copy for the partners would have agreed with the first today and drifted on the day a rule changed,
 * which is the defect `every-money-writer-is-known` exists to name.
 *
 * WHAT IT IS, SO THE PARTNERS DO NOT READ MORE INTO IT THAN IT SAYS. For ONE store: the delivered orders, their cost of goods,
 * their shipping, the commissions the ledger holds for them, and the store's live expenses — counted from the store's PROFIT EPOCH
 * (below) when it has one, and since the beginning when it has none.
 *
 * WHICH ORDERS ARE DELIVERED, AND WHAT EACH ONE BROUGHT IN (25/11, A1 — the fix for a month that read 125). This read the LEGACY
 * `status` column, which only the order's own shipping door keeps in step; the three roads the business delivers by (the statement
 * close, the «استلم» door, the per-line settle) write `shippingStatus` alone, so their orders never reached this figure. Delivered is
 * now `whereDelivered()` (`order-state.ts`, DELIVERED or PARTIALLY_DELIVERED) — the dashboard's set — and an order's revenue is
 * `revenueOf` (`delivered-revenue.ts`): what the courier paid for it, or its price before its statement arrives — the dashboard's rule.
 * The commissions are asked over the SAME set. Cost of goods, shipping, commissions and expenses are added up exactly as before.
 *
 * A WINDOW (D2, the owner 17/11: «حط الأشياء ع اليوم التاريخ»). The profit screen may ask for a span of days. The window is a filter
 * on the SAME three reads and nothing else: the delivered orders and the commissions of those same orders by the day they were
 * DELIVERED, the expenses by the day they were SPENT. The days are the store's own days (`profitWindow`).
 */
export interface ProfitWindow {
  /** The first instant of the first day. */
  start: Date;
  /** The first instant AFTER the last day. */
  end: Date;
}

/** `2026-13-40` has the shape of a day and is not one; the store's clock would roll it into a real date and add up the wrong span. */
function isRealDay(day: string): boolean {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(day);
  if (!m) return false;
  const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
  return d.getUTCMonth() === Number(m[2]) - 1 && d.getUTCDate() === Number(m[3]);
}

/** «from» and «to» as days of the store (YYYY-MM-DD, inclusive) → the instants they cover. Null when either is missing or not a day, or the span runs backwards: then there is no window and the figures are since the epoch (or the beginning), as before. */
export function profitWindow(from: string | null | undefined, to: string | null | undefined, timeZone: string): ProfitWindow | null {
  if (!from || !to || !isRealDay(from) || !isRealDay(to)) return null;
  const a = dayRange(from, timeZone);
  const b = dayRange(to, timeZone);
  if (!a || !b || b.end.getTime() <= a.start.getTime()) return null;
  return { start: a.start, end: b.end };
}

/** The schema's own default for a country's clock (`Country.timezone`), used only when the store's country cannot be read. */
const DEFAULT_TIMEZONE = 'Asia/Damascus';

/**
 * THE PROFIT EPOCH (25/11, A1) — the owner: «الأرباح المفروض تبلّش من أول ما صرنا نرفع كشوفات، هيك الأدق».
 *
 * The first instant of the store's local DAY on which its earliest courier statement was created. The open manual draft is not a
 * statement yet (`isManualDraftHash`) and does not count. Null when the store has no statement: then nothing changes for that store.
 *
 * Before it the store's books hold the old system's imported history against no expenses at all, so a profit «since the
 * beginning» was the old system's revenue with nothing taken off it — and the partners' shares were cut from that.
 */
export interface ProfitEpoch {
  /** The first instant of that day of the store. */
  at: Date;
  /** The same day as the store writes it (YYYY-MM-DD) — what the screens print, never re-derived in another clock. */
  day: string;
}

export async function profitEpoch(scope: { companyId: string; storeId: string }, timeZone?: string | null): Promise<ProfitEpoch | null> {
  const { companyId, storeId } = scope;
  const statements = await db.courierStatement.findMany({
    where: { companyId, storeId },
    select: { createdAt: true, fileHash: true },
    orderBy: { createdAt: 'asc' },
  });
  const first = statements.find((s) => !isManualDraftHash(s.fileHash));
  if (!first) return null;
  let zone = timeZone ?? null;
  if (!zone) {
    const store = await db.store.findUnique({ where: { id: storeId }, select: { country: { select: { timezone: true } } } });
    zone = store?.country?.timezone ?? DEFAULT_TIMEZONE;
  }
  const day = localDay(first.createdAt, zone);
  const range = dayRange(day, zone);
  return range ? { at: range.start, day } : null;
}

/**
 * The span the figures are added up over: the window asked for, floored at the epoch. No epoch → the window as asked (or none).
 * A window that ends on or before the epoch is an empty span — zeros, never a throw and never a silent move of the window.
 */
function countedSpan(window: ProfitWindow | null | undefined, epoch: Date | null | undefined): { gte?: Date; lt?: Date } | null {
  if (!epoch) return window ? { gte: window.start, lt: window.end } : null;
  if (!window) return { gte: epoch };
  return { gte: window.start.getTime() > epoch.getTime() ? window.start : epoch, lt: window.end };
}

export async function profitToDate(
  scope: { companyId: string; storeId: string; timeZone?: string | null },
  window?: ProfitWindow | null,
  /** The epoch, when the caller already read it (the profit door needs it for its cache key). Left out, it is read here. */
  known?: { epoch: ProfitEpoch | null }
) {
  const { companyId, storeId } = scope;
  const epoch = known ? known.epoch : await profitEpoch({ companyId, storeId }, scope.timeZone);
  const span = countedSpan(window, epoch?.at);
  const spent = span ? { expenseDate: span } : {};
  const delivered = span ? { deliveredAt: span } : {};

  /*
   * THIS STORE'S EXPENSES, AND THE ONES FROM BEFORE EXPENSES HAD A STORE.
   *
   * This read `where: { companyId }`: every store's profit subtracted every store's expenses. A row that
   * carries a store now counts for that store only; a row with none counts as it always did until the
   * owner runs the backfill (expense-scope.ts). The list keeps the CANCELLED rows, marked; the money does not.
   */
  const expenses = await db.expense.findMany({
    where: { ...expensesOf(companyId, storeId, { withCancelled: true }), ...spent },
    orderBy: { expenseDate: 'desc' },
  });
  const liveExpenses = expenses.filter((e) => !e.voidedAt);

  const rows = await db.order.findMany({
    where: { companyId, storeId, ...whereDelivered(), ...delivered },
    select: {
      id: true,
      orderNumber: true,
      totalAmount: true,
      collectedAmount: true,
      shippingCost: true,
      estimatedCostOfGoods: true,
      deliveredAt: true,
    },
    orderBy: { deliveredAt: 'desc' },
  });
  // The rows go out in the shape they always had; `collectedAmount` is read for the revenue only.
  const deliveredOrders = rows.map(({ id, orderNumber, totalAmount, shippingCost, estimatedCostOfGoods, deliveredAt }) => ({
    id, orderNumber, totalAmount, shippingCost, estimatedCostOfGoods, deliveredAt,
  }));

  const totalRevenue = rows.reduce((s, o) => s + revenueOf(o), 0);
  const totalCOGS = rows.reduce((s, o) => s + o.estimatedCostOfGoods, 0);
  const totalShipping = rows.reduce((s, o) => s + o.shippingCost, 0);
  // From the LEDGER — the one commission source — over the SAME delivered set and the same span as the revenue.
  const totalCommissions = await commissionCostForOrders({ companyId, storeId, ...whereDelivered(), ...delivered });
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

  return { expenses, liveExpenses, deliveredOrders, summary, since: epoch };
}
