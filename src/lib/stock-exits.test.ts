import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { memoryDb, type Row } from './stock-transfers.memory-db.test';
import { approveExit, exitShown, rejectExit, rejectSchema, requestExit, requestSchema, StockExitRefused } from './stock-exits';
import { EXIT_MOVEMENT_TYPE, EXIT_REASON_AR, EXIT_REASONS } from './stock-exit-reasons';
import { freeStockOf, sendTransfer, StockTransferRefused } from './stock-transfers';
import { drawDownStock } from './receiving';
import { warehouseStopBlockers } from './warehouses';

/**
 * GOODS OUT OF A WAREHOUSE FOR GOOD (W6a) — the lib, against the small in-memory database of the transfer tests, which
 * judges every `where` itself and has no money table at all.
 *
 * Every figure asserted is computed HERE from the batch rows, never by the function under test:
 *   «دخل» Σ produced · «خرج» Σ sold · on hand Σ remaining · the stock value Σ (remaining × cost), added per unit cost;
 *   the value at cost of what left = Σ over the rows of (remaining before − remaining after) × the row's cost.
 */

const C1 = 'c1';
const S1 = 's1';
const ASKER = 'u-asker';
const BOSS = 'u-boss';
const OTHER_BOSS = 'u-boss-2';
type MayUse = (w: { id: string }) => Promise<boolean>;
const yes: MayUse = async () => true;
const no: MayUse = async () => false;

let uuidSeq = 0;
const uuid = () => `00000000-0000-4000-a000-${String(++uuidSeq).padStart(12, '0')}`;

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
 * The default shelf of p1: wA holds b1 (10 at 2.000, oldest) and b2 (6 at 3.3335, newer); wB holds bB (5 at 1.000, the
 * OLDEST of all — an exit from wA must never touch it). The store's currency has THREE decimals.
 */
function world(batches: Row[] = defaultBatches(), extra: Row = {}) {
  return memoryDb({
    country: [
      { id: 'k1', companyId: C1, isActive: true, minorUnit: 3 },
      { id: 'k2', companyId: C1, isActive: true, minorUnit: 2 },
    ],
    store: [
      { id: S1, companyId: C1, countryId: 'k1', name: 'المتجر' },
      { id: 's2', companyId: C1, countryId: 'k1', name: 'متجر تاني' },
      { id: 's-unplaced', companyId: C1, countryId: 'k1', name: 'مش موزّع' },
    ],
    warehouse: [
      { id: 'wA', companyId: C1, countryId: 'k1', name: 'أ', isActive: true },
      { id: 'wB', companyId: C1, countryId: 'k1', name: 'ب', isActive: true },
      { id: 'wOff', companyId: C1, countryId: 'k1', name: 'موقوف', isActive: false },
      { id: 'wJ', companyId: C1, countryId: 'k2', name: 'عمّان', isActive: true },
      { id: 'wX', companyId: 'c2', countryId: 'k9', name: 'غريب', isActive: true },
    ],
    warehousePlacement: [
      { id: 'pl1', companyId: C1, storeId: S1 },
      { id: 'pl2', companyId: C1, storeId: 's2' },
    ],
    product: [
      { id: 'p1', companyId: C1, storeId: S1, name: 'منتج ١' },
      { id: 'p2', companyId: C1, storeId: S1, name: 'منتج ٢' },
      { id: 'p-s2', companyId: C1, storeId: 's2', name: 'منتج المتجر التاني' },
      { id: 'p-un', companyId: C1, storeId: 's-unplaced', name: 'منتج مش موزّع' },
    ],
    productionBatch: batches,
    ...extra,
  });
}
function defaultBatches() {
  return [
    batch('b1'),
    batch('b2', { productionDate: new Date('2026-10-05'), costPerUnit: 3.3335, quantityProduced: 9, quantitySold: 3, quantityRemaining: 6 }),
    batch('bB', { productionDate: new Date('2026-09-01'), costPerUnit: 1, quantityProduced: 5, quantityRemaining: 5, warehouseId: 'wB' }),
    batch('q1', { productId: 'p2', costPerUnit: 7, quantityProduced: 4, quantityRemaining: 4 }),
  ];
}

