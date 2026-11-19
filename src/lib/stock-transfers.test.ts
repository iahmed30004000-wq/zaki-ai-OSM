import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { memoryDb, type Row } from './stock-transfers.memory-db.test';
import {
  approveDifference,
  cancelTransfer,
  freeStockOf,
  receiveTransfer,
  sendTransfer,
  shownTo,
  StockTransferRefused,
} from './stock-transfers';
import { readStockTransfer, stockTransferKind } from './stock-transfer-kind';
import { drawDownStock } from './receiving';
import { SplitRefused } from './batch-split';

/**
 * THE TRANSFER INSIDE ONE STORE (W3a) — the lib, against a small in-memory database that judges every `where` itself.
 *
 * Every figure asserted is computed HERE from the batch rows, never by the function under test:
 *   «دخل» Σ produced · «خرج» Σ sold · on hand Σ remaining · the stock value Σ (remaining × cost), added per unit cost
 *   first (a run and its twins carry one cost, and a double does not care in which order equal costs are added).
 */

const C1 = 'c1';
const S1 = 's1';
const ME = 'u-sender';
const HER = 'u-receiver';
const THIRD = 'u-approver';
type MayUse = (w: { id: string }) => Promise<boolean>;
const yes: MayUse = async () => true;
const no: MayUse = async () => false;

let uuidSeq = 0;
const uuid = () => `00000000-0000-4000-8000-${String(++uuidSeq).padStart(12, '0')}`;

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
    manufacturingCost: 0,
    packagingCost: 0,
    rawMaterialCost: 0,
    otherCosts: 0,
    totalProductionCost: 20,
    costPerUnit: 2,
    productionDate: new Date('2026-10-01'),
    createdAt: new Date('2026-10-01T08:00:00Z'),
    status: 'COMPLETED',
    notes: null,
    warehouseId: 'wA',
    inTransitTransferId: null,
    splitFromBatchId: null,
    ...over,
  };
}

function world(batches: Row[] = [batch('b1'), batch('b2', { productionDate: new Date('2026-10-05'), costPerUnit: 3.3333, quantityRemaining: 6, quantityProduced: 9, quantitySold: 3 })], extra: Row = {}) {
  return memoryDb({
    country: [
      { id: 'k1', companyId: C1, isActive: true },
      { id: 'k2', companyId: C1, isActive: true },
    ],
    store: [
      { id: S1, companyId: C1, countryId: 'k1', name: 'المتجر' },
      { id: 's2', companyId: C1, countryId: 'k1', name: 'متجر تاني' },
      { id: 's-c2', companyId: 'c2', countryId: 'k9', name: 'غريب' },
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
      { id: 'p1', companyId: C1, storeId: S1, name: 'منتج ١' },
      { id: 'p2', companyId: C1, storeId: S1, name: 'منتج ٢' },
      { id: 'p-s2', companyId: C1, storeId: 's2', name: 'منتج المتجر التاني' },
    ],
    productionBatch: batches,
    ...extra,
  });
}

type M = ReturnType<typeof memoryDb>;
const rows = (m: M, productId = 'p1') => m.data.productionBatch.filter((b) => b.productId === productId && b.companyId === C1);

/** The figures of the balances screen, from the rows. */
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
const at = (m: M, place: string | null, productId = 'p1', transfer?: string) =>
  rows(m, productId)
    .filter((r) => (place === null ? r.warehouseId == null && (transfer ? r.inTransitTransferId === transfer : r.inTransitTransferId != null) : r.warehouseId === place))
    .reduce((s, r) => s + r.quantityRemaining, 0);
const identityHolds = (m: M) =>
  m.data.productionBatch.every((r) => r.quantityRemaining === r.quantityProduced + r.quantityMovedIn - r.quantitySold - r.quantityMovedOut);

const send = (m: M, lines: Row[], over: Row = {}, by = ME, mayUse = yes) =>
  (m.db as Row).$transaction((tx: Row) =>
    sendTransfer(tx as never, { companyId: C1, storeId: S1, sentById: by, mayUse, body: { fromWarehouseId: 'wA', toWarehouseId: 'wB', lines, ...over } as never })
  );
const receive = (m: M, id: string, lines: Row[], by = HER, mayUse = yes) =>
  (m.db as Row).$transaction((tx: Row) => receiveTransfer(tx as never, { companyId: C1, storeId: S1, transferId: id, receivedById: by, mayUse, body: { lines } as never }));
