import { beforeEach, describe, expect, it, vi } from 'vitest';
import { REGION_REQUIRED_MESSAGE, CONTACT_FIRST_MESSAGE, NOT_HELD_MESSAGE } from '@/lib/confirmation-queue';
import {
  CONFIRMATION_STATUSES,
  CONFIRMATION_TRANSITIONS,
  TERMINAL_CONFIRMATION_STATUSES,
  isValidTransition,
} from '@/lib/confirmation-workflow';

/**
 * ═══════════════════════════════════════════════════════════════════════
 * A YES WORKS FROM WHEREVER THE ORDER WAITS (7/11).
 *
 * The owner: «الطلب ما بيتأكد حتى لو الزبون أكد معهم». An order the agent postponed, or marked «لا يرد» / «طلب معاودة» from the
 * order window, sits in POSTPONED / NO_ANSWER / FOLLOW_UP_REQUIRED. The desk draws it back on her list the day its date comes,
 * with «تأكيد الطلب» alive, and the customer says yes on that very call — and the door answered 409 INVALID_TRANSITION
 * («لا يمكن الانتقال من «مؤجل» إلى «مؤكد»»), because the table opened CONFIRMED from NEW and IN_PROGRESS only. The way through
 * was to open the order and press «العميل أجاب» first, a step no card of the desk offers.
 *
 * DEFINITION OF DONE for this file:
 *   · `confirm` from each of the three waiting states, with a contact attempt on it, held by her, with a governorate ⇒ 200,
 *     ONE write that says CONFIRMED (status, confirmedAt, confirmedById), the lines reserved once, the status log reading
 *     «from the waiting state → CONFIRMED», the twin guard asked first (its lock is taken);
 *   · a follow-up that was still scheduled is completed by the yes;
 *   · NEGATIVE, from every waiting state: no contact attempt ⇒ CONTACT_FIRST · not hers ⇒ NOT_HELD · no governorate ⇒
 *     REGION_REQUIRED · a confirmed twin ⇒ TWIN_CONFIRMED · a stale version ⇒ VERSION_CONFLICT — and nothing is reserved;
 *   · the table: CONFIRMED is reachable from NEW, IN_PROGRESS, NO_ANSWER, FOLLOW_UP_REQUIRED and POSTPONED, and from no end;
 *     the three ends stay ends.
 *
 * The door under test is the real one (`confirmation/route`); only the database and the side-effect doors are stubbed, as in
 * `no-yes-without-a-governorate.test.ts`.
 * ═══════════════════════════════════════════════════════════════════════
 */

const {
  db, requireContext, can, authorize, assertOrderAccess, releaseOrderLines, reserveOrderLines,
  emitAppEvent, queueConversions, logAudit, notify,
} = vi.hoisted(() => ({
  db: {
    // `Promise<unknown[]>`: a bare `async () => []` is typed `never[]` and the twin test below cannot give it a row (the CI typecheck).
    order: { updateMany: vi.fn(), findUnique: vi.fn(), findFirst: vi.fn(), findMany: vi.fn(async (): Promise<unknown[]> => []) },
    customer: { findUnique: vi.fn(async () => null), update: vi.fn() },
    orderNote: { create: vi.fn() },
    orderContactAttempt: { count: vi.fn(async () => 1) },
    orderItem: { findMany: vi.fn(async () => []) },
    orderStatusLog: { create: vi.fn() },
    orderActivity: { create: vi.fn() },
    user: { findUnique: vi.fn() },
    $executeRaw: vi.fn(async () => 1),
    $transaction: vi.fn(),
  },
  requireContext: vi.fn(),
  can: vi.fn(),
  authorize: vi.fn(),
  assertOrderAccess: vi.fn(),
  releaseOrderLines: vi.fn(async () => undefined),
  reserveOrderLines: vi.fn(async () => undefined),
  emitAppEvent: vi.fn(async () => undefined),
  queueConversions: vi.fn(async () => undefined),
  logAudit: vi.fn(async () => undefined),
  notify: vi.fn(),
}));

