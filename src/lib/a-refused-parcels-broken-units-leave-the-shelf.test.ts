import { describe, expect, it } from 'vitest';
import { restoreOrderStock, takeOffUnreturned } from './stock-consumption';

/**
 * ═══════════════════════════════════════════════════════════════════════
 * A REFUSED PARCEL'S BROKEN AND MISSING UNITS LEAVE THE SHELF.
 *
 * The owner, 5/11: «إي، صلّحها». A parcel refused at the door was never
 * consumed, so its units never left the shelf's books. Counted back as
 * 2 sound + 1 broken (or + 1 missing), the restore rightly adds nothing — and
 * nothing took the broken / missing unit off either: once the reservation was
 * released it was sold to the next customer. 13 on the books, 12 in the room.
 *
 *   · broken  → off the shelf, its money carried by the sound units (the
 *               owner's damage ruling, as `absorbDamaged` does on a consumed
 *               parcel): the shelf's VALUE does not move;
 *   · missing → off the shelf with its money (as the write-off does);
 *   · and nothing at all for a consumed parcel, a parcel that left before
 *     the opening count, a count where nothing came back, or a second press.
 *
 * Nothing is mocked: the real function runs against a transaction below that
 * applies the `where`, the order and the writes it is handed.
 * ═══════════════════════════════════════════════════════════════════════
 */

type Row = Record<string, any>;
const ORDER = 'o-1';
const STORE = 's1';
const OTHER = 's2';

function matches(row: Row, where: Row): boolean {
  for (const [key, want] of Object.entries(where)) {
    if (want && typeof want === 'object' && 'gt' in want) {
      if (!((row[key] ?? 0) > want.gt)) return false;
    } else if (row[key] !== want) return false;
  }
  return true;
}

function world(opts: {
  shelf: Row[];
  items?: Row[];
  addOns?: Row[];
  source?: string | null;
  sold?: boolean;
  /** A RETURN line already written for the order (a restore ran) — with no SALE. */
  returned?: boolean;
  /** The review line a delivery on an empty shelf writes instead of a SALE (STOCK_SHORT_AT_DELIVERY). */
  shortConsumed?: boolean;
}) {
  const movements: Row[] = [];
  const shelf = opts.shelf.map((b) => ({ ...b }));
  let seq = 0;
  const tx = {
    inventoryMovement: {
      findFirst: async ({ where }: any) => {
        if (movements.some((m) => m.referenceId === where.referenceId && m.type === where.type)) return { id: 'seen' };
        if (opts.sold && where.type === 'SALE') return { id: 'prior-sale' };
        if (opts.returned && where.type === 'RETURN') return { id: 'prior-return' };
        return null;
      },
      create: async ({ data }: any) => {
        movements.push(data);
        return { id: `m${movements.length}`, ...data };
      },
    },
    orderActivity: {
      findFirst: async ({ where }: any) =>
        opts.shortConsumed && where.action === 'STOCK_SHORT_AT_DELIVERY' ? { id: 'short-1' } : null,
    },
    order: {
      findFirst: async () => ({
        orderNumber: 'ORD-9',
        storeId: STORE,
        source: opts.source ?? 'MANUAL',
        items: opts.items ?? [{ productId: 'p1', productName: 'كريم', quantity: 3, freeQuantity: 0, reservedQty: 3 }],
        addOns: opts.addOns ?? [],
        store: { country: { minorUnit: 3 } },
      }),
    },
    productionBatch: {
      findMany: async ({ where, orderBy }: any) => {
        const rows = shelf.filter((b) => matches(b, where)).map((b) => ({ ...b }));
        const specs: Array<[string, string]> = (Array.isArray(orderBy) ? orderBy : [orderBy ?? {}]).flatMap((o: any) =>
          Object.entries<string>(o ?? {})
        );
        for (const [key, dir] of [...specs].reverse()) {
          rows.sort((a, b) => (a[key] < b[key] ? -1 : a[key] > b[key] ? 1 : 0));
          if (dir === 'desc') rows.reverse();
        }
        return rows;
      },
      findFirst: async ({ where }: any) => shelf.find((b) => matches(b, where)) ?? null,
      update: async ({ where, data }: any) => Object.assign(shelf.find((b) => b.id === where.id)!, data),
      create: async ({ data }: any) => {
        const row = { id: `new-${++seq}`, createdAt: new Date(), ...data };
        shelf.push(row);
        return row;
      },
      aggregate: async ({ where }: any) => ({
        _sum: { quantityRemaining: shelf.filter((b) => matches(b, where)).reduce((s, b) => s + b.quantityRemaining, 0) },
      }),
    },
  };
  const units = (productId = 'p1', storeId = STORE) =>
    shelf.filter((b) => b.productId === productId && b.storeId === storeId).reduce((s, b) => s + b.quantityRemaining, 0);
  const value = (productId = 'p1', storeId = STORE) =>
    Math.round(
      shelf
        .filter((b) => b.productId === productId && b.storeId === storeId)
        .reduce((s, b) => s + b.quantityRemaining * b.costPerUnit, 0) * 1000
    ) / 1000;
  return { tx: tx as never, movements, shelf, units, value };
}

