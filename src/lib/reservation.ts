import { db } from './db';
import type { Prisma } from '@prisma/client';

/**
 * RESERVATION — per LINE, never per order (contract, inventory section).
 *
 * Available stock = what production batches still hold, minus what other
 * open orders already reserve. Reserving and releasing always happen inside
 * the caller's transaction, so a cancel/void/unconfirm can never leave stock
 * reserved: `release` runs in the SAME transaction as the state change.
 *
 * allow_negative_stock is a per-country setting, enforced at shipment
 * creation rather than order creation; here it decides whether a shortage
 * blocks the reservation or is recorded and flagged.
 */

type Tx = Prisma.TransactionClient | typeof db;

/**
 * STOCK IS A STORE'S, NOT A COMPANY'S.
 *
 * Two stores drawing on one pile can each promise a customer what the other
 * has already taken, and neither count is wrong on its own screen. So every
 * question about stock is asked of one store.
 *
 * `storeId` is optional only while the existing rows are being placed. Left
 * out, these behave exactly as they did before — nothing silently changes
 * meaning half way through a migration. Once every batch carries a store,
 * the callers pass it and the pool is separated for good.
 */

/** Reserved units of a product across every order of this store still open. */
export async function reservedElsewhere(
  tx: Tx,
  companyId: string,
  productId: string,
  exceptOrderId?: string,
  storeId?: string | null
) {
  /*
   * THE SAME QUESTION OF THE ORDER'S ADD-ONS.
   *
   * «الأب سيل والكروس سيل بينحفظوا بالطلب وبالسعر، والمخزون ح يتأثر». An add-on (the offer after the order, a
   * recommended product) is money on the order and, from now on, units on the shelf: it reserves exactly like a
   * line, so another order cannot be promised the units it holds. Same filter, same reasons — one `where`, read by
   * both aggregates, so the two can never disagree about which orders are still holding stock.
   */
  const holding = {
    companyId,
    productId,
    ...(exceptOrderId ? { orderId: { not: exceptOrderId } } : {}),
    reservedQty: { gt: 0 },
  };
  const order = {
    // The order already knows its store — this side needs no migration.
    ...(storeId ? { storeId } : {}),
    confirmationStatus: { notIn: ['REJECTED', 'CANCELLED'] },
    /*
     * ── «RETURNED» IS NOT ON THIS LIST, AND THAT IS THE POINT ──
     *
     * The owner, 21/10: «بالمرتجعات لما يرجع لا ترجع — سواء جزئي او
     * غيرو — للمخزون غير لما احط انو استلم المرتجع و سليم».
     *
     * The two that remain belong here because by then nothing is
     * held any more: delivery CONSUMED the units (`consumeOrderStock`
     * clears `reservedQty`) and a cancellation RELEASED them. Their
     * reservation is already zero; skipping them only saves the read.
     *
     * A return is the opposite. A full return was never consumed —
     * the units are still counted in the batches as physically on
     * hand — and its reservation is cleared by the returns desk, when
     * the parcel is in somebody's hands. Excluding it here meant that
     * between «the courier says it came back» and «we have counted
     * it», the order stopped holding its units and `availableStock`
     * rose by exactly them.
     *
     * Those units are in a van, or in a courier's warehouse, or lost.
     * The shop could promise them to the next customer, and did.
     *
     * ⚠️ RETURNED is set without anybody counting anything — by the
     * door outcome «nothing taken», and by a manual transition on the
     * shipping screen. So the hold has to outlast the status and end
     * where the counting is: `POST /api/ops/returns`, which refuses
     * to restore a thing without `countedAndInspected` and returns
     * only the units ticked as sound.
     */
    shippingStatus: { notIn: ['DELIVERED', 'CANCELLED'] },
  };
  const [lines, addOns] = await Promise.all([
    tx.orderItem.aggregate({ where: { ...holding, order }, _sum: { reservedQty: true } }),
    tx.orderAddOn.aggregate({ where: { ...holding, order }, _sum: { reservedQty: true } }),
  ]);
  return (lines._sum.reservedQty ?? 0) + (addOns._sum.reservedQty ?? 0);
}

/** Units sitting in this store's production batches (what physically exists). */
export async function onHand(tx: Tx, companyId: string, productId: string, storeId?: string | null) {
  const agg = await tx.productionBatch.aggregate({
    where: { companyId, productId, ...(storeId ? { storeId } : {}) },
    _sum: { quantityRemaining: true },
  });
  return agg._sum.quantityRemaining ?? 0;
}

/** What a new reservation may still take. */
export async function availableStock(
  tx: Tx,
  companyId: string,
  productId: string,
  exceptOrderId?: string,
  storeId?: string | null
) {
  const [physical, reserved] = await Promise.all([
    onHand(tx, companyId, productId, storeId),
    reservedElsewhere(tx, companyId, productId, exceptOrderId, storeId),
  ]);
  return physical - reserved;
}

