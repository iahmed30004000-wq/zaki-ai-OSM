import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * ═══════════════════════════════════════════════════════════════════════
 * A HAND CANNOT WRITE THE SYSTEM'S REASON (Confirmation Center v2, step B — decision D8; BACKLOG RV2370).
 *
 * With «جدول المحاولات» on, `NO_ANSWER_3_ATTEMPTS` is the reason the contact door writes when the fifth COUNTED «لا يرد» lands on the second day. Nobody can meet that rule by hand —
 * so a `reject` with it answers 409 `SYSTEM_ONLY_REASON`, with a sentence in Arabic that says what to do, and writes NOTHING (no update, no transaction, no version bump).
 *
 *  · every other reason keeps its answer; an unknown reason is still 400; an order nobody has rung still answers CONTACT_FIRST first;
 *  · OFF (the switch off, or unreadable): the body is accepted exactly as before;
 *  · the switch is read ZERO times for anything but this action with this reason (`a-status-no-answer-needs-its-line-first.test.ts` counts reads on the other actions).
 *
 * The door under test is the real one; the harness of `a-closing-that-needs-no-call.test.ts`.
 * ═══════════════════════════════════════════════════════════════════════
 */

const { db, requireContext, can, authorize, assertOrderAccess, cad } = vi.hoisted(() => ({
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
  cad: { on: true, reads: 0 },
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
vi.mock('@/lib/reservation', () => ({ releaseOrderLines: vi.fn(async () => undefined), reserveOrderLines: vi.fn() }));
vi.mock('@/lib/apps/events', () => ({ emitAppEvent: vi.fn() }));
vi.mock('@/lib/conversions/emit', () => ({ queueConversions: vi.fn() }));
vi.mock('@/lib/blacklist', () => ({ AlreadyBlocked: class extends Error {}, blockPhone: vi.fn() }));
vi.mock('@/lib/call-proof-switch', () => ({
  callProofOn: async () => false,
  callProofSwitch: async () => ((cad.reads += 1), cad.on ? { enabled: true, enabledAt: new Date('2026-11-01T00:00:00Z') } : { enabled: false, enabledAt: null }),
}));

import { POST } from './route';
import { CADENCE_LIMIT } from '@/lib/no-answer-cadence';

const ME = { id: 'agent-1', name: 'سارة', role: 'CONFIRMATION_AGENT' };
const ORDER = {
  id: 'o1', companyId: 'c1', storeId: 's1', version: 3, orderNumber: 'ORD-1',
  confirmationStatus: 'IN_PROGRESS', shippingStatus: 'NOT_READY', shippedAt: null, labelPrintedAt: null,
  claimedById: ME.id, lockedById: null, lockExpiresAt: null, confirmedAt: null, customerId: 'cu1',
  nextFollowUpAt: null, followUpStatus: null, moderatorId: null,
  shippingBatchId: null, shippingBatch: null, deliveryProviderId: null, trackingNumber: null,
  courierSendStartedAt: null, totalAmount: 10, currency: 'JOD',
};

const send = async (body: Record<string, unknown>) => {
  const res = await POST(
    new Request('http://localhost/x', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ expectedVersion: 3, ...body }) }),
    { params: Promise.resolve({ id: 'o1' }) }
  );
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
};
const reject = (rejectionReason: string | undefined, extra: Record<string, unknown> = {}) =>
  send({ action: 'reject', ...(rejectionReason === undefined ? {} : { rejectionReason }), ...extra });

beforeEach(() => {
  vi.clearAllMocks();
  cad.on = true;
  cad.reads = 0;
  requireContext.mockResolvedValue({ user: ME, companyId: 'c1', storeId: 's1', country: { allowNegativeStock: false } });
  can.mockImplementation((_u: unknown, key: string) => key === 'orders.contact_log');
  authorize.mockReturnValue({ allowed: true });
  db.order.updateMany.mockResolvedValue({ count: 1 });
  db.order.findUnique.mockResolvedValue({ ...ORDER });
  db.$transaction.mockImplementation(async (fn: (tx: unknown) => unknown) => fn(db));
  assertOrderAccess.mockResolvedValue({ allowed: true, order: { ...ORDER } });
  db.order.findFirst.mockResolvedValue({ ...ORDER });
  db.orderContactAttempt.count.mockResolvedValue(1);
});

describe('ON — the system’s reason is refused to a hand', () => {
  it('409 SYSTEM_ONLY_REASON, the sentence says what to do and names the five, and NOTHING is written', async () => {
    const res = await reject('NO_ANSWER_3_ATTEMPTS');
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('SYSTEM_ONLY_REASON');
    expect(res.body.errorAr).toBe(res.body.error);
    const sentence = String(res.body.errorAr);
    expect(sentence).toContain('اختر');
    expect(sentence).toContain(String(CADENCE_LIMIT));
    expect(sentence).not.toMatch(/[A-Za-z]/);
    expect(db.order.updateMany).not.toHaveBeenCalled();
    expect(db.$transaction).not.toHaveBeenCalled();
    expect(db.orderStatusLog.create).not.toHaveBeenCalled();
  });

  it('every other reason keeps its answer; an unknown reason is still 400', async () => {
    const ok = await reject('PRICE_TOO_HIGH');
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    expect(db.order.updateMany).toHaveBeenCalledTimes(1);
    const unknown = await reject('NOT_A_REASON');
    expect(unknown.status).toBe(400);
    const none = await reject(undefined);
    expect(none.status).toBe(400);
  });

  it('an order nobody has rung answers CONTACT_FIRST before this refusal', async () => {
    db.orderContactAttempt.count.mockResolvedValue(0);
    const res = await reject('NO_ANSWER_3_ATTEMPTS');
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('CONTACT_FIRST');
  });
});

describe('OFF — accepted exactly as before (RV2370 stays as it was)', () => {
  it('the switch off: the same body goes through and closes the order', async () => {
    cad.on = false;
    const res = await reject('NO_ANSWER_3_ATTEMPTS');
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(db.order.updateMany).toHaveBeenCalledTimes(1);
    expect(db.order.updateMany.mock.calls[0][0].data).toMatchObject({ confirmationStatus: 'REJECTED', rejectionReason: 'NO_ANSWER_3_ATTEMPTS' });
  });
});

describe('the switch is read only for this action with this reason', () => {
  it('zero reads for any other reject, a plain contact result, start and the other reason', async () => {
    await reject('PRICE_TOO_HIGH');
    await send({ action: 'start' });
    await send({ action: 'contact_result', result: 'ANSWERED' });
    expect(cad.reads).toBe(0);
    await reject('NO_ANSWER_3_ATTEMPTS');
    expect(cad.reads).toBe(1);
  });
});