const cancel = (m: M, id: string, by = ME, mayUse = yes) =>
  (m.db as Row).$transaction((tx: Row) => cancelTransfer(tx as never, { companyId: C1, storeId: S1, transferId: id, cancelledById: by, mayUse, body: { reason: 'غلط بالكمية' } }));
const approve = (m: M, id: string, by = THIRD, type: 'LOSS' | 'DAMAGE' = 'LOSS', mayUse = yes) =>
  (m.db as Row).$transaction((tx: Row) => approveDifference(tx as never, { companyId: C1, storeId: S1, transferId: id, approvedById: by, mayUse, body: { type, reason: 'انكسرت بالطريق' } }));
const refusedWith = async (p: Promise<unknown>, code: string) => {
  const e = await p.then(() => null, (x: unknown) => x);
  expect(e, `expected refusal ${code}`).toBeInstanceOf(StockTransferRefused);
  expect((e as StockTransferRefused).code).toBe(code);
  expect((e as StockTransferRefused).errorAr).toMatch(/[؀-ۿ]/);
  return e as StockTransferRefused;
};

describe('send → on the road → receive: the place changes, nothing else', () => {
  it('a send splits the oldest batches into twins on the road; «دخل», «خرج», on hand and the value do not move', async () => {
    const m = world();
    const before = figures(m);
    const { transfer } = await send(m, [{ productId: 'p1', quantity: 13 }]);
    expect(transfer.status).toBe('SENT');
    expect(transfer.kind).toBe('INTERNAL');
    expect(figures(m)).toEqual(before);
    expect(identityHolds(m)).toBe(true);
    expect([at(m, 'wA'), at(m, null, 'p1', transfer.id), at(m, 'wB')]).toEqual([3, 13, 0]);
    // Oldest first: all 10 of b1, then 3 of b2. Each twin: produced 0, moved in, the parent's cost and dates.
    const twins = rows(m).filter((r) => r.inTransitTransferId === transfer.id);
    expect(twins.map((t) => [t.splitFromBatchId, t.quantityRemaining, t.quantityProduced, t.costPerUnit])).toEqual([
      ['b1', 10, 0, 2],
      ['b2', 3, 0, 3.3333],
    ]);
    // The ledger: one TRANSFER_OUT −13 at the source, pointing at the transfer.
    expect(m.data.inventoryMovement.map((x) => [x.type, x.quantity, x.warehouseId, x.referenceId, x.storeId])).toEqual([['TRANSFER_OUT', -13, 'wA', transfer.id, S1]]);
  });

  it('a full receipt lands every unit in the destination; the figures still have not moved', async () => {
    const m = world();
    const before = figures(m);
    const { transfer } = await send(m, [{ productId: 'p1', quantity: 13 }]);
    const out = await receive(m, transfer.id, [{ productId: 'p1', quantity: 13 }]);
    expect(out.transfer.status).toBe('RECEIVED');
    expect(figures(m)).toEqual(before);
    expect([at(m, 'wA'), at(m, null), at(m, 'wB')]).toEqual([3, 0, 13]);
    expect(identityHolds(m)).toBe(true);
    expect(m.data.inventoryMovement.map((x) => [x.type, x.quantity, x.warehouseId])).toEqual([
      ['TRANSFER_OUT', -13, 'wA'],
      ['TRANSFER_IN', 13, 'wB'],
    ]);
  });

  it('a receipt short: the counted units land, the rest STAY on the road until a third person approves them out', async () => {
    const m = world();
    const before = figures(m);
    const { transfer } = await send(m, [{ productId: 'p1', quantity: 13 }]);
    const got = await receive(m, transfer.id, [{ productId: 'p1', quantity: 11 }]);
    expect(got.transfer.status).toBe('RECEIVED_WITH_DIFFERENCE');
    expect(figures(m)).toEqual(before);
    expect([at(m, 'wA'), at(m, null, 'p1', transfer.id), at(m, 'wB')]).toEqual([3, 2, 11]);
    expect(identityHolds(m)).toBe(true);

    const done = await approve(m, transfer.id);
    expect(done.transfer.differenceApprovedById).toBe(THIRD);
    const after = figures(m);
    // Exactly the 2 missing units leave the store, at the cost of the units that were on the road (b2's, the newest sent).
    expect(after.produced).toBe(before.produced);
    expect(after.sold).toBe(before.sold + 2);
    expect(after.remaining).toBe(before.remaining - 2);
    expect(after.value).toBeCloseTo(before.value - 2 * 3.3333, 9);
    expect(at(m, null)).toBe(0);
    expect(identityHolds(m)).toBe(true);
    expect(m.data.inventoryMovement.at(-1)).toMatchObject({ type: 'LOSS', quantity: -2, warehouseId: null, referenceId: transfer.id });
  });

  it('receive ZERO (everything lost): nothing lands; approved as DAMAGE, the whole send leaves the store', async () => {
    const m = world();
    const before = figures(m);
    const { transfer } = await send(m, [{ productId: 'p1', quantity: 4 }]);
    await receive(m, transfer.id, [{ productId: 'p1', quantity: 0 }]);
    expect(m.data.inventoryMovement.filter((x) => x.type === 'TRANSFER_IN')).toEqual([]);
    expect(at(m, null, 'p1', transfer.id)).toBe(4);
    await approve(m, transfer.id, THIRD, 'DAMAGE');
    expect(figures(m).remaining).toBe(before.remaining - 4);
    expect(figures(m).sold).toBe(before.sold + 4);
    expect(m.data.inventoryMovement.at(-1)).toMatchObject({ type: 'DAMAGE', quantity: -4 });
  });

  it('cancel before any receipt: the units go back to the source, a reversing line, nothing deleted', async () => {
    const m = world();
    const before = figures(m);
    const countBefore = m.data.productionBatch.length;
    const { transfer } = await send(m, [{ productId: 'p1', quantity: 13 }]);
    const out = await cancel(m, transfer.id);
    expect(out.transfer.status).toBe('CANCELLED');
    expect(figures(m)).toEqual(before);
    expect([at(m, 'wA'), at(m, null), at(m, 'wB')]).toEqual([16, 0, 0]); // all 16 home again
    expect(m.data.productionBatch.length).toBe(countBefore + 2); // the twins stay, at home: nothing is deleted
    expect(m.data.stockTransfer).toHaveLength(1);
    expect(m.data.inventoryMovement.map((x) => [x.type, x.quantity, x.warehouseId])).toEqual([
      ['TRANSFER_OUT', -13, 'wA'],
      ['TRANSFER_IN', 13, 'wA'],
    ]);
  });

  it('NEGATIVE: cancel after a receipt is refused — the way back is a transfer the other way', async () => {
    const m = world();
    const { transfer } = await send(m, [{ productId: 'p1', quantity: 2 }]);
    await receive(m, transfer.id, [{ productId: 'p1', quantity: 2 }]);
    await refusedWith(cancel(m, transfer.id), 'ALREADY_RECEIVED');
  });

  it('a batch already split (a twin of a twin) moves the same way, and FIFO order is the parent’s', async () => {
    const m = world([batch('b1'), batch('b1~aa', { quantityProduced: 0, quantityMovedIn: 4, quantityRemaining: 4, splitFromBatchId: 'b1', warehouseId: 'wA', costPerUnit: 2 })]);
    (m.data.productionBatch[0] as Row).quantityRemaining = 6;
    (m.data.productionBatch[0] as Row).quantityMovedOut = 4;
    const before = figures(m);
    const { transfer } = await send(m, [{ productId: 'p1', quantity: 8 }]);
    await receive(m, transfer.id, [{ productId: 'p1', quantity: 5 }]);
    expect(figures(m)).toEqual(before);
    expect(identityHolds(m)).toBe(true);
    expect([at(m, 'wA'), at(m, null), at(m, 'wB')]).toEqual([2, 3, 5]);
  });
});

