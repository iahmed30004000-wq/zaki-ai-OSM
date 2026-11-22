import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { memoryDb, type Row } from './stock-transfers.memory-db.test';
import { approveAbroad, cancelTransfer, receiveTransfer, sendTransfer, shownTo, StockTransferRefused } from './stock-transfers';
import { rateLooksOff, rateMirror, rateText, rateWords } from './exchange-rate-words';
import { EXCHANGE_RATE_MAX, arrivalCost, checkExchangeRate, convertedArrivalCost, needsExchangeRate, normalizeLanded } from './stock-transfer-cost';

/**
 * 22/11 (F2): «سعر الصرف» — a transfer between two stores whose countries keep their costs in DIFFERENT currencies (the
 * owner's word of 22/11, reversing his «no exchange rate» of 20/11). Against the in-memory database that judges every
 * `where` itself. Every figure asserted is written out BY HAND here — never computed with the function under test.
 *
 * The world: s1 in k1 (SYP, two decimals), s3 in k2 (JOD, three decimals), s5 in k3 (SYP again, zero decimals — another
 * country of the SAME currency). p1 of s1: ten units at 1000 SYP each, in wA. Its twins: r1 (s3), t1 (s5).
 *
 * ASSUMPTION (the brief, stated for the owner to correct): the cost that left AND every typed landed line are in the
 * SOURCE currency (SYP here); the conversion happens once, at the receipt.
 */

const C1 = 'c1';
const ME = 'u-sender';
const HER = 'u-receiver';
const OWNER = 'u-owner';
const yes = async () => true;
const RATE = 0.000071; // 1 SYP = 0.000071 JOD

function world() {
  return memoryDb({
    country: [
      { id: 'k1', companyId: C1, isActive: true, minorUnit: 2, currencyCode: 'SYP' },
      { id: 'k2', companyId: C1, isActive: true, minorUnit: 3, currencyCode: 'JOD' },
      { id: 'k3', companyId: C1, isActive: true, minorUnit: 0, currencyCode: 'SYP' },
    ],
    store: [
      { id: 's1', companyId: C1, countryId: 'k1', name: 'متجر الشام' },
      { id: 's3', companyId: C1, countryId: 'k2', name: 'متجر عمّان' },
      { id: 's5', companyId: C1, countryId: 'k3', name: 'متجر تالت' },
    ],
    warehouse: [
      { id: 'wA', companyId: C1, countryId: 'k1', name: 'أ', isActive: true },
      { id: 'wJ', companyId: C1, countryId: 'k2', name: 'ج', isActive: true },
      { id: 'wT', companyId: C1, countryId: 'k3', name: 'ت', isActive: true },
    ],
    warehousePlacement: [
      { id: 'pl1', companyId: C1, storeId: 's1' },
      { id: 'pl3', companyId: C1, storeId: 's3' },
      { id: 'pl5', companyId: C1, storeId: 's5' },
    ],
    product: [
      { id: 'p1', companyId: C1, storeId: 's1', name: 'منتج' },
      { id: 'r1', companyId: C1, storeId: 's3', name: 'توأم بعمّان' },
      { id: 't1', companyId: C1, storeId: 's5', name: 'توأم تالت' },
    ],
    productPair: [
      { id: 'pr1', companyId: C1, productAId: 'p1', storeAId: 's1', productBId: 'r1', storeBId: 's3', hint: null, createdById: ME },
      { id: 'pr2', companyId: C1, productAId: 'p1', storeAId: 's1', productBId: 't1', storeBId: 's5', hint: null, createdById: ME },
    ],
    productionBatch: [
      {
        id: 'b1', companyId: C1, storeId: 's1', productId: 'p1', batchNumber: 'RCV-1', quantityProduced: 10, quantitySold: 0, quantityRemaining: 10,
        quantityMovedIn: 0, quantityMovedOut: 0, manufacturingCost: 0, packagingCost: 0, rawMaterialCost: 0, otherCosts: 0, totalProductionCost: 10000,
        costPerUnit: 1000, productionDate: new Date('2026-10-01'), createdAt: new Date('2026-10-01T08:00:00Z'), status: 'COMPLETED', notes: null,
        warehouseId: 'wA', inTransitTransferId: null, splitFromBatchId: null,
      },
    ],
  });
}

