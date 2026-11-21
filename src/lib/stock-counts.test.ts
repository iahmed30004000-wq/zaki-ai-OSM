import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { memoryDb, type Row } from './stock-transfers.memory-db.test';
import { approveCount, countShown, openCount, recordAnswers, StockCountRefused, submitCount, voidCount } from './stock-counts';
import { sendTransfer, receiveTransfer, cancelTransfer, StockTransferRefused } from './stock-transfers';
import { requestExit, approveExit, StockExitRefused } from './stock-exits';
import { drawDownStock, receiveStock } from './receiving';
import { IntakePlaceRefused, returnPlace } from './warehouse-intake';
import { warehouseStopBlockers } from './warehouses';
import { expectedInWarehouse } from './warehouse-count';

/**
 * THE COUNT AGAINST THE KEEPER (W5a) — the lib, on the in-memory database of the stock-document tests, which judges every
 * `where` itself and has no money table at all.
 *
 * Every figure asserted is computed HERE from the rows, never by the function under test:
 *   «دخل» Σ produced · «خرج» Σ sold · on hand Σ remaining · the stock value Σ (remaining × cost).
 */

const C1 = 'c1';
const S1 = 's1';
const KEEPER = 'u-keeper';
const HELPER = 'u-helper';
const BOSS = 'u-boss';
const BOSS2 = 'u-boss-2';
type MayUse = (w: { id: string }) => Promise<boolean>;
const yes: MayUse = async () => true;
const no: MayUse = async () => false;

function batch(id: string, over: Row = {}): Row {
  return {
    id,
    companyId: C1,
    storeId: S1,
    productId: 'p1',
    batchNumber: `RCV-${id}`,
    quantityProduced: 10,
    quantitySold: 0,
    quantityRemaining: 10,
    quantityMovedIn: 0,
    quantityMovedOut: 0,
    totalProductionCost: 20,
    costPerUnit: 2,
    productionDate: new Date('2026-10-01'),
    createdAt: new Date('2026-10-01T08:00:00Z'),
    status: 'COMPLETED',
    warehouseId: 'wA',
    inTransitTransferId: null,
    splitFromBatchId: null,
    ...over,
  };
}

/**
 * p1 in wA: b1 10 at 2.000 (oldest), b2 6 at 3.3335 (newest) = 16; in wB: bB 5 at 1.000 (older than both).
 * p2 in wA: q1 4 at 7. p0 (never costed) in wA: z1 3 at 0.
 * Orders: o-left (waybill printed, sourced wA, holds 3 of p1) — with the courier, NOT on the shelf;
 *         o-shelf (confirmed, sourced wA, no waybill, holds 2 of p1) — on the shelf, counted;
 *         o-nowhere (waybill printed outside a trolley, no source, holds 1 of p1) — subtracted from no warehouse.
 */
function world(extra: Row = {}) {
  return memoryDb({
    country: [
      { id: 'k1', companyId: C1, isActive: true, minorUnit: 3 },
      { id: 'k2', companyId: C1, isActive: true, minorUnit: 2 },
    ],
    store: [
      { id: S1, companyId: C1, countryId: 'k1', name: 'المتجر' },
      { id: 's-unplaced', companyId: C1, countryId: 'k1', name: 'مش موزّع' },
    ],
    warehouse: [
      { id: 'wA', companyId: C1, countryId: 'k1', name: 'أ', isActive: true },
      { id: 'wB', companyId: C1, countryId: 'k1', name: 'ب', isActive: true },
      { id: 'wOff', companyId: C1, countryId: 'k1', name: 'موقوف', isActive: false },
      { id: 'wJ', companyId: C1, countryId: 'k2', name: 'عمّان', isActive: true },
      { id: 'wX', companyId: 'c2', countryId: 'k9', name: 'غريب', isActive: true },
    ],
    warehousePlacement: [{ id: 'pl1', companyId: C1, storeId: S1 }],
    product: [
      { id: 'p0', companyId: C1, storeId: S1, name: 'منتج بلا كلفة' },
      { id: 'p1', companyId: C1, storeId: S1, name: 'منتج ١' },
      { id: 'p2', companyId: C1, storeId: S1, name: 'منتج ٢' },
      { id: 'p-un', companyId: C1, storeId: 's-unplaced', name: 'منتج مش موزّع' },
    ],
    productionBatch: [
      batch('b1'),
      batch('b2', { productionDate: new Date('2026-10-05'), costPerUnit: 3.3335, quantityProduced: 9, quantitySold: 3, quantityRemaining: 6 }),
      batch('bB', { productionDate: new Date('2026-09-01'), costPerUnit: 1, quantityProduced: 5, quantityRemaining: 5, warehouseId: 'wB' }),
      batch('q1', { productId: 'p2', costPerUnit: 7, quantityProduced: 4, quantityRemaining: 4 }),
      batch('z1', { productId: 'p0', costPerUnit: 0, quantityProduced: 3, quantityRemaining: 3, totalProductionCost: 0 }),
    ],
    order: [
      { id: 'o-left', companyId: C1, storeId: S1, confirmationStatus: 'CONFIRMED', labelPrintedAt: new Date('2026-11-20'), sourceWarehouseId: 'wA' },
      { id: 'o-shelf', companyId: C1, storeId: S1, confirmationStatus: 'CONFIRMED', sourceWarehouseId: 'wA' },
      { id: 'o-nowhere', companyId: C1, storeId: S1, confirmationStatus: 'CONFIRMED', labelPrintedAt: new Date('2026-11-20'), sourceWarehouseId: null },
    ],
    orderItem: [
      { id: 'i-left', companyId: C1, orderId: 'o-left', productId: 'p1', reservedQty: 3 },
      { id: 'i-shelf', companyId: C1, orderId: 'o-shelf', productId: 'p1', reservedQty: 2 },
      { id: 'i-nowhere', companyId: C1, orderId: 'o-nowhere', productId: 'p1', reservedQty: 1 },
    ],
    ...extra,
  });
}