describe('conservation on random stores — every step, computed from the rows', () => {
  it('400 random sequences of send / receive (whole, short, zero) / cancel / approve', async () => {
    let seed = 7;
    const rnd = (n: number) => {
      seed = (seed * 1103515245 + 12345) % 2147483648;
      return seed % n;
    };
    for (let round = 0; round < 400; round++) {
      const bs: Row[] = [];
      const n = 1 + rnd(4);
      for (let i = 0; i < n; i++) {
        const produced = 1 + rnd(20);
        const sold = rnd(produced);
        bs.push(
          batch(`r${round}b${i}`, {
            productId: rnd(3) === 0 ? 'p2' : 'p1',
            quantityProduced: produced,
            quantitySold: sold,
            quantityRemaining: produced - sold,
            costPerUnit: [0, 1.5, 2.25, 3.3333, 17.4047][rnd(5)],
            productionDate: new Date(Date.UTC(2026, 9, 1 + rnd(3))),
            warehouseId: rnd(4) === 0 ? 'wB' : 'wA',
          })
        );
      }
      const m = world(bs);
      const start = { p1: figures(m, 'p1'), p2: figures(m, 'p2') };
      const lines = (['p1', 'p2'] as const)
        .map((p) => ({ productId: p, free: at(m, 'wA', p) }))
        .filter((x) => x.free > 0)
        .map((x) => ({ productId: x.productId, quantity: 1 + rnd(x.free) }));
      if (lines.length === 0) continue;
      const { transfer } = await send(m, lines, { id: uuid() });
      for (const p of ['p1', 'p2'] as const) expect(figures(m, p)).toEqual(start[p]);
      expect(identityHolds(m)).toBe(true);

      const action = rnd(3);
      if (action === 0) {
        await cancel(m, transfer.id);
        for (const p of ['p1', 'p2'] as const) expect(figures(m, p)).toEqual(start[p]);
      } else {
        const counts = lines.map((l) => ({ productId: l.productId, quantity: action === 1 ? l.quantity : rnd(l.quantity + 1) }));
        await receive(m, transfer.id, counts);
        for (const p of ['p1', 'p2'] as const) expect(figures(m, p)).toEqual(start[p]);
        const missing = new Map(lines.map((l) => [l.productId, l.quantity - counts.find((c) => c.productId === l.productId)!.quantity]));
        if ([...missing.values()].some((x) => x > 0)) {
          await approve(m, transfer.id);
          for (const p of ['p1', 'p2'] as const) {
            const after = figures(m, p);
            const k = missing.get(p) ?? 0;
            expect([after.produced, after.sold, after.remaining]).toEqual([start[p].produced, start[p].sold + k, start[p].remaining - k]);
          }
        }
      }
      expect(identityHolds(m)).toBe(true);
      // Every unit has exactly one place: Σ warehouses + Σ road = on hand, and the road is empty unless short and unapproved.
      for (const p of ['p1', 'p2'] as const) {
        expect(at(m, 'wA', p) + at(m, 'wB', p) + at(m, null, p)).toBe(figures(m, p).remaining);
        expect(at(m, null, p)).toBe(0);
      }
    }
  });
});

