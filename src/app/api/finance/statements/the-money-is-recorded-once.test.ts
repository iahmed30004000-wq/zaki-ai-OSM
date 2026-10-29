import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * THE OWNER, 28/10, with a screenshot of the wallet «شام كاش دولار»:
 * «لاحظت شغله — لما بنعمل اعتماد للكشف — بتتسجل حركت المال مره ثانيه».
 *
 * A 1543.9 collection was typed by hand on 27/10; approving its statement on 28/10 wrote the same 1543.9 again.
 * These tests drive the real approval route against a fake database that APPLIES the filters it is given — so a
 * reversed row, a 15-day-old row or a row in another wallet is excluded by the route's own `where`, not by a
 * mock that was told the answer — and a fake claim that behaves like a conditional update (one winner).
 */

const {
  db, requireContext, requirePermission, logAudit, recordMovement, receiptGap, markPayableForOrders, state,
} = vi.hoisted(() => {
  const state = {
    stamped: false,
    // What the transaction's own read of the statement returns, call after call.
    reads: [] as unknown[],
    handRows: [] as Record<string, unknown>[],
  };
  const db = {
    courierStatement: {
      findFirst: vi.fn(async () => {
        const next = state.reads.length > 1 ? state.reads.shift() : state.reads[0];
        return next;
      }),
      update: vi.fn(),
      // The fake of a CONDITIONAL update: only a row still unapproved is claimed, and once claimed the
      // next claim finds it approved. One winner, whatever the number of presses.
      updateMany: vi.fn(async ({ where }: { where: { approvedAt?: null } }) => {
        if (where.approvedAt === null && state.stamped) return { count: 0 };
        state.stamped = true;
        return { count: 1 };
      }),
    },
    walletMovement: {
      // Applies the filters the route sends. Nothing is returned that the route's `where` would not return.
      findMany: vi.fn(async ({ where }: { where: Record<string, any> }) =>
        state.handRows.filter(
          (r) =>
            r.companyId === where.companyId &&
            where.walletId.in.includes(r.walletId) &&
            r.direction === where.direction &&
            r.referenceType === where.referenceType &&
            r.reversalOfId === where.reversalOfId &&
            (where.reversedBy === null ? r.reversedBy === null : true) &&
            (r.createdAt as Date).getTime() >= where.createdAt.gte.getTime()
        )
      ),
    },
    user: { findMany: vi.fn(async () => [{ id: 'hand-writer', name: 'مها المحاسبة' }]) },
    order: { updateMany: vi.fn(), findMany: vi.fn(), update: vi.fn() },
    orderActivity: { create: vi.fn() },
    customer: { update: vi.fn() },
    $transaction: vi.fn(async (fn: (tx: unknown) => unknown) => fn(db)),
  };
  return {
    db, state,
    requireContext: vi.fn(), requirePermission: vi.fn(), logAudit: vi.fn(),
    recordMovement: vi.fn(), receiptGap: vi.fn(), markPayableForOrders: vi.fn(),
  };
});

vi.mock('@/lib/db', () => ({ db }));
vi.mock('@/lib/geo-context', () => ({ requireContext: (...a: unknown[]) => requireContext(...a) }));
vi.mock('@/lib/authorization', () => ({ requirePermission: (...a: unknown[]) => requirePermission(...a), can: () => true }));
vi.mock('@/lib/audit', () => ({ logAudit: (...a: unknown[]) => logAudit(...a) }));
vi.mock('@/lib/settlement', async (orig) => ({
  ...(await orig<typeof import('@/lib/settlement')>()),
  receiptGap: (...a: unknown[]) => receiptGap(...a),
}));
vi.mock('@/lib/wallets', async (orig) => ({
  ...(await orig<typeof import('@/lib/wallets')>()),
  recordMovement: (...a: unknown[]) => recordMovement(...a),
}));
vi.mock('@/lib/commission', async (orig) => ({
  ...(await orig<typeof import('@/lib/commission')>()),
  markPayableForOrders: (...a: unknown[]) => markPayableForOrders(...a),
}));
vi.mock('@/lib/stock-consumption', () => ({ consumeOrderStock: vi.fn() }));

import { PATCH } from './[id]/route';

const ID = '88888888-8888-4888-8888-888888888888';
const params = { params: Promise.resolve({ id: ID }) };
const approve = (extra: Record<string, unknown> = {}) =>
  PATCH(
    new Request('http://localhost/x', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ approve: true, ...extra }),
    }),
    params
  );

const NOW = new Date('2026-10-28T12:25:00.000Z');
const DAY = 24 * 60 * 60 * 1000;
const daysAgo = (n: number) => new Date(NOW.getTime() - n * DAY);

const statement = (receipts: { id: string; walletId: string; amount: number }[], over: Record<string, unknown> = {}) => ({
  id: ID, status: 'MATCHED', reference: '7446102700052', gapExplanation: null, approvedAt: null,
  receipts, matches: [{ orderId: 'o1', result: 'MATCHED', statementAmount: 10, statementFee: 0 }],
  ...over,
});