/**
 * THE POOL THIS QUESTION IS ASKED OF, AS ONE STRING.
 *
 * The lock below and `availableStock` above MUST name the same pool, or the
 * lock guards a door nobody walks through. So the key is built from exactly
 * the arguments availability is computed from — add a `storeId` to one and
 * this function makes you add it to the other.
 */
function stockScopeKey(companyId: string, productId: string, storeId?: string | null) {
  return `stock:${companyId}:${storeId ?? '*'}:${productId}`;
}

/**
 * A number nobody else is using, so two unrelated features cannot collide on
 * one advisory lock. Postgres has ONE global advisory-lock space.
 */
const STOCK_LOCK_DOMAIN = 4711;

/**
 * ONE RESERVER AT A TIME, PER PRODUCT.
 *
 * Reserving is a read followed by a write — «how many are free?» then «take
 * this many» — and between the two, nothing stopped a second worker asking
 * the same question and getting the same answer. Measured, not suspected:
 * two transactions each reserving 400 of a batch of 500 both succeeded, both
 * reported no shortage, and the shelf ended 800 reserved of 500.
 *
 * Every transaction in this product runs at READ COMMITTED, which is exactly
 * the level at which that is allowed to happen: T2's read is perfectly valid,
 * it simply cannot see T1's uncommitted write. Raising the isolation level
 * would turn the second one into a serialization failure the caller must
 * retry — a bigger change, and one that makes every OTHER statement in the
 * transaction retryable too.
 *
 * An advisory lock is the smaller instrument: it serialises the ONE question
 * that has to be asked and answered without interruption, and Postgres drops
 * it at commit or rollback, so no path can leak it.
 *
 * ROW LOCKS WOULD NOT WORK HERE. What must hold still is not a row but a
 * SUBTRACTION across two tables — batches on hand, minus what other orders
 * reserve. `SELECT … FOR UPDATE` on the batches would not stop a second
 * transaction INSERTING a reservation, which is the other half of the sum.
 */
