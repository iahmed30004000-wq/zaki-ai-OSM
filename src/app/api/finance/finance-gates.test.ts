import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The money gates: no fund movement before settlement approval, no approval
 * over an unexplained gap, no closing approved by the person who recorded
 * it, and an unexplained difference blocks the next day.
 */

const { db, requireContext, requirePermission, logAudit, recordMovement, markPayableForOrders, receiptGap, runMatching, blockingClosing, walletBalance } =
  vi.hoisted(() => ({
    db: {
      // `updateMany` is the conditional claim the approval and a new receipt now take first (approvedAt: null).
      courierStatement: { findFirst: vi.fn(), update: vi.fn(), updateMany: vi.fn() },
      statementReceipt: { create: vi.fn(), aggregate: vi.fn(), findFirst: vi.fn() },
      wallet: { findFirst: vi.fn() },
      // Approving a statement now also closes the deliveries it reports.
      order: { updateMany: vi.fn(), findMany: vi.fn(), update: vi.fn() },
      orderActivity: { create: vi.fn() },
      // The statement promotion counts the delivery on the customer too.
      customer: { update: vi.fn(async () => ({})) },
      orderItem: { findMany: vi.fn() },
      inventoryMovement: { findFirst: vi.fn(), create: vi.fn() },
      productionBatch: { findMany: vi.fn(), update: vi.fn() },
      dailyClosing: { findFirst: vi.fn(), findUnique: vi.fn(), upsert: vi.fn(), update: vi.fn(), updateMany: vi.fn() },
      walletMovement: { findFirst: vi.fn(), findMany: vi.fn() },
      $transaction: vi.fn(async (fn: any) => fn(db)),
    },
    requireContext: vi.fn(),
    requirePermission: vi.fn(),
    logAudit: vi.fn(),
    recordMovement: vi.fn(),
    markPayableForOrders: vi.fn(),
    receiptGap: vi.fn(),
    runMatching: vi.fn(),
    blockingClosing: vi.fn(),
    walletBalance: vi.fn(),
  }));

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
  blockingClosing: (...a: unknown[]) => blockingClosing(...a),
  walletBalance: (...a: unknown[]) => walletBalance(...a),
}));
vi.mock('@/lib/commission', async (orig) => ({
  ...(await orig<typeof import('@/lib/commission')>()),
  markPayableForOrders: (...a: unknown[]) => markPayableForOrders(...a),
}));

vi.mock('@/lib/stock-consumption', () => ({ consumeOrderStock: vi.fn().mockResolvedValue({ taken: 0, short: 0, alreadyDone: false }) }));

import { PATCH as approveStatement } from '@/app/api/finance/statements/[id]/route';
import { POST as runMatch } from '@/app/api/finance/statements/[id]/match/route';
import { POST as recordClosing, PATCH as approveClosing } from '@/app/api/finance/closing/route';
import { POST as addReceipt } from '@/app/api/finance/statements/[id]/receipts/route';

const ID = '88888888-8888-4888-8888-888888888888';
const body = (b: unknown, method = 'PATCH') =>
  new Request('http://localhost/x', { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(b) });
const CLOSING_ID = '99999999-9999-4999-8999-999999999999';
const params = { params: Promise.resolve({ id: ID }) };

beforeEach(() => {
  vi.clearAllMocks();
  // Nothing still in flight unless a test says so.
  db.order.findMany.mockResolvedValue([]);
  db.orderItem.findMany.mockResolvedValue([]);
  db.inventoryMovement.findFirst.mockResolvedValue(null);
  requireContext.mockResolvedValue({
    user: { id: 'u1', name: 'Accountant', role: 'ACCOUNTANT', status: 'ACTIVE' },
    companyId: 'c1', storeId: 's1',
    country: { minorUnit: 3, currencyCode: 'JOD' },
  });
  requirePermission.mockResolvedValue({});
  db.courierStatement.update.mockResolvedValue({ id: ID, status: 'APPROVED' });
  db.courierStatement.updateMany.mockResolvedValue({ count: 1 });
  db.walletMovement.findMany.mockResolvedValue([]);
  db.order.updateMany.mockResolvedValue({ count: 0 });
  markPayableForOrders.mockResolvedValue(0);
  // The approval recomputes the book balance; by default nothing moved
  // since the count, so the recorded difference still holds.
  walletBalance.mockResolvedValue({ balance: 100 });
  db.dailyClosing.updateMany.mockResolvedValue({ count: 1 });
  db.dailyClosing.findUnique.mockResolvedValue({ id: CLOSING_ID, status: 'APPROVED' });
});