type M = ReturnType<typeof memoryDb>;
const rows = (m: M, productId = 'p1') => m.data.productionBatch.filter((b) => b.productId === productId && b.companyId === C1);
function figures(m: M, productId = 'p1') {
  const rs = rows(m, productId);
  return {
    produced: rs.reduce((s, r) => s + r.quantityProduced, 0),
    sold: rs.reduce((s, r) => s + r.quantitySold, 0),
    remaining: rs.reduce((s, r) => s + r.quantityRemaining, 0),
    value: rs.reduce((s, r) => s + r.quantityRemaining * r.costPerUnit, 0),
  };
}
const at = (m: M, place: string, productId = 'p1') =>
  rows(m, productId).filter((r) => r.warehouseId === place && !r.inTransitTransferId).reduce((s, r) => s + r.quantityRemaining, 0);
const identityHolds = (m: M) =>
  m.data.productionBatch.every((r) => r.quantityRemaining === r.quantityProduced + (r.quantityMovedIn ?? 0) - r.quantitySold - (r.quantityMovedOut ?? 0));

const tx = <T>(m: M, fn: (t: never) => Promise<T>) => (m.db as Row).$transaction((t: Row) => fn(t as never)) as Promise<T>;
const open = (m: M, over: Row = {}, by = KEEPER, mayUse = yes, storeId = S1) =>
  tx(m, (t) => openCount(t, { companyId: C1, storeId, openedById: by, mayUse, body: { warehouseId: 'wA', ...over } as never }));
const answer = (m: M, id: string, lines: Row[], by = KEEPER, mayUse = yes) =>
  tx(m, (t) => recordAnswers(t, { companyId: C1, storeId: S1, countId: id, countedById: by, mayUse, body: { lines } as never }));
const submit = (m: M, id: string, by = KEEPER, mayUse = yes) => tx(m, (t) => submitCount(t, { companyId: C1, storeId: S1, countId: id, userId: by, mayUse }));
const approve = (m: M, id: string, by = BOSS, mayUse = yes) => tx(m, (t) => approveCount(t, { companyId: C1, storeId: S1, countId: id, userId: by, mayUse }));
const voidIt = (m: M, id: string, by = BOSS, mayDecide = true) =>
  tx(m, (t) => voidCount(t, { companyId: C1, storeId: S1, countId: id, userId: by, mayUse: yes, mayDecide, body: { reason: 'انفتحت بالغلط' } }));

const refusedWith = async (p: Promise<unknown>, code: string, klass: new (...a: never[]) => Error = StockCountRefused as never) => {
  const e = await p.then(() => null, (x: unknown) => x);
  expect(e, `expected refusal ${code}`).toBeInstanceOf(klass);
  expect((e as { code: string }).code).toBe(code);
  expect((e as { errorAr: string }).errorAr).toMatch(/[؀-ۿ]/);
  return e as StockCountRefused;
};

