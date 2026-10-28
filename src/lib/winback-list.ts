import type { Prisma } from '@prisma/client';
import type { db as Db } from './db';
import {
  PERIODS,
  SHIPPING_KINDS,
  VIEWS,
  WINBACK_ORDER_BY,
  periodWhere,
  shippingWhere,
  viewWhere,
  type Period,
  type ShippingKind,
  type View,
} from './winback-filters';
import type { WinbackRule } from './winback';

/**
 * THE LOST ORDERS' QUERIES — THE PAGE, AND THE NUMBERS BESIDE THE OPTIONS.
 *
 * Out of the route file because a route may export nothing but its handlers, and
 * because a fake client is enough to hold what matters: that the scope (the
 * company, the store, the look-back) is always in the question, that a choice is
 * ANDed onto it and never replaces it, and that a page is a place.
 */

type Where = Prisma.OrderWhereInput;
type Client = Pick<typeof Db, 'order'>;

export interface WinbackPage<Row> {
  total: number;
  page: number;
  limit: number;
  totalPages: number;
  rows: Row[];
}

/** One page of one view, with the total the pager needs. A page past the end is answered with the last. */
export async function readWinbackPage<Row>(
  db: Client,
  input: { base: Where; viewClause: Where; clauses: Where[]; page: number; limit: number; select: Prisma.OrderSelect }
): Promise<WinbackPage<Row>> {
  // The scope stays at the TOP of the question — spread, never nested — and what was chosen is ANDed onto it.
  const where: Where = { ...input.base, AND: [input.viewClause, ...input.clauses] };
  const total = await db.order.count({ where });
  const totalPages = Math.max(1, Math.ceil(total / input.limit));
  const page = Math.min(Math.max(input.page, 1), totalPages);
  const rows = (await db.order.findMany({
    where,
    orderBy: WINBACK_ORDER_BY,
    skip: (page - 1) * input.limit,
    take: input.limit,
    select: input.select,
  })) as unknown as Row[];
  return { total, page, limit: input.limit, totalPages, rows };
}

export interface WinbackFacts {
  /** Over every lost order the rule reads — so each view says how many it holds. */
  views: Record<View, number>;
  /** Inside the CURRENT view: the reasons its orders carry, biggest first. */
  reasons: { reason: string; count: number }[];
  /** Inside the current view: the products, biggest first, the first thirty. */
  products: { name: string; count: number }[];
  /** Inside the current view: how many were cancelled within each period. */
  periods: Record<Period, number>;
  /** Inside the current view: how many never left, and how many did — the two add up to the view. */
  shipping: Record<ShippingKind, number>;
}

/** How many products the dropdown names — a shop with two hundred is not helped by a list of two hundred. */
export const PRODUCT_OPTIONS = 30;

/**
 * The numbers beside the options.
 *
 * The VIEWS are counted over everything the rule reads, so «جاهز (23)» and
 * «مستثنى (41)» are both on the screen whichever is open. The reasons, products,
 * periods and the two sides of «الشحن» are counted inside the view that is open:
 * under «جاهز» the reason list holds only the reasons the rule calls for, and
 * «السعر مرتفع (9)» is nine
 * rows of what is on screen — not nine of a hundred that are somewhere else.
 *
 * Not narrowed by the other dropdowns: «last 7 days (3)» is how many of THIS
 * VIEW were cancelled in the last week. With nothing else chosen — the state the
 * screen opens in — it is exactly how many rows will appear.
 */
export async function winbackFacts(
  db: Client,
  input: { base: Where; view: View; rule: WinbackRule; now: Date }
): Promise<WinbackFacts> {
  const inView = (view: View): Where => ({ ...input.base, AND: [viewWhere(view, input.rule, input.now)] });
  const current = inView(input.view);

  // The view AND one more clause, both: spreading `current` and giving `AND` a new list would REPLACE the view's clause.
  const inViewAnd = (clause: Where): Where => ({ ...input.base, AND: [viewWhere(input.view, input.rule, input.now), clause] });

  const [views, byReason, byProduct, periods, shipping] = await Promise.all([
    Promise.all(VIEWS.map((v) => db.order.count({ where: inView(v) }))),
    db.order.groupBy({ by: ['rejectionReason'], where: current, _count: { _all: true } }),
    db.order.groupBy({ by: ['productNameSnapshot'], where: current, _count: { _all: true } }),
    Promise.all(PERIODS.map((p) => db.order.count({ where: inViewAnd(periodWhere(p, input.now, input.rule)) }))),
    Promise.all(SHIPPING_KINDS.map((k) => db.order.count({ where: inViewAnd(shippingWhere(k)) }))),
  ]);

  return {
    views: Object.fromEntries(VIEWS.map((v, i) => [v, views[i]])) as Record<View, number>,
    reasons: byReason
      .filter((g): g is typeof g & { rejectionReason: string } => !!g.rejectionReason)
      .map((g) => ({ reason: g.rejectionReason, count: g._count._all }))
      .sort((a, b) => b.count - a.count || a.reason.localeCompare(b.reason)),
    products: byProduct
      .filter((g): g is typeof g & { productNameSnapshot: string } => !!g.productNameSnapshot)
      .map((g) => ({ name: g.productNameSnapshot, count: g._count._all }))
      .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name, 'ar'))
      .slice(0, PRODUCT_OPTIONS),
    periods: Object.fromEntries(PERIODS.map((p, i) => [p, periods[i]])) as Record<Period, number>,
    shipping: Object.fromEntries(SHIPPING_KINDS.map((k, i) => [k, shipping[i]])) as Record<ShippingKind, number>,
  };
}