type M = ReturnType<typeof memoryDb>;
const rows = (m: M, productId = 'p1') => m.data.productionBatch.filter((b) => b.productId === productId && b.companyId === C1);
function figures(m: M, productId = 'p1') {
  const rs = rows(m, productId);
  const byCost = new Map<number, number>();
  for (const r of rs) byCost.set(r.costPerUnit, (byCost.get(r.costPerUnit) ?? 0) + r.quantityRemaining);
  return {
    produced: rs.reduce((s, r) => s + r.quantityProduced, 0),
    sold: rs.reduce((s, r) => s + r.quantitySold, 0),
    remaining: rs.reduce((s, r) => s + r.quantityRemaining, 0),
    value: [...byCost.entries()].reduce((s, [c, u]) => s + c * u, 0),
  };
}
const at = (m: M, place: string, productId = 'p1') =>
  rows(m, productId).filter((r) => r.warehouseId === place).reduce((s, r) => s + r.quantityRemaining, 0);
const snapshot = (m: M) => new Map(m.data.productionBatch.map((r) => [r.id, { left: r.quantityRemaining, cost: r.costPerUnit }]));
/** What left between two snapshots, at each row's own cost — computed from the rows, not by the lib. */
const leftValue = (before: ReturnType<typeof snapshot>, m: M) =>
  m.data.productionBatch.reduce((s, r) => s + ((before.get(r.id)?.left ?? 0) - r.quantityRemaining) * r.costPerUnit, 0);
const identityHolds = (m: M) =>
  m.data.productionBatch.every((r) => r.quantityRemaining === r.quantityProduced + r.quantityMovedIn - r.quantitySold - r.quantityMovedOut);

const ask = (m: M, lines: Row[], over: Row = {}, by = ASKER, mayUse = yes, storeId = S1) =>
  (m.db as Row).$transaction((tx: Row) =>
    requestExit(tx as never, { companyId: C1, storeId, requestedById: by, mayUse, body: { warehouseId: 'wA', reason: 'DAMAGED', lines, ...over } as never })
  );
const approve = (m: M, id: string, by = BOSS, mayUse = yes) =>
  (m.db as Row).$transaction((tx: Row) => approveExit(tx as never, { companyId: C1, storeId: S1, exitId: id, decidedById: by, mayUse }));
const reject = (m: M, id: string, by = BOSS, mayUse = yes) =>
  (m.db as Row).$transaction((tx: Row) => rejectExit(tx as never, { companyId: C1, storeId: S1, exitId: id, decidedById: by, mayUse, body: { reason: 'العدّ غلط' } }));
const free = (m: M, warehouseId = 'wA', productIds = ['p1'], storeId = S1) =>
  (m.db as Row).$transaction((tx: Row) => freeStockOf(tx as never, { companyId: C1, storeId, warehouseId, productIds }));
const refusedWith = async (p: Promise<unknown>, code: string) => {
  const e = await p.then(() => null, (x: unknown) => x);
  expect(e, `expected refusal ${code}`).toBeInstanceOf(StockExitRefused);
  expect((e as StockExitRefused).code).toBe(code);
  expect((e as StockExitRefused).errorAr).toMatch(/[؀-ۿ]/);
  return e as StockExitRefused;
};

