import { beforeEach, describe, expect, it, vi } from 'vitest';
import { REGION_REQUIRED_MESSAGE } from '@/lib/confirmation-queue';

/**
 * ═══════════════════════════════════════════════════════════════════════
 * NO CONFIRMATION WITHOUT A GOVERNORATE — THE CONFIRMATION DOOR (30/10).
 *
 * The owner: «طلب ORD-2026-0600 مؤكَّد بلا محافظة … المفروض ما يسمح لموظفة التأكيد تأكّد غير لما تحدد المحافظة». The
 * shipment screen could not price the order («لم تُحدَّد المحافظة — لا يمكن حساب أجرة التوصيل») because nothing had asked
 * for the governorate where the yes was given; `NO_REGION` only runs when the shipment is created.
 *
 * DEFINITION OF DONE for this file:
 *   · `confirm` on an order with `regionId` null / '' / absent ⇒ 409 `REGION_REQUIRED`, the sentence in `errorAr` and
 *     `error`, the status unchanged, no write, no reservation;
 *   · the override (`orders.unlock` and everything else) does not reach it;
 *   · rejecting, postponing (`schedule_follow_up`) and cancelling still work with no governorate;
 *   · NEGATIVE: with a governorate it still confirms, and reserves, exactly once.
 *
 * The door under test is the real one (`confirmation/route`); only the database and the side-effect doors are stubbed,
 * as in `a-closing-that-needs-no-call.test.ts`.
 * ═══════════════════════════════════════════════════════════════════════
 */

const { db, requireContext, can, authorize, assertOrderAccess, releaseOrderLines, reserveOrderLines } = vi.hoisted(() => ({
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
  reserveOrderLines: vi.fn(async () => undefined),
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
  reserveOrderLines: (...a: unknown[]) => reserveOrderLines(...(a as [])),
}));
vi.mock('@/lib/apps/events', () => ({ emitAppEvent: vi.fn() }));
vi.mock('@/lib/conversions/emit', () => ({ queueConversions: vi.fn() }));
vi.mock('@/lib/blacklist', () => ({ AlreadyBlocked: class extends Error {}, blockPhone: vi.fn() }));

import { POST } from './route';

const ME = { id: 'agent-1', name: 'سارة', role: 'CONFIRMATION_AGENT' };
const ORDER: Record<string, unknown> = {
  id: 'o1', companyId: 'c1', storeId: 's1', version: 3, orderNumber: 'ORD-2026-0600',
  confirmationStatus: 'IN_PROGRESS', shippingStatus: 'NOT_READY', shippedAt: null, labelPrintedAt: null,
  claimedById: ME.id, lockedById: null, lockExpiresAt: null, confirmedAt: null, customerId: 'cu1',
  nextFollowUpAt: null, followUpStatus: null, moderatorId: null,
  shippingBatchId: null, shippingBatch: null, deliveryProviderId: null, trackingNumber: null,
  courierSendStartedAt: null, totalAmount: 10, currency: 'JOD',
  regionId: null,
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
  expect(db.$transaction).not.toHaveBeenCalled();
  expect(db.orderStatusLog.create).not.toHaveBeenCalled();
  expect(reserveOrderLines).not.toHaveBeenCalled();
  expect(releaseOrderLines).not.toHaveBeenCalled();
}

beforeEach(() => {
  vi.clearAllMocks();
  requireContext.mockResolvedValue({
    user: ME, companyId: 'c1', storeId: 's1', country: { allowNegativeStock: false },
  });
  // An agent: the contact-log key, and NOT the unlock override.
  can.mockImplementation((_u: unknown, key: string) => key === 'orders.contact_log');
  authorize.mockReturnValue({ allowed: true });
  db.order.updateMany.mockResolvedValue({ count: 1 });
  db.orderContactAttempt.count.mockResolvedValue(1);
  db.$transaction.mockImplementation(async (fn: (tx: unknown) => unknown) => fn(db));
  orderIs({});
});