describe('statement approval', () => {
  const statement = (over: Record<string, unknown> = {}) => ({
    id: ID, status: 'MATCHED', reference: 'ST-1', gapExplanation: null,
    receipts: [{ id: 'r1', walletId: 'w1', amount: 90 }],
    matches: [{ orderId: 'o1', result: 'MATCHED' }],
    ...over,
  });

  it('refuses a statement with no receipts — nothing arrived yet', async () => {
    db.courierStatement.findFirst.mockResolvedValue(statement({ receipts: [] }));
    const res = await approveStatement(body({ approve: true }), params);
    expect(res.status).toBe(409);
    expect((await res.json()).code).toBe('NO_RECEIPTS');
    expect(recordMovement).not.toHaveBeenCalled();
  });

  it('refuses to approve an unexplained gap', async () => {
    db.courierStatement.findFirst.mockResolvedValue(statement());
    receiptGap.mockResolvedValue({ claimed: 100, received: 90, gap: -10, needsExplanation: true, explained: false });

    const res = await approveStatement(body({ approve: true }), params);
    expect(res.status).toBe(409);
    expect((await res.json()).code).toBe('GAP_REQUIRES_EXPLANATION');
    expect(recordMovement).not.toHaveBeenCalled();
  });

  it('refuses to approve before matching has run', async () => {
    db.courierStatement.findFirst.mockResolvedValue(statement({ matches: [] }));
    receiptGap.mockResolvedValue({ claimed: 100, received: 100, gap: 0, needsExplanation: false, explained: false });

    const res = await approveStatement(body({ approve: true }), params);
    expect((await res.json()).code).toBe('MATCHING_REQUIRED');
  });

  it('moves the money and makes commission payable only on approval', async () => {
    db.courierStatement.findFirst.mockResolvedValue(statement());
    receiptGap.mockResolvedValue({ claimed: 90, received: 90, gap: 0, needsExplanation: false, explained: false });

    const res = await approveStatement(body({ approve: true }), params);
    expect(res.status).toBe(200);
    expect(recordMovement).toHaveBeenCalledTimes(1);
    expect(recordMovement.mock.calls[0][1]).toMatchObject({ direction: 'IN', amount: 90, category: 'COURIER_SETTLEMENT' });
    expect(markPayableForOrders).toHaveBeenCalledWith(expect.anything(), 'c1', ['o1']);
  });

  /**
   * The early gate is not a duplicate of the approval gate: it stands BEFORE
   * the branch that saves a gap explanation. Without it, a statement whose
   * money has moved can still have its written reason rewritten.
   */
  it('refuses to rewrite the gap explanation of one whose money has moved', async () => {
    db.courierStatement.findFirst.mockResolvedValue(
      statement({ status: 'MATCHED', approvedAt: new Date('2026-09-20T00:00:00.000Z') })
    );
    const res = await approveStatement(body({ gapExplanation: 'سببٌ جديدٌ بعد الاعتماد' }), params);
    expect(res.status).toBe(409);
    expect((await res.json()).code).toBe('ALREADY_APPROVED');
    expect(db.courierStatement.update).not.toHaveBeenCalled();
  });

  it('never approves twice', async () => {
    db.courierStatement.findFirst.mockResolvedValue(statement({ status: 'APPROVED' }));
    expect((await approveStatement(body({ approve: true }), params)).status).toBe(409);
  });

  /**
   * ── THE DOUBLE-POST ──
   *
   * `status` carried two facts: where the statement is in the flow, and
   * whether its money has moved. Re-running matching wrote MATCHED over
   * APPROVED, every gate below then passed a second time, and a second IN
   * movement was written for the same receipt. Proved on the dev database:
   * 1,889.48 USD posted twice.
   */
  it('never approves one whose status was reset after the money moved', async () => {
    db.courierStatement.findFirst.mockResolvedValue(
      statement({ status: 'MATCHED', approvedAt: new Date('2026-09-20T00:00:00.000Z') })
    );
    receiptGap.mockResolvedValue({ claimed: 90, received: 90, gap: 0, needsExplanation: false, explained: false });

    const res = await approveStatement(body({ approve: true }), params);
    expect(res.status).toBe(409);
    expect((await res.json()).code).toBe('ALREADY_APPROVED');
    expect(recordMovement).not.toHaveBeenCalled();
  });
});

