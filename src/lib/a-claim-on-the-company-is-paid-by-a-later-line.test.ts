import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * A CLAIM ON THE COMPANY IS CLOSED BY A LATER STATEMENT («كشف تسوية») WHOSE LINE PAYS WHAT REMAINS.
 *
 * An order of 20.000 whose line said 18.000 and was answered «رقمنا هو المعتمد» stays PENDING_COLLECTION as a
 * claim of 2.000. When the company pays it on a later statement, that line is not measured against the whole
 * order again (18.000 of it is already in the wallet) but against the 2.000 that is owed:
 *
 *   exactly 2.000  → MATCHED   (the approval settles it)
 *   less than that → MISMATCHED, and answered like any other difference
 *   more than that → MISMATCHED, the same
 *
 * The matcher and the hand link judge by the same function, so a person's link is never a more generous judge.
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

import { runMatching, judgeLine } from './settlement';

const scope = { companyId: 'c1', storeId: 's1', statementId: 'st2', minorUnit: 3 };

const orderRow = (over: Record<string, unknown> = {}) => ({
  id: 'o1',
  shippingStatus: 'DELIVERED',
  settlementStatus: 'PENDING_COLLECTION',
  totalAmount: 20,
  priceIncludesDelivery: false,
  collectedAmount: null,
  deliveryFee: 0,
  returnReceipt: null,
  addOns: [],
  items: [{ quantity: 1, freeQuantity: 0, unitPrice: 20, discountShare: 0, lineTotal: 20, deliveredQty: null }],
  ...over,
});

const line = (amount: number, over: Record<string, unknown> = {}) => ({
  id: 'l1', merchantRef: 'REF-1', barcode: null, amount, fee: null, status: null, ...over,
});
const created = () => db.settlementMatch.create.mock.calls.map((c) => c[0].data);

/** The earlier APPROVED statement's answer «رقمنا»: expected 20.000, the company paid 18.000. */
const claimRow = (over: Record<string, unknown> = {}) => ({
  orderId: 'o1', expectedAmount: 20, statementAmount: 18, statementFee: 0,
  statement: { approvedAt: new Date('2026-10-20T00:00:00Z') }, ...over,
});

const withClaims = (rows: unknown[]) =>
  db.settlementMatch.findMany.mockImplementation(async (args: { where: { resolution?: string } }) =>
    args.where.resolution === 'OURS_STANDS' ? rows : []
  );

beforeEach(() => {
  vi.clearAllMocks();
  db.settlementMatch.create.mockResolvedValue({});
  db.settlementMatch.deleteMany.mockResolvedValue({ count: 0 });
  db.settlementMatch.findMany.mockResolvedValue([]);
  db.orderChangeRequest.findMany.mockResolvedValue([]);
  db.order.findMany.mockResolvedValue([]);
  db.order.findFirst.mockResolvedValue(orderRow());
  db.courierStatement.findFirst.mockResolvedValue({
    id: 'st2', deliveryProviderId: 'dp1', periodFrom: null, periodTo: null, createdAt: new Date('2026-10-25T00:00:00Z'), fileHash: 'ab'.repeat(32),
  });
});

describe('a line that pays exactly what remains', () => {
  it('is MATCHED against 2.000 — the 18.000 already paid is not expected twice', async () => {
    withClaims([claimRow()]);
    db.statementLine.findMany.mockResolvedValue([line(2)]);

    const outcome = await runMatching(db as never, scope);

    expect(outcome).toMatchObject({ matched: 1, mismatched: 0 });
    expect(created()[0]).toMatchObject({ result: 'MATCHED', expectedAmount: 2, statementAmount: 2, difference: 0, note: null });
  });

  it('and without a claim the very same line is a difference of 18.000 — the claim is what makes it clean', async () => {
    withClaims([]);
    db.statementLine.findMany.mockResolvedValue([line(2)]);

    await runMatching(db as never, scope);

    expect(created()[0]).toMatchObject({ result: 'MISMATCHED', expectedAmount: 20, difference: -18 });
  });
});

describe('a line that pays less or more than what remains', () => {
  it('LESS: MISMATCHED by 0.500, and the note says it is a payment on a claim', async () => {
    withClaims([claimRow()]);
    db.statementLine.findMany.mockResolvedValue([line(1.5)]);

    await runMatching(db as never, scope);

    expect(created()[0]).toMatchObject({ result: 'MISMATCHED', expectedAmount: 2, statementAmount: 1.5, difference: -0.5 });
    expect(created()[0].note).toContain('مطالبة سابقة على الشركة');
    expect(created()[0].note).toContain('الباقي 2');
  });

  it('MORE: MISMATCHED by 3.000 the other way', async () => {
    withClaims([claimRow()]);
    db.statementLine.findMany.mockResolvedValue([line(5)]);

    await runMatching(db as never, scope);

    expect(created()[0]).toMatchObject({ result: 'MISMATCHED', expectedAmount: 2, statementAmount: 5, difference: 3 });
  });

  it('the fils of a dinar are kept: a claim of 2.125 is paid by 2.125, not by 2.13', async () => {
    withClaims([claimRow({ expectedAmount: 20.125, statementAmount: 18 })]);
    db.statementLine.findMany.mockResolvedValue([line(2.125)]);
    await runMatching(db as never, scope);
    expect(created()[0]).toMatchObject({ result: 'MATCHED', expectedAmount: 2.125 });

    vi.clearAllMocks();
    db.settlementMatch.create.mockResolvedValue({});
    db.settlementMatch.deleteMany.mockResolvedValue({ count: 0 });
    db.orderChangeRequest.findMany.mockResolvedValue([]);
    db.order.findMany.mockResolvedValue([]);
    db.order.findFirst.mockResolvedValue(orderRow());
    db.courierStatement.findFirst.mockResolvedValue({
      id: 'st2', deliveryProviderId: 'dp1', periodFrom: null, periodTo: null, createdAt: new Date('2026-10-25T00:00:00Z'), fileHash: 'ab'.repeat(32),
    });
    withClaims([claimRow({ expectedAmount: 20.125, statementAmount: 18 })]);
    db.statementLine.findMany.mockResolvedValue([line(2.13)]);
    await runMatching(db as never, scope);
    expect(created()[0]).toMatchObject({ result: 'MISMATCHED', difference: 0.005 });
  });
});

