import { beforeEach, describe, expect, it, vi } from 'vitest';
import { repoFile, stripComments } from './guard-source';

/**
 * A LINE A PERSON TIED TO AN ORDER SURVIVES THE NEXT RUN — AND THE ORDER IS NOT «MISSING» BECAUSE OF IT.
 *
 * Two ways a hand link could be undone without anybody pressing anything:
 *
 *   · «تشغيل المطابقة» again. It deletes the machine's unanswered rows and rebuilds them; the link is a row
 *     marked MANUAL and must be neither deleted nor rebuilt (its line is not resolved a second time).
 *   · the sweep «طلبات لم يذكرها أي كشف». It asks whether any line NAMES the order by its own references — and
 *     a hand link exists because the line named something else, so without a rule of its own the order the
 *     person just tied to a statement would be listed as one no statement mentions.
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
import { MANUAL_MATCH } from './match-integrity';

const scope = { companyId: 'c1', storeId: 's1', statementId: 'st1', minorUnit: 3 };

const delivered = (id = 'o9') => ({
  id, shippingStatus: 'DELIVERED', settlementStatus: 'PENDING', trackingNumber: 'TN-9', merchantRef: 'REF-9',
  totalAmount: 20, priceIncludesDelivery: false, collectedAmount: null, deliveryFee: 0, returnReceipt: null, addOns: [],
  items: [{ quantity: 1, freeQuantity: 0, unitPrice: 20, discountShare: 0, lineTotal: 20, deliveredQty: null }],
});

const created = () => db.settlementMatch.create.mock.calls.map((c) => c[0].data);

beforeEach(() => {
  vi.clearAllMocks();
  db.settlementMatch.create.mockResolvedValue({});
  db.settlementMatch.deleteMany.mockResolvedValue({ count: 0 });
  db.orderChangeRequest.findMany.mockResolvedValue([]);
  db.order.findFirst.mockResolvedValue(null);
  db.courierStatement.findFirst.mockResolvedValue({
    id: 'st1', deliveryProviderId: 'dp1', periodFrom: null, periodTo: null, createdAt: new Date('2026-10-20T00:00:00Z'),
  });
});

describe('matching again keeps the link', () => {
  it('deletes only the machine’s unanswered rows: a MANUAL row is outside what it deletes', async () => {
    db.statementLine.findMany.mockResolvedValue([]);
    db.settlementMatch.findMany.mockResolvedValue([]);
    db.order.findMany.mockResolvedValue([]);
    await runMatching(db as never, scope);

    const where = db.settlementMatch.deleteMany.mock.calls[0][0].where as {
      resolution: null;
      OR: { matchedBy: unknown }[];
    };
    expect(where.resolution).toBeNull();
    // matchedBy is null (the sweep) or anything but MANUAL — so the link is never a candidate for deletion.
    expect(where.OR).toEqual([{ matchedBy: null }, { matchedBy: { not: MANUAL_MATCH } }]);
  });

  it('and does not resolve the linked line a second time', async () => {
    db.statementLine.findMany.mockResolvedValue([
      { id: 'l1', merchantRef: 'NOT-OURS', barcode: null, amount: 20, fee: null, status: null },
    ]);
    // The row the person made is what is left after the delete.
    db.settlementMatch.findMany.mockResolvedValueOnce([
      { statementLineId: 'l1', orderId: 'o9', result: 'MATCHED', resolution: null },
    ]);
    db.settlementMatch.findMany.mockResolvedValue([]);
    db.order.findMany.mockResolvedValue([]);

    const outcome = await runMatching(db as never, scope);

    expect(created()).toEqual([]);
    expect(outcome).toMatchObject({ matched: 1, missingInSystem: 0, kept: 1 });
    // The lookup that would have failed again («لا يوجد طلب بهذا الباركود أو المرجع») never ran for it.
    expect(db.order.findFirst).not.toHaveBeenCalled();
  });

  it('and the linked row’s order is not swept as missing from this statement', async () => {
    db.statementLine.findMany.mockImplementation(async (args: { where: { statementId?: string } }) =>
      args.where.statementId ? [{ id: 'l1', merchantRef: 'NOT-OURS', barcode: null, amount: 20, fee: null, status: null }] : []
    );
    db.settlementMatch.findMany.mockResolvedValueOnce([
      { statementLineId: 'l1', orderId: 'o9', result: 'MISMATCHED', resolution: null },
    ]);
    db.settlementMatch.findMany.mockResolvedValue([]);
    db.order.findMany.mockResolvedValue([delivered('o9')]);

    const outcome = await runMatching(db as never, scope);
    expect(outcome.missingInStatement).toBe(0);
    expect(created().filter((r) => r.result === 'MISSING_IN_STATEMENT')).toEqual([]);
  });
});

describe('the sweep counts a hand link, on any statement, as a mention', () => {
  it('an order linked by hand on ANOTHER statement is not «missing» here', async () => {
    db.statementLine.findMany.mockResolvedValue([]);
    db.order.findMany.mockResolvedValue([delivered('o9')]);
    // 1st call: the rows kept on this statement (none). 2nd: the hand links among the swept orders.
    db.settlementMatch.findMany.mockResolvedValueOnce([]);
    db.settlementMatch.findMany.mockResolvedValueOnce([{ orderId: 'o9' }]);

    const outcome = await runMatching(db as never, scope);

    expect(outcome.missingInStatement).toBe(0);
    expect(created()).toEqual([]);
    const ask = db.settlementMatch.findMany.mock.calls[1][0].where;
    expect(ask).toMatchObject({ companyId: 'c1', matchedBy: MANUAL_MATCH, statementLineId: { not: null }, orderId: { in: ['o9'] } });
    // Any statement, not only this one: that is what «mentioned» means.
    expect(ask).not.toHaveProperty('statementId');
  });

  it('and the same order with no link and no line naming it IS missing — the rule did not just switch the sweep off', async () => {
    db.statementLine.findMany.mockResolvedValue([]);
    db.order.findMany.mockResolvedValue([delivered('o9')]);
    db.settlementMatch.findMany.mockResolvedValue([]);

    const outcome = await runMatching(db as never, scope);

    expect(outcome.missingInStatement).toBe(1);
    expect(created()[0]).toMatchObject({ orderId: 'o9', result: 'MISSING_IN_STATEMENT' });
  });

  it('and asks nothing when the sweep found no orders', async () => {
    db.statementLine.findMany.mockResolvedValue([]);
    db.order.findMany.mockResolvedValue([]);
    db.settlementMatch.findMany.mockResolvedValue([]);
    await runMatching(db as never, scope);
    // Only the kept-rows read: no second query over an empty list.
    expect(db.settlementMatch.findMany).toHaveBeenCalledTimes(1);
  });
});

describe('the link is a door of its own, not a branch of the matcher', () => {
  const link = stripComments(repoFile('src/lib/hand-link.ts'));
  const matcher = stripComments(repoFile('src/lib/settlement.ts'));

  it('the matcher never reads a phone — the phone is searched in the link, by a person', () => {
    const body = matcher.slice(matcher.indexOf('export async function runMatching('));
    expect(body.slice(0, body.indexOf('\nexport '))).not.toMatch(/phone/i);
    expect(link).toMatch(/orderSearchOr\(/);
  });

  it('the link does not call the matcher', () => {
    expect(link).not.toMatch(/runMatching/);
  });

  it('and the verdict comes from the matcher’s own function, with no second expectation in the link', () => {
    expect(link).toMatch(/judgeLine\(/);
    expect(matcher).toMatch(/judgeLine\(\{/);
    // The one place that computes «expected» for a line is judgeLine; the link only READS it to rank candidates.
    const writes = link.slice(link.indexOf('export async function linkLineToOrder'));
    expect(writes).not.toMatch(/expectedAmountFor\(/);
    expect(writes).not.toMatch(/roundMinor\(/);
  });

  it('and it writes no money: no wallet, no order update, no commission', () => {
    expect(link).not.toMatch(/walletMovement|recordMovement|markPayable|settlementStatus:\s*'SETTLED'|order\.update/);
  });
});
