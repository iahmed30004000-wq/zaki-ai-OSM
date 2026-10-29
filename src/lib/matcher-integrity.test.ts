import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * THE MATCHER KEEPS ITS INTEGRITY.
 *
 * Four things the matcher got wrong, each pinned with the case that breaks it AND the ordinary case that must not
 * be touched:
 *   6 · a line naming an order already SETTLED (by hand) is not matched again;
 *   7 · an order with an open cancel or postpone request is never matched by itself;
 *   9 · running matching again keeps what a person decided or linked, and an order named twice is flagged
 *       (the approval's promotion of a failed attempt, item 8, is pinned in finance-gates.test.ts).
 */

const { db } = vi.hoisted(() => ({
  db: {
    statementLine: { findMany: vi.fn() },
    courierStatement: { findFirst: vi.fn() },
    settlementMatch: { deleteMany: vi.fn(), create: vi.fn(), findMany: vi.fn() },
    orderChangeRequest: { findMany: vi.fn() },
    order: { findFirst: vi.fn(), findMany: vi.fn() },
  },
}));
vi.mock('./db', () => ({ db }));

import { runMatching } from './settlement';
import { HAND_COLLECTED_NOTE, SAME_FILE_NOTE, integrityNotes, openRequestWhere } from './match-integrity';

const scope = { companyId: 'c1', storeId: 's1', statementId: 'st1', minorUnit: 3 };

const orderRow = (over: Record<string, unknown>) => ({
  id: 'o1',
  shippingStatus: 'DELIVERED',
  settlementStatus: 'PENDING',
  totalAmount: 12,
  priceIncludesDelivery: false,
  collectedAmount: null,
  deliveryFee: 0,
  returnReceipt: null,
  addOns: [],
  items: [{
    quantity: 1, freeQuantity: 0, unitPrice: Number(over.totalAmount ?? 12),
    discountShare: 0, lineTotal: Number(over.totalAmount ?? 12), deliveredQty: null,
  }],
  ...over,
});

const line = (over: Record<string, unknown> = {}) => ({ id: 'l1', merchantRef: 'REF-1', barcode: null, amount: 12, fee: null, ...over });
const created = () => db.settlementMatch.create.mock.calls.map((c) => c[0].data);

beforeEach(() => {
  vi.clearAllMocks();
  db.settlementMatch.create.mockResolvedValue({});
  db.settlementMatch.deleteMany.mockResolvedValue({ count: 0 });
  db.settlementMatch.findMany.mockResolvedValue([]);
  db.orderChangeRequest.findMany.mockResolvedValue([]);
  db.order.findMany.mockResolvedValue([]);
  db.courierStatement.findFirst.mockResolvedValue({
    id: 'st1', deliveryProviderId: 'dp1', periodFrom: null, periodTo: null, createdAt: new Date('2026-10-20T00:00:00Z'),
  });
});

describe('6 · a line that names an order already collected by hand', () => {
  it('is MISMATCHED with «حُصّل يدوياً», even when the figures agree to the fils', async () => {
    db.statementLine.findMany.mockResolvedValue([line()]);
    db.order.findFirst.mockResolvedValue(orderRow({ settlementStatus: 'SETTLED' }));

    const outcome = await runMatching(db as never, scope);

    expect(outcome).toMatchObject({ matched: 0, mismatched: 1 });
    const row = created()[0];
    expect(row).toMatchObject({ result: 'MISMATCHED', orderId: 'o1', difference: 0 });
    expect(row.note).toContain('حُصّل يدوياً');
  });

  it('and an order not yet settled is matched as before', async () => {
    db.statementLine.findMany.mockResolvedValue([line()]);
    db.order.findFirst.mockResolvedValue(orderRow({ settlementStatus: 'PENDING' }));

    const outcome = await runMatching(db as never, scope);

    expect(outcome).toMatchObject({ matched: 1, mismatched: 0 });
    expect(created()[0]).toMatchObject({ result: 'MATCHED', note: null });
  });

  it('settled by an APPROVED earlier statement says that, not «by hand»', async () => {
    db.statementLine.findMany.mockResolvedValue([line()]);
    db.order.findFirst.mockResolvedValue(orderRow({ settlementStatus: 'SETTLED' }));
    db.settlementMatch.findMany.mockImplementation(async (args: any) =>
      args.where.orderId ? [{ orderId: 'o1', statement: { reference: 'ST-OLD', approvedAt: new Date('2026-10-01') } }] : []
    );

    await runMatching(db as never, scope);

    const row = created()[0];
    expect(row.result).toBe('MISMATCHED');
    expect(row.note).toContain('ST-OLD');
    expect(row.note).not.toContain('حُصّل يدوياً');
  });

  it('keeps the fils in a three-place currency: 12.345 against 12.345 is still refused when settled', async () => {
    db.statementLine.findMany.mockResolvedValue([line({ amount: 12.345 })]);
    db.order.findFirst.mockResolvedValue(orderRow({ totalAmount: 12.345, settlementStatus: 'SETTLED' }));

    await runMatching(db as never, scope);

    expect(created()[0]).toMatchObject({ result: 'MISMATCHED', expectedAmount: 12.345, statementAmount: 12.345, difference: 0 });
  });

  it('asks for the settlement state of the order it found — by barcode and by reference alike', async () => {
    db.statementLine.findMany.mockResolvedValue([line({ barcode: 'BC1' })]);
    db.order.findFirst.mockResolvedValue(null);
    await runMatching(db as never, scope);
    for (const call of db.order.findFirst.mock.calls) {
      expect(call[0].select.settlementStatus).toBe(true);
    }
  });
});

describe('7 · an order with an open cancel or postpone request', () => {
  it('is never matched by itself: MISMATCHED, and the note names the reason', async () => {
    db.statementLine.findMany.mockResolvedValue([line()]);
    db.order.findFirst.mockResolvedValue(orderRow({}));
    db.orderChangeRequest.findMany.mockResolvedValue([{ orderId: 'o1', intent: 'CANCEL' }]);

    const outcome = await runMatching(db as never, scope);

    expect(outcome).toMatchObject({ matched: 0, mismatched: 1 });
    expect(created()[0].result).toBe('MISMATCHED');
    expect(created()[0].note).toContain('طلب إلغاء مفتوح');
  });

  it('a postponement is named as a postponement', async () => {
    db.statementLine.findMany.mockResolvedValue([line()]);
    db.order.findFirst.mockResolvedValue(orderRow({}));
    db.orderChangeRequest.findMany.mockResolvedValue([{ orderId: 'o1', intent: 'POSTPONE' }]);

    await runMatching(db as never, scope);

    expect(created()[0].note).toContain('طلب تأجيل مفتوح');
  });

  it('asks only for CANCEL and POSTPONE that are still open — an edit, or an answered and applied one, does not count', async () => {
    const where = openRequestWhere();
    expect(where.intent).toEqual({ in: ['CANCEL', 'POSTPONE'] });
    expect(where.OR).toEqual([{ status: 'PENDING' }, { status: 'APPROVED', appliedAt: null }]);

    db.statementLine.findMany.mockResolvedValue([line()]);
    db.order.findFirst.mockResolvedValue(orderRow({}));
    await runMatching(db as never, scope);
    expect(db.orderChangeRequest.findMany.mock.calls[0][0].where).toMatchObject({ companyId: 'c1', ...where });
  });

  it('an order with no request at all (no receipt either) is matched as before', async () => {
    db.statementLine.findMany.mockResolvedValue([line()]);
    db.order.findFirst.mockResolvedValue(orderRow({}));

    const outcome = await runMatching(db as never, scope);

    expect(outcome.matched).toBe(1);
    expect(created()[0]).toMatchObject({ result: 'MATCHED', note: null });
  });

  it('a request on ANOTHER order does not touch this one', async () => {
    db.statementLine.findMany.mockResolvedValue([line()]);
    db.order.findFirst.mockResolvedValue(orderRow({}));
    db.orderChangeRequest.findMany.mockResolvedValue([{ orderId: 'someone-else', intent: 'CANCEL' }]);

    const outcome = await runMatching(db as never, scope);

    expect(outcome.matched).toBe(1);
  });
});

describe('9 · matching again keeps the answers', () => {
  it('deletes only automatic rows nobody decided — never a MANUAL one, never one with a resolution', async () => {
    db.statementLine.findMany.mockResolvedValue([]);
    await runMatching(db as never, scope);

    const where = db.settlementMatch.deleteMany.mock.calls[0][0].where;
    expect(where.statementId).toBe('st1');
    expect(where.resolution).toBeNull();
    // `not: 'MANUAL'` alone drops the rows whose matchedBy is NULL (the sweep, the unmatched): both are named.
    expect(where.OR).toEqual([{ matchedBy: null }, { matchedBy: { not: 'MANUAL' } }]);
  });

  it('does not match a line again when a kept answer already holds it, and counts the answer', async () => {
    db.statementLine.findMany.mockResolvedValue([line({ id: 'l1' }), line({ id: 'l2', merchantRef: 'REF-2' })]);
    // l1 was decided «اعتُمد رقم الشركة» last time and survived the delete.
    db.settlementMatch.findMany.mockImplementation(async (args: any) =>
      args.where.statementId === 'st1' && !args.where.orderId
        ? [{ statementLineId: 'l1', orderId: 'o1', result: 'MISMATCHED' }]
        : []
    );
    db.order.findFirst.mockResolvedValue(orderRow({ id: 'o2' }));

    const outcome = await runMatching(db as never, scope);

    // Only l2 was looked up and written.
    expect(db.order.findFirst).toHaveBeenCalledTimes(1);
    expect(db.order.findFirst.mock.calls[0][0].where.merchantRef).toBe('REF-2');
    expect(created()).toHaveLength(1);
    expect(created()[0].statementLineId).toBe('l2');
    expect(outcome).toMatchObject({ matched: 1, mismatched: 1, kept: 1 });
  });

  it('a kept order is not swept as «missing» and not matched a second time by another line', async () => {
    db.statementLine.findMany.mockResolvedValue([line({ id: 'l2', merchantRef: 'REF-1' })]);
    db.settlementMatch.findMany.mockImplementation(async (args: any) =>
      args.where.statementId === 'st1' && !args.where.orderId
        ? [{ statementLineId: 'l1', orderId: 'o1', result: 'MATCHED' }]
        : []
    );
    db.order.findFirst.mockResolvedValue(orderRow({ id: 'o1' }));
    db.order.findMany.mockResolvedValue([orderRow({ id: 'o1', trackingNumber: null, merchantRef: 'REF-1' })]);

    await runMatching(db as never, scope);

    // The new line names an order a kept row already holds: flagged, not matched.
    expect(created()[0]).toMatchObject({ result: 'MISMATCHED' });
    expect(created()[0].note).toContain(SAME_FILE_NOTE);
    // And the sweep wrote no MISSING row for it.
    expect(created().some((r) => r.result === 'MISSING_IN_STATEMENT')).toBe(false);
  });

  it('with nothing kept, runs exactly as before and reports no kept count', async () => {
    db.statementLine.findMany.mockResolvedValue([line()]);
    db.order.findFirst.mockResolvedValue(orderRow({}));

    const outcome = await runMatching(db as never, scope);

    expect(outcome.kept).toBeUndefined();
    expect(outcome.matched).toBe(1);
  });
});

describe('9 · an order named twice', () => {
  it('keeps the verdict of the FIRST line and flags the second as MISMATCHED, so only one can ever settle it', async () => {
    db.statementLine.findMany.mockResolvedValue([line({ id: 'l1' }), line({ id: 'l2' })]);
    db.order.findFirst.mockResolvedValue(orderRow({}));

    const outcome = await runMatching(db as never, scope);

    const [first, second] = created();
    expect(first).toMatchObject({ statementLineId: 'l1', result: 'MATCHED', note: null });
    expect(second).toMatchObject({ statementLineId: 'l2', result: 'MISMATCHED' });
    expect(second.note).toContain(SAME_FILE_NOTE);
    expect(outcome).toMatchObject({ matched: 1, mismatched: 1 });
  });

  it('two lines for two different orders are both matched', async () => {
    db.statementLine.findMany.mockResolvedValue([line({ id: 'l1' }), line({ id: 'l2', merchantRef: 'REF-2' })]);
    db.order.findFirst
      .mockResolvedValueOnce(orderRow({ id: 'o1' }))
      .mockResolvedValueOnce(orderRow({ id: 'o2' }));

    const outcome = await runMatching(db as never, scope);

    expect(outcome).toMatchObject({ matched: 2, mismatched: 0 });
  });

  it('an order another statement already names is flagged with that statement reference', async () => {
    db.statementLine.findMany.mockResolvedValue([line()]);
    db.order.findFirst.mockResolvedValue(orderRow({}));
    db.settlementMatch.findMany.mockImplementation(async (args: any) =>
      args.where.orderId ? [{ orderId: 'o1', statement: { reference: 'ST-OTHER', approvedAt: null } }] : []
    );

    await runMatching(db as never, scope);

    expect(created()[0].result).toBe('MISMATCHED');
    expect(created()[0].note).toContain('ST-OTHER');
  });

  it('asks about other statements that are approved or older than this one — never "any", which would flag both ways', async () => {
    db.statementLine.findMany.mockResolvedValue([line()]);
    db.order.findFirst.mockResolvedValue(orderRow({}));
    await runMatching(db as never, scope);

    const call = db.settlementMatch.findMany.mock.calls.find((c) => c[0].where.orderId)!;
    expect(call[0].where.statementId).toEqual({ not: 'st1' });
    expect(call[0].where.statementLineId).toEqual({ not: null });
    expect(call[0].where.statement.OR).toEqual([
      { approvedAt: { not: null } },
      { createdAt: { lt: new Date('2026-10-20T00:00:00Z') } },
    ]);
  });

  it('a fee-only mismatch keeps its own sentence and gains the reason after it', async () => {
    db.statementLine.findMany.mockResolvedValue([line({ amount: 17, fee: 5 })]);
    db.order.findFirst.mockResolvedValue(orderRow({ totalAmount: 20, deliveryFee: 3, settlementStatus: 'SETTLED' }));

    const outcome = await runMatching(db as never, scope);

    expect(outcome).toMatchObject({ mismatched: 1, feeMismatched: 1 });
    const note = created()[0].note as string;
    expect(note.indexOf('أجرة التوصيل')).toBeLessThan(note.indexOf('حُصّل يدوياً'));
  });
});

describe('the reasons, as a rule', () => {
  const none = { settlementStatus: 'PENDING', claimedByAnotherLine: false, otherStatements: [], openRequests: [] };

  it('says nothing about an ordinary order', () => {
    expect(integrityNotes(none)).toEqual([]);
  });

  it('names each reason once, and a hand collection only when no approved statement explains the SETTLED', () => {
    expect(integrityNotes({ ...none, settlementStatus: 'SETTLED' })).toEqual([HAND_COLLECTED_NOTE]);
    expect(
      integrityNotes({ ...none, settlementStatus: 'SETTLED', otherStatements: [{ reference: 'A', approved: true }, { reference: 'A', approved: true }] })
    ).toEqual(['الطلب مذكور بكشف آخر: A']);
    expect(integrityNotes({ ...none, claimedByAnotherLine: true })).toEqual([SAME_FILE_NOTE]);
  });
});