type M = ReturnType<typeof world>;
const ID = '00000000-0000-4000-8000-000000000001';
const send = (m: M, over: Row = {}, by = ME) =>
  (m.db as Row).$transaction((tx: Row) =>
    sendTransfer(tx as never, {
      companyId: C1,
      storeId: 's1',
      sentById: by,
      mayUse: yes,
      mayReachStore: yes,
      mayAbroad: true,
      body: { id: ID, fromWarehouseId: 'wA', toWarehouseId: 'wJ', toStoreId: 's3', lines: [{ productId: 'p1', quantity: 10 }], ...over } as never,
    })
  );
const press = (m: M, id = ID) =>
  (m.db as Row).$transaction((tx: Row) => approveAbroad(tx as never, { companyId: C1, storeId: 's1', transferId: id, approvedById: OWNER, isOwner: true, mayUse: yes }));
const receive = (m: M, lines: Row[], storeId = 's3', id = ID) =>
  (m.db as Row).$transaction((tx: Row) =>
    receiveTransfer(tx as never, { companyId: C1, storeId, transferId: id, receivedById: HER, mayUse: yes, mayReachStore: yes, body: { lines } as never })
  );
const cancel = (m: M, id = ID) =>
  (m.db as Row).$transaction((tx: Row) =>
    cancelTransfer(tx as never, { companyId: C1, storeId: 's1', transferId: id, cancelledById: ME, mayUse: yes, body: { reason: 'غلط بالكمية' } })
  );
const refusedWith = async (p: Promise<unknown>, code: string) => {
  const e = await p.then(() => null, (x: unknown) => x);
  expect(e, `expected refusal ${code}`).toBeInstanceOf(StockTransferRefused);
  expect((e as StockTransferRefused).code).toBe(code);
  expect((e as StockTransferRefused).status).toBe(code === 'TRANSFER_EXISTS' ? 409 : 400);
  expect((e as StockTransferRefused).errorAr).toMatch(/[؀-ۿ]/);
  return e as StockTransferRefused;
};
const batchesOf = (m: M, productId: string) => m.data.productionBatch.filter((b) => b.productId === productId);
const value = (m: M, productId: string) => batchesOf(m, productId).reduce((s, b) => s + b.quantityRemaining * b.costPerUnit, 0);