describe('re-running matching', () => {
  const found = (over: Record<string, unknown> = {}) => ({
    id: ID, status: 'RECEIPTED', approvedAt: null, reference: 'ST-1',
    _count: { receipts: 1 },
    ...over,
  });

  beforeEach(() => {
    runMatching.mockResolvedValue({ matched: 1, mismatched: 0, feeMismatched: 0, missingInSystem: 0, missingInStatement: 0 });
    db.courierStatement.update.mockResolvedValue({ id: ID, status: 'MATCHED' });
  });

  it('runs while the statement is unapproved', async () => {
    db.courierStatement.findFirst.mockResolvedValue(found());
    expect((await runMatch(body({}, 'POST'), params)).status).toBe(200);
    expect(runMatching).toHaveBeenCalledTimes(1);
  });

  it('refuses before a receipt exists', async () => {
    db.courierStatement.findFirst.mockResolvedValue(found({ _count: { receipts: 0 } }));
    const res = await runMatch(body({}, 'POST'), params);
    expect(res.status).toBe(409);
    expect((await res.json()).code).toBe('RECEIPT_REQUIRED');
    expect(runMatching).not.toHaveBeenCalled();
  });

  /** The fix: it must not touch an approved statement, and above all must
   *  not write its status back to MATCHED. */
  it('refuses an APPROVED statement and leaves its status alone', async () => {
    db.courierStatement.findFirst.mockResolvedValue(found({ status: 'APPROVED', approvedAt: new Date() }));
    const res = await runMatch(body({}, 'POST'), params);
    expect(res.status).toBe(409);
    expect((await res.json()).code).toBe('ALREADY_APPROVED');
    expect(runMatching).not.toHaveBeenCalled();
    expect(db.courierStatement.update).not.toHaveBeenCalled();
  });

  it('refuses one whose status was already reset but whose money moved', async () => {
    db.courierStatement.findFirst.mockResolvedValue(
      found({ status: 'MATCHED', approvedAt: new Date('2026-09-20T00:00:00.000Z') })
    );
    expect((await runMatch(body({}, 'POST'), params)).status).toBe(409);
    expect(db.courierStatement.update).not.toHaveBeenCalled();
  });
});

