import type { db as Db } from './db';
import {
  AGES,
  NO_COURIER,
  noBarcodeWhere,
  RETURN_STATUSES,
  VIEWS,
  ageWhere,
  viewScope,
  type Age,
  type ReturnStatus,
  type ReturnsScope,
  type View,
} from './returns-filters';

/**
 * THE NUMBERS BESIDE THE OPTIONS — for the returns desk.
 *
 * «متأخر (3)» is a promise that three rows will appear when it is chosen, so each count is asked of the definition
 * the list itself filters by (`returns-filters.ts`), never of a copy. Out of the route file because a route may export
 * nothing but its handlers, and because a fake client is enough to hold what matters: that the scope is always in the
 * question and that no filter the reader chose narrows another filter's numbers.
 */

type Client = Pick<typeof Db, 'order' | 'deliveryProvider'>;

export interface ReturnsFacts {
  /** Over everything each view reads — so each says how many it holds whichever is open. */
  views: Record<View, number>;
  /** The pending parcels in each of the four states. */
  statuses: Record<ReturnStatus, number>;
  /** Inside the open view: which company carried them, biggest first; «none» is a parcel with no company on it. */
  couriers: { id: string; name: string; count: number }[];
  /** The pending parcels in each age pile. */
  ages: Record<Age, number>;
  /** Inside the open view: how many carry no barcode — «بلا باركود (N)» promises exactly that many rows when it is chosen. */
  noBarcode: number;
}

/** The label for a parcel that has no delivery company. */
export const NO_COURIER_AR = 'بلا شركة شحن';

/**
 * Not narrowed by the other dropdowns: «مرتجع (12)» is how many of the pending parcels are in that state, so with
 * nothing else chosen — the state the screen opens in — it is exactly how many rows will appear.
 */
export async function returnsFacts(db: Client, input: { scope: ReturnsScope; view: View; now: Date }): Promise<ReturnsFacts> {
  const pending = viewScope('pending', input.scope);
  const current = viewScope(input.view, input.scope);

  const [views, byStatus, byCourier, ages, noBarcode] = await Promise.all([
    Promise.all(VIEWS.map((v) => db.order.count({ where: viewScope(v, input.scope) }))),
    db.order.groupBy({ by: ['shippingStatus'], where: pending, _count: { _all: true } }),
    db.order.groupBy({ by: ['deliveryProviderId'], where: current, _count: { _all: true } }),
    // The pile AND the pending scope, both: spreading `pending` and giving `AND` a new list keeps the scope at the top.
    Promise.all(AGES.map((a) => db.order.count({ where: { ...pending, AND: [ageWhere(a, input.now)] } }))),
    // Of the OPEN view, like the companies: the other dropdowns do not narrow it, so with nothing else chosen it is exactly the rows.
    db.order.count({ where: { ...current, AND: [noBarcodeWhere] } }),
  ]);

  const statusCount = new Map(byStatus.map((g) => [g.shippingStatus, g._count._all]));

  const ids = byCourier.map((g) => g.deliveryProviderId).filter((id): id is string => !!id);
  const names = new Map(
    (ids.length > 0
      ? await db.deliveryProvider.findMany({ where: { id: { in: ids }, companyId: input.scope.companyId }, select: { id: true, name: true } })
      : []
    ).map((p) => [p.id, p.name])
  );

  return {
    views: Object.fromEntries(VIEWS.map((v, i) => [v, views[i]])) as Record<View, number>,
    statuses: Object.fromEntries(RETURN_STATUSES.map((s) => [s, statusCount.get(s) ?? 0])) as Record<ReturnStatus, number>,
    couriers: byCourier
      .map((g) => ({
        id: g.deliveryProviderId ?? NO_COURIER,
        name: g.deliveryProviderId ? (names.get(g.deliveryProviderId) ?? '—') : NO_COURIER_AR,
        count: g._count._all,
      }))
      .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name, 'ar')),
    ages: Object.fromEntries(AGES.map((a, i) => [a, ages[i]])) as Record<Age, number>,
    noBarcode,
  };
}
