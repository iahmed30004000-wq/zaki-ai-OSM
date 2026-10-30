import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  CONFIRMATION_STATUSES,
  CONFIRMATION_TRANSITIONS,
  TERMINAL_CONFIRMATION_STATUSES,
  isValidTransition,
} from '@/lib/confirmation-workflow';

/**
 * ═══════════════════════════════════════════════════════════════════════
 * «ألغِ» WORKS ON AN ORDER THE AGENT HAS ALREADY TRIED TO REACH (30/10).
 *
 * The owner: the cancel did not work on «طلباتي» — it only worked after she opened the order, recorded «العميل أجاب»
 * and then cancelled. The cause was the transition table, not the screen: `REJECTED` was allowed from NEW and IN_PROGRESS
 * only, so an order sitting in NO_ANSWER (a «لا يرد» / «مشغول» / «رقم خطأ»), FOLLOW_UP_REQUIRED (a «طلب معاودة») or
 * POSTPONED answered the reject with 409 INVALID_TRANSITION — with the contact-first rule already met.
 *
 * The decision (the owner, 28/10: «اي قرار بعد الان اتخذو دون الرجوع الي»): open REJECTED from those three — none is
 * confirmed, so there is no stock held that `endOrder` does not release — and change nothing else: contact-first stays,
 * the reason is still demanded, CONFIRMED stays closed from them, and the three ends stay ends.
 * ═══════════════════════════════════════════════════════════════════════
 */

