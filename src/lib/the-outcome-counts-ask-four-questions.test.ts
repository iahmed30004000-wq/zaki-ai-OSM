import { describe, expect, it } from 'vitest';
import type { Prisma } from '@prisma/client';
import { countOutcomes, OUTCOME_CLOSED, OUTCOME_LABEL_AR, OUTCOMES, orderOutcome, type Outcome } from './order-outcome';
import { receiptNothingCameBackWhere } from './written-off';

/**
 * ═══════════════════════════════════════════════════════════════════════
 * «WHERE DID MY ORDERS GO» ASKS THE DATABASE FOUR QUESTIONS, NOT ONE PLUS THREE FOR EVERY GROUP (13/11 — plan PR-7, item 4).
 *
 * `countOutcomes` read one GROUP BY, then — for each group whose answer depends on the return receipt — three counts, one group
 * after the other: 1 + 3G statements on every dashboard opening (G is the number of distinct (confirmation, shipping, settlement,
 * rejection) combinations that are coming back or part-delivered: dozens on a shop with a history). It reads the same four columns
 * three more times now, each with one of the three receipt questions, and looks the numbers up inside the same loop. INTEGERS ONLY
 * — nothing here is money.
 *
 * What is held: the answer is the very answer the old function gave, on a fake database that evaluates the same `where`s over rows
 * (a differential, not a pair of mocks), and the statement count is four at most — one when no group depends on a receipt.
 * ═══════════════════════════════════════════════════════════════════════
 */

// ───────────────────────── THE OLD FUNCTION, copied word for word from the commit before the change ─────────────────────────

const COMING_BACK = ['FAILED_DELIVERY', 'RETURN_REQUESTED', 'RETURNED'];

type Db = {
  order: {
    groupBy: (args: any) => Promise<any[]>;
    count: (args: { where: Prisma.OrderWhereInput }) => Promise<number>;
  };
};

async function countOutcomesOld(
  db: Db,
  scope: { companyId: string; storeId?: string | null }
): Promise<{ total: number; outcomes: { key: Outcome; label: string; count: number; closed: boolean }[] }> {
  const base: Prisma.OrderWhereInput = { companyId: scope.companyId, ...(scope.storeId ? { storeId: scope.storeId } : {}) };
  const groups = await db.order.groupBy({
    by: ['confirmationStatus', 'shippingStatus', 'settlementStatus', 'rejectionReason'],
    where: base,
    _count: { _all: true },
  });

  const counts = new Map<Outcome, number>();
  const add = (k: Outcome, n: number) => counts.set(k, (counts.get(k) ?? 0) + n);
  let total = 0;

  for (const g of groups) {
    const n: number = g._count._all;
    total += n;
    const src = {
      confirmationStatus: g.confirmationStatus,
      shippingStatus: g.shippingStatus,
      settlementStatus: g.settlementStatus,
      rejectionReason: g.rejectionReason,
    };
    if (COMING_BACK.includes(g.shippingStatus) || g.shippingStatus === 'PARTIALLY_DELIVERED') {
      const where = { ...base, ...src };
      const [lostCount, noFeeAll, fee] = await Promise.all([
        db.order.count({ where: { ...where, returnReceipt: { is: { courierFeeCharged: false, ...receiptNothingCameBackWhere() } } } }),
        db.order.count({ where: { ...where, returnReceipt: { is: { courierFeeCharged: false } } } }),
        db.order.count({ where: { ...where, returnReceipt: { is: { courierFeeCharged: true } } } }),
      ]);
      const noFee = noFeeAll - lostCount;
      const none = n - noFeeAll - fee;
      if (none) add(orderOutcome({ ...src, returnReceipt: null }), none);
      if (lostCount) add(orderOutcome({ ...src, returnReceipt: { courierFeeCharged: false, receivedQty: 0, damagedQty: 0, missingQty: 1 } }), lostCount);
      if (noFee) add(orderOutcome({ ...src, returnReceipt: { courierFeeCharged: false } }), noFee);
      if (fee) add(orderOutcome({ ...src, returnReceipt: { courierFeeCharged: true } }), fee);
    } else {
      add(orderOutcome(src), n);
    }
  }

  return {
    total,
    outcomes: OUTCOMES.filter((k) => counts.has(k)).map((k) => ({
      key: k,
      label: OUTCOME_LABEL_AR[k],
      count: counts.get(k) ?? 0,
      closed: OUTCOME_CLOSED[k],
    })),
  };
}

// ───────────────────────── A DATABASE THAT EVALUATES THE `where`s OVER ROWS ─────────────────────────