describe('daily closing', () => {
  beforeEach(() => {
    db.wallet.findFirst.mockResolvedValue({ id: 'w1', name: 'الصندوق', isActive: true, country: { minorUnit: 3 } });
    walletBalance.mockResolvedValue({ balance: 100 });
    blockingClosing.mockResolvedValue(null);
    db.dailyClosing.findUnique.mockResolvedValue(null);
    db.dailyClosing.upsert.mockImplementation(async ({ create }: any) => ({ id: 'cl1', ...create }));
  });

  it('refuses a non-zero difference with no explanation', async () => {
    const res = await recordClosing(
      body({ walletId: ID, date: '2026-09-20', actualBalance: 95 }, 'POST')
    );
    expect(res.status).toBe(400);
    expect((await res.json()).code).toBe('EXPLANATION_REQUIRED');
    expect(db.dailyClosing.upsert).not.toHaveBeenCalled();
  });

  it('blocks the day after an unexplained difference', async () => {
    blockingClosing.mockResolvedValue({ id: 'cl0', date: new Date('2026-09-19'), difference: -5 });
    const res = await recordClosing(body({ walletId: ID, date: '2026-09-20', actualBalance: 100 }, 'POST'));
    expect(res.status).toBe(409);
    expect((await res.json()).code).toBe('PREVIOUS_CLOSING_UNEXPLAINED');
  });

  it('accepts a matching count', async () => {
    const res = await recordClosing(body({ walletId: ID, date: '2026-09-20', actualBalance: 100 }, 'POST'));
    expect(res.status).toBe(201);
    expect(db.dailyClosing.upsert.mock.calls[0][0].create).toMatchObject({ difference: 0, bookBalance: 100 });
  });

  it('refuses approval by the person who recorded it', async () => {
    db.dailyClosing.findFirst.mockResolvedValue({
      id: CLOSING_ID, walletId: 'w1', date: new Date('2026-09-20'), difference: 0, actualBalance: 100, status: 'OPEN',
      recordedById: 'u1', explanation: null, wallet: { id: 'w1', name: 'الصندوق', country: { minorUnit: 3 } },
    });
    db.walletMovement.findFirst.mockResolvedValue(null);

    const res = await approveClosing(body({ closingId: CLOSING_ID }));
    expect(res.status).toBe(403);
    expect((await res.json()).code).toBe('SEGREGATION_OF_DUTIES');
  });

  it('refuses approval by someone who recorded that wallet’s movements that day', async () => {
    db.dailyClosing.findFirst.mockResolvedValue({
      id: CLOSING_ID, walletId: 'w1', date: new Date('2026-09-20'), difference: 0, actualBalance: 100, status: 'OPEN',
      recordedById: 'someone-else', explanation: null, wallet: { id: 'w1', name: 'الصندوق', country: { minorUnit: 3 } },
    });
    db.walletMovement.findFirst.mockResolvedValue({ id: 'm1' });

    expect((await approveClosing(body({ closingId: CLOSING_ID }))).status).toBe(403);
  });

  it('approves when a different person signs it off', async () => {
    db.dailyClosing.findFirst.mockResolvedValue({
      id: CLOSING_ID, walletId: 'w1', date: new Date('2026-09-20'), difference: 0, actualBalance: 100, status: 'OPEN',
      recordedById: 'someone-else', explanation: null, wallet: { id: 'w1', name: 'الصندوق', country: { minorUnit: 3 } },
    });
    db.walletMovement.findFirst.mockResolvedValue(null);

    const res = await approveClosing(body({ closingId: CLOSING_ID }));
    expect(res.status).toBe(200);
  });

  /**
   * THE DIFFERENCE WAS WORKED OUT WHEN THE CASH WAS COUNTED.
   *
   * Every movement posted between the count and the approval moves the
   * book balance under it, so a row can still say «zero» while the till is
   * short by whatever went through in between. Approving that number signs
   * off a discrepancy nobody ever looked at.
   */
  it('refuses to approve a difference the book has moved away from', async () => {
    db.dailyClosing.findFirst.mockResolvedValue({
      id: CLOSING_ID, walletId: 'w1', date: new Date('2026-09-20'), difference: 0, actualBalance: 100,
      status: 'OPEN', recordedById: 'someone-else', explanation: null,
      wallet: { id: 'w1', name: 'الصندوق', country: { minorUnit: 3 } },
    });
    db.walletMovement.findFirst.mockResolvedValue(null);
    // 40 went out after the count: the till is now 40 over the book.
    walletBalance.mockResolvedValue({ balance: 60 });

    const res = await approveClosing(body({ closingId: CLOSING_ID }));
    expect(res.status).toBe(409);
    const json = await res.json();
    expect(json.code).toBe('CLOSING_OUT_OF_DATE');
    // Both numbers, because «it changed» without them is unactionable.
    expect(json).toMatchObject({ recordedDifference: 0, currentDifference: 40 });
    expect(db.dailyClosing.updateMany, 'اعتمد رغم أن الرقم تغيّر').not.toHaveBeenCalled();
  });

  /**
   * TWO APPROVERS PRESSING AT ONCE.
   *
   * The status check above the write is a read: both passed it, both
   * wrote, and the second name and timestamp replaced the first on the
   * record of a cash count. The row decides now.
   */
  it('lets exactly one approval land, and tells the loser', async () => {
    db.dailyClosing.findFirst.mockResolvedValue({
      id: CLOSING_ID, walletId: 'w1', date: new Date('2026-09-20'), difference: 0, actualBalance: 100,
      status: 'OPEN', recordedById: 'someone-else', explanation: null,
      wallet: { id: 'w1', name: 'الصندوق', country: { minorUnit: 3 } },
    });
    db.walletMovement.findFirst.mockResolvedValue(null);
    db.dailyClosing.updateMany.mockResolvedValue({ count: 0 });

    const res = await approveClosing(body({ closingId: CLOSING_ID }));
    expect(res.status).toBe(409);
    expect((await res.json()).code).toBe('ALREADY_APPROVED');
    expect(logAudit, 'كتب في السجلّ اعتماداً لم يحدث').not.toHaveBeenCalled();
  });

  it('writes the approval only while the row is not approved yet', async () => {
    db.dailyClosing.findFirst.mockResolvedValue({
      id: CLOSING_ID, walletId: 'w1', date: new Date('2026-09-20'), difference: 0, actualBalance: 100,
      status: 'OPEN', recordedById: 'someone-else', explanation: null,
      wallet: { id: 'w1', name: 'الصندوق', country: { minorUnit: 3 } },
    });
    db.walletMovement.findFirst.mockResolvedValue(null);

    await approveClosing(body({ closingId: CLOSING_ID }));
    expect(db.dailyClosing.updateMany.mock.calls[0][0].where).toMatchObject({
      id: CLOSING_ID, status: { not: 'APPROVED' },
    });
  });
});