async function lockStockScopes(tx: Tx, keys: string[]) {
  /*
   * SORTED, AND THAT IS THE WHOLE DEADLOCK STORY.
   *
   * Two orders holding the same two products in opposite order would each
   * take one lock and wait forever for the other. Everyone taking them in
   * the same order makes that impossible.
   */
  for (const key of [...new Set(keys)].sort()) {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(${STOCK_LOCK_DOMAIN}::int4, hashtext(${key})::int4)`;
  }
}

/**
 * A LOCK TAKEN OUTSIDE A TRANSACTION IS RELEASED IMMEDIATELY.
 *
 * `pg_advisory_xact_lock` lives and dies with the transaction. Handed the
 * root client it is taken and dropped in the same breath — the code would
 * read as protected and protect nothing, which is worse than no lock at all,
 * because nobody looks twice at a line that is already there.
 *
 * The transaction client is the one WITHOUT `$transaction` on it.
 */
function assertInTransaction(tx: Tx, what: string) {
  if ('$transaction' in tx) {
    throw new Error(`${what} يجب أن يعمل داخل معاملة — قفل المخزون خارجها لا يحجز شيئاً`);
  }
}

export interface ReservationOutcome {
  /** Lines (and add-ons) whose full quantity (including gift units) is now reserved. */
  reserved: number;
  /** Lines left short because stock is missing. `addOn` marks a shortage on an add-on rather than a line. */
  shortages: { orderItemId: string; productId: string; productName: string; missing: number; addOn?: true }[];
}

/**
 * Reserve every line of an order. With negative stock disallowed the short
 * lines stay unreserved (the order cannot become READY_TO_SHIP); with it
 * allowed they are reserved and reported as shortages for the daily alert.
 */
export async function reserveOrderLines(
  tx: Tx,
  orderId: string,
  opts: { allowNegativeStock: boolean }
): Promise<ReservationOutcome> {
  assertInTransaction(tx, 'reserveOrderLines');

  const items = await tx.orderItem.findMany({
    where: { orderId },
    select: { id: true, companyId: true, productId: true, productName: true, quantity: true, freeQuantity: true, reservedQty: true },
  });
  // The add-ons the customer accepted on the thank-you screen — they reserve with the lines (see `reservedElsewhere`).
  const addOns = await tx.orderAddOn.findMany({
    where: { orderId },
    select: { id: true, companyId: true, productId: true, productName: true, quantity: true, reservedQty: true },
  });

  /*
   * EVERY product of this order is locked BEFORE the first availability is
   * read — including the lines that turn out to need nothing. Locking them
   * one at a time as the loop reaches them would leave the earlier answers
   * going stale while the later locks are being waited for.
   */
  await lockStockScopes(tx, [...items, ...addOns].map((i) => stockScopeKey(i.companyId, i.productId)));

  const outcome: ReservationOutcome = { reserved: 0, shortages: [] };
  for (const item of items) {
    const need = item.quantity + item.freeQuantity - item.reservedQty;
    if (need <= 0) {
      outcome.reserved++;
      continue;
    }
    const available = await availableStock(tx, item.companyId, item.productId, orderId);
    const missing = Math.max(0, need - available);

    if (missing > 0) {
      outcome.shortages.push({
        orderItemId: item.id,
        productId: item.productId,
        productName: item.productName,
        missing,
      });
      if (!opts.allowNegativeStock) continue; // line stays unreserved — blocks READY_TO_SHIP
    }

    await tx.orderItem.update({
      where: { id: item.id },
      data: { reservedQty: item.quantity + item.freeQuantity },
    });
    item.reservedQty = item.quantity + item.freeQuantity;
    outcome.reserved++;
  }

  /*
   * THE ADD-ONS, AFTER THE LINES, BY THE SAME RULE.
   *
   * `availableStock` leaves this whole order out, so an add-on of a product the order ALSO buys as a line would be
   * told the line's units are still free. What this order already holds of the product — its lines just above, and
   * the add-ons before this one — comes off first.
   */
  const heldHere = new Map<string, number>();
  for (const i of items) heldHere.set(i.productId, (heldHere.get(i.productId) ?? 0) + i.reservedQty);
  for (const addOn of addOns) {
    const need = addOn.quantity - addOn.reservedQty;
    if (need <= 0) {
      outcome.reserved++;
      continue;
    }
    const held = heldHere.get(addOn.productId) ?? 0;
    const available = (await availableStock(tx, addOn.companyId, addOn.productId, orderId)) - held;
    const missing = Math.max(0, need - available);
    if (missing > 0) {
      outcome.shortages.push({ orderItemId: addOn.id, productId: addOn.productId, productName: addOn.productName, missing, addOn: true });
      if (!opts.allowNegativeStock) continue; // stays unreserved — blocks READY_TO_SHIP like a line
    }
    await tx.orderAddOn.update({ where: { id: addOn.id }, data: { reservedQty: addOn.quantity } });
    heldHere.set(addOn.productId, held + addOn.quantity);
    outcome.reserved++;
  }
  return outcome;
}

/**
 * Release every reservation of an order. MUST run in the same transaction as
 * CANCELLED / VOIDED / unconfirm.
 *
 * The contract's fourth case was «NEEDS_REVIEW entered from any
 * post-confirmation state». That state left `CORE_STATES` on 2026-10-02 —
 * doubt is held at the intake door, before an order exists, so there is no
 * confirmed order to un-reserve. The three cases above are all of them.
 */
export async function releaseOrderLines(tx: Tx, orderId: string): Promise<number> {
  const res = await tx.orderItem.updateMany({
    where: { orderId, reservedQty: { gt: 0 } },
    data: { reservedQty: 0 },
  });
  // And the add-ons' — a cancelled order must not keep holding the offer it accepted.
  const addOns = await tx.orderAddOn.updateMany({
    where: { orderId, reservedQty: { gt: 0 } },
    data: { reservedQty: 0 },
  });
  return res.count + addOns.count;
}

/**
 * An order's lines AND its add-ons in the one shape the READY_TO_SHIP guard reads.
 *
 * An add-on short of stock holds the parcel back exactly like a line: the customer was promised it. Pure, so the
 * bulk shipment door — which has already read both — asks the same question as the single-order door without a
 * second query.
 */
export function guardLines(
  items: ReadonlyArray<{ quantity: number; freeQuantity: number; reservedQty: number }>,
  addOns: ReadonlyArray<{ quantity: number; reservedQty: number }>
) {
  return [
    ...items.map((i) => ({ quantity: i.quantity, freeQuantity: i.freeQuantity, reservedQty: i.reservedQty })),
    ...addOns.map((a) => ({ quantity: a.quantity, freeQuantity: 0, reservedQty: a.reservedQty, addOn: true })),
  ];
}

/** Lines of an order in the shape the READY_TO_SHIP guard expects. */
export async function orderLinesForGuard(tx: Tx, orderId: string) {
  const [lines, addOns] = await Promise.all([
    tx.orderItem.findMany({
      where: { orderId },
      select: { quantity: true, freeQuantity: true, reservedQty: true },
    }),
    tx.orderAddOn.findMany({ where: { orderId }, select: { quantity: true, reservedQty: true } }),
  ]);
  return guardLines(lines, addOns);
}
