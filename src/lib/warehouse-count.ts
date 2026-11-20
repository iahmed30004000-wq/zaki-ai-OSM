import type { Prisma } from '@prisma/client';
import type { db as prismaDb } from './db';
import { withCourierWhere } from './warehouse-placement';

type Tx = Prisma.TransactionClient | typeof prismaDb;

/**
 * THE QUICK COUNT OF ONE WAREHOUSE (the warehouse plan, W2b — the owner's decision 4, his «نفّذ» of 20/11).
 *
 * In a store placed in warehouses, «جرد» is no longer the AVAILABLE of the whole store (his ruling of 8/11, which still
 * holds, word for word, for every store that is not placed). It is what is PHYSICALLY on one warehouse's shelf:
 *
 *   expected = Σ remaining of the product's rows IN that warehouse (rows on the road have no warehouse, so none is here)
 *            − units of this store's orders that LEFT that warehouse with the courier and still hold their reservation
 *
 *   · «left with the courier» is the placement's own rule (`warehouse-placement.withCourierWhere`: the reservation's
 *     «still held» AND the order states' «has left» — a waybill printed, waiting for pickup, shipped, or past it);
 *   · «that warehouse» is the order's `sourceWarehouseId`, stamped when it joined a shipment (W4a);
 *   · a confirmed order whose parcel has NOT left (no waybill) is still on the shelf, so it IS counted — its units are in
 *     the rows and nothing takes them off.
 *
 * Pure reads. Nothing here writes; the door decides what a difference does.
 */

export interface WarehouseCountFacts {
  /** Σ remaining of the product's rows in the warehouse. */
  book: number;
  /** Units of orders that left this warehouse with the courier and are not delivered or received back. */
  withCourier: number;
  /** What a person standing in the warehouse should find: `book − withCourier`. */
  expected: number;
}

export async function expectedInWarehouse(
  tx: Tx,
  p: { companyId: string; storeId: string; productId: string; warehouseId: string }
): Promise<WarehouseCountFacts> {
  const rows = await tx.productionBatch.aggregate({
    where: { companyId: p.companyId, storeId: p.storeId, productId: p.productId, warehouseId: p.warehouseId, inTransitTransferId: null },
    _sum: { quantityRemaining: true },
  });
  const left = withCourierWhere({ companyId: p.companyId, storeId: p.storeId, productIds: [p.productId] });
  const where = { ...left, order: { ...left.order, sourceWarehouseId: p.warehouseId } };
  const [lines, addOns] = await Promise.all([
    tx.orderItem.aggregate({ where, _sum: { reservedQty: true } }),
    tx.orderAddOn.aggregate({ where, _sum: { reservedQty: true } }),
  ]);
  const book = rows._sum?.quantityRemaining ?? 0;
  const withCourier = (lines._sum?.reservedQty ?? 0) + (addOns._sum?.reservedQty ?? 0);
  return { book, withCourier, expected: book - withCourier };
}

/**
 * WHAT A QUICK COUNT OF A PLACED STORE DOES WITH WHAT IT FOUND — pure.
 *
 * His rule (20/11): «a difference is approved by a person OTHER than the counter». The quick count has one hand — the
 * person pressing — so it never writes a difference: a match is recorded and nothing moves; a difference is recorded
 * (the audit row names the warehouse, the counter, the counted and the expected) and the stock is left as it is, for a
 * second person — the shortfall through «إخراج بضاعة» (W6a, approved by another person), the surplus through the count
 * sheet with two hands (W5a). The store total is never written by this count.
 */
export function quickCountVerdict(counted: number, facts: WarehouseCountFacts): { difference: number; matches: boolean } {
  const difference = counted - facts.expected;
  return { difference, matches: difference === 0 };
}

/** The sentence a difference answers with (409) — nothing was written. */
export function differenceWaitsAr(name: string, counted: number, difference: number): string {
  const signed = difference > 0 ? `زيادة ${difference}` : `نقص ${Math.abs(difference)}`;
  return (
    `بمخزن «${name}» انعدّ ${counted} وطلع ${signed} عن الدفتر. العدّ انحفظ باسمك، وما انكتب على المخزون شي: ` +
    'الفرق بدّو اعتماد شخص تاني — النقص بطلب من «إخراج بضاعة»، والزيادة بتستنى ورقة الجرد.'
  );
}

export const COUNT_MATCHES_AR = (name: string) => `الجرد مطابق بمخزن «${name}» — ما انكتب شي.`;