describe('a request holds the units; nothing leaves yet', () => {
  it('the shelf and the ledger do not move; the free stock of THAT warehouse falls by the request', async () => {
    const m = world();
    const before = figures(m);
    expect((await free(m)).get('p1')).toBe(16);
    const { exit, replay } = await ask(m, [{ productId: 'p1', quantity: 12 }]);
    expect([exit.status, replay, exit.warehouseId, exit.reason]).toEqual(['PENDING', false, 'wA', 'DAMAGED']);
    expect(figures(m)).toEqual(before);
    expect(m.data.inventoryMovement).toEqual([]);
    expect((await free(m)).get('p1')).toBe(4);
    // Another warehouse's free stock is not touched by it.
    expect((await free(m, 'wB')).get('p1')).toBe(5);
  });

  it('NEGATIVE: more than the free stock is refused, naming the product and what is free — pending exits count', async () => {
    const m = world();
    await ask(m, [{ productId: 'p1', quantity: 12 }]);
    const e = await refusedWith(ask(m, [{ productId: 'p1', quantity: 5 }]), 'NOT_ENOUGH_FREE');
    expect(e.errorAr).toContain('منتج ١');
    expect(e.extra.short).toEqual([{ productId: 'p1', name: 'منتج ١', asked: 5, free: 4 }]);
    expect(m.data.stockExit).toHaveLength(1);
    // Exactly the free stock is allowed.
    expect((await ask(m, [{ productId: 'p1', quantity: 4 }])).exit.status).toBe('PENDING');
  });

  it('NEGATIVE: a transfer cannot send the units an exit holds (one free-stock formula for both documents)', async () => {
    const m = world();
    await ask(m, [{ productId: 'p1', quantity: 15 }]);
    const e = await (m.db as Row)
      .$transaction((tx: Row) =>
        sendTransfer(tx as never, { companyId: C1, storeId: S1, sentById: ASKER, mayUse: yes, body: { fromWarehouseId: 'wA', toWarehouseId: 'wB', lines: [{ productId: 'p1', quantity: 2 }] } as never })
      )
      .then(() => null, (x: unknown) => x);
    expect(e).toBeInstanceOf(StockTransferRefused);
    expect((e as StockTransferRefused).code).toBe('NOT_ENOUGH_FREE');
  });

  it('the store filter: a pending exit of ANOTHER store in the same warehouse, or of this store in another warehouse, holds nothing here', async () => {
    const m = world([...defaultBatches(), batch('s2b', { storeId: 's2', productId: 'p-s2', quantityRemaining: 8, quantityProduced: 8 })]);
    await ask(m, [{ productId: 'p-s2', quantity: 3 }], {}, ASKER, yes, 's2');
    await ask(m, [{ productId: 'p1', quantity: 2 }], { warehouseId: 'wB' });
    expect((await free(m)).get('p1')).toBe(16);
    expect((await free(m, 'wA', ['p-s2'], 's2')).get('p-s2')).toBe(5);
    // …and the pending line of store s2 is not this store's, though the product id were asked under this store.
    m.data.stockExitLine.push({ id: 'forged', exitId: m.data.stockExit[0].id, productId: 'p1', quantity: 9, valueAtCost: null });
    expect((await free(m)).get('p1')).toBe(16);
  });

  it('NEGATIVE: the same product twice, another country, a stopped warehouse, an unplaced store, no reach, another store’s product', async () => {
    const m = world();
    await refusedWith(ask(m, [{ productId: 'p1', quantity: 1 }, { productId: 'p1', quantity: 2 }]), 'PRODUCT_TWICE');
    await refusedWith(ask(m, [{ productId: 'p1', quantity: 1 }], { warehouseId: 'wJ' }), 'WAREHOUSE_OTHER_COUNTRY');
    await refusedWith(ask(m, [{ productId: 'p1', quantity: 1 }], { warehouseId: 'wOff' }), 'WAREHOUSE_STOPPED');
    await refusedWith(ask(m, [{ productId: 'p1', quantity: 1 }], { warehouseId: 'wX' }), 'WAREHOUSE_NOT_FOUND');
    await refusedWith(ask(m, [{ productId: 'p-un', quantity: 1 }], {}, ASKER, yes, 's-unplaced'), 'STORE_NOT_PLACED');
    await refusedWith(ask(m, [{ productId: 'p1', quantity: 1 }], {}, ASKER, no), 'NOT_REACHED');
    await refusedWith(ask(m, [{ productId: 'p-s2', quantity: 1 }]), 'PRODUCT_NOT_FOUND');
    expect(m.data.stockExit).toEqual([]);
  });

  it('the replay: the same id, request and person → that exit, nothing written; anything else under the id → EXIT_EXISTS', async () => {
    const m = world();
    const id = uuid();
    const first = await ask(m, [{ productId: 'p1', quantity: 3 }], { id, note: ' انكسرت ' });
    const again = await ask(m, [{ productId: 'p1', quantity: 3 }], { id, note: 'انكسرت' });
    expect([again.replay, again.exit.id]).toEqual([true, first.exit.id]);
    await refusedWith(ask(m, [{ productId: 'p1', quantity: 4 }], { id, note: 'انكسرت' }), 'EXIT_EXISTS');
    await refusedWith(ask(m, [{ productId: 'p1', quantity: 3 }], { id, note: 'انكسرت', reason: 'EXPIRED' }), 'EXIT_EXISTS');
    await refusedWith(ask(m, [{ productId: 'p1', quantity: 3 }], { id, note: 'انكسرت' }, 'u-somebody-else'), 'EXIT_EXISTS');
    expect(m.data.stockExit).toHaveLength(1);
    expect(m.data.stockExitLine).toHaveLength(1);
  });
});