/** A sheet of p1 + p2 in wA, answered (p1 counted c1, p2 counted c2) and submitted by the keeper. */
async function submitted(m: M, c1: number, c2 = 4) {
  const { id } = await open(m, { productIds: ['p1', 'p2'] });
  await answer(m, id, [{ productId: 'p1', counted: c1 }, { productId: 'p2', counted: c2 }]);
  await submit(m, id);
  return id;
}

describe('the expected figure is the quick count’s, frozen at submit', () => {
  it('book − the units that left THAT warehouse with the courier; a confirmed parcel still on the shelf is counted', async () => {
    const m = world();
    const id = await submitted(m, 13);
    const line = m.data.stockCountLine.find((l) => l.countId === id && l.productId === 'p1')!;
    // Computed here from the rows: wA holds 10 + 6 = 16; o-left (waybill, from wA) holds 3; o-shelf (no waybill) is on the shelf.
    expect([line.book, line.withCourier, line.expected]).toEqual([16, 3, 13]);
    // The one formula: the sheet froze exactly what the quick count says.
    const facts = await tx(m, (t) => expectedInWarehouse(t, { companyId: C1, storeId: S1, productId: 'p1', warehouseId: 'wA' }));
    expect(line.expected).toBe(facts.expected);
    // o-nowhere names no warehouse: shown to the approver, subtracted from none.
    expect(line.unsourcedWithCourier).toBe(1);
    expect(m.data.stockCount[0].status).toBe('SUBMITTED');
    // Nothing on the shelf or in the ledger moved by opening, answering or submitting.
    expect(m.data.inventoryMovement).toEqual([]);
  });

  it('NEGATIVE: a sheet with an unanswered line is not submitted', async () => {
    const m = world();
    const { id } = await open(m, { productIds: ['p1', 'p2'] });
    await answer(m, id, [{ productId: 'p1', counted: 13 }]);
    const e = await refusedWith(submit(m, id), 'INCOMPLETE');
    expect(e.extra.missing).toBe(1);
    expect(m.data.stockCount[0].status).toBe('OPEN');
    expect(m.data.stockCountLine.every((l) => l.expected === null)).toBe(true);
  });

  it('NEGATIVE: after submit nothing is written on the sheet any more', async () => {
    const m = world();
    const id = await submitted(m, 13);
    await refusedWith(answer(m, id, [{ productId: 'p1', counted: 99 }]), 'NOT_OPEN');
    expect(m.data.stockCountLine.find((l) => l.productId === 'p1')!.counted).toBe(13);
  });
});

describe('opening a sheet', () => {
  it('all the store’s products by default, a chosen list when given; one open sheet per warehouse', async () => {
    const m = world();
    const all = await open(m);
    expect(all.scope).toBe('ALL');
    expect(all.lines.map((l) => l.productId)).toEqual(['p0', 'p1', 'p2']);
    await refusedWith(open(m, { productIds: ['p1'] }, HELPER), 'COUNT_ALREADY_OPEN');
    // Another warehouse is free to be counted.
    const other = await open(m, { warehouseId: 'wB', productIds: ['p1'] });
    expect([other.scope, other.lines.length]).toEqual(['CHOSEN', 1]);
  });

  it('NEGATIVE: another country, a stopped warehouse, another company’s, an unplaced store, no reach, another store’s product, a product twice', async () => {
    const m = world();
    await refusedWith(open(m, { warehouseId: 'wJ' }), 'WAREHOUSE_OTHER_COUNTRY');
    await refusedWith(open(m, { warehouseId: 'wOff' }), 'WAREHOUSE_STOPPED');
    await refusedWith(open(m, { warehouseId: 'wX' }), 'WAREHOUSE_NOT_FOUND');
    await refusedWith(open(m, {}, KEEPER, yes, 's-unplaced'), 'STORE_NOT_PLACED');
    await refusedWith(open(m, {}, KEEPER, no), 'NOT_REACHED');
    await refusedWith(open(m, { productIds: ['p-un'] }), 'PRODUCT_NOT_FOUND');
    await refusedWith(open(m, { productIds: ['p1', 'p1'] }), 'PRODUCT_TWICE');
    expect(m.data.stockCount).toEqual([]);
  });

  it('the opening locks the warehouse row FOR UPDATE (every receipt reads it FOR SHARE before it asks «under count?»)', async () => {
    const m = world();
    await open(m);
    expect(m.locks.some((l) => /FROM "warehouses" WHERE "id" = \? FOR UPDATE :: wA/.test(l))).toBe(true);
  });
});

