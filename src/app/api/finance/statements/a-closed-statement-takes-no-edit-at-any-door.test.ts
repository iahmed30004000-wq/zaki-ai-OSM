import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * A CLOSED STATEMENT TAKES NO EDIT AT ANY DOOR — and every door says it in the same sentence, and writes nothing.
 *
 * These drive the REAL routes against a fake database. Two things are asserted at each door, not one:
 *
 *   · the read said «approved» → the door refuses with the one sentence, and no write is attempted;
 *   · the read said «open» but the WRITE found it approved (an approval landed in between) → the same sentence,
 *     and nothing that follows the write is done. That is the half a mock told the answer cannot prove: the fake
 *     here answers `count: 0` to a conditional write on a statement that is no longer open, exactly as the
 *     database does.
 *
 * Since 2/11 («افصل المطابقة عن التحصيل») «closed» is two stamps: the money (`approvedAt`) closes the receipts, the gap
 * and the undo; the close of the matching (`matchingClosedAt`) closes the re-match. The approval no longer waits on a
 * line: it posts the money and leaves the matching open while a line is a question.
 */

const { db, requireContext, requirePermission, logAudit, recordMovement, receiptGap, markPayableForOrders, runMatching, state } =
  vi.hoisted(() => {
    const state = {
      /** The statement as the database has it right now. */
      approved: false,
      /** …and whether its matching is closed (the orders settled). */
      closed: false,
      /** What a READ of the statement says (can lag the truth: a read taken just before an approval). */
      readsAs: 'open' as 'open' | 'approved' | 'closed',
      matches: [] as Record<string, unknown>[],
    };
    const db = {
      courierStatement: {
        findFirst: vi.fn(async (a: { include?: unknown }) => {
          const approvedAt = state.readsAs !== 'open' ? new Date('2026-10-28T10:00:00Z') : null;
          return {
            id: 'st1', status: approvedAt ? 'APPROVED' : 'MATCHED', approvedAt, reference: 'ST-1', gapExplanation: null,
            matchingClosedAt: state.readsAs === 'closed' ? new Date('2026-10-28T10:00:00Z') : null,
            periodTo: null, fileHash: 'ab'.repeat(32),
            receipts: [{ id: 'r1', walletId: 'w1', amount: 35 }],
            matches: state.matches.map((m) => ({ ...m, order: { orderNumber: `N-${m.orderId}`, settlementMatches: [] } })),
            _count: { receipts: 1 },
            ...(a?.include ? {} : {}),
          };
        }),
        // A conditional write on a statement: it takes only a statement that is open in the DATABASE.
        updateMany: vi.fn(async (a: { where: { approvedAt?: unknown; matchingClosedAt?: null } }) => {
          if (a.where.approvedAt === null && state.approved) return { count: 0 };
          if (a.where.approvedAt !== undefined && a.where.approvedAt !== null && !state.approved) return { count: 0 };
          if (a.where.matchingClosedAt === null && state.closed) return { count: 0 };
          return { count: 1 };
        }),
      },
      settlementMatch: { updateMany: vi.fn(async () => ({ count: 1 })), findMany: vi.fn(async () => []) },
      walletMovement: { findMany: vi.fn(async () => []) },
      user: { findMany: vi.fn(async () => []) },
      order: { updateMany: vi.fn(async (a: { where: { id: { in: unknown[] } } }) => ({ count: a.where.id.in.length })), findMany: vi.fn(async () => []), update: vi.fn() },
      orderActivity: { create: vi.fn() },
      customer: { update: vi.fn() },
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

import { PATCH } from './[id]/route';
import { POST as runMatch } from './[id]/match/route';

const CLOSED = 'الكشف مغلق نهائياً — التصحيح بكشف تسوية';
const params = { params: Promise.resolve({ id: 'st1' }) };
const send = (method: string, body: unknown) =>
  new Request('http://localhost/x', { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
const approve = () => PATCH(send('PATCH', { approve: true }), params);
const explain = () => PATCH(send('PATCH', { gapExplanation: 'الفرق من أجرة التوصيل' }), params);
const rematch = () => runMatch(send('POST', {}), params);

const clean = (orderId: string) => ({ id: `m-${orderId}`, orderId, result: 'MATCHED', resolution: null, statementAmount: 20, statementFee: 0, expectedAmount: 20 });

beforeEach(() => {
  vi.clearAllMocks();
  state.approved = false;
  state.closed = false;
  state.readsAs = 'open';
  state.matches = [clean('o1')];
  requireContext.mockResolvedValue({
    user: { id: 'u1', name: 'المحاسب' }, companyId: 'c1', storeId: 's1', country: { minorUnit: 3, currencyCode: 'JOD' },
  });
  requirePermission.mockResolvedValue({});
  receiptGap.mockResolvedValue({ claimed: 35, received: 35, gap: 0, needsExplanation: false, explained: false, unconvertible: 0 });
  markPayableForOrders.mockResolvedValue(0);
  recordMovement.mockResolvedValue({ id: 'mv1' });
  runMatching.mockResolvedValue({ matched: 1 });
  db.order.updateMany.mockImplementation(async (a: { where: { id: { in: unknown[] } } }) => ({ count: a.where.id.in.length }));
  db.order.findMany.mockResolvedValue([]);
});

/* ───────────────────────────── the matching, run again ───────────────────────────── */

describe('running the matching again', () => {
  it('on a closed statement: the one sentence, and the matching does not run', async () => {
    state.readsAs = 'closed';
    state.approved = true;
    state.closed = true;
    const res = await rematch();
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ code: 'ALREADY_APPROVED', error: CLOSED });
    expect(runMatching).not.toHaveBeenCalled();
    expect(db.courierStatement.updateMany).not.toHaveBeenCalled();
  });

  it('a close that lands after the read: the WRITE refuses it, with the same sentence, and the matching never runs', async () => {
    state.readsAs = 'open';
    state.approved = true; // the database is ahead of the read: approved AND closed
    state.closed = true;
    const res = await rematch();
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ code: 'ALREADY_APPROVED', error: CLOSED });
    expect(runMatching).not.toHaveBeenCalled();
    expect(logAudit).not.toHaveBeenCalled();
  });

  it('the money posted and the matching still open: it runs again — and never writes MATCHED over APPROVED, nor any money', async () => {
    state.readsAs = 'approved';
    state.approved = true;
    const res = await rematch();
    expect(res.status).toBe(200);
    expect(runMatching).toHaveBeenCalledTimes(1);
    const claims = (db.courierStatement.updateMany.mock.calls as unknown as [{ where: Record<string, unknown>; data?: unknown }][]).map((c) => c[0]);
    // The first claim is for an unapproved statement and takes nothing; the second takes it AS APPROVED.
    expect(claims[0].where).toMatchObject({ approvedAt: null, matchingClosedAt: null });
    expect(claims[1].where).toMatchObject({ matchingClosedAt: null, approvedAt: { not: null } });
    expect(claims[1].data).toEqual({ status: 'APPROVED' });
    expect(claims.some((c) => (c.data as { status?: string })?.status === 'MATCHED' && c.where.approvedAt !== null)).toBe(false);
    expect(recordMovement).not.toHaveBeenCalled();
  });

  it('on an open statement: the statement is taken FIRST, with the condition in the write, and only then is it matched', async () => {
    const res = await rematch();
    expect(res.status).toBe(200);
    const claim = (db.courierStatement.updateMany.mock.calls as unknown as [{ where: Record<string, unknown>; data?: unknown }][])[0][0];
    expect(claim.where).toMatchObject({ id: 'st1', companyId: 'c1', storeId: 's1', matchingClosedAt: null, approvedAt: null, status: { not: 'APPROVED' } });
    expect(claim.data).toEqual({ status: 'MATCHED' });
    expect(db.courierStatement.updateMany.mock.invocationCallOrder[0]).toBeLessThan(runMatching.mock.invocationCallOrder[0]);
  });
});

/* ───────────────────────────── the explanation of the gap ───────────────────────────── */

describe('writing the explanation of the gap', () => {
  it('on a closed statement: the one sentence (not «معتمد مسبقاً»), and nothing is written', async () => {
    state.readsAs = 'approved';
    state.approved = true;
    const res = await explain();
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ code: 'ALREADY_APPROVED', error: CLOSED });
    expect(db.courierStatement.updateMany).not.toHaveBeenCalled();
    expect(logAudit).not.toHaveBeenCalled();
  });

  it('an approval that lands after the read: the write carries approvedAt: null, finds nothing, and is refused the same way', async () => {
    state.approved = true;
    const res = await explain();
    expect(res.status).toBe(409);
    expect((await res.json()).error).toBe(CLOSED);
    expect(db.courierStatement.updateMany.mock.calls[0][0].where).toMatchObject({ id: 'st1', approvedAt: null, status: { not: 'APPROVED' } });
    expect(logAudit).not.toHaveBeenCalled();
  });

  it('on an open statement it is written, and audited', async () => {
    const res = await explain();
    expect(res.status).toBe(200);
    expect((await res.json()).statement.gapExplanation).toBe('الفرق من أجرة التوصيل');
    expect(logAudit).toHaveBeenCalledWith(expect.objectContaining({ action: 'STATEMENT_GAP_EXPLAINED' }));
  });

  it('pressing «اعتماد» again keeps the approval’s own answer — it is not an edit', async () => {
    state.readsAs = 'approved';
    state.approved = true;
    const res = await approve();
    expect(res.status).toBe(409);
    expect((await res.json()).error).toBe('الكشف معتمد مسبقاً');
  });
});