describe('free stock of the source', () => {
  it('NEGATIVE: more than the source holds is refused, with the product named — and nothing is written', async () => {
    const m = world();
    const e = await refusedWith(send(m, [{ productId: 'p1', quantity: 17 }]), 'NOT_ENOUGH_FREE');
    expect(e.errorAr).toContain('منتج ١');
    expect(e.extra.short).toEqual([{ productId: 'p1', name: 'منتج ١', asked: 17, free: 16 }]);
    expect(m.data.stockTransfer).toEqual([]);
    expect(m.data.inventoryMovement).toEqual([]);
  });

  it('NEGATIVE: units reserved by open orders sourced from the warehouse are not free', async () => {
    const m = world(undefined, {
      order: [
        { id: 'o1', companyId: C1, storeId: S1, sourceWarehouseId: 'wA', confirmationStatus: 'CONFIRMED', shippingStatus: 'IN_TRANSIT' },
        { id: 'o2', companyId: C1, storeId: S1, sourceWarehouseId: 'wB', confirmationStatus: 'CONFIRMED', shippingStatus: 'IN_TRANSIT' },
        { id: 'o3', companyId: C1, storeId: S1, sourceWarehouseId: 'wA', confirmationStatus: 'CONFIRMED', shippingStatus: 'DELIVERED' },
      ],
      orderItem: [
        { id: 'i1', companyId: C1, orderId: 'o1', productId: 'p1', reservedQty: 5 },
        { id: 'i2', companyId: C1, orderId: 'o2', productId: 'p1', reservedQty: 7 },
        { id: 'i3', companyId: C1, orderId: 'o3', productId: 'p1', reservedQty: 9 },
      ],
      orderAddOn: [{ id: 'a1', companyId: C1, orderId: 'o1', productId: 'p1', reservedQty: 1 }],
    });
    const free = await freeStockOf(m.tx, { companyId: C1, storeId: S1, warehouseId: 'wA', productIds: ['p1'] });
    expect(free.get('p1')).toBe(16 - 5 - 1); // o2 is sourced elsewhere, o3 was delivered
    await refusedWith(send(m, [{ productId: 'p1', quantity: 11 }]), 'NOT_ENOUGH_FREE');
    await expect(send(m, [{ productId: 'p1', quantity: 10 }])).resolves.toBeTruthy();
  });

  it('NEGATIVE: units already on the road are not free a second time', async () => {
    const m = world();
    await send(m, [{ productId: 'p1', quantity: 10 }]);
    await refusedWith(send(m, [{ productId: 'p1', quantity: 7 }]), 'NOT_ENOUGH_FREE');
  });
});

