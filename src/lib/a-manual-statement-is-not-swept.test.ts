import { beforeEach, describe, expect, it, vi } from 'vitest';
import { repoFile, stripComments } from './guard-source';

/**
 * A STATEMENT A PERSON GATHERED BY HAND IS MATCHED LINE BY LINE — AND NEVER SWEPT.
 *
 * The sweep after the lines asks «which delivered parcels of this courier did the statement leave out». For a
 * courier's own file that is the one check whose whole job is to catch a parcel quietly omitted. For a list a
 * person made of the parcels they chose to settle together, every OTHER delivered order of the courier would come
 * out as «لم يرد في كشف الشركة»: a false alarm per parcel not gathered yet, on the statement that is about to be
 * approved. So the sweep is skipped whenever the file hash starts with `manual:`.
 *
 * The other direction matters just as much: a manual statement's lines name their orders by reference, so the
 * sweep of a REAL statement of the same courier counts them as mentioned and does not call them missing there.
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

const scope = { companyId: 'c1', storeId: 's1', statementId: 'st1', minorUnit: 3 };

/** A delivered 20.000 order with the 2.500 fee inside the price: expected net 17.500. */
const delivered = (n: number, over: Record<string, unknown> = {}) => ({
  id: `o${n}`, shippingStatus: 'DELIVERED', settlementStatus: 'PENDING_COLLECTION',
  trackingNumber: null, merchantRef: `REF-${n}`,
  totalAmount: 20, priceIncludesDelivery: true, collectedAmount: null, deliveryFee: 2.5, returnReceipt: null, addOns: [],
  items: [{ quantity: 1, freeQuantity: 0, unitPrice: 20, discountShare: 0, lineTotal: 20, deliveredQty: null }],
  ...over,
});

/** The line the manual door writes: reference only, the net, and the fee the order itself carries. */
const line = (n: number, amount = 17.5) => ({
  id: `l${n}`, merchantRef: `REF-${n}`, barcode: null, amount, fee: 2.5, collected: amount + 2.5, status: null,
});

const created = () => db.settlementMatch.create.mock.calls.map((c) => c[0].data);

const MANUAL = `manual:${'a'.repeat(64)}`;

/** Lines of THIS statement for the pass-1 read, and the «who mentions it» read for the sweep. */
function lines(own: ReturnType<typeof line>[], mentions: { merchantRef: string | null; barcode: string | null }[] = []) {
  db.statementLine.findMany.mockImplementation(async (args: { where: { statementId?: string } }) =>
    args.where.statementId ? own : mentions
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  db.settlementMatch.create.mockResolvedValue({});
  db.settlementMatch.deleteMany.mockResolvedValue({ count: 0 });
  db.settlementMatch.findMany.mockResolvedValue([]);
  db.orderChangeRequest.findMany.mockResolvedValue([]);
  db.courierStatement.findFirst.mockResolvedValue({
    id: 'st1', deliveryProviderId: 'dp1', periodFrom: null, periodTo: null, createdAt: new Date('2026-10-20T00:00:00Z'),
    fileHash: MANUAL,
  });
  const orders: Record<string, ReturnType<typeof delivered>> = { 'REF-1': delivered(1), 'REF-2': delivered(2) };
  db.order.findFirst.mockImplementation(async (args: { where: { merchantRef?: string } }) =>
    args.where.merchantRef ? orders[args.where.merchantRef] ?? null : null
  );
  // The courier has a third delivered order that nobody gathered.
  db.order.findMany.mockResolvedValue([delivered(1), delivered(2), delivered(3)]);
});