describe('approval by a second person: oldest first in THAT warehouse, the value at cost kept on the line', () => {
  it('conservation: «دخل» still; «خرج» +n; on hand −n; the value falls by exactly what left at its rows’ cost', async () => {
    const m = world();
    const before = figures(m);
    const snap = snapshot(m);
    const { exit } = await ask(m, [{ productId: 'p1', quantity: 12 }]);
    const out = await approve(m, exit.id);
    expect(out.exit.status).toBe('APPROVED');
    expect(out.exit.decidedById).toBe(BOSS);
    const after = figures(m);
    expect(after.produced).toBe(before.produced);
    expect(after.sold).toBe(before.sold + 12);
    expect(after.remaining).toBe(before.remaining - 12);
    // Oldest first IN wA: all 10 of b1 at 2, then 2 of b2 at 3.3335. bB in wB — older than both — is untouched.
    expect([at(m, 'wA'), at(m, 'wB')]).toEqual([4, 5]);
    expect(m.data.productionBatch.find((b) => b.id === 'bB')).toMatchObject({ quantityRemaining: 5, quantitySold: 0 });
    const left = leftValue(snap, m);
    expect(left).toBeCloseTo(10 * 2 + 2 * 3.3335, 9);
    expect(after.value).toBeCloseTo(before.value - left, 9);
    // The line keeps it, rounded ONCE to the store currency's three decimals: 26.667 (26.6670), not two decimals.
    expect(out.exit.lines).toEqual([{ productId: 'p1', quantity: 12, valueAtCost: 26.667 }]);
    expect(identityHolds(m)).toBe(true);
    // One ledger line: the reason's type, −12, in wA, pointing at the exit, by the approver.
    expect(m.data.inventoryMovement.map((x) => [x.type, x.quantity, x.warehouseId, x.storeId, x.referenceId, x.createdById, x.balanceAfter])).toEqual([
      ['DAMAGE', -12, 'wA', S1, exit.id, BOSS, before.remaining - 12],
    ]);
  });

  it('a rounding the currency decides: 3 units at 3.3335 is 10.0005 → 10.001 with three decimals (half away from zero)', async () => {
    const m = world([batch('h1', { costPerUnit: 3.3335, quantityProduced: 3, quantityRemaining: 3 })]);
    const { exit } = await ask(m, [{ productId: 'p1', quantity: 3 }]);
    const out = await approve(m, exit.id);
    expect(out.exit.lines[0].valueAtCost).toBe(10.001);
  });

  it('several products in one exit: each line its own draw, its own value, its own ledger line', async () => {
    const m = world();
    const snap = snapshot(m);
    const { exit } = await ask(m, [{ productId: 'p1', quantity: 3 }, { productId: 'p2', quantity: 4 }], { reason: 'SAMPLES' });
    const out = await approve(m, exit.id);
    expect(out.exit.lines).toEqual([
      { productId: 'p1', quantity: 3, valueAtCost: 6 },
      { productId: 'p2', quantity: 4, valueAtCost: 28 },
    ]);
    expect(leftValue(snap, m)).toBeCloseTo(34, 9);
    expect(m.data.inventoryMovement.map((x) => [x.productId, x.type, x.quantity])).toEqual([
      ['p1', 'EXIT_SAMPLES', -3],
      ['p2', 'EXIT_SAMPLES', -4],
    ]);
  });

  it('every reason writes its own movement type — damage as DAMAGE, the six others as new EXIT_ types', async () => {
    const m = world([batch('big', { quantityProduced: 100, quantityRemaining: 100 })]);
    const seen: string[] = [];
    for (const reason of EXIT_REASONS) {
      const { exit } = await ask(m, [{ productId: 'p1', quantity: 1 }], { reason, note: reason === 'OTHER' ? 'هدية لمحل الجيران' : null });
      await approve(m, exit.id);
      seen.push(m.data.inventoryMovement.at(-1)!.type);
    }
    expect(seen).toEqual(['DAMAGE', 'EXIT_EXPIRED', 'EXIT_SAMPLES', 'EXIT_SUPPLIER_RETURN', 'EXIT_OFF_SYSTEM_SALE', 'EXIT_PARTNER_DRAW', 'EXIT_OTHER']);
    expect(m.data.inventoryMovement.at(-1)!.reason).toBe('إخراج (أخرى): هدية لمحل الجيران');
    expect(new Set(Object.values(EXIT_MOVEMENT_TYPE)).size).toBe(EXIT_REASONS.length);
  });

  it('a run and the rows split from it are costed once (the draw’s family cost), and units on the road are never taken', async () => {
    // b1 (15 produced at 17.4047) was split: 5 came back to wA as a twin, 3 are on the road. wA holds 7 + 5 of ONE run.
    const m = world([
      batch('b1', { costPerUnit: 17.4047, quantityProduced: 15, quantityMovedOut: 8, quantityRemaining: 7 }),
      batch('b1~t1', { costPerUnit: 17.4047, quantityProduced: 0, quantityMovedIn: 5, quantityRemaining: 5, splitFromBatchId: 'b1', createdAt: new Date('2026-10-02') }),
      batch('b1~t2', { costPerUnit: 17.4047, quantityProduced: 0, quantityMovedIn: 3, quantityRemaining: 3, splitFromBatchId: 'b1', warehouseId: null, inTransitTransferId: 'tr-road' }),
    ]);
    const snap = snapshot(m);
    const { exit } = await ask(m, [{ productId: 'p1', quantity: 12 }]);
    const out = await approve(m, exit.id);
    expect(at(m, 'wA')).toBe(0);
    expect(m.data.productionBatch.find((r) => r.id === 'b1~t2')!.quantityRemaining).toBe(3);
    // 12 units of one run: 12 × 17.4047 = 208.8564 → 208.856 — the double the run gave before it was split.
    expect(out.exit.lines[0].valueAtCost).toBe(208.856);
    expect(leftValue(snap, m)).toBeCloseTo(12 * 17.4047, 9);
    expect(identityHolds(m)).toBe(true);
  });

  it('NEGATIVE: the shelf of that warehouse no longer holds the units (a delivery drew store-wide) → refused whole, nothing written', async () => {
    const m = world();
    const { exit } = await ask(m, [{ productId: 'p1', quantity: 12 }]);
    // A delivery of today draws store-wide, oldest first: bB (wB) 5, then b1 (wA) 10 — wA is left with 6.
    await (m.db as Row).$transaction((tx: Row) => drawDownStock(tx as never, { companyId: C1, storeId: S1, productId: 'p1', quantity: 15, allowNegative: true }));
    const before = structuredClone(m.data.productionBatch);
    const movements = m.data.inventoryMovement.length;
    const e = await refusedWith(approve(m, exit.id), 'NOT_ON_SHELF');
    expect(e.extra).toMatchObject({ productId: 'p1', onShelf: 6, asked: 12 });
    expect(m.data.productionBatch).toEqual(before);
    expect(m.data.inventoryMovement).toHaveLength(movements);
    expect(m.data.stockExit[0].status).toBe('PENDING');
    // The approver can reject it instead; the hold is released.
    await reject(m, exit.id);
    expect(m.data.stockExit[0].status).toBe('REJECTED');
  });

  it('NEGATIVE: a writer that slips in between the check and the draw stops the whole approval', async () => {
    const m = world();
    const { exit } = await ask(m, [{ productId: 'p1', quantity: 16 }]);
    let once = false;
    m.hooks.beforeBatchWrite = (bs) => {
      if (once) return;
      once = true;
      const b = bs.find((x) => x.id === 'b2')!;
      b.quantityRemaining -= 1; // another door took one unit of b2
      b.quantitySold += 1;
    };
    const e = await (approve(m, exit.id).then(() => null, (x: unknown) => x));
    expect(e).toBeInstanceOf(StockExitRefused);
    expect((e as StockExitRefused).code).toBe('MOVED_MEANWHILE');
    m.hooks.beforeBatchWrite = undefined;
    expect(m.data.inventoryMovement).toEqual([]);
    expect(m.data.stockExit[0].status).toBe('PENDING');
  });
});