describe('the draw at delivery never takes units on the road', () => {
  it('drawDownStock skips the in-transit twins: with the whole shelf on the road it finds nothing', async () => {
    const m = world([batch('b1', { quantityRemaining: 5, quantityProduced: 5 })]);
    const { transfer } = await send(m, [{ productId: 'p1', quantity: 5 }]);
    const out = await (m.db as Row).$transaction((tx: Row) => drawDownStock(tx as never, { companyId: C1, productId: 'p1', quantity: 2, allowNegative: true, storeId: S1 }));
    expect(out).toEqual({ taken: 0, short: 2, cost: 0 });
    expect(at(m, null, 'p1', transfer.id)).toBe(5);
  });

  it('and a draw that happens WHILE a send is splitting makes the send stop whole (nothing half on the road)', async () => {
    const m = world();
    let once = false;
    m.hooks.beforeBatchWrite = (rs) => {
      if (once) return;
      once = true;
      // «another door» (a delivery's draw, which takes no lock) takes 1 unit of b1 between the send's read and its write
      const b1 = rs.find((r) => r.id === 'b1')!;
      b1.quantityRemaining -= 1;
      b1.quantitySold += 1;
    };
    const before = structuredClone(m.data.productionBatch);
    const e = await send(m, [{ productId: 'p1', quantity: 12 }]).then(() => null, (x: unknown) => x);
    expect(e).toBeInstanceOf(SplitRefused);
    // The transaction rolled back whole — including the meddling write in this fake, which is the point: no twin, no
    // transfer, no ledger line survives a send that could not finish.
    expect(m.data.productionBatch).toEqual(before);
    expect(m.data.stockTransfer).toEqual([]);
  });
});

describe('the lock order: the products’ stock lock before any batch is read, then the warehouses FOR SHARE', () => {
  it('send takes the reserver’s key for every product, then both warehouse rows in id order', async () => {
    const m = world();
    await send(m, [{ productId: 'p1', quantity: 1 }]);
    const advisory = m.locks.findIndex((l) => /pg_advisory_xact_lock/.test(l));
    const share = m.locks.filter((l) => /FOR SHARE/.test(l)).map((l) => l.split(' :: ')[1]);
    expect(advisory).toBe(0);
    expect(m.locks[0]).toContain(`stock:${C1}:*:p1`);
    expect(share).toEqual(['wA', 'wB']);
  });

  it('receive, cancel and difference lock the transfer row FOR UPDATE first', async () => {
    const m = world();
    const { transfer } = await send(m, [{ productId: 'p1', quantity: 2 }]);
    m.locks.length = 0;
    await receive(m, transfer.id, [{ productId: 'p1', quantity: 1 }]);
    expect(m.locks[0]).toMatch(/stock_transfers.*FOR UPDATE :: /);
    m.locks.length = 0;
    await approve(m, transfer.id);
    expect(m.locks[0]).toMatch(/stock_transfers.*FOR UPDATE :: /);
  });
});

