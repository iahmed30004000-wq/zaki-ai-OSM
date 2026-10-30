import type { Prisma } from '@prisma/client';
import { DELIVERED_SHIPPING } from './order-state';

/**
 * «HOW MANY WERE SOLD» — ONE SOURCE, FOR EVERY DOOR THAT SAYS IT (RV87).
 *
 * `analytics.totalSold` was the sum of `ProductionBatch.quantitySold`, a counter that moves only when a delivery draws its
 * units from a production batch. A delivery recorded before batches existed, or one the courier's statement closed, never
 * touched it: measured on the local database, 13 of 14 products that had delivered units showed 0. `product-stats.ts`
 * already says why that is not «sales» and counts the right thing for the stats door. This is that count, moved here so the
 * list door and the product page can say the same number instead of a second, wrong one.
 *
 * WHAT «SOLD» IS. The units a customer actually took: for every line of an order that reached the door as delivered
 * (`DELIVERED` or `PARTIALLY_DELIVERED`), `deliveredQty` where the door settled the parcel, and otherwise
 * `quantity + freeQuantity` — the gift is a real unit of the same product that left the shelf.
 *
 * Counted in the database, never in JavaScript: two `groupBy`s, one row per product however much the shop has traded.
 * NOTHING HERE IS MONEY. Units only; no price, no cost, no total is read or written.
 */

type Client = Pick<Prisma.TransactionClient, 'orderItem'>;

export async function deliveredUnitsByProduct(
  client: Client,
  scope: { companyId: string; storeId?: string | null; productIds: readonly string[] }
): Promise<Map<string, number>> {
  const units = new Map<string, number>();
  if (scope.productIds.length === 0) return units;

  // The lines of orders that reached the door as delivered, for THESE products in THIS store.
  const delivered = {
    companyId: scope.companyId,
    productId: { in: [...scope.productIds] },
    order: { companyId: scope.companyId, ...(scope.storeId ? { storeId: scope.storeId } : {}), shippingStatus: { in: [...DELIVERED_SHIPPING] } },
  };

  const [settled, unsettled] = await Promise.all([
    client.orderItem.groupBy({ by: ['productId'], where: { ...delivered, deliveredQty: { not: null } }, _sum: { deliveredQty: true } }),
    client.orderItem.groupBy({ by: ['productId'], where: { ...delivered, deliveredQty: null }, _sum: { quantity: true, freeQuantity: true } }),
  ]);

  for (const row of settled) {
    units.set(row.productId, (units.get(row.productId) ?? 0) + (row._sum.deliveredQty ?? 0));
  }
  for (const row of unsettled) {
    units.set(row.productId, (units.get(row.productId) ?? 0) + (row._sum.quantity ?? 0) + (row._sum.freeQuantity ?? 0));
  }
  return units;
}