describe('F2 — the rate at the send', () => {
  it('NEGATIVE: between SYP and JOD a send without a rate, at zero, below zero, not a finite number, or above the bound is refused — nothing written', async () => {
    for (const [rate, code] of [
      [undefined, 'RATE_MISSING'],
      [null, 'RATE_MISSING'],
      [0, 'RATE_INVALID'],
      [-0.000071, 'RATE_INVALID'],
      [Number.NaN, 'RATE_INVALID'],
      [Number.POSITIVE_INFINITY, 'RATE_INVALID'],
      [EXCHANGE_RATE_MAX + 1, 'RATE_TOO_BIG'],
    ] as const) {
      const m = world();
      await refusedWith(send(m, rate === undefined ? {} : { exchangeRate: rate }), code);
      expect(m.data.stockTransfer, String(rate)).toEqual([]);
      expect(batchesOf(m, 'p1')[0].quantityRemaining).toBe(10);
    }
    // The bound itself is accepted.
    expect((await send(world(), { exchangeRate: EXCHANGE_RATE_MAX })).transfer.exchangeRate).toBe(EXCHANGE_RATE_MAX);
  });

  it('NEGATIVE: two countries of the SAME currency (SYP → SYP) refuse a rate, and without one the row carries no rate key', async () => {
    const m = world();
    await refusedWith(send(m, { toWarehouseId: 'wT', toStoreId: 's5', exchangeRate: 1 }), 'RATE_NOT_HERE');
    const { transfer } = await send(m, { toWarehouseId: 'wT', toStoreId: 's5' });
    expect(transfer.status).toBe('AWAITING_APPROVAL');
    expect(m.data.stockTransfer[0]).not.toHaveProperty('exchangeRate');
  });

  it('the rate is stored on the transfer and frozen: the owner’s press keeps it; a replay with the same rate is that transfer, with another rate a conflict', async () => {
    const m = world();
    const { transfer } = await send(m, { exchangeRate: RATE });
    expect([transfer.status, m.data.stockTransfer[0].exchangeRate]).toEqual(['AWAITING_APPROVAL', RATE]);
    expect((await send(m, { exchangeRate: RATE })).replay).toBe(true);
    await refusedWith(send(m, { exchangeRate: 0.00007 }), 'TRANSFER_EXISTS');
    await refusedWith(send(m, {}), 'TRANSFER_EXISTS');
    await press(m);
    expect(m.data.stockTransfer[0].exchangeRate).toBe(RATE);
    // After the press, too: the replay with another rate is still a conflict, and nothing changed it.
    await refusedWith(send(m, { exchangeRate: 1 }), 'TRANSFER_EXISTS');
    expect(m.data.stockTransfer[0].exchangeRate).toBe(RATE);
  });
});