describe('two hands — by the person’s id, before anything else, a replay included', () => {
  it('NEGATIVE: the sender cannot receive — not first, and not as a «replay» after somebody else received', async () => {
    const m = world();
    const { transfer } = await send(m, [{ productId: 'p1', quantity: 3 }]);
    await refusedWith(receive(m, transfer.id, [{ productId: 'p1', quantity: 3 }], ME), 'SENDER_CANNOT_RECEIVE');
    await receive(m, transfer.id, [{ productId: 'p1', quantity: 3 }], HER);
    await refusedWith(receive(m, transfer.id, [{ productId: 'p1', quantity: 3 }], ME), 'SENDER_CANNOT_RECEIVE');
  });

  it('NEGATIVE: neither the receiver nor the sender approves the difference — before and after a third person did', async () => {
    const m = world();
    const { transfer } = await send(m, [{ productId: 'p1', quantity: 3 }]);
    await receive(m, transfer.id, [{ productId: 'p1', quantity: 1 }], HER);
    await refusedWith(approve(m, transfer.id, HER), 'RECEIVER_CANNOT_APPROVE');
    await refusedWith(approve(m, transfer.id, ME), 'SENDER_CANNOT_APPROVE');
    await approve(m, transfer.id, THIRD);
    await refusedWith(approve(m, transfer.id, HER), 'RECEIVER_CANNOT_APPROVE');
    await refusedWith(approve(m, transfer.id, ME), 'SENDER_CANNOT_APPROVE');
  });

  it('a replay by the SAME hand is answered with what happened, and writes nothing', async () => {
    const m = world();
    const id = uuid();
    const first = await send(m, [{ productId: 'p1', quantity: 3 }], { id });
    const snapshot = structuredClone(m.data);
    const again = await send(m, [{ productId: 'p1', quantity: 3 }], { id });
    expect([again.replay, again.transfer.id]).toEqual([true, first.transfer.id]);
    expect(m.data).toEqual(snapshot);

    await receive(m, id, [{ productId: 'p1', quantity: 2 }]);
    const r2 = await receive(m, id, [{ productId: 'p1', quantity: 2 }]);
    expect(r2.replay).toBe(true);
    await approve(m, id);
    const snap2 = structuredClone(m.data);
    expect((await approve(m, id)).replay).toBe(true);
    expect(m.data).toEqual(snap2);
  });

  it('NEGATIVE: the same id with another deal, another person, or a second receipt with other counts is a conflict', async () => {
    const m = world();
    const id = uuid();
    await send(m, [{ productId: 'p1', quantity: 3 }], { id });
    await refusedWith(send(m, [{ productId: 'p1', quantity: 4 }], { id }), 'TRANSFER_EXISTS');
    await refusedWith(send(m, [{ productId: 'p1', quantity: 3 }], { id }, 'u-other'), 'TRANSFER_EXISTS');
    await receive(m, id, [{ productId: 'p1', quantity: 3 }]);
    await refusedWith(receive(m, id, [{ productId: 'p1', quantity: 2 }]), 'ALREADY_RECEIVED');
    await refusedWith(receive(m, id, [{ productId: 'p1', quantity: 3 }], 'u-other'), 'ALREADY_RECEIVED');
  });

  it('NEGATIVE: approving where nothing is missing, and approving twice by two people', async () => {
    const m = world();
    const { transfer } = await send(m, [{ productId: 'p1', quantity: 3 }]);
    await refusedWith(approve(m, transfer.id), 'NO_DIFFERENCE');
    await receive(m, transfer.id, [{ productId: 'p1', quantity: 3 }]);
    await refusedWith(approve(m, transfer.id), 'NO_DIFFERENCE');
    const m2 = world();
    const t2 = (await send(m2, [{ productId: 'p1', quantity: 3 }])).transfer;
    await receive(m2, t2.id, [{ productId: 'p1', quantity: 2 }]);
    await approve(m2, t2.id, THIRD);
    await refusedWith(approve(m2, t2.id, 'u-fourth'), 'ALREADY_APPROVED');
  });
});