const WALLET_USD = { name: 'شام كاش دولار', currencyCode: 'USD', country: { minorUnit: 2 } };
const WALLET_JOD = { name: 'الصندوق', currencyCode: 'JOD', country: { minorUnit: 3 } };
const hand = (over: Record<string, unknown> = {}) => ({
  id: 'hand-1', companyId: 'c1', walletId: 'w-usd', direction: 'IN', amount: 1543.9,
  party: 'الباشا 27-10-2026', note: 'Qabas', category: 'EXPENSE', createdAt: daysAgo(1), createdById: 'hand-writer',
  referenceType: null, reversalOfId: null, reversedBy: null, wallet: WALLET_USD, ...over,
});

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW);
  state.stamped = false;
  state.handRows = [];
  requireContext.mockResolvedValue({
    user: { id: 'u1', name: 'المحاسب' }, companyId: 'c1', storeId: 's1', country: { minorUnit: 2, currencyCode: 'USD' },
  });
  requirePermission.mockResolvedValue({});
  receiptGap.mockResolvedValue({ claimed: 1543.9, received: 1543.9, gap: 0, needsExplanation: false, explained: false, unconvertible: 0 });
  db.order.findMany.mockResolvedValue([]);
  // The approval claims its orders with a conditional write and stops unless it took every one it asked for
  // (RV291): a fake that answers like a database that took them all.
  db.order.updateMany.mockImplementation(async (a: { where?: { id?: { in?: unknown[] } } }) => ({ count: a?.where?.id?.in?.length ?? 0 }));
  markPayableForOrders.mockResolvedValue(0);
  recordMovement.mockResolvedValue({ id: 'm1' });
  state.reads = [statement([{ id: 'r1', walletId: 'w-usd', amount: 1543.9 }])];
});

afterEach(() => vi.useRealTimers());

describe('one approval, however many presses', () => {
  it('the claim is conditional on the statement being unapproved — and a lost claim posts nothing', async () => {
    state.stamped = true; // somebody else's press already took it
    const res = await approve();

    expect(res.status).toBe(409);
    expect((await res.json()).code).toBe('ALREADY_APPROVED');
    expect(recordMovement).not.toHaveBeenCalled();
    expect(db.order.updateMany).not.toHaveBeenCalled();
    expect(markPayableForOrders).not.toHaveBeenCalled();
    expect(logAudit).not.toHaveBeenCalled();
    const where = db.courierStatement.updateMany.mock.calls[0][0].where;
    expect(where).toMatchObject({ id: ID, companyId: 'c1', approvedAt: null });
  });

  it('two presses in flight write the receipt ONCE', async () => {
    const [a, b] = await Promise.all([approve(), approve()]);

    expect([a.status, b.status].sort()).toEqual([200, 409]);
    expect(recordMovement).toHaveBeenCalledTimes(1);
    expect(recordMovement.mock.calls[0][1]).toMatchObject({ direction: 'IN', amount: 1543.9, category: 'COURIER_SETTLEMENT' });
  });

  it('a retry after the first success is refused before it can claim anything', async () => {
    state.reads = [statement([{ id: 'r1', walletId: 'w-usd', amount: 1543.9 }], { approvedAt: new Date() })];
    const res = await approve();
    expect(res.status).toBe(409);
    expect(db.courierStatement.updateMany).not.toHaveBeenCalled();
    expect(recordMovement).not.toHaveBeenCalled();
  });
});

describe('what the money is built from is read INSIDE the transaction, after the claim', () => {
  it('a receipt that landed after the first read is paid too — not left out of the wallet', async () => {
    const first = statement([{ id: 'r1', walletId: 'w-usd', amount: 90 }]);
    const second = statement([
      { id: 'r1', walletId: 'w-usd', amount: 90 },
      { id: 'r2', walletId: 'w-usd', amount: 40 },
    ]);
    state.reads = [first, second];
    receiptGap.mockResolvedValue({ claimed: 130, received: 130, gap: 0, needsExplanation: false, explained: false, unconvertible: 0 });

    const res = await approve();

    expect(res.status).toBe(200);
    expect(recordMovement.mock.calls.map((c) => c[1].amount)).toEqual([90, 40]);
    expect(db.courierStatement.findFirst).toHaveBeenCalledTimes(2);
    // The claim comes before the read that decides the money.
    const claim = db.courierStatement.updateMany.mock.invocationCallOrder[0];
    const insideRead = db.courierStatement.findFirst.mock.invocationCallOrder[1];
    expect(claim).toBeLessThan(insideRead);
  });

  it('and a receipt removed in the meantime stops the approval — nothing is written', async () => {
    state.reads = [statement([{ id: 'r1', walletId: 'w-usd', amount: 90 }]), statement([])];
    const res = await approve();
    expect(res.status).toBe(409);
    expect((await res.json()).code).toBe('NO_RECEIPTS');
    expect(recordMovement).not.toHaveBeenCalled();
  });
});