describe('the statement is the delivery proof', () => {
  // The courier has told us in writing that they delivered this parcel and
  // collected this amount. Reading that and then asking somebody to tick
  // "delivered" by hand is the same fact entered twice — and every order
  // nobody got round to ticking sat in the tracking list forever, long
  // after the money had arrived.
  const ID2 = '11111111-1111-4111-8111-111111111111';
  const approveWith = async (matches: unknown[], inFlight: { id: string; orderNumber?: string }[], awaitingAmount: { id: string }[] = []) => {
    db.courierStatement.findFirst.mockResolvedValue({
      id: ID2,
      status: 'MATCHED',
      reference: 'ST-1',
      gapExplanation: null,
      periodTo: new Date('2026-09-20T00:00:00.000Z'),
      // A statement cannot be approved with no receipt at all.
      receipts: [{ id: 'r1', walletId: 'w1', amount: 50.01 }],
      matches,
    });
    db.courierStatement.update.mockResolvedValue({ id: ID2 });
    // Two reads now, in order: the orders still in flight (promoted to
    // DELIVERED), then the matched ones that were delivered by hand and have
    // no amount yet. `awaitingAmount` defaults to none so the older tests
    // describe exactly what they always did.
    db.order.findMany.mockReset();
    db.order.findMany.mockResolvedValueOnce(inFlight).mockResolvedValueOnce(awaitingAmount);
    receiptGap.mockResolvedValue({ claimed: 0, received: 0, gap: 0, needsExplanation: false, explained: false });
    return approveStatement(
      new Request('http://localhost/x', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ approve: true }),
      }),
      { params: Promise.resolve({ id: ID2 }) }
    );
  };

  it('closes a matched order that is still in flight', async () => {
    const res = await approveWith(
      [{ orderId: 'o1', result: 'MATCHED', statementAmount: 50.01 }],
      [{ id: 'o1', orderNumber: 'SY-1' }]
    );
    expect(res.status).toBe(200);
    const written = db.order.update.mock.calls[0][0].data;
    expect(written.shippingStatus).toBe('DELIVERED');
    expect(written.collectedAmount).toBe(50.01);
    // The courier's period end, not the moment somebody uploaded a file.
    expect(written.deliveredAt).toEqual(new Date('2026-09-20T00:00:00.000Z'));
  });

  it('leaves the STATUS and DATE of one delivered by hand alone', async () => {
    // Whoever stood there knows what happened; only the money is the
    // statement's to write, and there is none to write here.
    await approveWith([{ orderId: 'o1', result: 'MATCHED', statementAmount: 50 }], []);
    expect(db.order.update).not.toHaveBeenCalled();
  });

  it('does not close an order the statement did not match', async () => {
    await approveWith([{ orderId: 'o1', result: 'MISMATCHED', statementAmount: 10 }], []);
    expect(db.order.findMany.mock.calls[0][0].where.id).toEqual({ in: [] });
  });

  /**
   * OLD → NEW (matcher integrity): the list gains FAILED_DELIVERY. A parcel marked failed that the courier then
   * delivered and paid for matched at the collected amount, was settled, and stayed «فشل التوصيل» for ever.
   * RETURN_REQUESTED and RETURNED are NOT in the list: a parcel coming back is not promoted to delivered.
   */
  it('only ever CLOSES orders still on the road — a failed attempt included, a return never', async () => {
    await approveWith([{ orderId: 'o1', result: 'MATCHED', statementAmount: 50 }], []);
    const asked = db.order.findMany.mock.calls[0][0].where.shippingStatus;
    expect(asked).toEqual({
      in: ['SHIPPED', 'OUT_FOR_DELIVERY', 'READY_FOR_PICKUP', 'FAILED_DELIVERY'],
    });
    expect(asked.in).not.toContain('RETURN_REQUESTED');
    expect(asked.in).not.toContain('RETURNED');
    expect(asked.in).not.toContain('DELIVERED');
  });

  it('promotes a FAILED_DELIVERY order that the statement paid for: delivered, dated, counted out of stock', async () => {
    const res = await approveWith(
      [{ orderId: 'o7', result: 'MATCHED', statementAmount: 47.5, statementFee: 2.5 }],
      [{ id: 'o7', orderNumber: 'SY-7', customerId: 'cu7' } as never]
    );
    expect(res.status).toBe(200);
    const written = db.order.update.mock.calls[0][0].data;
    expect(written).toMatchObject({ shippingStatus: 'DELIVERED', collectedAmount: 50 });
    expect(db.customer.update.mock.calls[0][0].data.deliveredOrders).toEqual({ increment: 1 });
    expect(db.orderActivity.create.mock.calls[0][0].data.action).toBe('DELIVERED_BY_STATEMENT');
  });

  it('and never promotes an order the statement did not MATCH, whatever its state', async () => {
    await approveWith([{ orderId: 'o7', result: 'MISMATCHED', statementAmount: 10 }], []);
    expect(db.order.findMany.mock.calls[0][0].where.id).toEqual({ in: [] });
  });

  /**
   * BUT THE MONEY REACHES THE ONES IT DOES NOT CLOSE.
   *
   * The door stopped writing `collectedAmount` — a follow-up agent repeating
   * what a courier said on the phone is not what arrived. If this sweep also
   * skipped those orders, the amount would stay null for ever: recording a
   * delivery by hand would remove the order from the only thing that knows
   * what the courier paid.
   */
  it('and writes the amount on one delivered by hand, which it does not close', async () => {
    await approveWith(
      [{ orderId: 'o2', result: 'MATCHED', statementAmount: 41.5 }],
      [],
      [{ id: 'o2' }]
    );
    const written = db.order.update.mock.calls.at(-1)?.[0].data;
    expect(written.collectedAmount, 'المبلغ لم يصل الطلب المُسجَّل يدويّاً').toBe(41.5);
    // Its status and date are the door's, and are left alone.
    expect(written.shippingStatus).toBeUndefined();
    expect(written.deliveredAt).toBeUndefined();
  });

  /** Never twice for one order, and never a second version bump. */
  it('and never writes to an order the in-flight loop already wrote', async () => {
    await approveWith(
      [{ orderId: 'o1', result: 'MATCHED', statementAmount: 50 }],
      [{ id: 'o1', orderNumber: 'SY-1' }]
    );
    expect(db.order.findMany.mock.calls[1][0].where.id).toEqual({ in: [] });
  });

  /** A correction is deliberate, not a side effect of re-importing a file. */
  it('and never overwrites an amount that is already there', async () => {
    await approveWith([{ orderId: 'o3', result: 'MATCHED', statementAmount: 9 }], []);
    expect(db.order.findMany.mock.calls[1][0].where.collectedAmount).toBeNull();
  });
});