describe('the edges of the row', () => {
  it('NEGATIVE: the same product on two lines', async () => {
    const m = world();
    await refusedWith(send(m, [{ productId: 'p1', quantity: 1 }, { productId: 'p1', quantity: 2 }]), 'PRODUCT_TWICE');
  });

  it('the destination stopped while in transit: receive still lands the goods; a NEW send to it is refused', async () => {
    const m = world();
    const { transfer } = await send(m, [{ productId: 'p1', quantity: 3 }]);
    m.data.warehouse.find((w) => w.id === 'wB')!.isActive = false;
    await refusedWith(send(m, [{ productId: 'p1', quantity: 1 }]), 'TO_STOPPED');
    const out = await receive(m, transfer.id, [{ productId: 'p1', quantity: 3 }]);
    expect(out.transfer.status).toBe('RECEIVED');
    expect(at(m, 'wB')).toBe(3);
  });

  it('NEGATIVE: from a stopped warehouse, to the same warehouse, a count over what was sent, a count that misses a product', async () => {
    const m = world([batch('b1'), batch('bOff', { warehouseId: 'wOff' })]);
    await refusedWith(send(m, [{ productId: 'p1', quantity: 1 }], { fromWarehouseId: 'wOff' }), 'FROM_STOPPED');
    await refusedWith(send(m, [{ productId: 'p1', quantity: 1 }], { toWarehouseId: 'wA' }), 'SAME_WAREHOUSE');
    const { transfer } = await send(m, [{ productId: 'p1', quantity: 3 }]);
    await refusedWith(receive(m, transfer.id, [{ productId: 'p1', quantity: 4 }]), 'COUNT_OVER_SENT');
    await refusedWith(receive(m, transfer.id, [{ productId: 'p2', quantity: 0 }]), 'COUNTS_INVALID');
    await refusedWith(receive(m, transfer.id, [{ productId: 'p1', quantity: 1 }, { productId: 'p1', quantity: 1 }]), 'COUNTS_INVALID');
  });

  it('NEGATIVE: a store that is not placed has no places to move between', async () => {
    const m = world();
    m.data.warehousePlacement.length = 0;
    await refusedWith(send(m, [{ productId: 'p1', quantity: 1 }]), 'STORE_NOT_PLACED');
  });
});

describe('only INTERNAL is built — the kind is read from the ends, and the others answer «لسا مش مبني»', () => {
  it('another country: BETWEEN_COUNTRIES, not built', async () => {
    const e = await refusedWith(send(world(), [{ productId: 'p1', quantity: 1 }], { toWarehouseId: 'wJ' }), 'KIND_NOT_BUILT');
    expect(e.errorAr).toContain('لسا مش مبني');
    expect(e.extra.kind).toBe('BETWEEN_COUNTRIES');
  });

  it('another store of the same country: BETWEEN_STORES, not built', async () => {
    const e = await refusedWith(send(world(), [{ productId: 'p1', quantity: 1 }], { toStoreId: 's2' }), 'KIND_NOT_BUILT');
    expect(e.extra.kind).toBe('BETWEEN_STORES');
  });

  it('NEGATIVE: the screen expected another kind than the ends say (409 KIND_CHANGED)', async () => {
    const e = await refusedWith(send(world(), [{ productId: 'p1', quantity: 1 }], { expectKind: 'BETWEEN_STORES' }), 'KIND_CHANGED');
    expect(e.extra.kind).toBe('INTERNAL');
  });

  it('the pure reading mirrors transfer-kind: country first, then store', () => {
    const end = (warehouseId: string, storeId: string, countryId: string) => ({ warehouseId, storeId, countryId });
    expect(stockTransferKind(end('a', 's', 'k'), end('b', 's', 'k'))).toBe('INTERNAL');
    expect(stockTransferKind(end('a', 's', 'k'), end('b', 't', 'k'))).toBe('BETWEEN_STORES');
    expect(stockTransferKind(end('a', 's', 'k'), end('b', 's', 'j'))).toBe('BETWEEN_COUNTRIES');
    expect(stockTransferKind(end('a', 's', 'k'), end('b', 't', 'j'))).toBe('BETWEEN_COUNTRIES');
    expect(readStockTransfer(end('a', 's', 'k'), end('b', 's', 'k')).built).toBe(true);
    expect(readStockTransfer(end('a', 's', 'k'), end('b', 't', 'k')).built).toBe(false);
  });
});

