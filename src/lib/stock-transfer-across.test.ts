import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { memoryDb, type Row } from './stock-transfers.memory-db.test';
import {
  approveAbroad,
  approveDifference,
  cancelTransfer,
  freeStockOf,
  receiveTransfer,
  sendTransfer,
  shownTo,
  StockTransferRefused,
} from './stock-transfers';
import { arrivalCost, missingValue, normalizeLanded, landedCostsField } from './stock-transfer-cost';
import { roundMinor } from './money';

/**
 * THE TRANSFER ACROSS STORES AND COUNTRIES (W7b) — the lib, against the in-memory database that judges every `where`
 * itself (`stock-transfers.memory-db.test.ts`).
 *
 * Every figure asserted is computed HERE from the batch rows or written out by hand — never by the function under test:
 *   on hand Σ remaining · «دخل» Σ produced · «خرج» Σ sold · the stock value Σ (remaining × cost) of ONE product.
 *
 * The world: company c1. Country k1 (minor unit 3) holds stores s1 and s2 and warehouses wA, wB; country k2 (minor unit
 * 2) holds store s3 and warehouse wJ. p1 of s1 is paired with q1 of s2 and with r1 of s3; p2 of s1 has no twin anywhere.
 */

const C1 = 'c1';
const ME = 'u-sender';
const HER = 'u-receiver';
const THIRD = 'u-approver';
const OWNER = 'u-owner';
type MayUse = (w: { id: string }) => Promise<boolean>;
const yes: MayUse = async () => true;
const reachAll = async () => true;

let uuidSeq = 0;
const uuid = () => `00000000-0000-4000-8000-${String(++uuidSeq).padStart(12, '0')}`;

