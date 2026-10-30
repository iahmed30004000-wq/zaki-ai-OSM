import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  NO_CONVERSATION_REJECTION_REASONS,
  PICKABLE_REJECTION_REASONS,
  REJECTION_REASONS,
} from '@/lib/confirmation-workflow';

/**
 * ═══════════════════════════════════════════════════════════════════════
 * «ألغِ» FOR A REASON THAT NEEDS NO WORD WITH THE CUSTOMER (30/10).
 *
 * The owner: «٥ تمام». The contact-first rule (C1) stays — `confirm`, `schedule_follow_up`, `edit`, `cancel` and
 * `reject` are locked until the order carries one contact attempt — EXCEPT that a `reject` for a duplicate, a fake
 * order, a wrong number or a place we do not serve goes through with none. The agent no longer presses «لا يرد»
 * (a pretend attempt) just to close an order that is plainly a duplicate.
 *
 * The door under test is the real one (`confirmation/route`); only the database and the side-effect doors are
 * stubbed, as in `a-waiting-order-can-be-cancelled.test.ts`.
 * ═══════════════════════════════════════════════════════════════════════
 */

const { db, requireContext, can, authorize, assertOrderAccess, releaseOrderLines } = vi.hoisted(() => ({
  db: {
    order: { updateMany: vi.fn(), findUnique: vi.fn(), findFirst: vi.fn() },
    customer: { findUnique: vi.fn(async () => null), update: vi.fn() },
    orderNote: { create: vi.fn() },
    orderContactAttempt: { count: vi.fn(async () => 0) },
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

import { blockPhone } from '@/lib/blacklist';
import { POST } from './route';

const ME = { id: 'agent-1', name: 'سارة', role: 'CONFIRMATION_AGENT' };
const ORDER = {
  id: 'o1', companyId: 'c1', storeId: 's1', version: 3, orderNumber: 'ORD-1',
  confirmationStatus: 'NEW', shippingStatus: 'NOT_READY', shippedAt: null, labelPrintedAt: null,
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
const reject = (rejectionReason: string | undefined, extra: Record<string, unknown> = {}) =>
  send({ action: 'reject', ...(rejectionReason === undefined ? {} : { rejectionReason }), ...extra });

const noAttempt = () => db.orderContactAttempt.count.mockResolvedValue(0);
const oneAttempt = () => db.orderContactAttempt.count.mockResolvedValue(1);

beforeEach(() => {
  vi.clearAllMocks();
  requireContext.mockResolvedValue({
    user: ME, companyId: 'c1', storeId: 's1', country: { allowNegativeStock: false },
  });
  can.mockImplementation((_u: unknown, key: string) => key === 'orders.contact_log');
  authorize.mockReturnValue({ allowed: true });
  db.order.updateMany.mockResolvedValue({ count: 1 });
  db.order.findUnique.mockResolvedValue({ ...ORDER });
  db.$transaction.mockImplementation(async (fn: (tx: unknown) => unknown) => fn(db));
  assertOrderAccess.mockResolvedValue({ allowed: true, order: { ...ORDER } });
  db.order.findFirst.mockResolvedValue({ ...ORDER });
  noAttempt();
});

describe('the three reasons that need no call', () => {
  it('the set is exactly three (the owner’s five less «وهمي» and the system-only one, on purpose)', () => {
    expect([...NO_CONVERSATION_REJECTION_REASONS].sort()).toEqual(
      ['DUPLICATE_ORDER', 'OUT_OF_SERVICE_AREA', 'WRONG_NUMBER']
    );
    // every one of them is something the screen can offer — an exemption for a value nobody can pick is a back door
    for (const r of NO_CONVERSATION_REJECTION_REASONS) expect(PICKABLE_REJECTION_REASONS).toContain(r);
  });

  it.each([...NO_CONVERSATION_REJECTION_REASONS])(
    '%s — with NO attempt on the order — closes it, and the units go back',
    async (reason) => {
      const res = await reject(reason);

      expect(res.status, JSON.stringify(res.body)).toBe(200);
      expect(db.order.updateMany).toHaveBeenCalledTimes(1);
      expect(db.order.updateMany.mock.calls[0][0].data).toMatchObject({
        confirmationStatus: 'REJECTED', rejectionReason: reason,
      });
      expect(releaseOrderLines).toHaveBeenCalledTimes(1);
    }
  );
});

describe('every other reason still needs the call', () => {
  const needCall = [
    'PRICE_TOO_HIGH', 'CUSTOMER_CHANGED_MIND', 'CUSTOMER_DOES_NOT_WANT_PRODUCT', 'FOUND_CHEAPER_ELSEWHERE', 'FAKE_ORDER',
  ];

  it.each(needCall)('%s with no attempt ⇒ 409 CONTACT_FIRST and nothing is written', async (reason) => {
    const res = await reject(reason);

    expect(res.status).toBe(409);
    expect(res.body.code).toBe('CONTACT_FIRST');
    expect(db.order.updateMany).not.toHaveBeenCalled();
    expect(releaseOrderLines).not.toHaveBeenCalled();
  });

  it('FAKE_ORDER with no attempt blocks no number: the blacklist is never touched', async () => {
    const res = await reject('FAKE_ORDER');
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('CONTACT_FIRST');
    expect(blockPhone).not.toHaveBeenCalled();
  });

  it('OTHER (even with its note) with no attempt ⇒ 409 CONTACT_FIRST', async () => {
    const res = await reject('OTHER', { note: 'الزبون طلب شيئاً آخر' });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('CONTACT_FIRST');
    expect(db.order.updateMany).not.toHaveBeenCalled();
  });

  it('the two the system owns are no way round it: MODERATOR_DATA_ERROR and NO_ANSWER_3_ATTEMPTS ⇒ 409', async () => {
    for (const r of ['MODERATOR_DATA_ERROR', 'NO_ANSWER_3_ATTEMPTS']) {
      const res = await reject(r);
      expect(res.status, r).toBe(409);
      expect(res.body.code, r).toBe('CONTACT_FIRST');
    }
    expect(db.order.updateMany).not.toHaveBeenCalled();
  });

  it('no reason, a made-up reason, or a non-string ⇒ still locked, never exempt', async () => {
    expect((await reject(undefined)).status).toBe(409);
    expect((await reject('NOT_A_REASON')).status).toBe(409);
    expect((await send({ action: 'reject', rejectionReason: ['DUPLICATE_ORDER'] })).status).toBe(409);
    expect(db.order.updateMany).not.toHaveBeenCalled();
  });

  it('the list of reasons the rule can see is the real one — nothing is added that the door would refuse', () => {
    for (const r of NO_CONVERSATION_REJECTION_REASONS) expect(REJECTION_REASONS).toContain(r);
  });
});

describe('with an attempt on the order the door is as it was', () => {
  beforeEach(oneAttempt);

  it.each(['PRICE_TOO_HIGH', 'CUSTOMER_CHANGED_MIND', 'DUPLICATE_ORDER'])('%s ⇒ 200', async (reason) => {
    const res = await reject(reason);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(db.order.updateMany).toHaveBeenCalledTimes(1);
  });

  it('OTHER with no note ⇒ 400, as before', async () => {
    const res = await reject('OTHER');
    expect(res.status).toBe(400);
    expect(String(res.body.error)).toMatch(/ملاحظة/);
  });

  it('no reason ⇒ 400, as before', async () => {
    const res = await reject(undefined);
    expect(res.status).toBe(400);
    expect(String(res.body.error)).toMatch(/سبب الرفض/);
  });
});

describe('the exemption belongs to «reject» alone', () => {
  it('confirm / schedule_follow_up / cancel with an exempt reason in the body and no attempt ⇒ 409', async () => {
    can.mockImplementation(() => true);
    const nextWeek = new Date(Date.now() + 7 * 86_400_000).toISOString();
    const bodies: Record<string, unknown>[] = [
      { action: 'confirm', rejectionReason: 'DUPLICATE_ORDER' },
      { action: 'schedule_follow_up', rejectionReason: 'DUPLICATE_ORDER', nextFollowUpAt: nextWeek },
      { action: 'cancel', rejectionReason: 'DUPLICATE_ORDER', note: 'طلب مكرر بالتأكيد' },
    ];
    for (const body of bodies) {
      const res = await send(body);
      expect(res.status, String(body.action)).toBe(409);
      expect(res.body.code, String(body.action)).toBe('CONTACT_FIRST');
    }
    expect(db.order.updateMany).not.toHaveBeenCalled();
  });

  it('a result that carries a date is still a postponement (RV5): no attempt ⇒ 409, even with an exempt reason', async () => {
    const nextWeek = new Date(Date.now() + 7 * 86_400_000).toISOString();
    const res = await send({
      action: 'contact_result', result: 'CALLBACK_REQUESTED', nextFollowUpAt: nextWeek, rejectionReason: 'FAKE_ORDER',
    });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('CONTACT_FIRST');
  });

  it('someone who does not hold the order was never bound — a reject for a locked reason goes through', async () => {
    const other = { ...ORDER, claimedById: 'someone-else' };
    assertOrderAccess.mockResolvedValue({ allowed: true, order: other });
    db.order.findFirst.mockResolvedValue(other);
    const res = await reject('PRICE_TOO_HIGH');
    expect(res.status, JSON.stringify(res.body)).toBe(200);
  });
});