vi.mock('@/lib/db', () => ({ db }));
vi.mock('@/lib/geo-context', () => ({ requireContext: (...a: unknown[]) => requireContext(...a) }));
vi.mock('@/lib/authorization', () => ({
  can: (...a: unknown[]) => can(...a),
  authorize: (...a: unknown[]) => authorize(...a),
  requirePermission: vi.fn(),
}));
vi.mock('@/lib/rbac', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  assertOrderAccess: (...a: unknown[]) => assertOrderAccess(...a),
}));
vi.mock('@/lib/audit', () => ({ logAudit: (...a: unknown[]) => logAudit(...(a as [])) }));
vi.mock('@/lib/notify', () => ({ notify: (...a: unknown[]) => notify(...a) }));
vi.mock('@/lib/reservation', () => ({
  releaseOrderLines: (...a: unknown[]) => releaseOrderLines(...(a as [])),
  reserveOrderLines: (...a: unknown[]) => reserveOrderLines(...(a as [])),
}));
vi.mock('@/lib/apps/events', () => ({ emitAppEvent: (...a: unknown[]) => emitAppEvent(...(a as [])) }));
vi.mock('@/lib/conversions/emit', () => ({ queueConversions: (...a: unknown[]) => queueConversions(...(a as [])) }));
vi.mock('@/lib/blacklist', () => ({ AlreadyBlocked: class extends Error {}, blockPhone: vi.fn() }));

import { POST } from './route';

const ME = { id: 'agent-1', name: 'سارة', role: 'CONFIRMATION_AGENT' };
const WAITING = ['NO_ANSWER', 'FOLLOW_UP_REQUIRED', 'POSTPONED'] as const;
const ORDER: Record<string, unknown> = {
  id: 'o1', companyId: 'c1', storeId: 's1', version: 3, orderNumber: 'ORD-2026-1513',
  confirmationStatus: 'POSTPONED', shippingStatus: 'NOT_READY', shippedAt: null, labelPrintedAt: null,
  claimedById: ME.id, lockedById: null, lockExpiresAt: null, confirmedAt: null, customerId: 'cu1', productId: 'p1',
  nextFollowUpAt: null, followUpStatus: null, moderatorId: null,
  shippingBatchId: null, shippingBatch: null, deliveryProviderId: null, trackingNumber: null,
  courierSendStartedAt: null, totalAmount: 10, currency: 'JOD',
  regionId: 'r-damascus',
};

const send = async (body: Record<string, unknown>) => {
  const res = await POST(
    new Request('http://localhost/x', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ expectedVersion: 3, ...body }),
    }),
    { params: Promise.resolve({ id: 'o1' }) }
  );
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
};
const confirm = (extra: Record<string, unknown> = {}) => send({ action: 'confirm', ...extra });

function orderIs(over: Record<string, unknown>) {
  const o = { ...ORDER, ...over };
  assertOrderAccess.mockResolvedValue({ allowed: true, order: o });
  db.order.findFirst.mockResolvedValue(o);
  db.order.findUnique.mockResolvedValue(o);
}

/** Nothing was decided, written or reserved. */
function expectUntouched() {
  expect(db.order.updateMany).not.toHaveBeenCalled();
  expect(db.orderStatusLog.create).not.toHaveBeenCalled();
  expect(reserveOrderLines).not.toHaveBeenCalled();
  // And nobody outside was told: no app event, no conversion, no supervisor notice.
  expect(emitAppEvent).not.toHaveBeenCalled();
  expect(queueConversions).not.toHaveBeenCalled();
  expect(notify).not.toHaveBeenCalled();
}