describe('two hands — the requester never decides her own exit, by either door, a replay included', () => {
  it('the requester may not approve nor reject; a second person may; the requester’s «replay» after it is still refused', async () => {
    const m = world();
    const { exit } = await ask(m, [{ productId: 'p1', quantity: 2 }]);
    await refusedWith(approve(m, exit.id, ASKER), 'REQUESTER_CANNOT_DECIDE');
    await refusedWith(reject(m, exit.id, ASKER), 'REQUESTER_CANNOT_DECIDE');
    expect(m.data.inventoryMovement).toEqual([]);
    await approve(m, exit.id, BOSS);
    await refusedWith(approve(m, exit.id, ASKER), 'REQUESTER_CANNOT_DECIDE');
  });

  it('the approver’s replay: done, nothing written again; another approver or a rejection after it is refused', async () => {
    const m = world();
    const { exit } = await ask(m, [{ productId: 'p1', quantity: 2 }]);
    await approve(m, exit.id, BOSS);
    const rowsAfter = structuredClone(m.data.productionBatch);
    const again = await approve(m, exit.id, BOSS);
    expect(again.replay).toBe(true);
    expect(m.data.productionBatch).toEqual(rowsAfter);
    expect(m.data.inventoryMovement).toHaveLength(1);
    await refusedWith(approve(m, exit.id, OTHER_BOSS), 'ALREADY_APPROVED');
    await refusedWith(reject(m, exit.id, OTHER_BOSS), 'ALREADY_APPROVED');
    await refusedWith(reject(m, exit.id, BOSS), 'ALREADY_APPROVED');
  });

  it('NEGATIVE: an approver who does not reach the warehouse, or an exit of another store, is refused', async () => {
    const m = world();
    const { exit } = await ask(m, [{ productId: 'p1', quantity: 2 }]);
    await refusedWith(approve(m, exit.id, BOSS, no), 'NOT_REACHED');
    await refusedWith(reject(m, exit.id, BOSS, no), 'NOT_REACHED');
    await refusedWith(
      (m.db as Row).$transaction((tx: Row) => approveExit(tx as never, { companyId: C1, storeId: 's2', exitId: exit.id, decidedById: BOSS, mayUse: yes })),
      'NOT_FOUND'
    );
    await refusedWith(
      (m.db as Row).$transaction((tx: Row) => approveExit(tx as never, { companyId: 'c2', storeId: S1, exitId: exit.id, decidedById: BOSS, mayUse: yes })),
      'NOT_FOUND'
    );
    expect(m.data.stockExit[0].status).toBe('PENDING');
  });
});