describe('while a sheet is open the warehouse stands still — deliveries go on', () => {
  const receipt = (m: M, warehouseId = 'wA') =>
    tx(m, (t) => receiveStock(t, { companyId: C1, storeId: S1, productId: 'p1', quantity: 2, unitCost: 2, createdById: BOSS, warehouseId, mayUse: yes }));
  const send = (m: M, from: string, to: string) =>
    tx(m, (t) => sendTransfer(t, { companyId: C1, storeId: S1, sentById: BOSS, mayUse: yes, body: { fromWarehouseId: from, toWarehouseId: to, lines: [{ productId: 'p1', quantity: 1 }] } as never }));
  const exit = (m: M, warehouseId = 'wA') =>
    tx(m, (t) => requestExit(t, { companyId: C1, storeId: S1, requestedById: BOSS, mayUse: yes, body: { warehouseId, reason: 'DAMAGED', lines: [{ productId: 'p2', quantity: 1 }] } as never }));

  for (const status of ['OPEN', 'SUBMITTED'] as const) {
    it(`NEGATIVE (${status}): a receipt, a production-like intake, a return receipt, a transfer from or to it, an exit — each refused in Arabic`, async () => {
      const m = world();
      const id = status === 'OPEN' ? (await open(m)).id : await submitted(m, 13);
      const before = JSON.stringify(m.data.productionBatch);
      await refusedWith(receipt(m), 'WAREHOUSE_COUNTING', IntakePlaceRefused as never);
      await refusedWith(
        tx(m, (t) => returnPlace(t, { companyId: C1, storeId: S1, productIds: ['p1'], warehouseId: 'wA', mayUse: yes })),
        'WAREHOUSE_COUNTING',
        IntakePlaceRefused as never
      );
      await refusedWith(send(m, 'wA', 'wB'), 'WAREHOUSE_COUNTING', StockTransferRefused as never);
      await refusedWith(send(m, 'wB', 'wA'), 'WAREHOUSE_COUNTING', StockTransferRefused as never);
      await refusedWith(exit(m), 'WAREHOUSE_COUNTING', StockExitRefused as never);
      expect(JSON.stringify(m.data.productionBatch)).toBe(before);
      expect(m.data.stockTransfer).toEqual([]);
      expect(m.data.stockExit).toEqual([]);
      // Another warehouse is not frozen by it.
      expect((await receipt(m, 'wB')).batch.warehouseId).toBe('wB');
      expect(m.data.stockCount.find((c) => c.id === id)!.status).toBe(status);
    });
  }

  it('NEGATIVE: a transfer sent BEFORE the sheet is neither received into it nor cancelled back into it while it is open', async () => {
    const m = world();
    const toA = await send(m, 'wB', 'wA');
    const fromA = await send(m, 'wA', 'wB');
    await open(m);
    await refusedWith(
      tx(m, (t) => receiveTransfer(t, { companyId: C1, storeId: S1, transferId: toA.transfer.id, receivedById: KEEPER, mayUse: yes, body: { lines: [{ productId: 'p1', quantity: 1 }] } as never })),
      'WAREHOUSE_COUNTING',
      StockTransferRefused as never
    );
    await refusedWith(
      tx(m, (t) => cancelTransfer(t, { companyId: C1, storeId: S1, transferId: fromA.transfer.id, cancelledById: BOSS, mayUse: yes, body: { reason: 'غلط بالعدد' } as never })),
      'WAREHOUSE_COUNTING',
      StockTransferRefused as never
    );
    // …but the transfer from wA can still be received in wB: wB is not under count.
    const r = await tx(m, (t) => receiveTransfer(t, { companyId: C1, storeId: S1, transferId: fromA.transfer.id, receivedById: KEEPER, mayUse: yes, body: { lines: [{ productId: 'p1', quantity: 1 }] } as never }));
    expect(r.transfer.status).toBe('RECEIVED');
  });

  it('NEGATIVE: an exit asked before the sheet is not approved while it is open', async () => {
    const m = world();
    const e = await exit(m);
    await open(m);
    await refusedWith(
      tx(m, (t) => approveExit(t, { companyId: C1, storeId: S1, exitId: e.exit.id, decidedById: BOSS2, mayUse: yes })),
      'WAREHOUSE_COUNTING',
      StockExitRefused as never
    );
    expect(m.data.stockExit[0].status).toBe('PENDING');
  });

  it('a delivery goes on between submit and approval, and the frozen difference is still the right one', async () => {
    const m = world();
    // The keeper finds 12 where 13 are expected: one unit is missing.
    const id = await submitted(m, 12);
    // o-left is delivered: its 3 units leave the book (the delivery's draw, its own warehouse first) and the courier.
    await tx(m, (t) => drawDownStock(t, { companyId: C1, storeId: S1, productId: 'p1', quantity: 3, allowNegative: true, prefer: 'wA' }));
    m.data.orderItem.find((i) => i.id === 'i-left')!.reservedQty = 0;
    // What a person standing in wA should find did not move: (16 − 3) − 0 = 13.
    const now = await tx(m, (t) => expectedInWarehouse(t, { companyId: C1, storeId: S1, productId: 'p1', warehouseId: 'wA' }));
    expect(now.expected).toBe(13);
    await approve(m, id);
    // The shelf of wA after the approval: 13 − 1 = 12 — what the keeper counted.
    expect(at(m, 'wA')).toBe(12);
  });
});

