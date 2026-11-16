import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * ═══════════════════════════════════════════════════════════════════════
 * DEFINITION OF DONE — THE PLAN'S CLOSE CODE IS NOT A REASON A HAND MAY SEND TO THIS DOOR (review round 1 of step B, ruling 6)
 *
 * `NO_ANSWER_5_ATTEMPTS` joined `REJECTION_REASONS` with the plan, and this door validates a «مرفوض» reason against the whole list. Before the code
 * existed a hand that sent it got «سبب الإلغاء مطلوب» (400); after, it passed the check and met the later «USE_CONFIRMATION_DOOR» 409 — a different
 * answer for the same input with the switch OFF. The confirmation door answers it as an unknown value; so does this one now.
 *
 *  1. `REJECTED` + `NO_ANSWER_5_ATTEMPTS` = 400 «سبب الإلغاء مطلوب», exactly what an unknown reason gets, and nothing is written.
 *  2. A real reason still reaches the old answer (409, use the confirmation door) — the door is otherwise untouched.
 *
 * Blockers: no money, no order creation, no migration, no `contracts/`, no external model.
 * ═══════════════════════════════════════════════════════════════════════
 */

const { db, requireContext, can, authorize, assertOrderAccess, logAudit } = vi.hoisted(() => ({
  db: {
    callLog: { create: vi.fn(), findMany: vi.fn() },
    order: { update: vi.fn(), findUnique: vi.fn() },
    orderStatusLog: { create: vi.fn() },
    orderActivity: { create: vi.fn() },
    $transaction: vi.fn(),
  },
  requireContext: vi.fn(),
  can: vi.fn(),
  authorize: vi.fn(),
  assertOrderAccess: vi.fn(),
  logAudit: vi.fn(),
}));

vi.mock('@/lib/db', () => ({ db }));
vi.mock('@/lib/geo-context', () => ({ requireContext: (...a: unknown[]) => requireContext(...a) }));
vi.mock('@/lib/authorization', () => ({
  can: (...a: unknown[]) => can(...a),
  authorize: (...a: unknown[]) => authorize(...a),
}));
vi.mock('@/lib/rbac', () => ({
  ORDER_ACCESS_STATUS: { NOT_FOUND: 404, WRONG_COMPANY: 404, NOT_ASSIGNED: 403 },
  assertOrderAccess: (...a: unknown[]) => assertOrderAccess(...a),
}));
vi.mock('@/lib/audit', () => ({ logAudit: (...a: unknown[]) => logAudit(...a) }));
vi.mock('@/lib/api-error', () => ({
  apiError: (e: unknown) => ({ body: { error: `UNEXPECTED: ${(e as Error)?.message}` }, status: 500 }),
}));

import { POST } from './route';

const ORDER = { id: 'o1', companyId: 'c1', orderNumber: 'ORD-3', confirmationStatus: 'IN_PROGRESS', status: 'CLAIMED', claimedById: 'a1' };

const reject = (rejectionReason: string) =>
  POST(
    new Request('http://localhost/api/orders/o1/call-logs', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ result: 'REJECTED', rejectionReason }),
    }),
    { params: Promise.resolve({ id: 'o1' }) }
  );

beforeEach(() => {
  vi.clearAllMocks();
  requireContext.mockResolvedValue({ user: { id: 'a1', name: 'سارة', role: 'CONFIRMATION_AGENT' }, companyId: 'c1', storeId: 's1' });
  assertOrderAccess.mockResolvedValue({ allowed: true, order: ORDER });
  can.mockImplementation((_u: unknown, k: string) => ['orders.edit', 'orders.view', 'orders.contact_log', 'orders.confirm'].includes(k));
  authorize.mockImplementation(() => ({ allowed: true }));
  db.$transaction.mockImplementation(async (fn: (tx: unknown) => Promise<unknown>) => fn(db));
});

describe('the plan’s close code sent by a hand', () => {
  it('is answered exactly like an unknown reason, and nothing is written', async () => {
    const five = await reject('NO_ANSWER_5_ATTEMPTS');
    const fiveBody = await five.json();
    const unknown = await reject('NOT_A_REASON');
    const unknownBody = await unknown.json();

    expect(five.status, JSON.stringify(fiveBody)).toBe(400);
    expect(fiveBody).toEqual(unknownBody);
    expect(fiveBody.error).toBe('سبب الإلغاء مطلوب');
    expect(db.callLog.create).not.toHaveBeenCalled();
    expect(db.order.update).not.toHaveBeenCalled();
    expect(db.orderStatusLog.create).not.toHaveBeenCalled();
  });

  it('a real reason still meets the answer it always met: close from the confirmation door', async () => {
    const res = await reject('PRICE_TOO_HIGH');
    const body = await res.json();
    expect(res.status, JSON.stringify(body)).toBe(409);
    expect(body.code).toBe('USE_CONFIRMATION_DOOR');
  });
});