beforeEach(() => {
  vi.clearAllMocks();
  requireContext.mockResolvedValue({
    user: ME, companyId: 'c1', storeId: 's1', country: { allowNegativeStock: false },
  });
  // A live agent: the contact-log key and the desk key (`confirmation.work` is what binds her to the order she holds —
  // `mustHoldToWork`), and NOT the unlock / assign overrides that would let any move through.
  can.mockImplementation((_u: unknown, key: string) => key === 'orders.contact_log' || key === 'confirmation.work');
  authorize.mockReturnValue({ allowed: true });
  db.order.updateMany.mockResolvedValue({ count: 1 });
  db.order.findMany.mockResolvedValue([]);
  db.orderContactAttempt.count.mockResolvedValue(1);
  db.$transaction.mockImplementation(async (fn: (tx: unknown) => unknown) => fn(db));
  orderIs({});
});

describe('the table', () => {
  it('CONFIRMED is reachable from every open state — and from no end', () => {
    const into = CONFIRMATION_STATUSES.filter((s) => isValidTransition(s, 'CONFIRMED'));
    expect(into).toEqual(['NEW', 'IN_PROGRESS', 'NO_ANSWER', 'FOLLOW_UP_REQUIRED', 'POSTPONED']);
  });

  it.each(['CONFIRMED', 'REJECTED', 'CANCELLED'])('keeps %s an end: nothing leaves it', (from) => {
    expect(CONFIRMATION_TRANSITIONS[from as keyof typeof CONFIRMATION_TRANSITIONS]).toEqual([]);
    expect(TERMINAL_CONFIRMATION_STATUSES).toContain(from);
  });

  it('the WHOLE table: the yes opened from the three waiting states and nothing else moved (7/11)', () => {
    expect(CONFIRMATION_TRANSITIONS).toEqual({
      NEW: ['IN_PROGRESS', 'NO_ANSWER', 'FOLLOW_UP_REQUIRED', 'POSTPONED', 'CONFIRMED', 'REJECTED'],
      IN_PROGRESS: ['NO_ANSWER', 'FOLLOW_UP_REQUIRED', 'POSTPONED', 'CONFIRMED', 'REJECTED'],
      NO_ANSWER: ['IN_PROGRESS', 'FOLLOW_UP_REQUIRED', 'CONFIRMED', 'REJECTED'],
      FOLLOW_UP_REQUIRED: ['IN_PROGRESS', 'CONFIRMED', 'REJECTED'],
      POSTPONED: ['IN_PROGRESS', 'CONFIRMED', 'REJECTED'],
      CONFIRMED: [],
      REJECTED: [],
      CANCELLED: [],
    });
  });
});

