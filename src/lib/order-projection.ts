import { can } from '@/lib/authorization';
import type { SessionUser } from '@/types/auth';

/**
 * WHAT AN ORDER READ HANDS OUT, BY WHO IS READING.
 *
 * The orders list and the order window read `include: { … }` with no
 * `select` on the order, so every column left — the cost of goods written
 * at creation, the gross and net profit, the retired commission column —
 * and the window added every commission entry on the order, with whose it
 * was. A confirmation agent reading her own queue was reading the shop's
 * margin on each line and her colleague's commission.
 *
 * Nothing was decided about those figures; they simply came along. The
 * money is the finance key's, as it is on every money screen: an order
 * read without it carries no cost, no profit and nobody else's commission.
 *
 * The customer is the same story one level down. `customers.view_basic`
 * is documented as «not the address-book's notes or stats», and the order
 * window handed the whole customer row to anyone who could open an order.
 * The address and phone stay — the call and the waybill need them — and
 * so does the count of earlier orders, which is what marks a repeat
 * customer on the list.
 */

/** The order columns that are the shop's own money, not the customer's bill. */
export const ORDER_COST_FIELDS = [
  'estimatedCostOfGoods',
  'productCost',
  'packagingCost',
  'advertisingCost',
  'otherCost',
  'grossProfit',
  'netProfit',
  'moderatorCommission',
] as const;

/** The customer fields `customers.view_basic` is documented not to see. */
export const CUSTOMER_PRIVATE_FIELDS = [
  'notes',
  'totalPurchaseValue',
  'confirmedOrders',
  'deliveredOrders',
  'cancelledOrders',
] as const;

/**
 * Cost and profit on an order: the finance key AND the cost key (perm-plan PR-10, D3).
 *
 * BOTH, not either. The money is the finance key's, as on every money screen; what the goods cost is the cost key's, and an
 * order's cost and profit are exactly that. `costs.view` alone (a warehouse keeper who sees the unit cost of the shelf) must
 * not open an order's margin, so nobody gains a figure on the day; and the migration gave `costs.view` to every holder of
 * `finance.view`, so nobody loses one either.
 */
export function maySeeOrderCost(user: SessionUser): boolean {
  return can(user, 'finance.view') && can(user, 'costs.view');
}

/** Other people's commission on an order: pay is payroll's, money is finance's. */
export function maySeeOthersCommission(user: SessionUser): boolean {
  return can(user, 'finance.view') || can(user, 'payroll.view');
}

/** The customer's notes and counters: the address-book key. */
export function maySeeCustomerDetail(user: SessionUser): boolean {
  return can(user, 'customers.view');
}

type Row = Record<string, unknown>;

function without<T extends Row>(row: T, fields: readonly string[]): T {
  const out: Row = { ...row };
  for (const f of fields) delete out[f];
  return out as T;
}

/**
 * One order, as this person may read it. Works on a list row and on the
 * window's full read alike: a field the read did not select is simply not
 * there to remove.
 */
export function projectOrder<T extends Row>(order: T, user: SessionUser): T {
  let out: Row = maySeeOrderCost(user) ? { ...order } : without(order, ORDER_COST_FIELDS);

  if (out.customer && typeof out.customer === 'object' && !maySeeCustomerDetail(user)) {
    out = { ...out, customer: without(out.customer as Row, CUSTOMER_PRIVATE_FIELDS) };
  }

  if (Array.isArray(out.commissions) && !maySeeOthersCommission(user)) {
    out = { ...out, commissions: (out.commissions as Row[]).filter((e) => e.userId === user.id) };
  }

  return out as T;
}