interface Row {
  companyId: string;
  storeId: string;
  confirmationStatus: string;
  shippingStatus: string;
  settlementStatus: string;
  rejectionReason: string | null;
  receipt: null | { courierFeeCharged: boolean; receivedQty: number; damagedQty: number; missingQty: number };
}

function receiptMatches(receipt: NonNullable<Row['receipt']>, cond: Record<string, unknown>): boolean {
  for (const [key, want] of Object.entries(cond)) {
    const have = (receipt as unknown as Record<string, number | boolean>)[key];
    if (want && typeof want === 'object' && 'gt' in want) {
      if (!((have as number) > (want as { gt: number }).gt)) return false;
    } else if (have !== want) {
      return false;
    }
  }
  return true;
}

function rowMatches(row: Row, where: Record<string, unknown>): boolean {
  for (const [key, want] of Object.entries(where)) {
    if (key === 'returnReceipt') {
      if (!row.receipt) return false; // `is` needs a receipt to exist
      if (!receiptMatches(row.receipt, (want as { is: Record<string, unknown> }).is)) return false;
    } else if ((row as unknown as Record<string, unknown>)[key] !== want) {
      return false;
    }
  }
  return true;
}

function fakeDb(rows: Row[]) {
  const calls = { groupBy: 0, count: 0, wheres: [] as unknown[] };
  const db: Db = {
    order: {
      groupBy: async ({ by, where }: { by: string[]; where: Record<string, unknown> }) => {
        calls.groupBy += 1;
        calls.wheres.push(where);
        const groups = new Map<string, Record<string, unknown>>();
        for (const row of rows) {
          if (!rowMatches(row, where)) continue;
          const keyed = Object.fromEntries(by.map((c) => [c, (row as unknown as Record<string, unknown>)[c]]));
          const k = JSON.stringify(by.map((c) => keyed[c]));
          const g = groups.get(k) ?? { ...keyed, _count: { _all: 0 } };
          (g._count as { _all: number })._all += 1;
          groups.set(k, g);
        }
        return [...groups.values()];
      },
      count: async ({ where }: { where: Record<string, unknown> }) => {
        calls.count += 1;
        return rows.filter((row) => rowMatches(row, where)).length;
      },
    },
  };
  return { db, calls };
}

// ───────────────────────── SEEDED FIXTURES ─────────────────────────

function rng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

const CONFIRMATION = ['NEW', 'CONFIRMED', 'POSTPONED', 'REJECTED', 'NO_ANSWER'];
const SHIPPING = ['NOT_READY', 'READY', 'SHIPPED', 'DELIVERED', 'PARTIALLY_DELIVERED', 'FAILED_DELIVERY', 'RETURN_REQUESTED', 'RETURNED', 'CANCELLED'];
const SETTLEMENT = ['NOT_APPLICABLE', 'PENDING', 'SETTLED', 'COLLECTED', 'CANCELLED'];
const REJECTION = [null, null, 'DUPLICATE_ORDER', 'CUSTOMER_DECLINED'];

function fixture(seed: number, size = 400): Row[] {
  const next = rng(seed);
  const pick = <T,>(list: T[]) => list[Math.floor(next() * list.length)];
  const rows: Row[] = [];
  for (let i = 0; i < size; i++) {
    const shippingStatus = pick(SHIPPING);
    const comesBack = COMING_BACK.includes(shippingStatus) || shippingStatus === 'PARTIALLY_DELIVERED';
    // most coming-back orders have a receipt, a third do not; a few that are NOT coming back carry one too (it must be ignored)
    const hasReceipt = comesBack ? next() < 0.7 : next() < 0.05;
    const received = Math.floor(next() * 3);
    rows.push({
      companyId: next() < 0.9 ? 'c1' : 'c2',
      storeId: next() < 0.8 ? 's1' : 's2',
      confirmationStatus: pick(CONFIRMATION),
      shippingStatus,
      settlementStatus: pick(SETTLEMENT),
      rejectionReason: pick(REJECTION),
      receipt: hasReceipt
        ? {
            courierFeeCharged: next() < 0.4,
            // a loss (0,0,>0), a return that came back, a receipt that expected nothing (missing 0), damage only
            receivedQty: received,
            damagedQty: next() < 0.3 ? 1 : 0,
            missingQty: next() < 0.5 ? Math.floor(next() * 4) : 0,
          }
        : null,
    });
  }
  return rows;
}

const SCOPES = [{ companyId: 'c1', storeId: 's1' }, { companyId: 'c1' }, { companyId: 'c2', storeId: 's2' }, { companyId: 'c9' }];

// ───────────────────────── THE TESTS ─────────────────────────