describe('rejection releases the hold and moves nothing', () => {
  it('the free stock comes back; the shelf, the ledger and the lines are untouched; nothing deleted', async () => {
    const m = world();
    const before = structuredClone(m.data.productionBatch);
    const { exit } = await ask(m, [{ productId: 'p1', quantity: 10 }]);
    expect((await free(m)).get('p1')).toBe(6);
    const out = await reject(m, exit.id);
    expect([out.exit.status, out.exit.decidedById, out.exit.rejectReason]).toEqual(['REJECTED', BOSS, 'العدّ غلط']);
    expect((await free(m)).get('p1')).toBe(16);
    expect(m.data.productionBatch).toEqual(before);
    expect(m.data.inventoryMovement).toEqual([]);
    expect(m.data.stockExitLine.map((l) => [l.quantity, l.valueAtCost])).toEqual([[10, null]]);
    // Replay of the rejection by the same person: done. An approval after it: refused.
    expect((await reject(m, exit.id)).replay).toBe(true);
    await refusedWith(approve(m, exit.id, OTHER_BOSS), 'ALREADY_REJECTED');
    await refusedWith(reject(m, exit.id, OTHER_BOSS), 'ALREADY_REJECTED');
    expect(m.data.stockExit).toHaveLength(1);
  });
});

describe('the warehouse may not stop while an exit from it is pending', () => {
  it('NEGATIVE: pending → a blocker; approved or rejected → none', async () => {
    const m = world([batch('only', { quantityProduced: 2, quantityRemaining: 2 })]);
    const { exit } = await ask(m, [{ productId: 'p1', quantity: 2 }]);
    expect((await warehouseStopBlockers(m.db as never, C1, 'wA')).map((b) => b.code)).toEqual(['HOLDS_UNITS', 'PENDING_EXIT']);
    await approve(m, exit.id);
    // The shelf is empty and nothing is pending: it may stop.
    expect(await warehouseStopBlockers(m.db as never, C1, 'wA')).toEqual([]);
  });
});