const { db, requireContext, can, authorize, assertOrderAccess, releaseOrderLines } = vi.hoisted(() => ({
  db: {
    order: { updateMany: vi.fn(), findUnique: vi.fn(), findFirst: vi.fn() },
    customer: { findUnique: vi.fn(async () => null), update: vi.fn() },
    orderNote: { create: vi.fn() },
    orderContactAttempt: { count: vi.fn(async () => 1) },
    orderStatusLog: { create: vi.fn() },
    orderActivity: { create: vi.fn() },
    user: { findUnique: vi.fn() },
    $transaction: vi.fn(),
  },
  requireContext: vi.fn(),
  can: vi.fn(),
  authorize: vi.fn(),
  assertOrderAccess: vi.fn(),
  releaseOrderLines: vi.fn(async () => undefined),
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
vi.mock('@/lib/audit', () => ({ logAudit: vi.fn() }));
vi.mock('@/lib/notify', () => ({ notify: vi.fn() }));
vi.mock('@/lib/reservation', () => ({
  releaseOrderLines: (...a: unknown[]) => releaseOrderLines(...(a as [])),
  reserveOrderLines: vi.fn(),
}));
vi.mock('@/lib/apps/events', () => ({ emitAppEvent: vi.fn() }));
vi.mock('@/lib/conversions/emit', () => ({ queueConversions: vi.fn() }));
vi.mock('@/lib/blacklist', () => ({ AlreadyBlocked: class extends Error {}, blockPhone: vi.fn() }));

import { POST } from './route';

const ME = { id: 'agent-1', name: 'سارة', role: 'CONFIRMATION_AGENT' };
const ORDER = {
  id: 'o1', companyId: 'c1', storeId: 's1', version: 3, orderNumber: 'ORD-1',
  confirmationStatus: 'NO_ANSWER', shippingStatus: 'NOT_READY', shippedAt: null, labelPrintedAt: null,
  claimedById: ME.id, lockedById: null, lockExpiresAt: null, confirmedAt: null, customerId: 'cu1',
  nextFollowUpAt: null, followUpStatus: null, moderatorId: null,
  shippingBatchId: null, shippingBatch: null, deliveryProviderId: null, trackingNumber: null,
  courierSendStartedAt: null, totalAmount: 10, currency: 'JOD',
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
const reject = (extra: Record<string, unknown> = {}) =>
  send({ action: 'reject', rejectionReason: 'CUSTOMER_CHANGED_MIND', ...extra });

function orderIs(over: Record<string, unknown>) {
  const o = { ...ORDER, ...over };
  assertOrderAccess.mockResolvedValue({ allowed: true, order: o });
  db.order.findFirst.mockResolvedValue(o);
}

beforeEach(() => {
  vi.clearAllMocks();
  requireContext.mockResolvedValue({
    user: ME, companyId: 'c1', storeId: 's1', country: { allowNegativeStock: false },
  });
  // An agent: the contact-log key, and NOT the unlock override that would let any move through.
  can.mockImplementation((_u: unknown, key: string) => key === 'orders.contact_log');
  authorize.mockReturnValue({ allowed: true });
  db.order.updateMany.mockResolvedValue({ count: 1 });
  db.order.findUnique.mockResolvedValue({ ...ORDER });
  db.orderContactAttempt.count.mockResolvedValue(1);
  db.$transaction.mockImplementation(async (fn: (tx: unknown) => unknown) => fn(db));
  orderIs({});
});

describe('the table', () => {
  it.each(['NEW', 'IN_PROGRESS', 'NO_ANSWER', 'FOLLOW_UP_REQUIRED', 'POSTPONED'])('allows %s → REJECTED', (from) => {
    expect(isValidTransition(from, 'REJECTED')).toBe(true);
  });

  it.each(['CONFIRMED', 'REJECTED', 'CANCELLED'])('keeps %s an end: nothing leaves it', (from) => {
    expect(CONFIRMATION_TRANSITIONS[from as keyof typeof CONFIRMATION_TRANSITIONS]).toEqual([]);
    expect(TERMINAL_CONFIRMATION_STATUSES).toContain(from);
  });

  it('opens nothing else: CONFIRMED is still reachable only from NEW and IN_PROGRESS', () => {
    const into = CONFIRMATION_STATUSES.filter((s) => isValidTransition(s, 'CONFIRMED'));
    expect(into).toEqual(['NEW', 'IN_PROGRESS']);
  });
});

describe('POST /api/orders/[id]/confirmation — reject', () => {
  it.each(['NO_ANSWER', 'FOLLOW_UP_REQUIRED', 'POSTPONED'])(
    'an order in %s, with an attempt on it, is cancelled in one press — and its units go back',
    async (status) => {
      orderIs({ confirmationStatus: status });

      const res = await reject();

      expect(res.status, JSON.stringify(res.body)).toBe(200);
      expect(db.order.updateMany).toHaveBeenCalledTimes(1);
      expect(db.order.updateMany.mock.calls[0][0].data).toMatchObject({
        confirmationStatus: 'REJECTED', rejectionReason: 'CUSTOMER_CHANGED_MIND',
      });
      expect(releaseOrderLines).toHaveBeenCalledTimes(1);
    }
  );

  it.each(['FOLLOW_UP_REQUIRED', 'POSTPONED'])(
    'an order in %s with a scheduled follow-up: the cancel succeeds and the follow-up is COMPLETED, not left hanging',
    async (status) => {
      orderIs({
        confirmationStatus: status,
        nextFollowUpAt: new Date(Date.now() + 2 * 24 * 60 * 60 * 1000),
        followUpStatus: 'SCHEDULED',
      });

      const res = await reject();

      expect(res.status, JSON.stringify(res.body)).toBe(200);
      const data = db.order.updateMany.mock.calls[0][0].data;
      expect(data).toMatchObject({ confirmationStatus: 'REJECTED', followUpStatus: 'COMPLETED', followUpResolvedById: ME.id });
      expect(data.followUpResolvedAt).toBeInstanceOf(Date);
    }
  );

  it('NEGATIVE: a follow-up already closed is not rewritten by the cancel', async () => {
    orderIs({
      confirmationStatus: 'POSTPONED',
      nextFollowUpAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
      followUpStatus: 'CANCELLED',
    });

    const res = await reject();

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const data = db.order.updateMany.mock.calls[0][0].data;
    expect(data.followUpStatus).toBeUndefined();
    expect(data.followUpResolvedById).toBeUndefined();
  });

  it.each(['NO_ANSWER', 'FOLLOW_UP_REQUIRED', 'POSTPONED'])(
    'NEGATIVE: a stale version on an order in %s (it went back to the queue meanwhile) is 409 VERSION_CONFLICT and writes nothing',
    async (status) => {
      orderIs({ confirmationStatus: status });

      const res = await reject({ expectedVersion: 2 });

      expect(res.status).toBe(409);
      expect(res.body.code).toBe('VERSION_CONFLICT');
      expect(db.order.updateMany).not.toHaveBeenCalled();
      expect(releaseOrderLines).not.toHaveBeenCalled();
    }
  );

  it('NEGATIVE: with no attempt on the order it is still refused CONTACT_FIRST, and nothing is written', async () => {
    orderIs({ confirmationStatus: 'POSTPONED' });
    db.orderContactAttempt.count.mockResolvedValue(0);

    const res = await reject();

    expect(res.status).toBe(409);
    expect(res.body.code).toBe('CONTACT_FIRST');
    expect(db.order.updateMany).not.toHaveBeenCalled();
    expect(releaseOrderLines).not.toHaveBeenCalled();
  });

  it('NEGATIVE: with no reason it is still refused 400, from a waiting state too', async () => {
    orderIs({ confirmationStatus: 'NO_ANSWER' });

    const res = await send({ action: 'reject' });

    expect(res.status).toBe(400);
    expect(db.order.updateMany).not.toHaveBeenCalled();
  });

  it('NEGATIVE: «سبب آخر» still needs its sentence', async () => {
    orderIs({ confirmationStatus: 'FOLLOW_UP_REQUIRED' });

    const res = await reject({ rejectionReason: 'OTHER', note: 'قصير' });

    expect(res.status).toBe(400);
    expect(db.order.updateMany).not.toHaveBeenCalled();
  });

  it('NEGATIVE: a CONFIRMED order is still not rejected by an agent — the transition is refused, in Arabic', async () => {
    orderIs({ confirmationStatus: 'CONFIRMED', confirmedAt: new Date() });

    const res = await reject();

    expect(res.status).toBe(409);
    expect(res.body.code).toBe('INVALID_TRANSITION');
    // The words the screen uses for the two states — not the English codes.
    expect(String(res.body.errorAr)).toContain('«مؤكد»');
    expect(String(res.body.errorAr)).toContain('«مرفوض»');
    expect(String(res.body.errorAr)).not.toMatch(/CONFIRMED|REJECTED/);
    expect(db.order.updateMany).not.toHaveBeenCalled();
  });

  it('NEGATIVE: an order already ended is not ended twice', async () => {
    orderIs({ confirmationStatus: 'CANCELLED' });

    const res = await reject();

    expect(res.status).not.toBe(200);
    expect(db.order.updateMany).not.toHaveBeenCalled();
    expect(releaseOrderLines).not.toHaveBeenCalled();
  });

  it('NEGATIVE: opening the way to REJECTED does not open «تأكيد» from a waiting state', async () => {
    orderIs({ confirmationStatus: 'NO_ANSWER' });

    const res = await send({ action: 'confirm' });

    expect(res.status).toBe(409);
    expect(res.body.code).toBe('INVALID_TRANSITION');
    expect(db.order.updateMany).not.toHaveBeenCalled();
  });

  it('NEGATIVE: the «cancel» action keeps its own rule — an agent without the key is refused', async () => {
    orderIs({ confirmationStatus: 'NO_ANSWER' });

    const res = await send({ action: 'cancel', note: 'الزبون ألغى بالهاتف' });

    expect(res.status).toBe(403);
    expect(db.order.updateMany).not.toHaveBeenCalled();
  });
});