describe('F2 — the one conversion, at the receipt (worked by hand)', () => {
  it('10 sent at 1000 SYP, 10 received, landed 20 SYP, rate 0.000071 → 0.071 JOD a unit; remainder 0.00142 JOD', async () => {
    const m = world();
    await send(m, { exchangeRate: RATE });
    await press(m);
    // The source fell by exactly the cost that left: 10 × 1000 = 10,000 SYP.
    expect(value(m, 'p1')).toBe(0);
    expect(m.data.stockTransferLine[0].costOut).toBe(10000);
    const out = await receive(m, [{ productId: 'p1', quantity: 10, costs: [{ kind: 'TRANSPORT', amount: 20 }] }]);
    // By hand: carried 10,000 SYP + landed 20 SYP = 10,020 SYP; × 0.000071 = 0.71142 JOD; ÷ 10 = 0.071142 → 0.071 (three
    // decimals, half away from zero); remainder 0.71142 − 10 × 0.071 = 0.00142 JOD, booked nowhere.
    const line = m.data.stockTransferLine[0];
    expect(line.unitCostIn).toBe(0.071);
    expect(line.costRemainder).toBeCloseTo(0.00142, 12);
    expect(line.landedCosts).toEqual([{ kind: 'TRANSPORT', amount: 20 }]);
    const [arrived] = batchesOf(m, 'r1');
    expect([arrived.quantityRemaining, arrived.costPerUnit, arrived.warehouseId, arrived.storeId]).toEqual([10, 0.071, 'wJ', 's3']);
    // The destination rose by EXACTLY received × unit = 0.71 JOD.
    expect(value(m, 'r1')).toBeCloseTo(0.71, 12);
    expect(out.transfer.status).toBe('RECEIVED');
    // The ledger line says the rate, and no cost figure.
    const into = m.data.inventoryMovement.find((x) => x.type === 'TRANSFER_IN' && x.productId === 'r1')!;
    expect(into.reason).toContain('بسعر صرف 0.000071: 1 SYP = 0.000071 JOD');
    for (const f of ['10020', '0.71142', '0.071 ', '10000']) expect(into.reason).not.toContain(f);
    // What a cost holder is told after the receipt: the source total and what it became.
    const seen = shownTo(out.transfer, 'u-books', { seesCost: true });
    expect(seen.exchangeRate).toBe(RATE);
    expect(seen.lines[0].converted!.sourceTotal).toBeCloseTo(10020, 9);
    expect(seen.lines[0].converted!.total).toBeCloseTo(0.71142, 12);
    // NEGATIVE: no cost key — the rate yes (it is not a cost), the converted figures no.
    const plain = shownTo(out.transfer, 'u-viewer', {});
    expect(plain.exchangeRate).toBe(RATE);
    expect(plain.lines[0]).not.toHaveProperty('converted');
  });

  it('a shortfall converts per RECEIVED unit: 7 of 10 → (7,000 + 20) × 0.000071 ÷ 7 = 0.071; the missing 3 are 3,000 SYP, reported in the source', async () => {
    const m = world();
    await send(m, { exchangeRate: RATE });
    await press(m);
    const out = await receive(m, [{ productId: 'p1', quantity: 7, costs: [{ kind: 'CUSTOMS', amount: 20 }] }]);
    expect(out.transfer.status).toBe('RECEIVED_WITH_DIFFERENCE');
    const line = m.data.stockTransferLine[0];
    // By hand: 7,020 SYP × 0.000071 = 0.49842 JOD; ÷ 7 = 0.0712028… → 0.071; remainder 0.49842 − 0.497 = 0.00142.
    expect(line.unitCostIn).toBe(0.071);
    expect(line.costRemainder).toBeCloseTo(0.00142, 12);
    expect(batchesOf(m, 'r1')[0].quantityRemaining).toBe(7);
    const seen = shownTo(out.transfer, 'u-books', { seesCost: true });
    expect((seen.lines[0] as { missingValue?: number }).missingValue).toBe(3000);
    expect(seen.lines[0].converted!.sourceTotal).toBeCloseTo(7020, 9);
  });

  it('a landed line is rounded in the SOURCE’s minor unit (SYP, two decimals) before the conversion — never in the destination’s (three)', async () => {
    const m = world();
    await send(m, { exchangeRate: 0.5 });
    await press(m);
    await receive(m, [{ productId: 'p1', quantity: 10, costs: [{ kind: 'OTHER', amount: 20.004, note: 'تخزين' }] }]);
    const line = m.data.stockTransferLine[0];
    // 20.004 SYP → 20.00 SYP (two decimals). In the destination's three decimals it would have stayed 20.004.
    expect(line.landedCosts).toEqual([{ kind: 'OTHER', amount: 20, note: 'تخزين' }]);
    // By hand: (10,000 + 20) × 0.5 = 5,010 JOD; ÷ 10 = 501 JOD a unit, remainder 0.
    expect(line.unitCostIn).toBe(501);
    expect(line.costRemainder).toBe(0);
    // A replay of the same receipt, typed the same way, is the same receipt (the lines compared in the SOURCE's unit).
    const again = await receive(m, [{ productId: 'p1', quantity: 10, costs: [{ kind: 'OTHER', amount: 20.004, note: 'تخزين' }] }]);
    expect(again.replay).toBe(true);
    expect(batchesOf(m, 'r1')).toHaveLength(1);
  });

  it('cancel before the receipt gives the units back in the SOURCE at costOut ÷ sent — no rate involved', async () => {
    const m = world();
    await send(m, { exchangeRate: RATE });
    await press(m);
    await cancel(m);
    const back = batchesOf(m, 'p1').find((b) => b.id !== 'b1')!;
    expect([back.quantityRemaining, back.costPerUnit, back.warehouseId]).toEqual([10, 1000, 'wA']);
    expect(value(m, 'p1')).toBe(10000);
    expect(batchesOf(m, 'r1')).toEqual([]);
  });

  it('the rate goes nowhere near a wallet, an expense or a profit (the memory database throws on those tables)', async () => {
    const m = world();
    await send(m, { exchangeRate: RATE });
    await press(m);
    await receive(m, [{ productId: 'p1', quantity: 10, costs: [{ kind: 'TRANSPORT', amount: 20 }] }]);
    const src = readFileSync(join(__dirname, 'stock-transfer-cost.ts'), 'utf8');
    expect(src).not.toMatch(/from '\.\/(wallet|expense|profit|finance)/);
  });
});

describe('F2 — the pure arithmetic', () => {
  it('needsExchangeRate: only two KNOWN, different codes', () => {
    expect(needsExchangeRate('SYP', 'JOD')).toBe(true);
    expect(needsExchangeRate('JOD', 'JOD')).toBe(false);
    expect(needsExchangeRate(null, 'JOD')).toBe(false);
    expect(needsExchangeRate('SYP', undefined)).toBe(false);
  });

  it('checkExchangeRate refuses what the doors refuse, and convertedArrivalCost refuses a bad rate too', () => {
    expect(checkExchangeRate(1.41, true)).toEqual({ ok: true, rate: 1.41 });
    expect(checkExchangeRate(undefined, false)).toEqual({ ok: true, rate: null });
    for (const bad of [0, -1, Number.NaN, Number.NEGATIVE_INFINITY, '2']) expect(checkExchangeRate(bad, true).ok, String(bad)).toBe(false);
    const r = convertedArrivalCost({ costOut: 10, sent: 1, received: 1, landed: [], rate: 0, sourceMinorUnit: 2, minorUnit: 2 });
    expect(r.ok).toBe(false);
  });

  it('a rate of 1 with the same minor unit costs exactly what arrivalCost costs (one formula, one more multiplication)', () => {
    for (const minorUnit of [0, 2, 3]) {
      for (const [costOut, sent, received] of [[13 * 2.3333, 13, 13], [100, 7, 3], [0.5, 2, 1], [12345.678, 40, 39]] as const) {
        const landed = normalizeLanded([{ kind: 'TRANSPORT', amount: 1.2345 }], minorUnit);
        const a = arrivalCost({ costOut, sent, received, landed, minorUnit, zeroCostReason: 'هدية من المورد' });
        const b = convertedArrivalCost({ costOut, sent, received, landed, rate: 1, sourceMinorUnit: minorUnit, minorUnit, zeroCostReason: 'هدية من المورد' });
        expect(b.ok && a.ok && [b.unitCost, b.remainder]).toEqual(a.ok && [a.unitCost, a.remainder]);
      }
    }
  });

  it('5,000 random cases at minor units 0 / 2 / 3: the unit is on the grid, the parts add up, |remainder| ≤ received × half a destination minor unit; exact halves go away from zero', () => {
    let s = 7;
    const r = () => ((s = (s * 1103515245 + 12345) % 2147483648) / 2147483648);
    const int = (lo: number, hi: number) => lo + Math.floor(r() * (hi - lo + 1));
    let halves = 0;
    for (let i = 0; i < 5000; i++) {
      const minorUnit = [0, 2, 3][i % 3];
      const sourceMinorUnit = [0, 2, 3][int(0, 2)];
      const step = 10 ** -minorUnit;
      if (i % 5 === 0) {
        // AN EXACT HALF, built by hand: unit before rounding = (2k + 1) × half a step, with a binary-exact step for 2 and 3
        // decimals (1/8 and 1/16 — 12.5 and 62.5 of the grid), a rate that is a power of two, and nothing landed.
        const k = int(0, 500);
        const exact = minorUnit === 0 ? k + 0.5 : minorUnit === 2 ? (2 * k + 1) / 8 : (2 * k + 1) / 16;
        const n = int(1, 30);
        const rate = [0.5, 1, 2, 4][int(0, 3)];
        const got = convertedArrivalCost({ costOut: (exact * n) / rate, sent: n, received: n, landed: [], rate, sourceMinorUnit, minorUnit });
        expect(got.ok).toBe(true);
        if (!got.ok) continue;
        // Half away from zero, written out: the grid point just above.
        const scaled = exact * 10 ** minorUnit;
        expect(got.unitCost, `half ${exact} @${minorUnit}`).toBeCloseTo((Math.floor(scaled) + 1) / 10 ** minorUnit, 12);
        halves++;
        continue;
      }
      const sent = int(1, 60);
      const received = int(1, sent);
      const costOut = Math.round(r() * 1e8) / [1, 100, 10000][int(0, 2)];
      const rate = [r() * 0.001, r() * 2, r() * 20000][int(0, 2)] || 0.5;
      const landed = normalizeLanded(
        Array.from({ length: int(0, 3) }, () => ({ kind: 'CUSTOMS' as const, amount: Math.round(r() * 1e6) / [1, 10, 1000][int(0, 2)] })),
        sourceMinorUnit
      );
      const got = convertedArrivalCost({ costOut, sent, received, landed, rate, sourceMinorUnit, minorUnit, zeroCostReason: 'هدية من المورد' });
      expect(got.ok).toBe(true);
      if (!got.ok) continue;
      // Every landed line sits on the SOURCE's grid.
      for (const l of landed) expect(Math.abs(l.amount * 10 ** sourceMinorUnit - Math.round(l.amount * 10 ** sourceMinorUnit))).toBeLessThan(1e-6);
      // Written out by hand, not read from the function: what arrived at the cost that left, plus the lines, × the rate.
      const total = ((costOut * received) / sent + landed.reduce((t, l) => t + l.amount, 0)) * rate;
      const tol = 1e-9 * Math.max(1, Math.abs(total));
      const onGrid = got.unitCost * 10 ** minorUnit;
      expect(Math.abs(onGrid - Math.round(onGrid))).toBeLessThan(1e-9 * Math.max(1, Math.abs(onGrid)));
      expect(Math.abs(received * got.unitCost + got.remainder - total)).toBeLessThan(tol);
      expect(Math.abs(got.remainder)).toBeLessThanOrEqual(received * (step / 2) + tol);
    }
    expect(halves).toBe(1000);
  });
});

describe('F2 review — how the rate is said (exchange-rate-words)', () => {
  it('fixed decimals, never an exponent, no trailing zeros', () => {
    expect([rateText(0.000071), rateText(1e-7), rateText(1.41), rateText(14000), rateText(1 / 0.000071)]).toEqual([
      '0.000071',
      '0.0000001',
      '1.41',
      '14000',
      '14084.507042',
    ]);
    expect(rateWords(1e-7, { fromCode: 'SYP', toCode: 'JOD' })).toBe('بسعر صرف 0.0000001: 1 SYP = 0.0000001 JOD');
  });

  it('the mirror says the rate the other way round', () => {
    expect(rateMirror(0.000071, 'SYP', 'JOD')).toBe('يعني 1 JOD = 14084.507042 SYP');
    expect(rateMirror(14000, 'SYP', 'JOD')).toBe('يعني 1 JOD = 0.0000714286 SYP');
  });

  it('a WARNING when the rate is over 1000× off the usual order — the upside-down rate is caught; NEGATIVE: a near rate, or an unknown order', () => {
    const usual = 0.71 / 13000; // JOD per 1 SYP, the order only
    expect(rateLooksOff(0.000071, usual)).toBe(false);
    expect(rateLooksOff(14000, usual)).toBe(true);
    expect(rateLooksOff(usual / 2000, usual)).toBe(true);
    expect(rateLooksOff(usual * 999, usual)).toBe(false);
    expect(rateLooksOff(14000, null)).toBe(false);
  });

  it('the ledger note of a receipt uses fixed decimals too (a rate of 1e-7)', async () => {
    const m = world();
    await send(m, { exchangeRate: 1e-7 });
    await press(m);
    await receive(m, [{ productId: 'p1', quantity: 10, zeroCostReason: 'هدية من المورد' }]);
    const into = m.data.inventoryMovement.find((x) => x.type === 'TRANSFER_IN' && x.productId === 'r1')!;
    expect(into.reason).toContain('بسعر صرف 0.0000001: 1 SYP = 0.0000001 JOD');
    expect(into.reason).not.toMatch(/e-/);
  });
});