describe('a hand entry of the same money stops the approval and shows itself', () => {
  it('HIS CASE: IN 1543.9 by hand on 27/10, then the statement whose receipt is 1543.9 into the same wallet', async () => {
    state.handRows = [hand()];
    const res = await approve();
    const body = await res.json();

    expect(res.status).toBe(409);
    expect(body.code).toBe('POSSIBLE_DOUBLE');
    expect(body.error).toBe(
      'في حركة يدوية بنفس المبلغ بنفس المحفظة — إذا هي نفس مصاري الكشف، اعكسها («قيد عكسي») قبل الاعتماد.'
    );
    expect(body.rows).toEqual([
      expect.objectContaining({
        id: 'hand-1', amount: 1543.9, currencyCode: 'USD', wallet: 'شام كاش دولار',
        party: 'الباشا 27-10-2026', note: 'Qabas', by: 'مها المحاسبة',
      }),
    ]);
    expect(body.rows[0].date).toBeTruthy();
    expect(recordMovement).not.toHaveBeenCalled();
    expect(db.order.updateMany).not.toHaveBeenCalled();
    expect(logAudit).not.toHaveBeenCalled();
  });

  it('«اعتمد هيك» lets it through, and the audit row carries the confirmation and the rows', async () => {
    state.handRows = [hand()];
    const res = await approve({ confirmPossibleDouble: true });

    expect(res.status).toBe(200);
    expect(recordMovement).toHaveBeenCalledTimes(1);
    expect(logAudit.mock.calls[0][0]).toMatchObject({
      action: 'STATEMENT_APPROVED',
      newData: { confirmedPossibleDouble: true, handRows: ['hand-1'] },
    });
  });

  it('an approval with nothing alike carries no confirmation in its audit row', async () => {
    const res = await approve();
    expect(res.status).toBe(200);
    expect(logAudit.mock.calls[0][0].newData).not.toHaveProperty('confirmedPossibleDouble');
  });

  it('JOD has three decimals: 10.125 against 10.125 is a double', async () => {
    state.reads = [statement([{ id: 'r1', walletId: 'w-jod', amount: 10.125 }])];
    state.handRows = [hand({ walletId: 'w-jod', amount: 10.125, wallet: WALLET_JOD })];
    const res = await approve();
    expect(res.status).toBe(409);
    expect((await res.json()).code).toBe('POSSIBLE_DOUBLE');
  });

  it('…and 10.125 against 10.12 is NOT', async () => {
    state.reads = [statement([{ id: 'r1', walletId: 'w-jod', amount: 10.125 }])];
    state.handRows = [hand({ walletId: 'w-jod', amount: 10.12, wallet: WALLET_JOD })];
    const res = await approve();
    expect(res.status).toBe(200);
    expect(recordMovement).toHaveBeenCalledTimes(1);
  });

  it('a different amount in the same wallet is not a double', async () => {
    state.handRows = [hand({ amount: 1543.91 })];
    expect((await approve()).status).toBe(200);
  });

  it('the same amount in ANOTHER wallet is not a double', async () => {
    state.handRows = [hand({ walletId: 'w-other' })];
    expect((await approve()).status).toBe(200);
  });

  it('a hand row that was REVERSED does not count', async () => {
    state.handRows = [hand({ reversedBy: { id: 'rev-1' } })];
    expect((await approve()).status).toBe(200);
  });

  it('and a reversal itself does not count', async () => {
    state.handRows = [hand({ id: 'rev-1', reversalOfId: 'orig-1' })];
    expect((await approve()).status).toBe(200);
  });

  it('a row the statement or a collection wrote is not a hand entry', async () => {
    state.handRows = [hand({ referenceType: 'STATEMENT' }), hand({ id: 'h2', referenceType: 'MANUAL_COLLECTION' })];
    expect((await approve()).status).toBe(200);
  });

  it('a hand entry going OUT is not a double of money coming in', async () => {
    state.handRows = [hand({ direction: 'OUT' })];
    expect((await approve()).status).toBe(200);
  });

  it('14 days back still counts; 15 days back does not', async () => {
    state.handRows = [hand({ createdAt: daysAgo(13) })];
    expect((await approve()).status).toBe(409);

    state.stamped = false;
    state.handRows = [hand({ createdAt: daysAgo(15) })];
    expect((await approve()).status).toBe(200);
  });

  it('every receipt is compared in its own wallet — the second one is the double', async () => {
    state.reads = [
      statement([
        { id: 'r1', walletId: 'w-usd', amount: 500 },
        { id: 'r2', walletId: 'w-jod', amount: 10.125 },
      ]),
    ];
    state.handRows = [hand({ id: 'only-jod', walletId: 'w-jod', amount: 10.125, wallet: WALLET_JOD })];
    const body = await (await approve()).json();
    expect(body.code).toBe('POSSIBLE_DOUBLE');
    expect(body.rows.map((r: { id: string }) => r.id)).toEqual(['only-jod']);
  });
});
