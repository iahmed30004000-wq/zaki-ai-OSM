import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * A LINK A PERSON MADE HOLDS ITS ORDER AGAINST EVERY OTHER STATEMENT — THE OLDER ONES TOO.
 *
 * The matcher flags a line whose order «another statement» already names, but only counts a statement that is
 * approved or was imported BEFORE the one being matched (otherwise matching A would flag B's order and matching
 * B would flag A's, and whichever was re-run first would lose its answers for no fault of its own).
 *
 * That rule has a hole for a hand link: the person links a line of the NEWER statement A to order O, and the
 * OLDER statement B — whose own line for O merely disagreed, so it never took the order — is matched again.
 * B is older, so A did not count, and B's line matched O cleanly: two statements pay one order. A link is a
 * decision about this very order, so it holds it whatever the import dates say. A row that merely disagreed
 * still holds nothing, and an automatic row on a newer statement is still not counted.
 *
 * The rows are held by a fake that APPLIES the matcher's own `where` (so the answer comes from the query).
 */

type Row = Record<string, any>;
const { db, rows } = vi.hoisted(() => {
  const rows: { matches: Row[] } = { matches: [] };
  /** The few shapes the matcher asks: equality, in, not, lt, OR, AND and a relation filter. */
  const fits = (row: Row, where: Row): boolean =>
    Object.entries(where).every(([key, want]) => {
      if (key === 'OR') return (want as Row[]).some((w) => fits(row, w));
      if (key === 'AND') return (want as Row[]).every((w) => fits(row, w));
      const have = row[key];
      if (want !== null && typeof want === 'object' && !(want instanceof Date)) {
        const w = want as Row;
        if ('in' in w) return (w.in as unknown[]).includes(have);
        if ('not' in w) return (have ?? null) !== w.not;
        if ('lt' in w) return have < w.lt;
        return have && typeof have === 'object' ? fits(have, w) : false;
      }
      return (have ?? null) === want;
    });
  const db = {
    statementLine: { findMany: vi.fn() },
    courierStatement: { findFirst: vi.fn() },
    settlementMatch: {
      deleteMany: vi.fn(),
      create: vi.fn(),
      findMany: vi.fn(async ({ where }: { where: Row }) => rows.matches.filter((m) => fits(m, where))),
    },
    orderChangeRequest: { findMany: vi.fn() },
    order: { findFirst: vi.fn(), findMany: vi.fn() },
  };
  return { db, rows };
});
vi.mock('./db', () => ({ db }));

import { runMatching } from './settlement';

const B = { id: 'stB', deliveryProviderId: 'dp1', periodFrom: null, periodTo: null, createdAt: new Date('2026-10-10T00:00:00Z') };
const scope = { companyId: 'c1', storeId: 's1', statementId: 'stB', minorUnit: 3 };

const orderO = {
  id: 'o1', shippingStatus: 'DELIVERED', settlementStatus: 'PENDING', totalAmount: 12, priceIncludesDelivery: false,
  collectedAmount: null, deliveryFee: 0, returnReceipt: null, addOns: [],
  items: [{ quantity: 1, freeQuantity: 0, unitPrice: 12, discountShare: 0, lineTotal: 12, deliveredQty: null }],
};

/** A row of statement A: newer than B (imported 20/10), not approved. */
const rowOfA = (over: Row = {}): Row => ({
  companyId: 'c1', statementId: 'stA', statementLineId: 'lA', orderId: 'o1', result: 'MATCHED', matchedBy: 'MANUAL', resolution: null,
  statement: { reference: 'ST-A', approvedAt: null, createdAt: new Date('2026-10-20T00:00:00Z') },
  ...over,
});

const created = () => db.settlementMatch.create.mock.calls.map((c) => c[0].data);

beforeEach(() => {
  vi.clearAllMocks();
  rows.matches = [];
  db.settlementMatch.create.mockResolvedValue({});
  db.settlementMatch.deleteMany.mockResolvedValue({ count: 0 });
  db.orderChangeRequest.findMany.mockResolvedValue([]);
  db.order.findMany.mockResolvedValue([]);
  db.order.findFirst.mockResolvedValue(orderO);
  db.courierStatement.findFirst.mockResolvedValue(B);
  // B's own line for O: the figures agree, so on its own it would be MATCHED.
  db.statementLine.findMany.mockResolvedValue([{ id: 'lB', merchantRef: 'REF-1', barcode: null, amount: 12, fee: null, status: null }]);
});

describe('matching the OLDER statement again, after a newer one was linked by hand', () => {
  it('flags the line: «الطلب مذكور بكشف آخر» naming the newer statement', async () => {
    rows.matches = [rowOfA()];
    const outcome = await runMatching(db as never, scope);

    expect(outcome).toMatchObject({ matched: 0, mismatched: 1 });
    expect(created()[0]).toMatchObject({ result: 'MISMATCHED', orderId: 'o1' });
    expect(created()[0].note).toContain('ST-A');
  });

  it('also when the link was decided «اعتُمد رقم الشركة» (an accepted figure settles the order at approval)', async () => {
    rows.matches = [rowOfA({ result: 'MISMATCHED', resolution: 'ACCEPTED_COURIER' })];
    await runMatching(db as never, scope);
    expect(created()[0].result).toBe('MISMATCHED');
    expect(created()[0].note).toContain('ST-A');
  });

  it('but a link that only DISAGREED holds nothing — the older statement’s right line still matches', async () => {
    rows.matches = [rowOfA({ result: 'MISMATCHED', resolution: null })];
    await runMatching(db as never, scope);
    expect(created()[0]).toMatchObject({ result: 'MATCHED', note: null });
  });

  it('and an AUTOMATIC row on the newer statement is still not counted (the rule that stops flagging both ways)', async () => {
    rows.matches = [rowOfA({ matchedBy: 'MERCHANT_REF' })];
    await runMatching(db as never, scope);
    expect(created()[0]).toMatchObject({ result: 'MATCHED', note: null });
  });

  it('while an automatic row on an OLDER statement still is', async () => {
    rows.matches = [
      rowOfA({ matchedBy: 'BARCODE', statement: { reference: 'ST-0', approvedAt: null, createdAt: new Date('2026-10-01T00:00:00Z') } }),
    ];
    await runMatching(db as never, scope);
    expect(created()[0].result).toBe('MISMATCHED');
    expect(created()[0].note).toContain('ST-0');
  });

  it('the link on THIS statement is not «another statement»', async () => {
    rows.matches = [rowOfA({ statementId: 'stB', statement: { reference: 'ST-B', approvedAt: null, createdAt: B.createdAt } })];
    await runMatching(db as never, scope);
    // (it is the kept row: its line is not resolved a second time and nothing is created for it)
    expect(created().filter((r) => r.result === 'MISMATCHED' && String(r.note).includes('ST-B'))).toEqual([]);
  });
});
