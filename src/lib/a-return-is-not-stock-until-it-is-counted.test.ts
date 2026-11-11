import { describe, expect, it, vi, beforeEach } from 'vitest';

const db = {
  // An order with no add-ons, unless a test says otherwise — plain functions, so a mock reset leaves them answering.
  orderAddOn: { aggregate: async () => ({ _sum: { reservedQty: 0 } }), findMany: async () => [], update: async () => ({}), updateMany: async () => ({ count: 0 }) },
  orderItem: { aggregate: vi.fn() },
  productionBatch: { aggregate: vi.fn() },
};
vi.mock('./db', () => ({ db }));

import { availableStock } from './reservation';
import { repoFile, stripComments } from './guard-source';

/**
 * ═══════════════════════════════════════════════════════════════════════
 * A PARCEL COMING BACK IS NOT STOCK UNTIL SOMEBODY HAS COUNTED IT.
 *
 * The owner, 21/10: «بالمرتجعات لما يرجع لا ترجع — سواء جزئي او غيرو —
 * للمخزون غير لما احط انو استلم المرتجع و سليم».
 *
 * The returns desk was already right. `POST /api/ops/returns` demands an
 * explicit `countedAndInspected` acknowledgement and restores only the
 * units ticked as sound — damaged and missing ones never come back.
 *
 * ── THE STOCK CAME BACK BY ANOTHER ROAD ──
 *
 * `reservedElsewhere` stopped counting an order's reservation as soon as
 * its shipping status was RETURNED:
 *
 *     shippingStatus: { notIn: ['DELIVERED', 'RETURNED', 'CANCELLED'] }
 *
 * For the other two that is right, because by then nothing is held any
 * more: delivery CONSUMED the units (`consumeOrderStock` clears
 * `reservedQty`) and a cancellation RELEASED them.
 *
 * RETURNED is different. A full return was never consumed — the units are
 * still in the batches, counted as physically on hand — and the
 * reservation that was holding them is cleared only by the returns desk,
 * when the parcel is in front of somebody. So between «the courier says
 * it came back» and «we have it in our hands», the order stopped holding
 * its units and `availableStock` rose by exactly them.
 *
 * Those units are in a van, or in a courier's warehouse, or lost. The
 * shop could sell them to the next customer, and did.
 *
 * ── WHO SETS RETURNED WITHOUT A RECEIPT ──
 *
 * The door outcome «nothing taken» (`partial-delivery.ts`), and a manual
 * RETURN_REQUESTED → RETURNED on the shipping screen. Neither involves
 * counting anything.
 *
 * ⚠️ This is the rule the architecture contract already states:
 * «Stock never re-enters inventory before physical count and inspection».
 * ═══════════════════════════════════════════════════════════════════════
 */

/** The `where` the availability query was built with. */
function reservationWhere() {
  const call = db.orderItem.aggregate.mock.calls.at(-1)?.[0];
  return call?.where?.order ?? {};
}

beforeEach(() => {
  vi.clearAllMocks();
  db.orderItem.aggregate.mockResolvedValue({ _sum: { reservedQty: 0 } });
  db.productionBatch.aggregate.mockResolvedValue({ _sum: { quantityRemaining: 0 } });
});

describe('a returned parcel keeps holding its units', () => {
  it('— availability does not skip an order just because it came back', async () => {
    await availableStock(db as never, 'c1', 'p1');
    const excluded: string[] = reservationWhere().shippingStatus?.notIn ?? [];
    expect(
      excluded,
      'المرتجع بيبطّل يحجز بضاعته أوّل ما يتسمّى مرتجَع — وهي لسّا بالسيّارة'
    ).not.toContain('RETURNED');
  });

  it('and still skips the two that genuinely hold nothing', async () => {
    /*
     * DELIVERED consumed its units and CANCELLED released them, so in
     * both the reservation is already zero. Keeping them in the list is
     * not what makes them right — it is cheaper, and it says out loud
     * that the two are a different case from a return.
     */
    await availableStock(db as never, 'c1', 'p1');
    const excluded: string[] = reservationWhere().shippingStatus?.notIn ?? [];
    expect(excluded).toContain('DELIVERED');
    expect(excluded).toContain('CANCELLED');
  });

  it('and a rejected or cancelled CONFIRMATION still holds nothing', async () => {
    await availableStock(db as never, 'c1', 'p1');
    const excluded: string[] = reservationWhere().confirmationStatus?.notIn ?? [];
    expect(excluded).toEqual(expect.arrayContaining(['REJECTED', 'CANCELLED']));
  });
});

describe('and the desk is the only door back onto the shelf', () => {
  // The desk is its door AND the one receipt function both doors call (lib/return-receipt.ts, «استلام الكل» 11/11).
  const desk = () => stripComments(repoFile('src/app/api/ops/returns/route.ts') + repoFile('src/lib/return-receipt.ts'));

  it('— it refuses to restore anything without an explicit count', () => {
    // Not a checkbox that defaults to true: a literal the caller must
    // send. «استلمت المرتجع وهو سليم» is a person's statement.
    expect(desk()).toMatch(/countedAndInspected: z\.literal\(true/);
  });

  it('and it is the desk that lets the units go, so the hold ends there', () => {
    /*
     * The reservation is cleared here and nowhere else for a return. That
     * is what makes dropping RETURNED from the list above safe: the hold
     * does not last for ever, it lasts until somebody counts.
     */
    const src = desk();
    expect(src).toMatch(/reservedQty: 0/);
  });

  it('and only the SOUND units go back — not the damaged, not the missing', () => {
    const src = stripComments(repoFile('src/lib/stock-consumption.ts'));
    const restore = src.slice(src.indexOf('export async function restoreOrderStock'));
    expect(restore.slice(0, 3000)).toContain('receivedQty');
  });
});