describe('the sweep is skipped for a manual statement', () => {
  it('two gathered orders are matched, and the third delivered order of the courier is NOT called missing', async () => {
    lines([line(1), line(2)]);

    const outcome = await runMatching(db as never, scope);

    expect(outcome).toMatchObject({ matched: 2, mismatched: 0, missingInSystem: 0, missingInStatement: 0 });
    expect(created().map((r) => [r.orderId, r.result])).toEqual([['o1', 'MATCHED'], ['o2', 'MATCHED']]);
    expect(created().filter((r) => r.result === 'MISSING_IN_STATEMENT')).toEqual([]);
  });

  it('and the sweep’s question is never even asked: the delivered orders are not read', async () => {
    lines([line(1), line(2)]);
    await runMatching(db as never, scope);
    expect(db.order.findMany).not.toHaveBeenCalled();
  });

  it('the very same statement under a FILE’s hash IS swept — the rule did not just switch the sweep off', async () => {
    db.courierStatement.findFirst.mockResolvedValue({
      id: 'st1', deliveryProviderId: 'dp1', periodFrom: null, periodTo: null, createdAt: new Date('2026-10-20T00:00:00Z'),
      fileHash: 'ef'.repeat(32),
    });
    lines([line(1), line(2)]);

    const outcome = await runMatching(db as never, scope);

    expect(db.order.findMany).toHaveBeenCalledTimes(1);
    expect(outcome.missingInStatement).toBe(1);
    expect(created().filter((r) => r.result === 'MISSING_IN_STATEMENT').map((r) => r.orderId)).toEqual(['o3']);
  });

  it('a draft’s hash (not yet gathered) is manual too: skipped the same way', async () => {
    db.courierStatement.findFirst.mockResolvedValue({
      id: 'st1', deliveryProviderId: 'dp1', periodFrom: null, periodTo: null, createdAt: new Date(),
      fileHash: 'manual:draft:5f1c0b8e-0000-4000-8000-000000000000',
    });
    lines([line(1)]);
    const outcome = await runMatching(db as never, scope);
    expect(outcome.missingInStatement).toBe(0);
    expect(db.order.findMany).not.toHaveBeenCalled();
  });

  it('the skip is the statement’s own fact (its hash), not a switch anybody can flip from outside', () => {
    const body = stripComments(repoFile('src/lib/settlement.ts'));
    const matcher = body.slice(body.indexOf('export async function runMatching('));
    expect(matcher).toMatch(/if \(isManualHash\(statement\.fileHash\)\) return outcome;/);
    // …and it comes BEFORE the sweep's query, not after.
    expect(matcher.indexOf('isManualHash(statement.fileHash)')).toBeLessThan(matcher.indexOf('const delivered = await tx.order.findMany'));
  });
});

describe('a short handover is recorded on its order', () => {
  it('a line that is 2.000 under what we expect is MISMATCHED by exactly that, and its sibling is MATCHED', async () => {
    lines([line(1, 15.5), line(2)]);

    const outcome = await runMatching(db as never, scope);

    expect(outcome).toMatchObject({ matched: 1, mismatched: 1 });
    const [short, whole] = created();
    expect(short).toMatchObject({ orderId: 'o1', result: 'MISMATCHED', expectedAmount: 17.5, statementAmount: 15.5, difference: -2 });
    expect(whole).toMatchObject({ orderId: 'o2', result: 'MATCHED', difference: 0 });
  });

  it('the fee the line states is the order’s own, so no fee difference is ever invented', async () => {
    lines([line(1, 15.5)]);
    await runMatching(db as never, scope);
    expect(created()[0]).toMatchObject({ expectedFee: 2.5, statementFee: 2.5, feeDifference: 0 });
  });

  it('three decimals: a figure a fils off is a difference, not noise', async () => {
    lines([line(1, 17.499)]);
    await runMatching(db as never, scope);
    expect(created()[0]).toMatchObject({ result: 'MISMATCHED', difference: -0.001 });
  });

  it('a line of zero (the courier handed nothing over for that order) is kept, flagged, and never settles it', async () => {
    lines([line(1, 0)]);
    await runMatching(db as never, scope);
    expect(created()[0]).toMatchObject({ orderId: 'o1', result: 'MISMATCHED', statementAmount: 0, difference: -17.5 });
    expect(created()[0].note).toContain('صفر');
  });
});

describe('a real statement of the same courier counts the gathered orders as mentioned', () => {
  it('an order named by a manual line is not «missing» from the file statement’s sweep', async () => {
    db.courierStatement.findFirst.mockResolvedValue({
      id: 'st1', deliveryProviderId: 'dp1', periodFrom: null, periodTo: null, createdAt: new Date('2026-10-20T00:00:00Z'),
      fileHash: 'ef'.repeat(32),
    });
    // The file names nothing; a manual statement's line names REF-3 by reference.
    lines([], [{ merchantRef: 'REF-3', barcode: null }]);
    db.order.findMany.mockResolvedValue([delivered(3), delivered(4)]);

    const outcome = await runMatching(db as never, scope);

    expect(outcome.missingInStatement).toBe(1);
    expect(created().filter((r) => r.result === 'MISSING_IN_STATEMENT').map((r) => r.orderId)).toEqual(['o4']);
    // The question is asked of every statement of the company, whatever kind: that is what «mentioned» means.
    const ask = db.statementLine.findMany.mock.calls.map((c) => c[0].where).find((w) => w.statement);
    expect(ask).toMatchObject({ statement: { companyId: 'c1' } });
    expect(ask).not.toHaveProperty('statement.fileHash');
  });
});