describe('conservation on random sequences — every unit accounted for, and only approved exits leave', () => {
  it('300 random requests, approvals and rejections across two warehouses and two products', async () => {
    let seed = 7;
    const rnd = (n: number) => {
      seed = (seed * 1103515245 + 12345) % 2147483648;
      return seed % n;
    };
    const m = world([
      batch('a1', { quantityProduced: 40, quantityRemaining: 40, costPerUnit: 1.25 }),
      batch('a2', { quantityProduced: 30, quantityRemaining: 30, costPerUnit: 2.1, productionDate: new Date('2026-10-09') }),
      batch('b1', { quantityProduced: 25, quantityRemaining: 25, costPerUnit: 0.75, warehouseId: 'wB' }),
      batch('c1', { productId: 'p2', quantityProduced: 50, quantityRemaining: 50, costPerUnit: 9.999 }),
    ]);
    const start = { p1: figures(m, 'p1'), p2: figures(m, 'p2') };
    const approvedUnits = { p1: 0, p2: 0 } as Record<string, number>;
    let approvedValue = 0;
    const pending: string[] = [];
    for (let i = 0; i < 300; i++) {
      const op = rnd(3);
      if (op === 0 || pending.length === 0) {
        const productId = rnd(2) ? 'p1' : 'p2';
        const warehouseId = productId === 'p1' && rnd(2) ? 'wB' : 'wA';
        const res = await ask(m, [{ productId, quantity: 1 + rnd(6) }], { warehouseId, reason: EXIT_REASONS[rnd(6)] }).catch((e) => e);
        if (res instanceof StockExitRefused) expect(res.code).toBe('NOT_ENOUGH_FREE');
        else pending.push(res.exit.id);
      } else {
        const id = pending.splice(rnd(pending.length), 1)[0];
        if (op === 1) {
          const snap = snapshot(m);
          const out = await approve(m, id, rnd(2) ? BOSS : OTHER_BOSS);
          for (const l of out.exit.lines) approvedUnits[l.productId] += l.quantity;
          approvedValue += leftValue(snap, m);
          // The line's value is the units that left at their rows' cost, rounded once to three decimals.
          expect(out.exit.lines[0].valueAtCost).toBe(Math.round(leftValue(snap, m) * 1000) / 1000);
        } else {
          await reject(m, id);
        }
      }
      expect(identityHolds(m)).toBe(true);
      for (const w of ['wA', 'wB']) for (const r of rows(m).filter((x) => x.warehouseId === w)) expect(r.quantityRemaining).toBeGreaterThanOrEqual(0);
    }
    for (const p of ['p1', 'p2'] as const) {
      const now = figures(m, p);
      expect(now.produced).toBe(start[p].produced);
      expect(now.sold).toBe(start[p].sold + approvedUnits[p]);
      expect(now.remaining).toBe(start[p].remaining - approvedUnits[p]);
    }
    const valueNow = figures(m, 'p1').value + figures(m, 'p2').value;
    expect(valueNow).toBeCloseTo(start.p1.value + start.p2.value - approvedValue, 6);
    // The ledger: one line per approved line, Σ = −approved units, per product.
    for (const p of ['p1', 'p2']) {
      expect(m.data.inventoryMovement.filter((x) => x.productId === p).reduce((s, x) => s + x.quantity, 0)).toBe(-approvedUnits[p]);
    }
    expect(approvedUnits.p1 + approvedUnits.p2).toBeGreaterThan(0);
  });
});

describe('every refusal and every message of the bodies is Arabic', () => {
  const ar = /[؀-ۿ]/;
  it.each([
    [{}, 'warehouseId'],
    [{ warehouseId: 'w', reason: 'X', lines: [{ productId: 'p', quantity: 1 }] }, 'reason'],
    [{ warehouseId: 'w', reason: 'DAMAGED', lines: [] }, 'lines'],
    [{ warehouseId: 'w', reason: 'DAMAGED', lines: [{ productId: 'p', quantity: 0 }] }, 'quantity'],
    [{ warehouseId: 'w', reason: 'DAMAGED', lines: [{ productId: 'p', quantity: 1.5 }] }, 'quantity'],
    [{ warehouseId: 'w', reason: 'DAMAGED', lines: [{ productId: 'p', quantity: '2' }] }, 'quantity'],
    [{ warehouseId: 'w', reason: 'DAMAGED', lines: [{ quantity: 1 }] }, 'productId'],
    [{ warehouseId: 'w', reason: 'DAMAGED', lines: 'x' }, 'lines'],
    [{ warehouseId: 'w', reason: 'OTHER', lines: [{ productId: 'p', quantity: 1 }] }, 'note'],
    [{ warehouseId: 'w', reason: 'DAMAGED', note: 7, lines: [{ productId: 'p', quantity: 1 }] }, 'note'],
    [{ id: 'not-a-uuid', warehouseId: 'w', reason: 'DAMAGED', lines: [{ productId: 'p', quantity: 1 }] }, 'id'],
    [null, ''],
  ])('the request body %j is refused in Arabic (at %s)', (body, field) => {
    const r = requestSchema.safeParse(body);
    expect(r.success).toBe(false);
    for (const issue of r.error!.issues) expect(issue.message, JSON.stringify(issue)).toMatch(ar);
    if (field) expect(r.error!.issues.some((i) => i.path.includes(field)), field).toBe(true);
  });

  it('the rejection asks for a reason, in Arabic', () => {
    for (const body of [{}, { reason: 'a' }, null, { reason: 5 }]) {
      const r = rejectSchema.safeParse(body);
      expect(r.success).toBe(false);
      for (const issue of r.error!.issues) expect(issue.message).toMatch(ar);
    }
  });

  it('«أخرى» with a sentence is accepted; every reason has its Arabic word', () => {
    expect(requestSchema.safeParse({ warehouseId: 'w', reason: 'OTHER', note: 'هدية', lines: [{ productId: 'p', quantity: 1 }] }).success).toBe(true);
    for (const r of EXIT_REASONS) expect(EXIT_REASON_AR[r]).toMatch(ar);
  });
});

