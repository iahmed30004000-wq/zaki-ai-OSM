import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * A DECISION AND AN APPROVAL AT THE SAME MOMENT — one of them wins, and the other finds out.
 *
 * The REAL approval route and the REAL decision door run against ONE fake world. Its transactions are serialised
 * (a row lock: the second waits for the first to commit), its conditional writes answer as a database does (a
 * `statement: { approvedAt: null }` in the WHERE matches nothing once the statement is approved), and a READ can
 * be held back and answered with what the world was when it started — the stale read that makes the race real.
 *
 * The row is answered «رقمنا» (a claim on the company), and somebody presses «غيّر البتّ → قيد المراجعة» in the very
 * moment the approval is pressed. Two honest endings, and one dishonest one that must never appear:
 *
 *   · the decision commits first   → the approval reads it: the row is parked, NO claim is opened;
 *   · the approval commits first   → the decision is refused with the closed sentence; the row stays «رقمنا»
 *                                    and the claim the approval opened is the claim that is on record;
 *   · never: a claim opened on the company for a row that now says «قيد المراجعة» (RV313).
 */

const { db, requireContext, requirePermission, logAudit, recordMovement, receiptGap, markPayableForOrders, world, hold } = vi.hoisted(() => {
  type Row = Record<string, unknown>;
  const world = {
    statement: { id: 'st1', status: 'MATCHED', approvedAt: null as Date | null, reference: 'ST-1' },
    matches: [] as Row[],
    activities: [] as Row[],
    notes: [] as Row[],
  };
  /** Reads held back on purpose, released by the test. */
  const hold: { resolveRead?: Promise<void>; approveRead?: Promise<void> } = {};

  const statementShape = (rows: Row[]) => ({
    id: world.statement.id, status: world.statement.status, approvedAt: world.statement.approvedAt, reference: world.statement.reference,
    gapExplanation: null, periodTo: null, fileHash: 'ab'.repeat(32),
    receipts: [{ id: 'r1', walletId: 'w1', amount: 35 }],
    matches: rows.map((m) => ({ ...m, order: { orderNumber: 'N-1', settlementMatches: [] } })),
  });

  let chain: Promise<unknown> = Promise.resolve();
  const db = {
    courierStatement: {
      findFirst: vi.fn(async () => {
        // A snapshot taken NOW, handed over later if the read is held: a stale read.
        const snap = statementShape(world.matches.map((m) => ({ ...m })));
        if (hold.approveRead) {
          const wait = hold.approveRead;
          hold.approveRead = undefined;
          await wait;
        }
        return snap;
      }),
      updateMany: vi.fn(async (a: { where: { approvedAt?: null }; data: Record<string, unknown> }) => {
        if (a.where.approvedAt === null && world.statement.approvedAt !== null) return { count: 0 };
        Object.assign(world.statement, { status: a.data.status ?? world.statement.status, approvedAt: a.data.approvedAt ?? world.statement.approvedAt });
        return { count: 1 };
      }),
    },
    settlementMatch: {
      findFirst: vi.fn(async () => {
        const m = world.matches[0];
        const snap = { ...m, statement: { reference: world.statement.reference }, order: { orderNumber: 'N-1' } };
        if (hold.resolveRead) {
          const wait = hold.resolveRead;
          hold.resolveRead = undefined;
          await wait;
        }
        return snap;
      }),
      findMany: vi.fn(async () => []),
      updateMany: vi.fn(async (a: { where: { id: string; statement?: { approvedAt: null } }; data: Record<string, unknown> }) => {
        if (a.where.statement && world.statement.approvedAt !== null) return { count: 0 };
        const row = world.matches.find((m) => m.id === a.where.id);
        if (!row) return { count: 0 };
        Object.assign(row, a.data);
        return { count: 1 };
      }),
    },
    order: {
      findMany: vi.fn(async (a: { where: Record<string, unknown> }) =>
        'shippingStatus' in a.where || 'collectedAmount' in a.where
          ? []
          : [{ id: 'o1', shippingStatus: 'DELIVERED', settlementStatus: 'PENDING_COLLECTION' }]
      ),
      updateMany: vi.fn(async (a: { where: { id: { in: unknown[] } } }) => ({ count: a.where.id.in.length })),
      update: vi.fn(),
    },
    orderChangeRequest: { findMany: vi.fn(async () => []) },
    orderNote: { create: vi.fn(async (a: { data: Row }) => { world.notes.push(a.data); }) },
    orderActivity: { create: vi.fn(async (a: { data: Row }) => { world.activities.push(a.data); }) },
    walletMovement: { findMany: vi.fn(async () => []) },
    user: { findMany: vi.fn(async () => []) },
    customer: { update: vi.fn() },
    $queryRaw: vi.fn(),
    // A row lock: transactions run one after another, in the order they begin.
    $transaction: vi.fn((fn: (tx: unknown) => unknown) => {
      const run = chain.then(() => fn(db));
      chain = run.catch(() => undefined);
      return run;
    }),
  };
  return {
    db, world, hold,
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
import { POST as decide } from './[id]/matches/[matchId]/resolve/route';
import { POST as decideMany } from './[id]/decisions/route';

const CLOSED = 'الكشف مغلق نهائياً — التصحيح بكشف تسوية';
const M1 = '99999999-9999-4999-8999-999999999999';
const send = (body: unknown) =>
  new Request('http://localhost/x', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
const approve = () =>
  PATCH(new Request('http://localhost/x', { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ approve: true }) }), {
    params: Promise.resolve({ id: 'st1' }),
  });
const park = (note = 'ننتظر ردّ الشركة') =>
  decide(send({ resolution: 'UNDER_REVIEW', note }), { params: Promise.resolve({ id: 'st1', matchId: M1 }) });

const claim = () => ({
  id: M1, statementId: 'st1', companyId: 'c1', orderId: 'o1', result: 'MISMATCHED', resolution: 'OURS_STANDS',
  resolutionNote: 'نطالب بالفرق', resolvedById: 'u0', expectedAmount: 20, statementAmount: 18, statementFee: 0, difference: -2,
});
const claimOpened = () => world.activities.some((a) => a.action === 'SETTLEMENT_CLAIM_OPENED');

beforeEach(() => {
  vi.clearAllMocks();
  Object.assign(world.statement, { status: 'MATCHED', approvedAt: null });
  world.matches = [claim()];
  world.activities = [];
  world.notes = [];
  hold.resolveRead = undefined;
  hold.approveRead = undefined;
  requireContext.mockResolvedValue({
    user: { id: 'u1', name: 'المحاسب' }, companyId: 'c1', storeId: 's1', country: { minorUnit: 3, currencyCode: 'JOD' },
  });
  requirePermission.mockResolvedValue({ id: 'u1' });
  receiptGap.mockResolvedValue({ claimed: 35, received: 35, gap: 0, needsExplanation: false, explained: false, unconvertible: 0 });
  markPayableForOrders.mockResolvedValue(0);
  recordMovement.mockResolvedValue({ id: 'mv1' });
});

describe('the approval commits first', () => {
  it('the decision that read the row before the approval is refused when it gets its turn — the claim stays as the approval recorded it', async () => {
    // The decision has READ its row (still «رقمنا») and is held there; the approval runs to the end; then the decision goes on.
    let release!: () => void;
    hold.resolveRead = new Promise<void>((r) => (release = r));
    const deciding = park();
    const approved = await approve();
    release();
    const decided = await deciding;

    expect(approved.status).toBe(200);
    expect(claimOpened()).toBe(true);
    expect(decided.status).toBe(409);
    expect(await decided.json()).toEqual({ code: 'ALREADY_APPROVED', error: CLOSED });
    // The row is exactly what the approval carried out; nothing was written over it, no note on the order, no audit row.
    expect(world.matches[0].resolution).toBe('OURS_STANDS');
    expect(world.notes).toHaveLength(0);
    expect(logAudit.mock.calls.some((c) => (c[0] as { action: string }).action === 'SETTLEMENT_DIFFERENCE_RESOLVED')).toBe(false);
  });

  it('and a decision pressed AFTER the approval is refused at the first read of the statement', async () => {
    expect((await approve()).status).toBe(200);
    const late = await park();
    expect(late.status).toBe(409);
    expect((await late.json()).error).toBe(CLOSED);
    expect(world.matches[0].resolution).toBe('OURS_STANDS');
    // The row was never offered a write: the statement was seen closed first.
    expect(db.settlementMatch.updateMany).not.toHaveBeenCalled();
  });

  it('the bulk door says the same for a closed statement, and writes nothing', async () => {
    expect((await approve()).status).toBe(200);
    db.settlementMatch.findMany.mockResolvedValueOnce([
      { id: M1, result: 'MISMATCHED', orderId: 'o1', expectedAmount: 20, statementAmount: 18, difference: -2, statementLine: { status: 'مؤجلة' }, order: { orderNumber: 'N-1' } },
    ] as never);
    const res = await decideMany(send({ matchIds: [M1], resolution: 'UNDER_REVIEW', note: 'ننتظر ردّ الشركة' }), { params: Promise.resolve({ id: 'st1' }) });
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ code: 'ALREADY_APPROVED', error: CLOSED });
    expect(db.settlementMatch.updateMany).not.toHaveBeenCalled();
    expect(world.matches[0].resolution).toBe('OURS_STANDS');
  });
});