describe('approval by a different person applies each difference in THAT warehouse', () => {
  it('conservation: a shortfall leaves oldest first in wA only; «دخل» still, «خرج» + the shortfall, the value falls by what left at its cost', async () => {
    const m = world();
    const before = figures(m);
    const id = await submitted(m, 1); // expected 13 → 12 short
    const out = await approve(m, id);
    const after = figures(m);
    expect(after.produced).toBe(before.produced);
    expect(after.sold).toBe(before.sold + 12);
    expect(after.remaining).toBe(before.remaining - 12);
    // Oldest first IN wA: 10 of b1 at 2, then 2 of b2 at 3.3335; bB in wB (older than both) is untouched.
    expect([at(m, 'wA'), at(m, 'wB')]).toEqual([4, 5]);
    expect(m.data.productionBatch.find((b) => b.id === 'bB')).toMatchObject({ quantityRemaining: 5, quantitySold: 0 });
    expect(after.value).toBeCloseTo(before.value - (10 * 2 + 2 * 3.3335), 9);
    const line = out.count.lines.find((l) => l.productId === 'p1')!;
    // Rounded ONCE to the store currency's three decimals.
    expect([line.applied, line.valueAtCost]).toEqual([-12, -26.667]);
    // p2 matched: nothing moved for it.
    expect(figures(m, 'p2').remaining).toBe(4);
    expect(m.data.inventoryMovement.map((x) => [x.type, x.quantity, x.warehouseId, x.storeId, x.referenceId, x.createdById, x.productId])).toEqual([
      ['MANUAL_ADJUSTMENT', -12, 'wA', S1, id, BOSS, 'p1'],
    ]);
    expect(identityHolds(m)).toBe(true);
    expect([out.count.status, out.count.decidedById]).toEqual(['APPROVED', BOSS]);
  });

  it('a surplus enters wA at the cost of the NEWEST batch holding units there; one ledger line with the sheet’s id', async () => {
    const m = world();
    const before = figures(m);
    const id = await submitted(m, 15); // expected 13 → 2 more
    const out = await approve(m, id);
    const after = figures(m);
    expect(after.remaining).toBe(before.remaining + 2);
    expect(after.produced).toBe(before.produced + 2);
    expect(after.sold).toBe(before.sold);
    const born = m.data.productionBatch.find((b) => String(b.batchNumber).startsWith('ADJ-'))!;
    // b2 (3.3335) is the newest batch in wA — not bB, not a zero.
    expect([born.warehouseId, born.storeId, born.costPerUnit, born.quantityRemaining]).toEqual(['wA', S1, 3.3335, 2]);
    expect(after.value).toBeCloseTo(before.value + 2 * 3.3335, 9);
    expect(out.count.lines.find((l) => l.productId === 'p1')).toMatchObject({ applied: 2, valueAtCost: 6.667 });
    // ONE line, not a «استلام» line beside it.
    expect(m.data.inventoryMovement.map((x) => [x.type, x.quantity, x.warehouseId, x.referenceId])).toEqual([['MANUAL_ADJUSTMENT', 2, 'wA', id]]);
  });

  it('NEGATIVE: a surplus of something never costed refuses the WHOLE approval — nothing written, the sheet still waits', async () => {
    const m = world();
    const { id } = await open(m, { productIds: ['p0', 'p1'] });
    await answer(m, id, [{ productId: 'p0', counted: 5 }, { productId: 'p1', counted: 12 }]);
    await submit(m, id);
    const batches = JSON.stringify(m.data.productionBatch);
    const e = await refusedWith(approve(m, id), 'UNCOSTED_SURPLUS');
    expect(e.errorAr).toContain('منتج بلا كلفة');
    expect(JSON.stringify(m.data.productionBatch)).toBe(batches);
    expect(m.data.inventoryMovement).toEqual([]);
    expect(m.data.stockCount[0].status).toBe('SUBMITTED');
  });

  it('NEGATIVE: a shortfall the warehouse no longer holds refuses the whole approval', async () => {
    const m = world();
    const id = await submitted(m, 1);
    // A delivery emptied wA's rows meanwhile (and its parcel was never sourced here).
    for (const b of m.data.productionBatch.filter((x) => x.productId === 'p1' && x.warehouseId === 'wA')) {
      b.quantitySold += b.quantityRemaining - 1;
      b.quantityRemaining = 1;
    }
    const batches = JSON.stringify(m.data.productionBatch);
    await refusedWith(approve(m, id), 'NOT_ON_SHELF');
    expect(JSON.stringify(m.data.productionBatch)).toBe(batches);
  });

  it('TWO HANDS: the opener, anyone who counted a line and the submitter cannot approve — a replay is «done» only for the approver', async () => {
    const m = world();
    const { id } = await open(m, { productIds: ['p1', 'p2'] });
    await answer(m, id, [{ productId: 'p1', counted: 12 }]);
    await answer(m, id, [{ productId: 'p2', counted: 4 }], HELPER);
    await submit(m, id, BOSS2);
    for (const who of [KEEPER, HELPER, BOSS2]) await refusedWith(approve(m, id, who), 'COUNTER_CANNOT_APPROVE');
    expect(m.data.inventoryMovement).toEqual([]);
    const first = await approve(m, id, BOSS);
    const again = await approve(m, id, BOSS);
    expect([first.replay, again.replay]).toEqual([false, true]);
    expect(m.data.inventoryMovement).toHaveLength(1);
    await refusedWith(approve(m, id, 'u-third'), 'ALREADY_APPROVED');
    // …and the counter cannot «replay» an approval she never made.
    await refusedWith(approve(m, id, KEEPER), 'COUNTER_CANNOT_APPROVE');
  });

  it('NEGATIVE: an open sheet is not approved; a sheet of a warehouse the approver does not reach is not approved', async () => {
    const m = world();
    const { id } = await open(m, { productIds: ['p1'] });
    await answer(m, id, [{ productId: 'p1', counted: 12 }]);
    await refusedWith(approve(m, id), 'NOT_SUBMITTED');
    await submit(m, id);
    await refusedWith(approve(m, id, BOSS, no), 'NOT_REACHED');
    expect(m.data.stockCount[0].status).toBe('SUBMITTED');
  });

  it('after the approval the warehouse moves again', async () => {
    const m = world();
    const id = await submitted(m, 13, 4);
    await approve(m, id);
    const r = await tx(m, (t) => receiveStock(t, { companyId: C1, storeId: S1, productId: 'p1', quantity: 2, unitCost: 2, createdById: BOSS, warehouseId: 'wA', mayUse: yes }));
    expect(r.batch.warehouseId).toBe('wA');
  });
});