const batch = (id: string, qty: number, cost: number, date: string, over: Row = {}) => ({
  id,
  companyId: 'c1',
  storeId: STORE,
  productId: 'p1',
  quantityRemaining: qty,
  quantitySold: 0,
  costPerUnit: cost,
  productionDate: new Date(date),
  createdAt: new Date(date),
  ...over,
});

const count = (w: ReturnType<typeof world>, receivedQty: number, damagedQty: number, missingQty: number) =>
  takeOffUnreturned(w.tx, { orderId: ORDER, companyId: 'c1', receivedQty, damagedQty, missingQty, userId: 'u1' });

describe('a parcel refused at the door, counted back at the desk', () => {
  it('3 sent, 3 sound: the shelf is exactly as it was — nothing to take off', async () => {
    const w = world({ shelf: [batch('b1', 10, 4, '2026-01-01')] });
    const r = await count(w, 3, 0, 0);
    expect(r.skipped).toBe('NOTHING_MISSING');
    expect(w.units()).toBe(10);
    expect(w.movements).toEqual([]);
  });

  it('2 sound + 1 broken: the shelf loses ONE unit and not one fils of value; one «تالف» line', async () => {
    const w = world({ shelf: [batch('b1', 10, 4, '2026-01-01')] });
    const before = w.value();
    const r = await count(w, 2, 1, 0);
    expect(r).toMatchObject({ damaged: 1, missing: 0, absorbed: 4 });
    expect(w.units()).toBe(9);
    expect(w.value()).toBe(before);
    expect(w.movements).toHaveLength(1);
    expect(w.movements[0]).toMatchObject({ type: 'DAMAGE', quantity: -1, balanceAfter: 9, storeId: STORE, referenceId: ORDER });
    // The two sound units carry the money of three.
    const carried = w.shelf.find((b) => String(b.batchNumber ?? '').startsWith('DMG-'))!;
    expect(carried).toMatchObject({ quantityRemaining: 2, totalProductionCost: 12, costPerUnit: 6, storeId: STORE });
  });

  it('2 sound + 1 missing: the shelf loses ONE unit and its cost; one «ناقص» line', async () => {
    const w = world({ shelf: [batch('b1', 10, 4, '2026-01-01')] });
    const before = w.value();
    const r = await count(w, 2, 0, 1);
    expect(r).toMatchObject({ damaged: 0, missing: 1, absorbed: 0 });
    expect(w.units()).toBe(9);
    expect(w.value()).toBe(before - 4);
    expect(w.movements).toEqual([expect.objectContaining({ type: 'LOSS', quantity: -1, balanceAfter: 9 })]);
  });

  it('1 sound + 1 broken + 1 missing: both leave, the broken one’s money stays', async () => {
    const w = world({ shelf: [batch('b1', 10, 4, '2026-01-01')] });
    await count(w, 1, 1, 1);
    expect(w.units()).toBe(8);
    expect(w.value()).toBe(40 - 4); // only the missing unit's money left
    expect(w.movements.map((m) => [m.type, m.quantity])).toEqual([['DAMAGE', -1], ['LOSS', -1]]);
  });

  it('all 3 broken: nothing sound to carry them, so they leave with their cost', async () => {
    const w = world({ shelf: [batch('b1', 10, 4, '2026-01-01')] });
    await count(w, 0, 3, 0);
    expect(w.units()).toBe(7);
    expect(w.value()).toBe(28);
    expect(w.movements).toEqual([expect.objectContaining({ type: 'DAMAGE', quantity: -3 })]);
  });

  it('the value is kept across two batches at two prices, oldest first', async () => {
    const w = world({ shelf: [batch('old', 2, 3, '2026-01-01'), batch('new', 10, 5, '2026-02-01')] });
    const before = w.value();
    await count(w, 2, 1, 0);
    expect(w.units()).toBe(11);
    expect(w.value()).toBe(before);
    expect(w.shelf.find((b) => b.id === 'old')!.quantityRemaining).toBe(0);
    expect(w.shelf.find((b) => b.id === 'new')!.quantityRemaining).toBe(9);
  });

  it('only the order’s own store gives the units up', async () => {
    const w = world({ shelf: [batch('mine', 10, 4, '2026-01-01'), batch('theirs', 10, 4, '2025-01-01', { storeId: OTHER })] });
    await count(w, 2, 0, 1);
    expect(w.units('p1', STORE)).toBe(9);
    expect(w.units('p1', OTHER)).toBe(10);
  });

  it('two lines: the count is laid over them in order — sound first, then broken, then missing', async () => {
    const w = world({
      shelf: [batch('a', 10, 4, '2026-01-01'), batch('b', 10, 2, '2026-01-01', { productId: 'p2' })],
      items: [
        { productId: 'p1', productName: 'كريم', quantity: 2, freeQuantity: 0, reservedQty: 2 },
        { productId: 'p2', productName: 'صابون', quantity: 1, freeQuantity: 1, reservedQty: 2 },
      ],
    });
    await count(w, 3, 1, 0); // p1: 2 sound · p2: 1 sound + 1 broken
    expect(w.units('p1')).toBe(10);
    expect(w.units('p2')).toBe(9);
    expect(w.movements).toEqual([expect.objectContaining({ productId: 'p2', type: 'DAMAGE', quantity: -1 })]);
  });

  it('the desk counts the lines and no add-on, so an add-on is never taken off', async () => {
    const w = world({
      shelf: [batch('a', 10, 4, '2026-01-01'), batch('x', 5, 1, '2026-01-01', { productId: 'p9' })],
      items: [{ productId: 'p1', productName: 'كريم', quantity: 2, freeQuantity: 0, reservedQty: 2 }],
      addOns: [{ productId: 'p9', quantity: 1 }],
    });
    await count(w, 1, 0, 1); // the line: 1 sound + 1 missing
    expect(w.units('p9')).toBe(5);
    expect(w.units('p1')).toBe(9);
  });

  it('a line the customer kept owes nothing back: the count lands on the lines that came back (the parcel swap’s box Y)', async () => {
    // A ×2 kept (consumed on the new order), B ×1 and C ×1 coming back. The desk counts 1 sound + 1 missing.
    const w = world({
      shelf: [batch('a', 8, 4, '2026-01-01'), batch('b', 10, 4, '2026-01-01', { productId: 'pB' }), batch('c', 10, 4, '2026-01-01', { productId: 'pC' })],
      items: [
        { productId: 'p1', productName: 'أ', quantity: 2, freeQuantity: 0, reservedQty: 0, deliveredQty: 2 },
        { productId: 'pB', productName: 'ب', quantity: 1, freeQuantity: 0, reservedQty: 1, deliveredQty: 0 },
        { productId: 'pC', productName: 'ج', quantity: 1, freeQuantity: 0, reservedQty: 1, deliveredQty: 0 },
      ],
    });
    await count(w, 1, 0, 1);
    expect(w.units('p1')).toBe(8); // not taken a second time
    expect(w.units('pB')).toBe(10); // the sound one
    expect(w.units('pC')).toBe(9); // the missing one
    expect(w.movements).toEqual([expect.objectContaining({ productId: 'pC', type: 'LOSS', quantity: -1 })]);
  });
});