/**
 * RECORDING WHAT ARRIVED — ONCE.
 *
 * Many receipts on one statement are correct: a courier pays part in cash
 * and part by transfer. That is exactly why the server cannot recognise a
 * double-click — two identical receipts seconds apart are also a courier
 * paying the same amount twice. The caller carries an id for its attempt,
 * and a replay of that attempt finds the row it already wrote.
 */
describe('recording a receipt', () => {
  const RECEIPT_ID = '77777777-7777-4777-8777-777777777777';
  const payload = (over: Record<string, unknown> = {}) => ({
    receiptId: RECEIPT_ID, walletId: '11111111-1111-4111-8111-111111111111', amount: 90, ...over,
  });

  beforeEach(() => {
    db.courierStatement.findFirst.mockResolvedValue({ id: ID, status: 'MATCHED', currencyCode: 'JOD', reference: 'ST-1' });
    db.wallet.findFirst.mockResolvedValue({ id: '11111111-1111-4111-8111-111111111111', name: 'الصندوق', currencyCode: 'JOD' });
    db.statementReceipt.findFirst.mockResolvedValue(null);
    db.statementReceipt.create.mockResolvedValue({ id: RECEIPT_ID, amount: 90 });
    receiptGap.mockResolvedValue({ claimed: 90, received: 90, gap: 0, needsExplanation: false, explained: true });
  });

  it('writes the receipt and the statement status in one transaction', async () => {
    const res = await addReceipt(body(payload(), 'POST'), params);
    expect(res.status).toBe(201);
    // Both writes go through the transaction client, not around it: a
    // failure between them would record money against a statement that
    // still says nobody has paid.
    expect(db.$transaction).toHaveBeenCalledTimes(1);
    expect(db.statementReceipt.create).toHaveBeenCalledTimes(1);
    // The status is written as a conditional claim now (only a statement still unapproved takes it), so the
    // assertion names the condition that used to be absent.
    expect(db.courierStatement.updateMany).toHaveBeenCalledWith({
      where: { id: ID, companyId: 'c1', approvedAt: null, status: { not: 'APPROVED' } },
      data: { status: 'RECEIPTED' },
    });
  });

  it('uses the caller’s id as the row’s own, so the database enforces it', async () => {
    await addReceipt(body(payload(), 'POST'), params);
    expect(db.statementReceipt.create.mock.calls[0][0].data.id).toBe(RECEIPT_ID);
  });

  it('answers a repeat of the same attempt with the row already written', async () => {
    db.statementReceipt.findFirst.mockResolvedValue({ id: RECEIPT_ID, amount: 90 });
    const res = await addReceipt(body(payload(), 'POST'), params);
    expect(res.status).toBe(200);
    expect((await res.json()).replay).toBe(true);
    // The second press must not add a second 90 to the money that arrived.
    expect(db.statementReceipt.create, 'سجَّل الإيصال مرّتين').not.toHaveBeenCalled();
  });

  it('looks for the earlier attempt inside this company and statement only', async () => {
    await addReceipt(body(payload(), 'POST'), params);
    expect(db.statementReceipt.findFirst.mock.calls[0][0].where).toMatchObject({
      id: RECEIPT_ID, companyId: 'c1', statementId: ID,
    });
  });

  it('still records a genuine second payment carrying its own id', async () => {
    await addReceipt(body(payload({ receiptId: '66666666-6666-4666-8666-666666666666', amount: 40 }), 'POST'), params);
    expect(db.statementReceipt.create).toHaveBeenCalledTimes(1);
    expect(db.statementReceipt.create.mock.calls[0][0].data.amount).toBe(40);
  });

  it('refuses an id that is taken, rather than reporting a success it did not have', async () => {
    const conflict = Object.assign(new Error('Unique constraint failed'), { code: 'P2002' });
    Object.setPrototypeOf(conflict, (await import('@prisma/client')).Prisma.PrismaClientKnownRequestError.prototype);
    db.$transaction.mockRejectedValueOnce(conflict);
    const res = await addReceipt(body(payload(), 'POST'), params);
    expect(res.status).toBe(409);
    expect((await res.json()).code).toBe('RECEIPT_EXISTS');
  });

  it('refuses to record anything against an approved statement', async () => {
    db.courierStatement.findFirst.mockResolvedValue({ id: ID, status: 'APPROVED', currencyCode: 'JOD', reference: 'ST-1' });
    const res = await addReceipt(body(payload(), 'POST'), params);
    expect(res.status).toBe(409);
    expect(db.statementReceipt.create).not.toHaveBeenCalled();
  });
});
