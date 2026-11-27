import type { Prisma } from '@prisma/client';
import type { db as prismaDb } from './db';
import { holdingWhere } from './reservation';
import { PENDING_EXIT } from './stock-exit-reasons';

type Tx = Prisma.TransactionClient | typeof prismaDb;

/**
 * WHAT EACH WAREHOUSE HOLDS — «على الرف · محجوز · متاح», per warehouse (the owner, 27/11: «لازم متاح محجوز و ع الرف لكل
 * مخزن» and «النقل من المتاح»).
 *
 *   على الرف   the units in the warehouse's batch rows (`stock-places.placesOf`)
 *   محجوز      units still held by orders SOURCED from it — an order is the warehouse's once it joins a shipment from it
 *              (`Order.sourceWarehouseId`) — plus the units a pending exit, or a transfer waiting for the owner, has asked
 *              of it
 *   متاح       على الرف − محجوز
 *
 * The same terms as `stock-transfers.freeStockOf` (the figure the transfer and exit doors judge by), asked of every
 * warehouse and product at once. `warehouse-figures.test.ts` holds the two to one answer.
 *
 * Pure reads. Nothing here writes, and no money.
 */

export interface WarehouseHold {
  /** Units open orders sourced from the warehouse still hold. */
  reserved: number;
  /** Units asked of it and not yet taken: pending exits, transfers waiting for approval. */
  pending: number;
}

export interface WarehouseFigure {
  onHand: number;
  held: number;
  free: number;
  pending: number;
}

export const figureOf = (onHand: number, hold: WarehouseHold | undefined): WarehouseFigure => {
  const reserved = hold?.reserved ?? 0;
  const pending = hold?.pending ?? 0;
  return { onHand, held: reserved + pending, free: onHand - reserved - pending, pending };
};

/** warehouseId → productId → what it holds. Four grouped reads per warehouse, whatever the number of products. */
export async function warehouseHolds(
  tx: Tx,
  p: { companyId: string; storeId: string; warehouseIds: readonly string[]; productIds: readonly string[] }
): Promise<Map<string, Map<string, WarehouseHold>>> {
  const out = new Map<string, Map<string, WarehouseHold>>();
  const productIds = [...new Set(p.productIds)];
  const warehouseIds = [...new Set(p.warehouseIds)];
  if (productIds.length === 0) return out;
  const held = holdingWhere({ companyId: p.companyId, productId: { in: productIds }, storeId: p.storeId });
  for (const warehouseId of warehouseIds) {
    const per = new Map<string, WarehouseHold>();
    const at = (productId: string) => {
      let h = per.get(productId);
      if (!h) per.set(productId, (h = { reserved: 0, pending: 0 }));
      return h;
    };
    const where = { ...held, order: { ...held.order, sourceWarehouseId: warehouseId } };
    const [lines, addOns, exits, awaiting] = await Promise.all([
      tx.orderItem.groupBy({ by: ['productId'], where, _sum: { reservedQty: true } }),
      tx.orderAddOn.groupBy({ by: ['productId'], where, _sum: { reservedQty: true } }),
      tx.stockExitLine.groupBy({
        by: ['productId'],
        where: { productId: { in: productIds }, exit: { companyId: p.companyId, storeId: p.storeId, warehouseId, status: PENDING_EXIT } },
        _sum: { quantity: true },
      }),
      tx.stockTransferLine.groupBy({
        by: ['productId'],
        where: {
          productId: { in: productIds },
          transfer: { companyId: p.companyId, storeId: p.storeId, fromWarehouseId: warehouseId, status: 'AWAITING_APPROVAL' },
        },
        _sum: { quantitySent: true },
      }),
    ]);
    for (const r of [...lines, ...addOns]) at(r.productId).reserved += r._sum?.reservedQty ?? 0;
    for (const r of exits) at(r.productId).pending += r._sum?.quantity ?? 0;
    for (const r of awaiting) at(r.productId).pending += r._sum?.quantitySent ?? 0;
    out.set(warehouseId, per);
  }
  return out;
}

/** Units held by orders that have left and name no warehouse, per product — the «old stock» a placement leaves behind. */
export async function unsourcedHolds(
  tx: Tx,
  p: { companyId: string; storeId: string; productIds: readonly string[]; left: Record<string, unknown> }
): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  const productIds = [...new Set(p.productIds)];
  if (productIds.length === 0) return out;
  const held = holdingWhere({ companyId: p.companyId, productId: { in: productIds }, storeId: p.storeId });
  const where = { ...held, order: { ...held.order, ...p.left, sourceWarehouseId: null } };
  const [lines, addOns] = await Promise.all([
    tx.orderItem.groupBy({ by: ['productId'], where, _sum: { reservedQty: true } }),
    tx.orderAddOn.groupBy({ by: ['productId'], where, _sum: { reservedQty: true } }),
  ]);
  for (const r of [...lines, ...addOns]) out.set(r.productId, (out.get(r.productId) ?? 0) + (r._sum?.reservedQty ?? 0));
  return out;
}