describe('NEGATIVE: nothing is taken twice, or from a parcel that already left the books', () => {
  it('a consumed parcel (a SALE was written at delivery): its broken unit already left — untouched', async () => {
    const w = world({ shelf: [batch('b1', 10, 4, '2026-01-01')], sold: true });
    const r = await count(w, 2, 1, 0);
    expect(r.skipped).toBe('CONSUMED');
    expect(w.units()).toBe(10);
    expect(w.movements).toEqual([]);
  });

  it('a RETURN line already on the order, with no SALE, is proof enough on its own', async () => {
    const w = world({ shelf: [batch('b1', 10, 4, '2026-01-01')], returned: true });
    const r = await count(w, 2, 1, 0);
    expect(r.skipped).toBe('CONSUMED');
    expect(w.units()).toBe(10);
  });

  it('a parcel consumed on an EMPTY shelf (no SALE, only the short-shelf review line) is consumed — untouched when it turns up', async () => {
    const w = world({ shelf: [batch('b1', 10, 4, '2026-01-01')], shortConsumed: true });
    const r = await count(w, 2, 1, 0);
    expect(r.skipped).toBe('CONSUMED');
    expect(w.units()).toBe(10);
    expect(w.movements).toEqual([]);
  });

  it('a second press takes nothing more', async () => {
    const w = world({ shelf: [batch('b1', 10, 4, '2026-01-01')] });
    await count(w, 2, 1, 0);
    const r = await count(w, 2, 1, 0);
    expect(r.skipped).toBe('ALREADY_DONE');
    expect(w.units()).toBe(9);
  });

  it('nothing came back at all: the receipt stays open for the parcel to turn up — untouched', async () => {
    const w = world({ shelf: [batch('b1', 10, 4, '2026-01-01')] });
    const r = await count(w, 0, 0, 3);
    expect(r.skipped).toBe('NOTHING_CAME_BACK');
    expect(w.units()).toBe(10);
  });

  it('goods that left before the opening count were never in it — untouched', async () => {
    const w = world({
      shelf: [batch('b1', 10, 4, '2026-01-01')],
      source: 'Legacy import',
      items: [{ productId: 'p1', productName: 'كريم', quantity: 3, freeQuantity: 0, reservedQty: 0 }],
    });
    const r = await count(w, 2, 1, 0);
    expect(r.skipped).toBe('OUTSIDE_COUNT');
    expect(w.units()).toBe(10);
  });

  it('and the restore still adds nothing for the refused parcel — the sound units never left', async () => {
    const w = world({ shelf: [batch('b1', 10, 4, '2026-01-01')] });
    const r = await restoreOrderStock(w.tx, { orderId: ORDER, companyId: 'c1', receivedQty: 2, damagedQty: 1 });
    expect(r).toMatchObject({ restored: 0, neverConsumed: true });
    expect(w.units()).toBe(10);
  });
});