describe('a voided sheet changes nothing', () => {
  it('the shelf, the ledger and the cost stay byte for byte; the warehouse is free again', async () => {
    const m = world();
    const batches = JSON.stringify(m.data.productionBatch);
    const id = await submitted(m, 1);
    const out = await voidIt(m, id);
    expect(out.count.status).toBe('VOIDED');
    expect(JSON.stringify(m.data.productionBatch)).toBe(batches);
    expect(m.data.inventoryMovement).toEqual([]);
    await refusedWith(approve(m, id), 'ALREADY_VOIDED');
    // A new sheet may be opened on the warehouse.
    expect((await open(m, { productIds: ['p1'] })).status).toBe('OPEN');
  });

  it('the opener voids her own sheet while it is counted; not once it is submitted, and nobody else without the approver’s key', async () => {
    const m = world();
    const a = await open(m, { productIds: ['p1'] });
    await refusedWith(voidIt(m, a.id, HELPER, false), 'VOID_NOT_YOURS');
    expect((await voidIt(m, a.id, KEEPER, false)).count.status).toBe('VOIDED');
    const b = await submitted(m, 13);
    await refusedWith(voidIt(m, b, KEEPER, false), 'VOID_NOT_YOURS');
    expect((await voidIt(m, b, BOSS, true)).count.status).toBe('VOIDED');
  });
});