describe.each(WAITING)('«تأكيد الطلب» on an order that is %s', (status) => {
  it('confirms: one write that says CONFIRMED, the lines reserved once, the twin guard asked first', async () => {
    orderIs({ confirmationStatus: status });

    const res = await confirm({ note: 'الزبون أكد على الخط' });

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(db.$executeRaw).toHaveBeenCalledTimes(1);
    expect(db.order.updateMany).toHaveBeenCalledTimes(1);
    expect(db.order.updateMany.mock.calls[0][0].data).toMatchObject({
      confirmationStatus: 'CONFIRMED',
      status: 'CONFIRMED',
      confirmedById: ME.id,
      confirmedAt: expect.any(Date),
    });
    expect(db.order.updateMany.mock.calls[0][0].where).toMatchObject({ id: 'o1', version: 3 });
    expect(reserveOrderLines).toHaveBeenCalledTimes(1);
    // The history says where it came from, in the table's own words.
    expect(db.orderStatusLog.create.mock.calls[0][0].data).toMatchObject({ previousValue: status, newValue: 'CONFIRMED' });
    expect(db.orderActivity.create.mock.calls[0][0].data).toMatchObject({ previousStatus: status, newStatus: 'CONFIRMED' });
    // The same side effects as a yes from IN_PROGRESS: the app event (its `previousStatus` is the state it waited in), the
    // conversion, the audit line and the supervisors' notice — each once.
    expect(emitAppEvent).toHaveBeenCalledTimes(1);
    expect(emitAppEvent).toHaveBeenCalledWith(
      'c1',
      'order.confirmed',
      expect.objectContaining({ orderId: 'o1', orderNumber: 'ORD-2026-1513', confirmationStatus: 'CONFIRMED', previousStatus: status })
    );
    expect(queueConversions).toHaveBeenCalledWith('c1', 'order.confirmed', 'o1');
    expect(logAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'ORDER_CONFIRMED',
        entityId: 'o1',
        previousData: expect.objectContaining({ confirmationStatus: status }),
        newData: expect.objectContaining({ confirmationStatus: 'CONFIRMED', action: 'confirm' }),
      })
    );
    expect(notify).toHaveBeenCalledTimes(1);
  });

  it('a follow-up that was still scheduled is completed by the yes', async () => {
    orderIs({ confirmationStatus: status, nextFollowUpAt: new Date('2026-11-07T10:00:00Z'), followUpStatus: 'SCHEDULED' });

    const res = await confirm();

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(db.order.updateMany.mock.calls[0][0].data).toMatchObject({ followUpStatus: 'COMPLETED', followUpResolvedById: ME.id });
  });

  it('NEGATIVE: with no contact attempt on it the holder is still told to ring first', async () => {
    orderIs({ confirmationStatus: status });
    db.orderContactAttempt.count.mockResolvedValue(0);

    const res = await confirm();

    expect(res.status).toBe(409);
    expect(res.body.code).toBe('CONTACT_FIRST');
    expect(res.body.errorAr).toBe(CONTACT_FIRST_MESSAGE);
    expectUntouched();
  });

  it('NEGATIVE: an agent who does not hold it is still refused — the yes is never a way round the pull', async () => {
    orderIs({ confirmationStatus: status, claimedById: 'someone-else' });

    const res = await confirm();

    expect(res.status).toBe(403);
    expect(res.body.code).toBe('NOT_HELD');
    expect(res.body.errorAr).toBe(NOT_HELD_MESSAGE);
    expectUntouched();
  });

  it('NEGATIVE: no governorate is still refused, whatever the state', async () => {
    orderIs({ confirmationStatus: status, regionId: null });

    const res = await confirm();

    expect(res.status).toBe(409);
    expect(res.body.code).toBe('REGION_REQUIRED');
    expect(res.body.errorAr).toBe(REGION_REQUIRED_MESSAGE);
    expectUntouched();
  });

  it('NEGATIVE: a confirmed twin of the same customer still stops the second yes — nothing is written, nothing reserved', async () => {
    orderIs({ confirmationStatus: status });
    db.order.findMany.mockResolvedValue([
      { orderNumber: 'ORD-2026-1490', confirmedAt: new Date('2026-11-06T09:00:00Z'), confirmer: { name: 'منار' } },
    ]);

    const res = await confirm();

    expect(res.status).toBe(409);
    expect(res.body.code).toBe('TWIN_CONFIRMED');
    expect(db.order.updateMany).not.toHaveBeenCalled();
    expect(reserveOrderLines).not.toHaveBeenCalled();
    expect(emitAppEvent).not.toHaveBeenCalled();
    expect(queueConversions).not.toHaveBeenCalled();
  });

  it('NEGATIVE: a stale version is still a conflict, and nothing is reserved', async () => {
    orderIs({ confirmationStatus: status });
    db.order.updateMany.mockResolvedValue({ count: 0 });

    const res = await confirm();

    expect(res.status).toBe(409);
    expect(res.body.code).toBe('VERSION_CONFLICT');
    expect(reserveOrderLines).not.toHaveBeenCalled();
    expect(emitAppEvent).not.toHaveBeenCalled();
    expect(queueConversions).not.toHaveBeenCalled();
  });

});

describe('NEGATIVE: an end is still an end', () => {
  // (CONFIRMED itself is not listed: a self-transition has always passed the table — `from !== target` in the door — and that is not this change.)
  it.each(['REJECTED', 'CANCELLED'])('a yes on a %s order is INVALID_TRANSITION and writes nothing', async (status) => {
    orderIs({ confirmationStatus: status });

    const res = await confirm();

    expect(res.status).toBe(409);
    expect(res.body.code).toBe('INVALID_TRANSITION');
    expectUntouched();
  });
});
