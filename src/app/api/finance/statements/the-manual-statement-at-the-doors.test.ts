import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * THE MANUAL STATEMENT AT THE DOORS IT SHARES WITH EVERY STATEMENT: the approval, the receipt, the matching.
 *
 * Nothing about the money is new here, and these tests are about exactly that: a manual statement is approved by
 * the same door (one claim, one wallet movement per receipt, a possible double stopping it), takes the same
 * receipt, and differs in four things only —
 *
 *   · the approval matches it AGAIN inside its own transaction, after the claim and before the rows are read;
 *   · an open draft is refused at the approval, the receipt and the matching (it has no reference, its total moves);
 *   · a rate under 0.000001 is refused at the receipt, because the column would store it as zero;
 *   · the statement list says which statements are manual and which are still drafts.
 */

const {
  db, requireContext, requirePermission, logAudit, recordMovement, receiptGap, markPayableForOrders, runMatching, state,
} = vi.hoisted(() => {
  const state = {
    stamped: false,
    reads: [] as unknown[],
    handRows: [] as Record<string, unknown>[],
  };
  const db = {
    courierStatement: {
      findFirst: vi.fn(async () => (state.reads.length > 1 ? state.reads.shift() : state.reads[0])),
      findMany: vi.fn(),
      update: vi.fn(),
      updateMany: vi.fn(async ({ where }: { where: { approvedAt?: null } }) => {
        if (where.approvedAt === null && state.stamped) return { count: 0 };
        state.stamped = true;
        return { count: 1 };
      }),
    },
    statementReceipt: { create: vi.fn(), findFirst: vi.fn() },
    wallet: { findFirst: vi.fn() },
    walletMovement: {
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
    // The list counts the lines still a question, by the same rule the approval waits for.
    settlementMatch: { groupBy: vi.fn(async () => []) },
    $transaction: vi.fn(async (fn: (tx: unknown) => unknown) => fn(db)),
  };
  return {
    db, state,
    requireContext: vi.fn(), requirePermission: vi.fn(), logAudit: vi.fn(),
    recordMovement: vi.fn(), receiptGap: vi.fn(), markPayableForOrders: vi.fn(), runMatching: vi.fn(),
  };
});

vi.mock('@/lib/db', () => ({ db }));
vi.mock('@/lib/geo-context', () => ({ requireContext: (...a: unknown[]) => requireContext(...a) }));
vi.mock('@/lib/authorization', () => ({ requirePermission: (...a: unknown[]) => requirePermission(...a), can: () => true }));
vi.mock('@/lib/audit', () => ({ logAudit: (...a: unknown[]) => logAudit(...a) }));
vi.mock('@/lib/settlement', async (orig) => ({
  ...(await orig<typeof import('@/lib/settlement')>()),
  receiptGap: (...a: unknown[]) => receiptGap(...a),
  runMatching: (...a: unknown[]) => runMatching(...a),
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

import { GET as listStatements } from './route';
import { PATCH as approveStatement } from './[id]/route';
import { POST as addReceipt } from './[id]/receipts/route';
import { POST as runMatch } from './[id]/match/route';
import { manualFileHash, newDraftHash } from '@/lib/manual-statement-rules';
import { openLineWhere } from '@/lib/statement-open-lines';

const ID = '88888888-8888-4888-8888-888888888888';
const WALLET = '11111111-1111-4111-8111-111111111111';
const params = { params: Promise.resolve({ id: ID }) };
const send = (method: string, body: unknown) =>
  new Request('http://localhost/x', { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
const approve = (extra: Record<string, unknown> = {}) => approveStatement(send('PATCH', { approve: true, ...extra }), params);

const NOW = new Date('2026-10-29T12:00:00.000Z');
const GATHERED = manualFileHash({ companyId: 'c1', courierId: 'cA', reference: 'كشف الأحد' });

const statement = (over: Record<string, unknown> = {}, matches?: unknown[]) => ({
  id: ID, status: 'MATCHED', reference: 'كشف الأحد', gapExplanation: null, approvedAt: null, fileHash: GATHERED,
  receipts: [{ id: 'r1', walletId: 'w-jod', amount: 35 }],
  matches: matches ?? [
    { orderId: 'o1', result: 'MATCHED', statementAmount: 17.5, statementFee: 2.5 },
    { orderId: 'o2', result: 'MATCHED', statementAmount: 17.5, statementFee: 2.5 },
  ],
  ...over,
});

const WALLET_JOD = { name: 'الصندوق', currencyCode: 'JOD', country: { minorUnit: 3 } };
const hand = (over: Record<string, unknown> = {}) => ({
  id: 'hand-1', companyId: 'c1', walletId: 'w-jod', direction: 'IN', amount: 35,
  party: 'الباشا', note: 'استلمت', category: 'OTHER', createdAt: new Date(NOW.getTime() - 86_400_000), createdById: 'hand-writer',
  referenceType: null, reversalOfId: null, reversedBy: null, wallet: WALLET_JOD, ...over,
});

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW);
  state.stamped = false;
  state.handRows = [];
  requireContext.mockResolvedValue({
    user: { id: 'u1', name: 'المحاسب' }, companyId: 'c1', storeId: 's1', country: { minorUnit: 3, currencyCode: 'JOD' },
  });
  requirePermission.mockResolvedValue({});
  receiptGap.mockResolvedValue({ claimed: 35, received: 35, gap: 0, needsExplanation: false, explained: false, unconvertible: 0 });
  db.order.findMany.mockResolvedValue([]);
  // The approval claims its orders with a conditional write and stops unless it took every one it asked for
  // (RV291): a fake that answers like a database that took them all.
  db.order.updateMany.mockImplementation(async (a: { where?: { id?: { in?: unknown[] } } }) => ({ count: a?.where?.id?.in?.length ?? 0 }));
  markPayableForOrders.mockResolvedValue(0);
  recordMovement.mockResolvedValue({ id: 'm1' });
  runMatching.mockResolvedValue({ matched: 2 });
  state.reads = [statement()];
});

afterEach(() => vi.useRealTimers());

describe('the approval matches a manual statement AGAIN, inside its own transaction', () => {
  it('after the claim holds the statement, and before the rows the money is built from are read', async () => {
    const res = await approve();

    expect(res.status).toBe(200);
    expect(runMatching).toHaveBeenCalledTimes(1);
    expect(runMatching.mock.calls[0][0]).toBe(db);
    expect(runMatching.mock.calls[0][1]).toMatchObject({ companyId: 'c1', storeId: 's1', statementId: ID, minorUnit: 3 });

    const claim = db.courierStatement.updateMany.mock.invocationCallOrder[0];
    const rematch = runMatching.mock.invocationCallOrder[0];
    const insideRead = db.courierStatement.findFirst.mock.invocationCallOrder[1];
    expect(claim).toBeLessThan(rematch);
    expect(rematch).toBeLessThan(insideRead);
    // …and inside THE transaction, not before it.
    expect(db.$transaction.mock.invocationCallOrder[0]).toBeLessThan(rematch);
  });

  // (Was: the approval went on and settled only o1. The lock makes the approval wait for every line that is a question, so a
  // re-run that finds a NEW difference stops it — nothing is written — and the person answers it first. A row the re-run
  // KEPT because a person had answered it does not stop it: the test below.)
  it('an order a hand collection took meanwhile is flagged by the re-run — and that is a question the approval waits for', async () => {
    // The press on «مطابقة» saw both orders clean; by approval o2 was collected by hand and the re-run flagged it.
    state.reads = [
      statement(),
      statement({}, [
        { orderId: 'o1', result: 'MATCHED', statementAmount: 17.5, statementFee: 2.5 },
        { orderId: 'o2', result: 'MISMATCHED', statementAmount: 17.5, statementFee: 2.5 },
      ]),
    ];

    const res = await approve();
    const body = await res.json();

    expect(res.status).toBe(409);
    expect(body.code).toBe('OPEN_LINES');
    expect(body.error).toContain('اضغط «مطابقة»');
    expect(recordMovement).not.toHaveBeenCalled();
    expect(markPayableForOrders).not.toHaveBeenCalled();
    expect(db.order.updateMany).not.toHaveBeenCalled();
  });

  it('what is settled is what the re-run left clean: a flagged order a person has already parked settles nothing', async () => {
    state.reads = [
      statement(),
      statement({}, [
        { orderId: 'o1', result: 'MATCHED', statementAmount: 17.5, statementFee: 2.5 },
        { orderId: 'o2', result: 'MISMATCHED', resolution: 'UNDER_REVIEW', statementAmount: 17.5, statementFee: 2.5 },
      ]),
    ];

    const res = await approve();

    expect(res.status).toBe(200);
    expect(markPayableForOrders).toHaveBeenCalledWith(expect.anything(), 'c1', ['o1']);
    expect(db.order.updateMany.mock.calls[0][0]).toMatchObject({ where: { id: { in: ['o1'] } }, data: { settlementStatus: 'SETTLED' } });
  });

  it('a file statement is NOT matched again by its approval — its rows are what a press wrote', async () => {
    state.reads = [statement({ fileHash: 'ab'.repeat(32) })];
    await approve();
    expect(runMatching).not.toHaveBeenCalled();
  });

  it('a re-run that fails stops the approval: the transaction rolls back and no wallet is touched', async () => {
    runMatching.mockRejectedValue(new Error('boom'));
    expect((await approve()).status).toBe(500);
    expect(recordMovement).not.toHaveBeenCalled();
    expect(markPayableForOrders).not.toHaveBeenCalled();
  });
});

describe('one approval, one wallet movement per receipt — the existing door, unchanged', () => {
  it('two presses write the receipt ONCE and the second answers «معتمد مسبقاً»', async () => {
    const [a, b] = await Promise.all([approve(), approve()]);
    expect([a.status, b.status].sort()).toEqual([200, 409]);
    expect(recordMovement).toHaveBeenCalledTimes(1);
    expect(recordMovement.mock.calls[0][1]).toMatchObject({ direction: 'IN', amount: 35, walletId: 'w-jod', category: 'COURIER_SETTLEMENT' });
  });

  it('a hand entry of the same amount in the SAME wallet stops it and shows itself — the same money is not entered twice', async () => {
    state.handRows = [hand()];

    const res = await approve();

    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.code).toBe('POSSIBLE_DOUBLE');
    expect(body.rows).toHaveLength(1);
    expect(recordMovement).not.toHaveBeenCalled();
  });

  it('and goes through only when the person says the hand row is not the same money', async () => {
    state.handRows = [hand()];
    const res = await approve({ confirmPossibleDouble: true });
    expect(res.status).toBe(200);
    expect(recordMovement).toHaveBeenCalledTimes(1);
    expect(logAudit.mock.calls.at(-1)?.[0].newData).toMatchObject({ confirmedPossibleDouble: true, handRows: ['hand-1'] });
  });

  it('a hand entry in ANOTHER wallet, or reversed, is not the same money', async () => {
    state.handRows = [hand({ walletId: 'w-other' }), hand({ id: 'h2', reversedBy: 'x' })];
    const res = await approve();
    expect(res.status).toBe(200);
  });
});

describe('an open draft is not a statement yet', () => {
  const draft = () => statement({ fileHash: newDraftHash(), receipts: [] });

  it('cannot be approved, and nothing is claimed', async () => {
    state.reads = [draft()];
    const res = await approve();
    expect(res.status).toBe(409);
    expect((await res.json()).code).toBe('MANUAL_DRAFT');
    expect(db.courierStatement.updateMany).not.toHaveBeenCalled();
    expect(recordMovement).not.toHaveBeenCalled();
    expect(runMatching).not.toHaveBeenCalled();
  });

  it('takes no receipt: refused in words before the wallet is even looked up', async () => {
    db.courierStatement.findFirst.mockResolvedValueOnce({
      id: ID, status: 'IMPORTED', currencyCode: 'JOD', reference: 'x', approvedAt: null, fileHash: newDraftHash(),
    });
    const res = await addReceipt(send('POST', { walletId: WALLET, amount: 10 }), params);
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.code).toBe('MANUAL_DRAFT');
    expect(body.error).toContain('تجميع');
    expect(db.wallet.findFirst).not.toHaveBeenCalled();
    expect(db.statementReceipt.create).not.toHaveBeenCalled();
  });

  it('cannot be matched: it has no receipt, and says so', async () => {
    db.courierStatement.findFirst.mockResolvedValueOnce({
      id: ID, status: 'IMPORTED', approvedAt: null, reference: 'x', _count: { receipts: 0 },
    });
    const res = await runMatch(send('POST', {}), params);
    expect(res.status).toBe(409);
    expect((await res.json()).code).toBe('RECEIPT_REQUIRED');
    expect(runMatching).not.toHaveBeenCalled();
  });
});

describe('a receipt of the gathered statement — the rate has a floor', () => {
  beforeEach(() => {
    db.courierStatement.findFirst.mockResolvedValue({
      id: ID, status: 'MATCHED', currencyCode: 'JOD', reference: 'كشف الأحد', approvedAt: null, fileHash: GATHERED,
    });
    db.wallet.findFirst.mockResolvedValue({ id: WALLET, name: 'دولار', currencyCode: 'USD' });
    db.statementReceipt.findFirst.mockResolvedValue(null);
    db.statementReceipt.create.mockResolvedValue({ id: 'r1', amount: 49.5 });
  });

  it('a different currency without a rate is still refused', async () => {
    const res = await addReceipt(send('POST', { walletId: WALLET, amount: 49.5 }), params);
    expect(res.status).toBe(400);
    expect((await res.json()).code).toBe('EXCHANGE_RATE_REQUIRED');
  });

  it('a rate under 0.000001 is refused — the column would store zero, which is no rate at all', async () => {
    for (const rate of [0.0000001, 0.0000004, 0]) {
      const res = await addReceipt(send('POST', { walletId: WALLET, amount: 49.5, exchangeRate: rate }), params);
      expect(res.status, String(rate)).toBe(400);
      expect(db.statementReceipt.create).not.toHaveBeenCalled();
    }
  });

  it('0.000001 itself is accepted and stored as typed', async () => {
    const res = await addReceipt(send('POST', { walletId: WALLET, amount: 49.5, exchangeRate: 0.000001 }), params);
    expect(res.status).toBe(201);
    expect(db.statementReceipt.create.mock.calls[0][0].data.exchangeRate).toBe(0.000001);
  });

  it('and an ordinary rate is stored with the receipt, as before', async () => {
    const res = await addReceipt(send('POST', { walletId: WALLET, amount: 49.5, exchangeRate: 1.41 }), params);
    expect(res.status).toBe(201);
    expect(db.statementReceipt.create.mock.calls[0][0].data).toMatchObject({ walletId: WALLET, amount: 49.5, exchangeRate: 1.41, currencyCode: 'USD' });
  });
});

describe('the list says which statements are manual', () => {
  it('a draft and a gathered one carry the flags — and the hash itself is never sent', async () => {
    const row = (id: string, fileHash: string) => ({
      id, reference: 'x', fileName: 'كشف يدوي', status: 'IMPORTED', approvedAt: null, currencyCode: 'JOD', totalAmount: 35,
      createdAt: NOW, periodFrom: null, periodTo: null, fileHash,
      _count: { lines: 2, receipts: 0, matches: 0 }, receipts: [],
    });
    db.courierStatement.findMany.mockResolvedValue([row('a', newDraftHash()), row('b', GATHERED), row('c', 'ab'.repeat(32))]);

    const res = await listStatements();
    const { statements } = await res.json();

    expect(statements.map((s: { manual: boolean; draft: boolean }) => [s.manual, s.draft])).toEqual([
      [true, true],
      [true, false],
      [false, false],
    ]);
    expect(JSON.stringify(statements)).not.toContain('manual:');
    expect(statements[0]).not.toHaveProperty('fileHash');
  });

  it('each statement carries the number of lines still a question, counted by the SAME filter the approval’s rule is held to', async () => {
    const row = (id: string) => ({
      id, reference: 'x', fileName: 'f', status: 'MATCHED', approvedAt: null, currencyCode: 'JOD', totalAmount: 35,
      createdAt: NOW, periodFrom: null, periodTo: null, fileHash: 'ab'.repeat(32),
      _count: { lines: 4, receipts: 1, matches: 4 }, receipts: [],
    });
    db.courierStatement.findMany.mockResolvedValue([row('a'), row('b')]);
    db.settlementMatch.groupBy.mockResolvedValueOnce([{ statementId: 'a', _count: { _all: 3 } }] as never);

    const { statements } = await (await listStatements()).json();

    expect(statements.map((s: { counts: { openLines: number } }) => s.counts.openLines)).toEqual([3, 0]);
    // The existing counts are untouched…
    expect(statements[0].counts).toMatchObject({ lines: 4, receipts: 1, matches: 4 });
    // …and it was one grouped read for the page, by the shared filter.
    expect(db.settlementMatch.groupBy).toHaveBeenCalledTimes(1);
    expect(db.settlementMatch.groupBy.mock.calls[0][0].where).toEqual({
      companyId: 'c1', statementId: { in: ['a', 'b'] }, ...openLineWhere(),
    });
  });
});