describe('the keeper’s answers', () => {
  it('NEGATIVE: a product not on the sheet, a product twice, a warehouse she does not reach', async () => {
    const m = world();
    const { id } = await open(m, { productIds: ['p1'] });
    await refusedWith(answer(m, id, [{ productId: 'p2', counted: 1 }]), 'NOT_ON_SHEET');
    await refusedWith(answer(m, id, [{ productId: 'p1', counted: 1 }, { productId: 'p1', counted: 2 }]), 'PRODUCT_TWICE');
    await refusedWith(answer(m, id, [{ productId: 'p1', counted: 1 }], KEEPER, no), 'NOT_REACHED');
    expect(m.data.stockCountLine[0].counted).toBe(null);
  });

  it('a line answered again replaces the answer before it', async () => {
    const m = world();
    const { id } = await open(m, { productIds: ['p1'] });
    await answer(m, id, [{ productId: 'p1', counted: 9 }]);
    await answer(m, id, [{ productId: 'p1', counted: 11 }], HELPER);
    expect(m.data.stockCountLine[0]).toMatchObject({ counted: 11, countedById: HELPER });
  });
});

describe('combinations are counted one by one and moved by the one writer', () => {
  const withVariants = () =>
    world({
      productVariant: [
        { id: 'v-red', companyId: C1, productId: 'p1', label: 'أحمر', status: 'ACTIVE', onHand: 16, sortOrder: 0 },
        { id: 'v-blue', companyId: C1, productId: 'p1', label: 'أزرق', status: 'ACTIVE', onHand: 5, sortOrder: 1 },
      ],
      productVariantStock: [
        { id: 'pv1', companyId: C1, variantId: 'v-red', warehouseId: 'wA', onHand: 10, inTransitTransferId: null },
        { id: 'pv2', companyId: C1, variantId: 'v-blue', warehouseId: 'wA', onHand: 6, inTransitTransferId: null },
        { id: 'pv3', companyId: C1, variantId: 'v-red', warehouseId: null, onHand: 6, inTransitTransferId: null },
      ],
      orderItemVariant: [{ id: 'iv1', orderItemId: 'i-left', variantId: 'v-blue', quantity: 3, freeQuantity: 0 }],
    });

  it('NEGATIVE: a product with active combinations must name them, and their sum is the line', async () => {
    const m = withVariants();
    const { id } = await open(m, { productIds: ['p1'] });
    await refusedWith(answer(m, id, [{ productId: 'p1', counted: 13 }]), 'VARIANTS_REQUIRED');
    await refusedWith(answer(m, id, [{ productId: 'p1', counted: 13, variants: [{ variantId: 'v-red', quantity: 5 }, { variantId: 'v-blue', quantity: 3 }] }]), 'VARIANTS_SUM');
  });

  it('each combination’s expected is frozen (its pieces in wA − its pieces with the courier from wA) and its difference moves its place', async () => {
    const m = withVariants();
    const { id } = await open(m, { productIds: ['p1'] });
    // red: 9 counted against 10 expected (1 short); blue: 4 counted against 6 − 3 = 3 (1 more).
    await answer(m, id, [{ productId: 'p1', counted: 13, variants: [{ variantId: 'v-red', quantity: 9 }, { variantId: 'v-blue', quantity: 4 }] }]);
    await submit(m, id);
    expect(m.data.stockCountLineVariant.map((v) => [v.variantId, v.counted, v.expected])).toEqual([
      ['v-red', 9, 10],
      ['v-blue', 4, 3],
    ]);
    await approve(m, id);
    const place = (v: string, w: string | null) => m.data.productVariantStock.find((r) => r.variantId === v && r.warehouseId === w)?.onHand;
    expect([place('v-red', 'wA'), place('v-red', null), place('v-blue', 'wA')]).toEqual([9, 6, 7]);
    // onHand of each combination = Σ of its places (the one writer).
    for (const v of m.data.productVariant) {
      expect(v.onHand).toBe(m.data.productVariantStock.filter((r) => r.variantId === v.id).reduce((s, r) => s + r.onHand, 0));
    }
    expect(m.data.variantStockMovement.map((x) => [x.variantId, x.type, x.quantity, x.referenceId])).toEqual([
      ['v-blue', 'COUNT', 1, id],
      ['v-red', 'COUNT', -1, id],
    ]);
    // BLIND (review of #445): the keeper's view of a combination line carries what she counted — never its expected.
    const c = await tx(m, (t2) => import('./stock-counts').then((x) => x.readCount(t2, C1, S1, id)));
    const blind = JSON.parse(JSON.stringify(countShown(c, { seesExpected: false, seesCost: true })));
    expect(blind.lines[0].variants).toEqual([{ variantId: 'v-blue', counted: 4 }, { variantId: 'v-red', counted: 9 }]);
    expect(JSON.stringify(blind)).not.toMatch(/expected|book|withCourier|applied|valueAtCost/);
    expect(countShown(c, { seesExpected: true, seesCost: true }).lines[0].variants).toEqual([
      { variantId: 'v-blue', counted: 4, expected: 3 },
      { variantId: 'v-red', counted: 9, expected: 10 },
    ]);
  });
});