describe('what a door shows', () => {
  const e = { status: 'APPROVED', reason: 'EXPIRED', lines: [{ productId: 'p1', quantity: 3, valueAtCost: 6.5 }] };
  it('the value at cost only to a person who may see costs — omitted (not zero, not null) for anybody else', () => {
    expect(exitShown(e, true).lines[0]).toEqual({ productId: 'p1', quantity: 3, valueAtCost: 6.5 });
    expect(exitShown(e, false).lines[0]).toEqual({ productId: 'p1', quantity: 3 });
    expect('valueAtCost' in exitShown(e, false).lines[0]).toBe(false);
    expect(exitShown(e, false)).toMatchObject({ statusAr: 'طلع', reasonAr: 'منتهي' });
  });
});

/**
 * NO MONEY (the owner's default for decision 6: a report only). The exit lib and EVERY module it loads, walked file by
 * file, name no wallet, expense, profit, finance, commission or settlement module; the door files import none directly.
 * `money.ts` is reached for one pure function (`roundMinor`, the currency's rounding of the line's value) and holds no
 * table. And a whole life writes only batches, movements and the exit's own rows.
 */
describe('no money — the exit modules reach nothing of wallets, expenses or profit, and write only stock rows', () => {
  const MONEY = /wallet|expense|profit|financ|commission|settlement|payslip|partner/i;
  const ROOT = process.cwd();
  function resolve(from: string, spec: string): string | null {
    const base = spec.startsWith('@/') ? join(ROOT, 'src', spec.slice(2)) : spec.startsWith('.') ? join(dirname(from), spec) : null;
    if (!base) return null;
    for (const c of [`${base}.ts`, `${base}.tsx`, join(base, 'index.ts')]) if (existsSync(c)) return c;
    return null;
  }
  function reach(entry: string): string[] {
    const seen = new Set<string>();
    const walk = (f: string) => {
      if (seen.has(f)) return;
      seen.add(f);
      const src = readFileSync(f, 'utf8');
      for (const m of src.matchAll(/^\s*(import|export)(?!\s+type\b)[^'"]*?from\s+['"]([^'"]+)['"]/gm)) {
        const r = resolve(f, m[2]);
        if (r) walk(r);
      }
    };
    walk(join(ROOT, entry));
    return [...seen].map((p) => p.slice(ROOT.length + 1).split('\\').join('/'));
  }

  it('the lib and everything it loads', () => {
    const files = reach('src/lib/stock-exits.ts');
    expect(files).toContain('src/lib/receiving.ts');
    expect(files.filter((f) => MONEY.test(f))).toEqual([]);
  });

  it('the door files, directly', () => {
    for (const f of [
      'src/lib/stock-exit-door.ts',
      'src/lib/stock-exit-reasons.ts',
      'src/app/api/inventory/exits/route.ts',
      'src/app/api/inventory/exits/[id]/approve/route.ts',
      'src/app/api/inventory/exits/[id]/reject/route.ts',
    ]) {
      const src = readFileSync(join(ROOT, f), 'utf8');
      const imports = [...src.matchAll(/from\s+['"]([^'"]+)['"]/g)].map((x) => x[1]);
      expect(imports.filter((i) => MONEY.test(i) || /money/.test(i)), f).toEqual([]);
    }
  });

  it('a whole life (request, approve; request, reject) writes only batches, movements and the exit', async () => {
    const m = world();
    const a = (await ask(m, [{ productId: 'p1', quantity: 5 }])).exit;
    await approve(m, a.id);
    const b = (await ask(m, [{ productId: 'p1', quantity: 2 }], { reason: 'PARTNER_DRAW' })).exit;
    await reject(m, b.id);
    expect([...new Set(m.touched.map((x) => x.split('.')[0]))].sort()).toEqual(['inventoryMovement', 'productionBatch', 'stockExit', 'stockExitLine']);
    expect(m.data.stockExit).toHaveLength(2);
  });
});