describe('what has no claim is judged as it always was', () => {
  it('an order that is SETTLED has no claim, whatever its old rows say — and the claims are not even asked for it', async () => {
    withClaims([claimRow()]);
    db.order.findFirst.mockResolvedValue(orderRow({ settlementStatus: 'SETTLED' }));
    db.statementLine.findMany.mockResolvedValue([line(2)]);

    await runMatching(db as never, scope);

    expect(created()[0].expectedAmount).toBe(20);
    expect(db.settlementMatch.findMany.mock.calls.some((c) => c[0].where.resolution === 'OURS_STANDS')).toBe(false);
  });

  it('a claim from THIS statement is not a claim for its own lines', async () => {
    withClaims([]);
    db.statementLine.findMany.mockResolvedValue([line(18)]);
    await runMatching(db as never, scope);
    const asked = db.settlementMatch.findMany.mock.calls.map((c) => c[0].where).find((w) => w.resolution === 'OURS_STANDS');
    expect(asked.statementId).toEqual({ not: 'st2' });
    expect(asked.statement).toEqual({ approvedAt: { not: null } });
  });

  it('only an APPROVED statement’s answer is a claim — an answer on a statement not yet approved owes nothing yet', async () => {
    db.statementLine.findMany.mockResolvedValue([line(18)]);
    withClaims([]);
    await runMatching(db as never, scope);
    const asked = db.settlementMatch.findMany.mock.calls.map((c) => c[0].where).find((w) => w.resolution === 'OURS_STANDS');
    expect(asked.statement.approvedAt).toEqual({ not: null });
  });

  it('a claim already paid in full is no claim: the line is judged against the order again', async () => {
    withClaims([claimRow({ expectedAmount: 2, statementAmount: 2 })]);
    db.statementLine.findMany.mockResolvedValue([line(2)]);
    await runMatching(db as never, scope);
    expect(created()[0].expectedAmount).toBe(20);
  });
});

describe('the verdict itself (the hand link calls it with the same claim)', () => {
  const input = (openClaim: number | null | undefined, amount: number, fee: number | null = null) => ({
    order: { ...orderRow(), settlementStatus: 'PENDING_COLLECTION' } as never,
    line: { amount, fee },
    minorUnit: 3,
    integrity: { claimedByAnotherLine: false, otherStatements: [], openRequests: [] },
    openClaim,
  });

  it('a claim replaces the whole expectation', () => {
    expect(judgeLine(input(2, 2))).toMatchObject({ result: 'MATCHED', expected: 2, difference: 0, clean: true });
    expect(judgeLine(input(2, 1.5))).toMatchObject({ result: 'MISMATCHED', expected: 2, difference: -0.5 });
  });

  it('no claim, or a claim of nothing, changes nothing', () => {
    expect(judgeLine(input(undefined, 20))).toMatchObject({ result: 'MATCHED', expected: 20 });
    expect(judgeLine(input(null, 20))).toMatchObject({ result: 'MATCHED', expected: 20 });
    expect(judgeLine(input(0, 20))).toMatchObject({ result: 'MATCHED', expected: 20 });
  });

  it('the fee is not compared on a payment on a claim — its first statement already settled it', () => {
    const v = judgeLine({ ...input(2, 2, 2.5), order: { ...orderRow({ deliveryFee: 1 }) } as never });
    expect(v).toMatchObject({ result: 'MATCHED', feeWrong: false, feeDifference: null });
    // The same fee against an order with NO claim is still a fee difference.
    const plain = judgeLine({ ...input(null, 19, 2.5), order: { ...orderRow({ deliveryFee: 1 }) } as never });
    expect(plain.feeWrong).toBe(true);
  });

  it('a payment on a claim still stops for a cancel asked for on the order', () => {
    const v = judgeLine({ ...input(2, 2), integrity: { claimedByAnotherLine: false, otherStatements: [], openRequests: ['CANCEL'] } });
    expect(v.result).toBe('MISMATCHED');
    expect(v.note).toContain('طلب إلغاء مفتوح');
  });
});