describe('what a door shows', () => {
  const EXPECTED_KEYS = ['book', 'withCourier', 'expected', 'unsourcedWithCourier', 'applied', 'valueAtCost'];
  const walk = (v: unknown, visit: (k: string, x: unknown) => void, key = '') => {
    visit(key, v);
    if (Array.isArray(v)) v.forEach((x) => walk(x, visit));
    else if (v && typeof v === 'object') for (const [k, x] of Object.entries(v)) walk(x, visit, k);
  };

  it('BLIND: the keeper’s view carries no book figure at any depth; the approver sees them; the value only with the cost key', async () => {
    const m = world();
    const id = await submitted(m, 15);
    await approve(m, id);
    const c = (await tx(m, (t) => import('./stock-counts').then((x) => x.readCount(t, C1, S1, id))));
    const keeper = JSON.parse(JSON.stringify(countShown(c, { seesExpected: false, seesCost: true })));
    walk(keeper, (k) => expect(EXPECTED_KEYS, `«${k}» reached the keeper`).not.toContain(k));
    expect(keeper.lines.map((l: Row) => [l.productId, l.counted])).toEqual([['p1', 15], ['p2', 4]]);
    const boss = countShown(c, { seesExpected: true, seesCost: false });
    expect(boss.lines.find((l) => l.productId === 'p1')).toMatchObject({ expected: 13, applied: 2 });
    expect(boss.lines.some((l) => 'valueAtCost' in l)).toBe(false);
    expect(countShown(c, { seesExpected: true, seesCost: true }).lines.find((l) => l.productId === 'p1')).toMatchObject({ valueAtCost: 6.667 });
  });
});

describe('the warehouse is not stopped under a count', () => {
  it('an open or a submitted sheet is a stop blocker; an approved or voided one is not', async () => {
    const m = world();
    const id = await submitted(m, 13);
    const blockers = await warehouseStopBlockers(m.db as never, C1, 'wA');
    expect(blockers.map((b) => b.code)).toContain('OPEN_COUNT');
    expect(blockers.find((b) => b.code === 'OPEN_COUNT')?.ar).toMatch(/جرد/);
    await voidIt(m, id);
    expect((await warehouseStopBlockers(m.db as never, C1, 'wA')).map((b) => b.code)).not.toContain('OPEN_COUNT');
  });
});

describe('no money', () => {
  it('the count module imports nothing from wallets, expenses or profit — at any depth of its own imports', () => {
    const seen = new Set<string>();
    const forbidden = /wallet|expense|profit|settlement|payroll|commission/i;
    const visit = (file: string) => {
      if (seen.has(file)) return;
      seen.add(file);
      const src = readFileSync(file, 'utf8');
      for (const m of src.matchAll(/from '(\.[^']+|@\/lib\/[^']+)'/g)) {
        const spec = m[1].startsWith('@/') ? join(process.cwd(), 'src', m[1].slice(2)) : join(dirname(file), m[1]);
        const target = [`${spec}.ts`, join(spec, 'index.ts')].find((p) => existsSync(p));
        if (!target) continue;
        expect(target, `${file} → ${target}`).not.toMatch(forbidden);
        visit(target);
      }
    };
    for (const f of ['stock-counts.ts', 'stock-count-freeze.ts']) visit(join(process.cwd(), 'src', 'lib', f));
    expect(seen.size).toBeGreaterThan(3);
  });
});