describe('the answer is the answer the old function gave', () => {
  it('on 30 seeded shops of 400 orders each, for four different scopes: not one difference', async () => {
    const different: unknown[] = [];
    let nonEmptyReturns = 0;
    for (let seed = 1; seed <= 30; seed++) {
      const rows = fixture(seed * 7919);
      for (const scope of SCOPES) {
        const old = await countOutcomesOld(fakeDb(rows).db, scope);
        const now = await countOutcomes(fakeDb(rows).db, scope);
        if (JSON.stringify(old) !== JSON.stringify(now)) different.push({ seed, scope, old, now });
        expect(now).toEqual(old);
        if (now.outcomes.some((o) => o.key === 'LOST_AFTER_SHIPPING_CLOSED' || o.key === 'RETURNED_FEE_CLOSED')) nonEmptyReturns++;
      }
    }
    expect(different).toEqual([]);
    expect(nonEmptyReturns, 'الفحص ما غطّى حالات المرتجع — ما بيثبت شي').toBeGreaterThan(60);
  });

  it('and the outcomes still add up to every order of the scope', async () => {
    const rows = fixture(4242);
    const r = await countOutcomes(fakeDb(rows).db, { companyId: 'c1', storeId: 's1' });
    expect(r.outcomes.reduce((s, o) => s + o.count, 0)).toBe(r.total);
    expect(r.total).toBe(rows.filter((x) => x.companyId === 'c1' && x.storeId === 's1').length);
  });
});

describe('four statements, however many groups', () => {
  it('four at most on a shop with a long history — the old function asked one plus three for every group that depends on a receipt', async () => {
    const rows = fixture(777, 2_000);
    const scope = { companyId: 'c1', storeId: 's1' };
    const old = fakeDb(rows);
    const now = fakeDb(rows);
    await countOutcomesOld(old.db, scope);
    await countOutcomes(now.db, scope);
    expect(now.calls.groupBy + now.calls.count, 'كل بنود الفحص لازم ≤ 4').toBeLessThanOrEqual(4);
    expect(now.calls.count, 'ما عاد في عدّ لكل مجموعة').toBe(0);
    expect(old.calls.groupBy + old.calls.count, 'القديمة كانت أكتر بكتير — الفحص ما بيقيس شي').toBeGreaterThan(20);
  });

  it('ONE statement when no group depends on a receipt (nothing is coming back)', async () => {
    const rows = fixture(31, 300).filter((r) => !COMING_BACK.includes(r.shippingStatus) && r.shippingStatus !== 'PARTIALLY_DELIVERED');
    const now = fakeDb(rows);
    await countOutcomes(now.db, { companyId: 'c1', storeId: 's1' });
    expect(now.calls.groupBy).toBe(1);
  });

  it('the three receipt questions ride the SAME scope as the first read — never a wider one', async () => {
    const now = fakeDb(fixture(99));
    await countOutcomes(now.db, { companyId: 'c1', storeId: 's1' });
    expect(now.calls.wheres.length).toBe(4);
    for (const where of now.calls.wheres as Array<Record<string, unknown>>) {
      expect(where.companyId).toBe('c1');
      expect(where.storeId).toBe('s1');
    }
  });

  it('a group with no rejection reason finds its own count — null is a key, not a miss', async () => {
    const rows: Row[] = [
      { companyId: 'c1', storeId: 's1', confirmationStatus: 'CONFIRMED', shippingStatus: 'RETURNED', settlementStatus: 'NOT_APPLICABLE', rejectionReason: null, receipt: { courierFeeCharged: true, receivedQty: 1, damagedQty: 0, missingQty: 0 } },
      { companyId: 'c1', storeId: 's1', confirmationStatus: 'CONFIRMED', shippingStatus: 'RETURNED', settlementStatus: 'NOT_APPLICABLE', rejectionReason: 'DUPLICATE_ORDER', receipt: { courierFeeCharged: false, receivedQty: 0, damagedQty: 0, missingQty: 2 } },
      { companyId: 'c1', storeId: 's1', confirmationStatus: 'CONFIRMED', shippingStatus: 'RETURNED', settlementStatus: 'NOT_APPLICABLE', rejectionReason: null, receipt: null },
    ];
    const r = await countOutcomes(fakeDb(rows).db, { companyId: 'c1', storeId: 's1' });
    const by = Object.fromEntries(r.outcomes.map((o) => [o.key, o.count]));
    expect(by).toEqual(Object.fromEntries((await countOutcomesOld(fakeDb(rows).db, { companyId: 'c1', storeId: 's1' })).outcomes.map((o) => [o.key, o.count])));
    expect(by.RETURNED_FEE_CLOSED).toBe(1);
    expect(by.RETURN_AWAITING).toBe(1);
  });
});