/* ───────────────────────────── the money does not wait for the lines; the close does ───────────────────────────── */

describe('the approval', () => {
  const moved = () => ({
    wallet: recordMovement.mock.calls.length,
    commission: markPayableForOrders.mock.calls.length,
    orders: db.order.updateMany.mock.calls.length,
    stamp: db.courierStatement.updateMany.mock.calls.length,
  });

  it('an unanswered difference: the money is posted, and not one order is settled — the matching stays open on it', async () => {
    state.matches = [clean('o1'), { id: 'm2', orderId: 'o2', result: 'MISMATCHED', resolution: null, statementAmount: 18, statementFee: 0, expectedAmount: 20 }];
    const res = await approve();
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body).toMatchObject({ matchingClosed: false, openLines: 1 });
    // One stamp — the money's. No close, no commission, no order.
    expect(moved()).toEqual({ wallet: 1, commission: 0, orders: 0, stamp: 1 });
    expect(db.courierStatement.updateMany.mock.calls[0][0].where).toMatchObject({ approvedAt: null });
  });

  it('a line no order carries, not tied and not parked, keeps the matching open too — and only the matching', async () => {
    state.matches = [clean('o1'), { id: 'm3', orderId: null, result: 'MISSING_IN_SYSTEM', resolution: null, statementAmount: 7, statementFee: null, expectedAmount: null }];
    const res = await approve();
    expect(await res.json()).toMatchObject({ matchingClosed: false, openLines: 1 });
    expect(moved()).toMatchObject({ wallet: 1, orders: 0 });
  });

  it('a difference that was answered, a line that was parked, a line a person tied, and a parcel no statement names — none holds it', async () => {
    state.matches = [
      clean('o1'),
      { id: 'm2', orderId: 'o2', result: 'MISMATCHED', resolution: 'OURS_STANDS', resolutionNote: 'نطالب بالفرق', statementAmount: 18, statementFee: 0, expectedAmount: 20 },
      { id: 'm3', orderId: null, result: 'MISSING_IN_SYSTEM', resolution: 'UNDER_REVIEW', statementAmount: 7, statementFee: null, expectedAmount: null },
      { id: 'm4', orderId: 'o4', result: 'MATCHED', resolution: null, statementAmount: 20, statementFee: 0, expectedAmount: 20 },
      { id: 'm5', orderId: 'o5', result: 'MISSING_IN_STATEMENT', resolution: null, statementAmount: null, statementFee: null, expectedAmount: 20 },
    ];
    const res = await approve();
    expect(res.status).toBe(200);
    expect(recordMovement).toHaveBeenCalledTimes(1);
    // …so the matching closes with the money, in the same press: two stamps, the money's first.
    expect(await res.json()).toMatchObject({ matchingClosed: true, openLines: 0 });
    const stamps = db.courierStatement.updateMany.mock.calls.map((c) => c[0] as { where: Record<string, unknown> });
    expect(stamps).toHaveLength(2);
    expect(stamps[0].where).toMatchObject({ approvedAt: null });
    expect(stamps[1].where).toMatchObject({ matchingClosedAt: null });
  });

  it('the lines are counted AGAIN on the rows the transaction itself read after the stamp: a row answered a moment ago and not any more keeps the matching open — the money is still posted once', async () => {
    // The first read (outside) sees every row answered; the read inside the transaction, after the stamp, finds one open.
    const answered = [clean('o1'), { id: 'm2', orderId: 'o2', result: 'MISMATCHED', resolution: 'UNDER_REVIEW', statementAmount: 18, statementFee: 0, expectedAmount: 20 }];
    const open = [clean('o1'), { id: 'm2', orderId: 'o2', result: 'MISMATCHED', resolution: null, statementAmount: 18, statementFee: 0, expectedAmount: 20 }];
    const shaped = (rows: Record<string, unknown>[]) => ({
      id: 'st1', status: 'MATCHED', approvedAt: null, reference: 'ST-1', gapExplanation: null, periodTo: null, fileHash: 'ab'.repeat(32),
      receipts: [{ id: 'r1', walletId: 'w1', amount: 35 }],
      matches: rows.map((m) => ({ ...m, order: { orderNumber: 'N', settlementMatches: [] } })),
    });
    db.courierStatement.findFirst.mockImplementationOnce(async () => shaped(answered) as never);
    db.courierStatement.findFirst.mockImplementationOnce(async () => shaped(open) as never);
    const res = await approve();
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ matchingClosed: false, openLines: 1 });
    expect(recordMovement).toHaveBeenCalledTimes(1);
    expect(markPayableForOrders).not.toHaveBeenCalled();
  });
});