describe('the decision commits first', () => {
  it('the approval that read the row before it carries out what the row says NOW: parked, so no claim is opened', async () => {
    // The approval has READ the statement (the row still says «رقمنا») and is held there; the decision commits; the approval goes on.
    let release!: () => void;
    hold.approveRead = new Promise<void>((r) => (release = r));
    const approving = approve();
    const decided = await park();
    release();
    const approved = await approving;

    expect(decided.status).toBe(200);
    expect(approved.status).toBe(200);
    expect(world.matches[0].resolution).toBe('UNDER_REVIEW');
    expect(claimOpened()).toBe(false);
  });
});

describe('whichever wins, the record agrees with itself', () => {
  it.each(['approval first', 'decision first'])('%s: a claim is on record if and only if the row still says «رقمنا»', async (order) => {
    if (order === 'approval first') {
      const a = approve();
      const d = park();
      await Promise.all([a, d]);
    } else {
      const d = park();
      const a = approve();
      await Promise.all([a, d]);
    }
    expect(world.statement.approvedAt).not.toBeNull();
    expect(claimOpened()).toBe(world.matches[0].resolution === 'OURS_STANDS');
    // And never twice: one approval, one wallet movement.
    expect(recordMovement).toHaveBeenCalledTimes(1);
  });
});