describe('tenancy and reach', () => {
  it('NEGATIVE: a warehouse of another company is «not found» — nothing of it is said', async () => {
    await refusedWith(send(world(), [{ productId: 'p1', quantity: 1 }], { toWarehouseId: 'wX' }), 'WAREHOUSE_NOT_FOUND');
  });

  it('NEGATIVE: a product of another store is «not found»', async () => {
    await refusedWith(send(world(), [{ productId: 'p-s2', quantity: 1 }]), 'PRODUCT_NOT_FOUND');
  });

  it('NEGATIVE: a transfer of another store or company is «not found» for every door', async () => {
    const m = world();
    const { transfer } = await send(m, [{ productId: 'p1', quantity: 2 }]);
    const other = (fn: typeof receiveTransfer) =>
      (m.db as Row).$transaction((tx: Row) => fn(tx as never, { companyId: C1, storeId: 's2', transferId: transfer.id, receivedById: HER, mayUse: yes, body: { lines: [{ productId: 'p1', quantity: 2 }] } }));
    await refusedWith(other(receiveTransfer), 'NOT_FOUND');
    await refusedWith(
      (m.db as Row).$transaction((tx: Row) => cancelTransfer(tx as never, { companyId: 'c2', storeId: S1, transferId: transfer.id, cancelledById: ME, mayUse: yes, body: { reason: 'لا' } })),
      'NOT_FOUND'
    );
  });

  it('NEGATIVE: the sender must reach the source, the receiver and the approver the destination, the canceller the source', async () => {
    const m = world();
    await refusedWith(send(m, [{ productId: 'p1', quantity: 1 }], {}, ME, no), 'NOT_REACHED');
    const { transfer } = await send(m, [{ productId: 'p1', quantity: 2 }]);
    await refusedWith(receive(m, transfer.id, [{ productId: 'p1', quantity: 1 }], HER, no), 'NOT_REACHED');
    await refusedWith(cancel(m, transfer.id, ME, no), 'NOT_REACHED');
    await receive(m, transfer.id, [{ productId: 'p1', quantity: 1 }], HER);
    await refusedWith(approve(m, transfer.id, THIRD, 'LOSS', no), 'NOT_REACHED');
  });

  it('the reach question is asked about the right warehouse', async () => {
    const m = world();
    const asked: string[] = [];
    const spy = async (w: { id: string }) => (asked.push(w.id), true);
    const { transfer } = await send(m, [{ productId: 'p1', quantity: 2 }], {}, ME, spy);
    await receive(m, transfer.id, [{ productId: 'p1', quantity: 1 }], HER, spy);
    await approve(m, transfer.id, THIRD, 'LOSS', spy);
    expect(asked).toEqual(['wA', 'wB', 'wB']);
  });
});

describe('what the list shows while the goods are on the road', () => {
  const t = { status: 'SENT', sentById: ME, lines: [{ productId: 'p1', quantitySent: 7, quantityReceived: null }] };

  it('NEGATIVE: the receiver is not told the sent quantity before she counts', () => {
    expect(shownTo(t, HER).lines[0].quantitySent).toBeNull();
    expect(JSON.stringify(shownTo(t, HER))).not.toContain('7');
  });

  it('the sender is; and once received everybody sees sent, counted and the difference', () => {
    expect(shownTo(t, ME).lines[0].quantitySent).toBe(7);
    const done = { ...t, status: 'RECEIVED_WITH_DIFFERENCE', lines: [{ productId: 'p1', quantitySent: 7, quantityReceived: 5 }] };
    expect(shownTo(done, HER).lines[0]).toEqual({ productId: 'p1', quantitySent: 7, quantityReceived: 5, difference: 2 });
    expect(shownTo(done, HER).statusAr).toBe('مستلم بفرق');
  });
});

describe('no money — the transfer modules import nothing of wallets, expenses or profit, and write only stock rows', () => {
  it('imports', () => {
    for (const f of ['src/lib/stock-transfers.ts', 'src/lib/stock-transfer-kind.ts', 'src/lib/stock-transfer-door.ts']) {
      const src = readFileSync(join(process.cwd(), f), 'utf8');
      const imports = [...src.matchAll(/from\s+['"]([^'"]+)['"]/g)].map((x) => x[1]);
      expect(imports.filter((i) => /wallet|expense|profit|financ|commission|settlement|money/i.test(i)), f).toEqual([]);
    }
  });

  it('a whole life (send, short receipt, approval; send, cancel) writes only batches, movements and the transfer', async () => {
    const m = world();
    const a = (await send(m, [{ productId: 'p1', quantity: 5 }])).transfer;
    await receive(m, a.id, [{ productId: 'p1', quantity: 4 }]);
    await approve(m, a.id);
    const b = (await send(m, [{ productId: 'p1', quantity: 2 }])).transfer;
    await cancel(m, b.id);
    expect([...new Set(m.touched.map((x) => x.split('.')[0]))].sort()).toEqual(['inventoryMovement', 'productionBatch', 'stockTransfer', 'stockTransferLine']);
    // and nothing was deleted: no delete method exists on the fake, and every row ever written is still there
    expect(m.data.stockTransfer).toHaveLength(2);
  });
});