describe('«تأكيد الطلب» on an order with no governorate', () => {
  it('the sentence is the owner’s, in Arabic, and says what to do', () => {
    expect(REGION_REQUIRED_MESSAGE).toBe('حدّد المحافظة أولاً — أجرة التوصيل مبنية عليها ولا يُؤكَّد طلب بلا محافظة');
    expect(REGION_REQUIRED_MESSAGE).not.toMatch(/[A-Za-z]/);
  });

  it.each([
    ['null', null],
    ['an empty string', ''],
    ['blanks', '   '],
    ['absent', undefined],
  ])('regionId %s ⇒ 409 REGION_REQUIRED, the status unchanged, nothing written, nothing reserved', async (_name, regionId) => {
    orderIs({ regionId });

    const res = await confirm();

    expect(res.status).toBe(409);
    expect(res.body.code).toBe('REGION_REQUIRED');
    expect(res.body.errorAr).toBe(REGION_REQUIRED_MESSAGE);
    expect(res.body.error).toBe(REGION_REQUIRED_MESSAGE);
    expectUntouched();
  });

  it('a CITY written on the customer is not a governorate: the free text never opens the door', async () => {
    orderIs({ regionId: null, customer: { city: 'سكاكة الجوف' } });

    const res = await confirm();

    expect(res.status).toBe(409);
    expect(res.body.code).toBe('REGION_REQUIRED');
    expectUntouched();
  });

  it('the override does not reach it: holding every key (orders.unlock too), with a written reason, is still refused', async () => {
    can.mockImplementation(() => true);
    orderIs({ regionId: null });

    const res = await confirm({ note: 'المدير يطلب التأكيد الآن' });

    expect(res.status).toBe(409);
    expect(res.body.code).toBe('REGION_REQUIRED');
    expectUntouched();
  });

  it('and it is asked even where the transition table would have refused first (the override path out of a wrong state)', async () => {
    can.mockImplementation(() => true);
    orderIs({ regionId: null, confirmationStatus: 'NO_ANSWER' });

    const res = await confirm({ note: 'تأكيد بعد مراجعة المدير' });

    expect(res.body.code).toBe('REGION_REQUIRED');
    expectUntouched();
  });

  it('the contact-first rule is still asked first for the holder: no attempt ⇒ CONTACT_FIRST, not REGION_REQUIRED', async () => {
    db.orderContactAttempt.count.mockResolvedValue(0);
    orderIs({ regionId: null });

    const res = await confirm();

    expect(res.body.code).toBe('CONTACT_FIRST');
    expectUntouched();
  });
});

describe('everything else still works with no governorate', () => {
  it('«ألغِ» (reject) for a reason closes it and releases the units', async () => {
    orderIs({ regionId: null });

    const res = await send({ action: 'reject', rejectionReason: 'CUSTOMER_CHANGED_MIND' });

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(db.order.updateMany).toHaveBeenCalledTimes(1);
    expect(db.order.updateMany.mock.calls[0][0].data).toMatchObject({ confirmationStatus: 'REJECTED' });
    expect(releaseOrderLines).toHaveBeenCalledTimes(1);
    expect(reserveOrderLines).not.toHaveBeenCalled();
  });

  it('«تأجيل» (schedule_follow_up) with a date postpones it', async () => {
    orderIs({ regionId: null });
    const nextWeek = new Date(Date.now() + 7 * 86_400_000).toISOString();

    const res = await send({ action: 'schedule_follow_up', nextFollowUpAt: nextWeek });

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(db.order.updateMany.mock.calls[0][0].data).toMatchObject({ confirmationStatus: 'POSTPONED' });
    expect(reserveOrderLines).not.toHaveBeenCalled();
  });

  it('a call result (no answer) is recorded on it', async () => {
    orderIs({ regionId: null });

    const res = await send({ action: 'contact_result', result: 'NO_ANSWER' });

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(db.order.updateMany.mock.calls[0][0].data).toMatchObject({ confirmationStatus: 'NO_ANSWER' });
  });

  it('a manager’s cancel with a reason in writing goes through', async () => {
    can.mockImplementation(() => true);
    orderIs({ regionId: null });

    const res = await send({ action: 'cancel', note: 'الزبون ألغى بالهاتف' });

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(db.order.updateMany.mock.calls[0][0].data).toMatchObject({ confirmationStatus: 'CANCELLED' });
  });
});

describe('NEGATIVE: with a governorate it confirms, as it always did', () => {
  it('confirms, writes once and reserves the lines once', async () => {
    orderIs({ regionId: 'r-damascus' });

    const res = await confirm();

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(db.order.updateMany).toHaveBeenCalledTimes(1);
    expect(db.order.updateMany.mock.calls[0][0].data).toMatchObject({ confirmationStatus: 'CONFIRMED', status: 'CONFIRMED' });
    expect(reserveOrderLines).toHaveBeenCalledTimes(1);
  });
});