function batch(id: string, over: Row = {}): Row {
  return {
    id,
    companyId: C1,
    storeId: 's1',
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

/** Ten units at 2 (oldest), then six at 3.3333. */
const twoRuns = () => [batch('b1'), batch('b2', { productionDate: new Date('2026-10-05'), costPerUnit: 3.3333, quantityRemaining: 6, quantityProduced: 9, quantitySold: 3 })];

function world(batches: Row[] = twoRuns(), extra: Row = {}) {
  return memoryDb({
    country: [
      { id: 'k1', companyId: C1, isActive: true, minorUnit: 3 },
      { id: 'k2', companyId: C1, isActive: true, minorUnit: 2 },
    ],
    store: [
      { id: 's1', companyId: C1, countryId: 'k1', name: 'المتجر' },
      { id: 's2', companyId: C1, countryId: 'k1', name: 'متجر تاني' },
      { id: 's3', companyId: C1, countryId: 'k2', name: 'متجر البلد التاني' },
      { id: 's4', companyId: C1, countryId: 'k1', name: 'متجر مش موزّع' },
    ],
    warehouse: [
      { id: 'wA', companyId: C1, countryId: 'k1', name: 'أ', isActive: true },
      { id: 'wB', companyId: C1, countryId: 'k1', name: 'ب', isActive: true },
      { id: 'wJ', companyId: C1, countryId: 'k2', name: 'ج', isActive: true },
    ],
    warehousePlacement: [
      { id: 'pl1', companyId: C1, storeId: 's1' },
      { id: 'pl2', companyId: C1, storeId: 's2' },
      { id: 'pl3', companyId: C1, storeId: 's3' },
    ],
    product: [
      { id: 'p1', companyId: C1, storeId: 's1', name: 'منتج ١' },
      { id: 'p2', companyId: C1, storeId: 's1', name: 'منتج بلا توأم' },
      { id: 'q1', companyId: C1, storeId: 's2', name: 'توأم بالمتجر التاني' },
      { id: 'r1', companyId: C1, storeId: 's3', name: 'توأم بالبلد التاني' },
      { id: 'x4', companyId: C1, storeId: 's4', name: 'توأم بمتجر مش موزّع' },
    ],
    // One direction: side A is the store whose id sorts first.
    productPair: [
      { id: 'pr1', companyId: C1, productAId: 'p1', storeAId: 's1', productBId: 'q1', storeBId: 's2', hint: 'SKU', createdById: ME },
      { id: 'pr2', companyId: C1, productAId: 'p1', storeAId: 's1', productBId: 'r1', storeBId: 's3', hint: null, createdById: ME },
      { id: 'pr4', companyId: C1, productAId: 'p1', storeAId: 's1', productBId: 'x4', storeBId: 's4', hint: null, createdById: ME },
    ],
    productionBatch: batches,
    ...extra,
  });
}

type M = ReturnType<typeof memoryDb>;
const rowsOf = (m: M, productId: string) => m.data.productionBatch.filter((b) => b.productId === productId && b.companyId === C1);
function figures(m: M, productId: string) {
  const rs = rowsOf(m, productId);
  return {
    produced: rs.reduce((s, r) => s + r.quantityProduced, 0),
    sold: rs.reduce((s, r) => s + r.quantitySold, 0),
    remaining: rs.reduce((s, r) => s + r.quantityRemaining, 0),
    value: rs.reduce((s, r) => s + r.quantityRemaining * r.costPerUnit, 0),
  };
}
const ledger = (m: M, productId: string) => m.data.inventoryMovement.filter((x) => x.productId === productId);

const send = (m: M, lines: Row[], over: Row = {}, opts: { by?: string; abroad?: boolean; reach?: (s: string) => Promise<boolean> } = {}) =>
  (m.db as Row).$transaction((tx: Row) =>
    sendTransfer(tx as never, {
      companyId: C1,
      storeId: 's1',
      sentById: opts.by ?? ME,
      mayUse: yes,
      mayReachStore: opts.reach ?? reachAll,
      mayAbroad: opts.abroad ?? false,
      body: { fromWarehouseId: 'wA', toWarehouseId: 'wB', toStoreId: 's2', lines, ...over } as never,
    })
  );
const receive = (m: M, id: string, lines: Row[], opts: { by?: string; storeId?: string; reach?: (s: string) => Promise<boolean> } = {}) =>
  (m.db as Row).$transaction((tx: Row) =>
    receiveTransfer(tx as never, {
      companyId: C1,
      storeId: opts.storeId ?? 's2',
      transferId: id,
      receivedById: opts.by ?? HER,
      mayUse: yes,
      mayReachStore: opts.reach ?? reachAll,
      body: { lines } as never,
    })
  );
const cancel = (m: M, id: string, by = ME, storeId = 's1') =>
  (m.db as Row).$transaction((tx: Row) =>
    cancelTransfer(tx as never, { companyId: C1, storeId, transferId: id, cancelledById: by, mayUse: yes, body: { reason: 'غلط بالكمية' } })
  );
const difference = (m: M, id: string, by = THIRD, storeId = 's2') =>
  (m.db as Row).$transaction((tx: Row) =>
    approveDifference(tx as never, { companyId: C1, storeId, transferId: id, approvedById: by, mayUse: yes, body: { type: 'LOSS', reason: 'ضاعت بالطريق' } })
  );
const ownerPress = (m: M, id: string, isOwner = true, by = OWNER) =>
  (m.db as Row).$transaction((tx: Row) => approveAbroad(tx as never, { companyId: C1, storeId: 's1', transferId: id, approvedById: by, isOwner, mayUse: yes }));
const refusedWith = async (p: Promise<unknown>, code: string) => {
  const e = await p.then(() => null, (x: unknown) => x);
  expect(e, `expected refusal ${code}`).toBeInstanceOf(StockTransferRefused);
  expect((e as StockTransferRefused).code).toBe(code);
  expect((e as StockTransferRefused).errorAr).toMatch(/[؀-ۿ]/);
  return e as StockTransferRefused;
};
const toCountry = { toWarehouseId: 'wJ', toStoreId: 's3' };

/* ═════════════════════════════ between two stores of one country ═════════════════════════════ */

describe('BETWEEN_STORES — the units leave product A at their cost and arrive in its twin at that cost', () => {
  it('send: drawn oldest first out of wA; store A falls by EXACTLY the cost that left; the goods exist on the document only', async () => {
    const m = world();
    const a0 = figures(m, 'p1');
    const { transfer, kind } = await send(m, [{ productId: 'p1', quantity: 13 }]);
    expect(kind).toBe('BETWEEN_STORES');
    expect(transfer.status).toBe('SENT');
    const a1 = figures(m, 'p1');
    // 10 at 2 and 3 at 3.3333 — written out by hand.
    const left = 10 * 2 + 3 * 3.3333;
    expect(transfer.lines[0].costOut).toBeCloseTo(left, 12);
    expect(a0.value - a1.value).toBeCloseTo(transfer.lines[0].costOut!, 9);
    expect([a1.remaining, a1.sold, a1.produced]).toEqual([a0.remaining - 13, a0.sold + 13, a0.produced]);
    // Not in store B yet, and not on any road: no batch of the twin, no twin row with a transfer id.
    expect(rowsOf(m, 'q1')).toEqual([]);
    expect(m.data.productionBatch.some((b) => b.inTransitTransferId)).toBe(false);
    expect(transfer.lines[0].toProductId).toBe('q1');
    // The ledger: TRANSFER_OUT −13 in store A at wA, carrying the transfer's id.
    expect(ledger(m, 'p1').map((x) => [x.type, x.quantity, x.storeId, x.warehouseId, x.referenceId])).toEqual([['TRANSFER_OUT', -13, 's1', 'wA', transfer.id]]);
  });

  it('receive whole: one batch of the twin in wB at the carried unit cost; store B rises by EXACTLY received × that cost', async () => {
    const m = world();
    const { transfer } = await send(m, [{ productId: 'p1', quantity: 13 }]);
    const a1 = figures(m, 'p1');
    const out = await receive(m, transfer.id, [{ productId: 'p1', quantity: 13 }]);
    expect(out.transfer.status).toBe('RECEIVED');
    const q = rowsOf(m, 'q1');
    expect(q).toHaveLength(1);
    // (10 × 2 + 3 × 3.3333) ÷ 13 = 2.3076846…, rounded to k1's three decimals = 2.308.
    expect(q[0].costPerUnit).toBe(2.308);
    expect([q[0].storeId, q[0].warehouseId, q[0].quantityRemaining, q[0].quantityProduced]).toEqual(['s2', 'wB', 13, 13]);
    expect(figures(m, 'q1').value).toBe(13 * 2.308);
    expect(out.transfer.lines[0].unitCostIn).toBe(2.308);
    // The remainder: what the rounding left out, booked nowhere — (29.9999 − 13 × 2.308).
    expect(out.transfer.lines[0].costRemainder).toBeCloseTo(29.9999 - 13 * 2.308, 9);
    // Store A did not move at the receipt.
    expect(figures(m, 'p1')).toEqual(a1);
    // The ledger of B: TRANSFER_IN +13 at wB in s2, the transfer's id on it — never «استلام بضاعة».
    expect(ledger(m, 'q1').map((x) => [x.type, x.quantity, x.storeId, x.warehouseId, x.referenceId])).toEqual([['TRANSFER_IN', 13, 's2', 'wB', transfer.id]]);
  });

  it('goods exist in exactly one store after a completed transfer: A − 13 and B + 13, the sum unchanged', async () => {
    const m = world();
    const total0 = figures(m, 'p1').remaining + figures(m, 'q1').remaining;
    const { transfer } = await send(m, [{ productId: 'p1', quantity: 7 }]);
    await receive(m, transfer.id, [{ productId: 'p1', quantity: 7 }]);
    expect(figures(m, 'p1').remaining + figures(m, 'q1').remaining).toBe(total0);
    expect(figures(m, 'q1').remaining).toBe(7);
  });

  it('a short receipt: B gets what was counted at the cost of THOSE units; the missing ones are a report, approved by a third person', async () => {
    const m = world();
    const { transfer } = await send(m, [{ productId: 'p1', quantity: 13 }]);
    const out = await receive(m, transfer.id, [{ productId: 'p1', quantity: 12 }]);
    expect(out.transfer.status).toBe('RECEIVED_WITH_DIFFERENCE');
    // carried = 29.9999 × 12 ÷ 13 = 27.6922153…; ÷ 12 = 2.3076846… → 2.308.
    expect(rowsOf(m, 'q1')[0].costPerUnit).toBe(2.308);
    const before = structuredClone(m.data);
    // Two hands still: the sender and the receiver may not approve it.
    await refusedWith(difference(m, transfer.id, ME), 'SENDER_CANNOT_APPROVE');
    await refusedWith(difference(m, transfer.id, HER), 'RECEIVER_CANNOT_APPROVE');
    const ok = await difference(m, transfer.id, THIRD);
    expect(ok.replay).toBe(false);
    // REPORT ONLY: not one batch and not one ledger line moved.
    expect(m.data.productionBatch).toEqual(before.productionBatch);
    expect(m.data.inventoryMovement).toEqual(before.inventoryMovement);
    const t = m.data.stockTransfer[0];
    expect([t.differenceApprovedById, t.differenceType]).toEqual([THIRD, 'LOSS']);
    // The value of the missing unit, at the cost that left (for the report): 29.9999 ÷ 13.
    expect(missingValue(29.9999, 13, 12)).toBeCloseTo(29.9999 / 13, 12);
  });

  it('cancel before receipt: the units come back into product A as ONE new batch in wA at the captured cost; the value is back', async () => {
    const m = world();
    const a0 = figures(m, 'p1');
    const { transfer } = await send(m, [{ productId: 'p1', quantity: 13 }]);
    await cancel(m, transfer.id);
    const a2 = figures(m, 'p1');
    expect(a2.remaining).toBe(a0.remaining);
    expect(a2.value).toBeCloseTo(a0.value, 9);
    const back = rowsOf(m, 'p1').filter((r) => !['b1', 'b2'].includes(r.id));
    expect(back).toHaveLength(1);
    expect([back[0].warehouseId, back[0].storeId, back[0].quantityRemaining]).toEqual(['wA', 's1', 13]);
    expect(back[0].costPerUnit).toBeCloseTo(29.9999 / 13, 12);
    expect(ledger(m, 'p1').map((x) => [x.type, x.quantity])).toEqual([
      ['TRANSFER_OUT', -13],
      ['TRANSFER_IN', 13],
    ]);
    expect(m.data.stockTransfer[0].status).toBe('CANCELLED');
    expect(rowsOf(m, 'q1')).toEqual([]);
  });

  it('NEGATIVE: after the receipt there is no cancel — the way back is a new transfer', async () => {
    const m = world();
    const { transfer } = await send(m, [{ productId: 'p1', quantity: 2 }]);
    await receive(m, transfer.id, [{ productId: 'p1', quantity: 2 }]);
    await refusedWith(cancel(m, transfer.id), 'ALREADY_RECEIVED');
  });

  it('the destination store sees the transfer (and the source store too); a third store does not', async () => {
    const m = world();
    const { transfer } = await send(m, [{ productId: 'p1', quantity: 1 }]);
    await refusedWith(receive(m, transfer.id, [{ productId: 'p1', quantity: 1 }], { storeId: 's3' }), 'NOT_FOUND');
    expect((await receive(m, transfer.id, [{ productId: 'p1', quantity: 1 }], { storeId: 's2' })).transfer.status).toBe('RECEIVED');
  });
});

/* ═════════════════════════════ landed costs ═════════════════════════════ */

describe('landed costs go INTO the unit cost — the worked example, by hand', () => {
  it('13 sent (cost 29.9999), 12 counted, transport 5.5 + customs 1.25 in a 2-decimal currency: 2.87 a unit', async () => {
    const m = world();
    const { transfer } = await send(m, [{ productId: 'p1', quantity: 13 }], toCountry, { abroad: true });
    await ownerPress(m, transfer.id);
    const out = await receive(m, transfer.id, [
      { productId: 'p1', quantity: 12, costs: [{ kind: 'TRANSPORT', amount: 5.5 }, { kind: 'CUSTOMS', amount: 1.25 }] },
    ], { storeId: 's3' });
    // carried 29.9999 × 12 ÷ 13 = 27.69221538…; + 6.75 = 34.44221538…; ÷ 12 = 2.8701846… → 2.87.
    const r = rowsOf(m, 'r1');
    expect(r).toHaveLength(1);
    expect(r[0].costPerUnit).toBe(2.87);
    expect([r[0].storeId, r[0].warehouseId, r[0].quantityRemaining]).toEqual(['s3', 'wJ', 12]);
    expect(figures(m, 'r1').value).toBe(12 * 2.87);
    const line = out.transfer.lines[0];
    expect(line.unitCostIn).toBe(2.87);
    expect(line.landedCosts).toEqual([{ kind: 'TRANSPORT', amount: 5.5 }, { kind: 'CUSTOMS', amount: 1.25 }]);
    expect(line.costRemainder).toBeCloseTo((29.9999 * 12) / 13 + 6.75 - 12 * 2.87, 9);
    // The remainder rule: never more than received × half a minor unit.
    expect(Math.abs(line.costRemainder!)).toBeLessThanOrEqual(12 * 0.005);
  });

  it('typed amounts are rounded once to the destination’s minor unit; «غيره» needs a word', () => {
    expect(normalizeLanded([{ kind: 'TRANSPORT', amount: 1.005 }], 2)).toEqual([{ kind: 'TRANSPORT', amount: 1.01 }]);
    expect(normalizeLanded([{ kind: 'CUSTOMS', amount: 1.0005 }], 3)).toEqual([{ kind: 'CUSTOMS', amount: 1.001 }]);
    expect(landedCostsField.safeParse([{ kind: 'OTHER', amount: 3 }]).success).toBe(false);
    expect(landedCostsField.safeParse([{ kind: 'OTHER', amount: 3, note: 'تخليص' }]).success).toBe(true);
    expect(landedCostsField.safeParse([{ kind: 'TRANSPORT', amount: -1 }]).success).toBe(false);
  });

  it('the pure rule: everything arrived → carried IS the cost that left, not a division of it', () => {
    const c = arrivalCost({ costOut: 29.9999, sent: 13, received: 13, landed: [], minorUnit: 3 });
    expect(c.ok && c.carried).toBe(29.9999);
  });

  it('the remainder bound holds on 2000 random lines, and the unit cost is the rounded quotient', () => {
    let seed = 11;
    const rnd = (n: number) => {
      seed = (seed * 1103515245 + 12345) % 2147483648;
      return seed % n;
    };
    for (let i = 0; i < 2000; i++) {
      const sent = 1 + rnd(300);
      const received = 1 + rnd(sent);
      const minorUnit = [0, 2, 3][rnd(3)];
      const costOut = rnd(1_000_000) / 997;
      const landed = normalizeLanded([{ kind: 'TRANSPORT', amount: rnd(50_000) / 100 }], minorUnit);
      const c = arrivalCost({ costOut, sent, received, landed, minorUnit, zeroCostReason: 'عيّنة مجانية من المورّد' });
      expect(c.ok).toBe(true);
      if (!c.ok) continue;
      const total = (costOut * received) / sent + landed[0].amount;
      expect(c.unitCost).toBe(roundMinor(total / received, minorUnit));
      expect(Math.abs(c.remainder)).toBeLessThanOrEqual(received * (0.5 * 10 ** -minorUnit) + 1e-9);
    }
  });
});

/* ═════════════════════════════ a unit cost of zero ═════════════════════════════ */

describe('a zero unit cost needs a sentence (unit-cost.resolveUnitCost)', () => {
  it('NEGATIVE: goods that left at zero and nothing landed are refused without a reason — with one, they land at zero', async () => {
    const m = world([batch('z1', { costPerUnit: 0, totalProductionCost: 0 })]);
    const { transfer } = await send(m, [{ productId: 'p1', quantity: 4 }]);
    const e = await refusedWith(receive(m, transfer.id, [{ productId: 'p1', quantity: 4 }]), 'ZERO_COST_UNEXPLAINED');
    expect(e.errorAr).toContain('السبب');
    expect(rowsOf(m, 'q1')).toEqual([]);
    await receive(m, transfer.id, [{ productId: 'p1', quantity: 4, zeroCostReason: 'عيّنات مجانية من المورّد' }]);
    expect(rowsOf(m, 'q1')[0].costPerUnit).toBe(0);
    expect(m.data.stockTransferLine[0].zeroCostReason).toBe('عيّنات مجانية من المورّد');
  });

  it('and a landed cost lifts it off zero with no reason asked', async () => {
    const m = world([batch('z1', { costPerUnit: 0, totalProductionCost: 0 })]);
    const { transfer } = await send(m, [{ productId: 'p1', quantity: 4 }]);
    await receive(m, transfer.id, [{ productId: 'p1', quantity: 4, costs: [{ kind: 'TRANSPORT', amount: 2 }] }]);
    expect(rowsOf(m, 'q1')[0].costPerUnit).toBe(0.5);
  });
});

/* ═════════════════════════════ another country ═════════════════════════════ */

describe('BETWEEN_COUNTRIES — the abroad key, then the owner’s press before anything moves', () => {
  it('NEGATIVE: without inventory.transfer_abroad the send is refused, and nothing is written', async () => {
    const m = world();
    await refusedWith(send(m, [{ productId: 'p1', quantity: 1 }], toCountry, { abroad: false }), 'ABROAD_KEY_MISSING');
    expect(m.data.stockTransfer).toEqual([]);
  });

  it('with the key: AWAITING_APPROVAL, not one unit moved — and its units are held out of the free stock', async () => {
    const m = world();
    const before = structuredClone(m.data.productionBatch);
    const { transfer, kind } = await send(m, [{ productId: 'p1', quantity: 5 }], toCountry, { abroad: true });
    expect([kind, transfer.status]).toEqual(['BETWEEN_COUNTRIES', 'AWAITING_APPROVAL']);
    expect(m.data.productionBatch).toEqual(before);
    expect(m.data.inventoryMovement).toEqual([]);
    const free = await freeStockOf(m.tx, { companyId: C1, storeId: 's1', warehouseId: 'wA', productIds: ['p1'] });
    expect(free.get('p1')).toBe(16 - 5);
    // A second request may not take the same units.
    await refusedWith(send(m, [{ productId: 'p1', quantity: 12 }], toCountry, { abroad: true }), 'NOT_ENOUGH_FREE');
  });

  it('NEGATIVE: nobody receives a request the owner has not approved', async () => {
    const m = world();
    const { transfer } = await send(m, [{ productId: 'p1', quantity: 5 }], toCountry, { abroad: true });
    await refusedWith(receive(m, transfer.id, [{ productId: 'p1', quantity: 5 }], { storeId: 's3' }), 'NOT_APPROVED_YET');
  });

  it('NEGATIVE: the press is the owner’s — a person who is not is refused, even the one who asked', async () => {
    const m = world();
    const { transfer } = await send(m, [{ productId: 'p1', quantity: 5 }], toCountry, { abroad: true });
    await refusedWith(ownerPress(m, transfer.id, false, ME), 'OWNER_ONLY');
    await refusedWith(ownerPress(m, transfer.id, false, THIRD), 'OWNER_ONLY');
    expect(m.data.stockTransfer[0].status).toBe('AWAITING_APPROVAL');
  });

  it('the owner’s press sends it: drawn out of A at its cost, TRANSFER_OUT by his hand; a second press is a replay', async () => {
    const m = world();
    const a0 = figures(m, 'p1');
    const { transfer } = await send(m, [{ productId: 'p1', quantity: 12 }], toCountry, { abroad: true });
    const out = await ownerPress(m, transfer.id);
    expect(out.transfer.status).toBe('SENT');
    expect([out.transfer.approvedById, !!out.transfer.approvedAt]).toEqual([OWNER, true]);
    // 10 at 2 and 2 at 3.3333.
    expect(out.transfer.lines[0].costOut).toBeCloseTo(20 + 2 * 3.3333, 12);
    expect(a0.value - figures(m, 'p1').value).toBeCloseTo(20 + 2 * 3.3333, 9);
    expect(ledger(m, 'p1').map((x) => [x.type, x.quantity, x.createdById])).toEqual([['TRANSFER_OUT', -12, OWNER]]);
    const again = await ownerPress(m, transfer.id);
    expect(again.replay).toBe(true);
    expect(ledger(m, 'p1')).toHaveLength(1);
  });

  it('NEGATIVE: the press re-asks the free stock — units taken meanwhile by a delivery stop it whole', async () => {
    const m = world();
    const { transfer } = await send(m, [{ productId: 'p1', quantity: 12 }], toCountry, { abroad: true });
    // Another door draws 10 out of wA meanwhile.
    m.data.productionBatch.find((b) => b.id === 'b1')!.quantityRemaining = 0;
    await refusedWith(ownerPress(m, transfer.id), 'NOT_ENOUGH_FREE');
    expect(m.data.stockTransfer[0].status).toBe('AWAITING_APPROVAL');
    expect(m.data.inventoryMovement).toEqual([]);
  });

  it('a request still awaiting the owner is cancelled with nothing to give back', async () => {
    const m = world();
    const before = structuredClone(m.data.productionBatch);
    const { transfer } = await send(m, [{ productId: 'p1', quantity: 5 }], toCountry, { abroad: true });
    await cancel(m, transfer.id);
    expect(m.data.stockTransfer[0].status).toBe('CANCELLED');
    expect(m.data.productionBatch).toEqual(before);
    expect(m.data.inventoryMovement).toEqual([]);
    await refusedWith(ownerPress(m, transfer.id), 'ALREADY_CANCELLED');
  });

  it('NEGATIVE: the destination warehouse must be of the destination store’s country', async () => {
    await refusedWith(send(world(), [{ productId: 'p1', quantity: 1 }], { toWarehouseId: 'wB', toStoreId: 's3' }, { abroad: true }), 'TO_OTHER_COUNTRY');
  });
});

/* ═════════════════════════════ what the send refuses ═════════════════════════════ */

describe('the send refuses, by name, before anything is written', () => {
  it('NEGATIVE: a product with no twin in the other store', async () => {
    const m = world([...twoRuns(), batch('c1', { productId: 'p2' })]);
    const e = await refusedWith(send(m, [{ productId: 'p1', quantity: 1 }, { productId: 'p2', quantity: 1 }]), 'NO_PAIR');
    expect(e.errorAr).toContain('منتج بلا توأم');
    expect(e.extra.productIds).toEqual(['p2']);
    expect(m.data.stockTransfer).toEqual([]);
  });

  it('NEGATIVE: a destination store the sender does not reach', async () => {
    await refusedWith(send(world(), [{ productId: 'p1', quantity: 1 }], {}, { reach: async () => false }), 'TO_STORE_NOT_REACHED');
  });

  it('NEGATIVE: a destination store never placed in warehouses', async () => {
    await refusedWith(send(world(), [{ productId: 'p1', quantity: 1 }], { toStoreId: 's4' }), 'TO_STORE_NOT_PLACED');
  });

  it('NEGATIVE: a destination store of another company is «not found»', async () => {
    const m = world(twoRuns(), { store: [{ id: 's1', companyId: C1, countryId: 'k1', name: 'المتجر' }, { id: 'sX', companyId: 'c2', countryId: 'k1', name: 'غريب' }] });
    await refusedWith(send(m, [{ productId: 'p1', quantity: 1 }], { toStoreId: 'sX' }), 'TO_STORE_NOT_FOUND');
  });

  it('NEGATIVE: a product with combinations at the source — or a twin with them — is refused across stores', async () => {
    const m1 = world(twoRuns(), { productVariant: [{ id: 'v1', companyId: C1, productId: 'p1', label: 'L', status: 'ACTIVE', sortOrder: 0 }] });
    await refusedWith(send(m1, [{ productId: 'p1', quantity: 1 }]), 'VARIANTS_ACROSS');
    const m2 = world(twoRuns(), { productVariant: [{ id: 'v2', companyId: C1, productId: 'q1', label: 'L', status: 'ARCHIVED', sortOrder: 0 }] });
    await refusedWith(send(m2, [{ productId: 'p1', quantity: 1 }]), 'VARIANTS_ACROSS');
    expect([m1.data.stockTransfer, m2.data.stockTransfer]).toEqual([[], []]);
  });

  it('NEGATIVE: more than the free stock of the source warehouse', async () => {
    await refusedWith(send(world(), [{ productId: 'p1', quantity: 17 }]), 'NOT_ENOUGH_FREE');
  });

  it('a replay of the same send (same id, same deal, same person) writes nothing more', async () => {
    const m = world();
    const id = uuid();
    await send(m, [{ productId: 'p1', quantity: 3 }], { id });
    const again = await send(m, [{ productId: 'p1', quantity: 3 }], { id });
    expect(again.replay).toBe(true);
    expect(ledger(m, 'p1')).toHaveLength(1);
    // The same id to another store is a conflict.
    await refusedWith(send(m, [{ productId: 'p1', quantity: 3 }], { id, ...toCountry }, { abroad: true }), 'TRANSFER_EXISTS');
  });
});

describe('what the receipt refuses', () => {
  it('NEGATIVE: the sender may not receive; a count over what was sent; costs on a line where nothing arrived', async () => {
    const m = world();
    const { transfer } = await send(m, [{ productId: 'p1', quantity: 3 }]);
    await refusedWith(receive(m, transfer.id, [{ productId: 'p1', quantity: 3 }], { by: ME }), 'SENDER_CANNOT_RECEIVE');
    await refusedWith(receive(m, transfer.id, [{ productId: 'p1', quantity: 4 }]), 'COUNT_OVER_SENT');
    await refusedWith(receive(m, transfer.id, [{ productId: 'p1', quantity: 0, costs: [{ kind: 'TRANSPORT', amount: 1 }] }]), 'COSTS_WITHOUT_UNITS');
    await refusedWith(receive(m, transfer.id, [{ productId: 'p1', quantity: 3 }], { reach: async () => false }), 'TO_STORE_NOT_REACHED');
    expect(rowsOf(m, 'q1')).toEqual([]);
  });

  it('NEGATIVE: costs typed on a transfer INSIDE one store are refused — its cost does not move', async () => {
    const m = world();
    const { transfer } = await send(m, [{ productId: 'p1', quantity: 3 }], { toStoreId: undefined });
    await refusedWith(
      (m.db as Row).$transaction((tx: Row) =>
        receiveTransfer(tx as never, { companyId: C1, storeId: 's1', transferId: transfer.id, receivedById: HER, mayUse: yes, body: { lines: [{ productId: 'p1', quantity: 3, costs: [{ kind: 'CUSTOMS', amount: 1 }] }] } as never })
      ),
      'COSTS_NOT_HERE'
    );
  });

  it('a replay of the receipt by the same hand with the same costs is answered as done; other costs are a conflict', async () => {
    const m = world();
    const { transfer } = await send(m, [{ productId: 'p1', quantity: 3 }]);
    const lines = [{ productId: 'p1', quantity: 3, costs: [{ kind: 'TRANSPORT', amount: 1.5 }] }];
    await receive(m, transfer.id, lines);
    expect((await receive(m, transfer.id, lines)).replay).toBe(true);
    await refusedWith(receive(m, transfer.id, [{ productId: 'p1', quantity: 3, costs: [{ kind: 'TRANSPORT', amount: 2 }] }]), 'ALREADY_RECEIVED');
    expect(rowsOf(m, 'q1')).toHaveLength(1);
  });
});

/* ═════════════════════════════ conservation on random stores ═════════════════════════════ */

describe('conservation on random stores — every figure from the rows', () => {
  it('300 random transfers across: A falls by exactly costOut; B rises by exactly received × unit cost; units in one place', async () => {
    let seed = 5;
    const rnd = (n: number) => {
      seed = (seed * 1103515245 + 12345) % 2147483648;
      return seed % n;
    };
    for (let round = 0; round < 300; round++) {
      const bs: Row[] = [];
      for (let i = 0; i < 1 + rnd(4); i++) {
        const produced = 1 + rnd(20);
        const sold = rnd(produced);
        bs.push(
          batch(`r${round}b${i}`, {
            quantityProduced: produced,
            quantitySold: sold,
            quantityRemaining: produced - sold,
            costPerUnit: [0.5, 1.5, 2.25, 3.3333, 17.4047][rnd(5)],
            productionDate: new Date(Date.UTC(2026, 9, 1 + rnd(5))),
            createdAt: new Date(Date.UTC(2026, 9, 1, i)),
          })
        );
      }
      const m = world(bs);
      const onShelf = figures(m, 'p1').remaining;
      if (onShelf === 0) continue;
      const n = 1 + rnd(onShelf);
      const abroad = rnd(2) === 0;
      const a0 = figures(m, 'p1');
      const b0 = figures(m, abroad ? 'r1' : 'q1');
      // The cost that left, by hand: oldest first.
      const oldest = [...bs].sort((x, y) => x.productionDate - y.productionDate || x.createdAt - y.createdAt);
      let left = n;
      let byHand = 0;
      for (const b of oldest) {
        const take = Math.min(left, b.quantityRemaining);
        byHand += take * b.costPerUnit;
        left -= take;
      }
      const { transfer } = await send(m, [{ productId: 'p1', quantity: n }], abroad ? toCountry : {}, { abroad });
      if (abroad) await ownerPress(m, transfer.id);
      const a1 = figures(m, 'p1');
      expect(a1.remaining).toBe(a0.remaining - n);
      expect(a0.value - a1.value).toBeCloseTo(byHand, 9);
      expect(m.data.stockTransferLine[0].costOut).toBeCloseTo(byHand, 9);

      const action = rnd(3);
      if (action === 0) {
        await cancel(m, transfer.id);
        expect(figures(m, 'p1').remaining).toBe(a0.remaining);
        expect(figures(m, 'p1').value).toBeCloseTo(a0.value, 9);
        continue;
      }
      const received = action === 1 ? n : rnd(n + 1);
      const landed = rnd(2) ? [{ kind: 'TRANSPORT', amount: rnd(1000) / 100 }] : [];
      await receive(m, transfer.id, [{ productId: 'p1', quantity: received, ...(received > 0 ? { costs: landed } : {}) }], { storeId: abroad ? 's3' : 's2' });
      const b1 = figures(m, abroad ? 'r1' : 'q1');
      const line = m.data.stockTransferLine[0];
      expect(b1.remaining - b0.remaining).toBe(received);
      if (received > 0) {
        // Exactly received × the stored unit cost — the batch it opened, nothing else.
        expect(b1.value - b0.value).toBe(received * line.unitCostIn);
        const minor = abroad ? 2 : 3;
        const typed = landed.reduce((s, l) => s + l.amount, 0);
        expect(line.unitCostIn).toBe(roundMinor(((line.costOut * received) / n + roundMinor(typed, minor)) / received, minor));
      }
      // Never in both stores, never in neither (what was not counted is the reported shortfall).
      expect(figures(m, 'p1').remaining + b1.remaining).toBe(a0.remaining + b0.remaining - (n - received));
      expect(figures(m, 'p1')).toEqual(a1);
    }
  });
});

/* ═════════════════════════════ what a viewer is told ═════════════════════════════ */

describe('what the list shows — the count stays blind, the cost only to the cost key', () => {
  const t = (status: string) => ({
    status,
    sentById: ME,
    lines: [{ productId: 'p1', quantitySent: 5, quantityReceived: status === 'RECEIVED' ? 5 : null, toProductId: 'q1', costOut: 10, landedCosts: [], unitCostIn: status === 'RECEIVED' ? 2 : null, costRemainder: 0 }],
  });

  it('NEGATIVE: a request awaiting the owner is blind to the receiver; the owner and the sender read it', () => {
    expect(shownTo(t('AWAITING_APPROVAL'), HER, { seesCost: true }).lines[0].quantitySent).toBeNull();
    expect(shownTo(t('AWAITING_APPROVAL'), HER, { seesCost: true }).lines[0]).not.toHaveProperty('costOut');
    expect(shownTo(t('AWAITING_APPROVAL'), OWNER, { owner: true }).lines[0].quantitySent).toBe(5);
    expect(shownTo(t('AWAITING_APPROVAL'), ME).lines[0].quantitySent).toBe(5);
  });

  it('NEGATIVE: the cost fields are omitted without the cost key — not zeroed', () => {
    const plain = shownTo(t('RECEIVED'), HER).lines[0];
    expect(plain).not.toHaveProperty('costOut');
    expect(plain).not.toHaveProperty('unitCostIn');
    expect(plain.toProductId).toBe('q1');
    expect(shownTo(t('RECEIVED'), HER, { seesCost: true }).lines[0]).toMatchObject({ costOut: 10, unitCostIn: 2 });
  });
});

/* ═════════════════════════════ no money ═════════════════════════════ */

describe('no money — nothing of wallets, expenses or profit is imported, and only stock rows are written', () => {
  it('imports of the new modules', () => {
    for (const f of ['src/lib/stock-transfer-cost.ts', 'src/lib/product-twins.ts', 'src/lib/stock-transfers.ts']) {
      const src = readFileSync(join(process.cwd(), f), 'utf8');
      const imports = [...src.matchAll(/from\s+['"]([^'"]+)['"]/g)].map((x) => x[1]);
      expect(imports.filter((i) => /wallet|expense|profit|financ|commission|settlement|partner/i.test(i)), f).toEqual([]);
    }
  });

  it('a whole life (request, the owner’s press, a short receipt with costs, the approval; send, cancel) touches only stock tables', async () => {
    const m = world();
    const a = (await send(m, [{ productId: 'p1', quantity: 5 }], toCountry, { abroad: true })).transfer;
    await ownerPress(m, a.id);
    await receive(m, a.id, [{ productId: 'p1', quantity: 4, costs: [{ kind: 'CUSTOMS', amount: 3 }] }], { storeId: 's3' });
    await difference(m, a.id, THIRD, 's3');
    const b = (await send(m, [{ productId: 'p1', quantity: 2 }])).transfer;
    await cancel(m, b.id);
    expect([...new Set(m.touched.map((x) => x.split('.')[0]))].sort()).toEqual(['inventoryMovement', 'productionBatch', 'stockTransfer', 'stockTransferLine']);
  });
});
