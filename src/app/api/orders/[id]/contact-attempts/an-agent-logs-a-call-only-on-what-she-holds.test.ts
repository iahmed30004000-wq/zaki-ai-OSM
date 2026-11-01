import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NOT_HELD_MESSAGE } from '@/lib/confirmation-queue';

/**
 * ═══════════════════════════════════════════════════════════════════════
 * AN AGENT LOGS A CALL ONLY ON THE ORDER SHE HOLDS (the owner, 1/11)
 *
 * The confirmation door next door (`an-agent-works-only-what-she-holds.test.ts`) refuses an agent on an order she does not hold.
 * The call she logs is half of the same act — «محاولة اتصال … وافق على الطلب» came BEFORE the confirmation in the 20 orders — and
 * this door let `orders.claim` holders record attempts on "the claimable queue" without holding anything.
 *
 *  · an agent (`confirmation.work` without `confirmation.supervise`) on an order nobody holds, or a colleague holds ⇒ 403
 *    `NOT_HELD`, and no attempt is written;
 *  · on the order she holds ⇒ exactly as before;
 *  · a supervisor, the owner, and somebody who is not an agent of the queue ⇒ as before, on any order.
 * ═══════════════════════════════════════════════════════════════════════
 */

const { db, requireContext, can, authorize, assertOrderAccess, logAudit } = vi.hoisted(() => ({
  db: {
    orderContactAttempt: { count: vi.fn(), create: vi.fn(), findMany: vi.fn(), findFirst: vi.fn() },
    order: { update: vi.fn(), findUnique: vi.fn() },
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
  assertOrderReadable: vi.fn(),
}));
vi.mock('@/lib/audit', () => ({ logAudit: (...a: unknown[]) => logAudit(...a) }));
vi.mock('@/lib/reservation', () => ({ releaseOrderLines: vi.fn() }));
vi.mock('@/lib/api-error', () => ({
  apiErrorResponse: (e: unknown) =>
    new Response(JSON.stringify({ error: `UNEXPECTED: ${(e as Error)?.message}` }), { status: 500 }),
}));

import { POST } from './route';

const ME = { id: 'agent-1', name: 'عبير', role: 'CONFIRMATION_AGENT' };
const ORDER = { id: 'o1', companyId: 'c1', orderNumber: 'ORD-2026-1896', confirmationStatus: 'NEW', noAnswerCount: 0, customerId: 'cu1', claimedById: null as string | null };

const AGENT = ['confirmation.work', 'confirmation.pull', 'orders.contact_log', 'orders.claim', 'orders.edit'];
const holding = (...keys: string[]) => {
  can.mockImplementation((_u: unknown, k: string) => keys.includes(k));
  authorize.mockImplementation((_u: unknown, k: string) => ({ allowed: keys.includes(k) }));
};
const orderIs = (over: Partial<typeof ORDER>) => assertOrderAccess.mockResolvedValue({ allowed: true, order: { ...ORDER, ...over } });

const record = () =>
  POST(
    new Request('http://localhost/api/orders/o1/contact-attempts', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ contactMethod: 'PHONE', result: 'NO_ANSWER' }),
    }),
    { params: Promise.resolve({ id: 'o1' }) }
  );

beforeEach(() => {
  vi.clearAllMocks();
  requireContext.mockResolvedValue({ user: ME, companyId: 'c1', storeId: 's1' });
  holding(...AGENT);
  orderIs({});
  db.$transaction.mockImplementation(async (fn: (tx: unknown) => Promise<unknown>) => fn(db));
  db.orderContactAttempt.count.mockResolvedValue(0);
  db.orderContactAttempt.findFirst.mockResolvedValue(null);
  db.orderContactAttempt.findMany.mockResolvedValue([]);
  db.orderContactAttempt.create.mockResolvedValue({ id: 'at1', attemptNumber: 1, createdAt: new Date() });
  db.order.update.mockResolvedValue({ ...ORDER, noAnswerCount: 1 });
  db.orderActivity.create.mockResolvedValue({});
  logAudit.mockResolvedValue(undefined);
});

describe('an agent', () => {
  it('on an order NOBODY holds ⇒ 403 NOT_HELD, the sentence, and no attempt is written', async () => {
    const res = await record();
    const body = await res.json();
    expect(res.status, JSON.stringify(body)).toBe(403);
    expect(body.code).toBe('NOT_HELD');
    expect(body.errorAr).toBe(NOT_HELD_MESSAGE);
    expect(db.orderContactAttempt.create, 'انكتبت محاولة على طلب ما هو بين يديها').not.toHaveBeenCalled();
    expect(db.order.update).not.toHaveBeenCalled();
  });

  it('on an order a COLLEAGUE holds ⇒ the same', async () => {
    orderIs({ claimedById: 'agent-2' });
    const res = await record();
    expect(res.status).toBe(403);
    expect((await res.json()).code).toBe('NOT_HELD');
    expect(db.orderContactAttempt.create).not.toHaveBeenCalled();
  });

  it('on the order she HOLDS ⇒ exactly as before', async () => {
    orderIs({ claimedById: ME.id });
    const res = await record();
    expect(res.status, JSON.stringify(await res.clone().json())).toBe(200);
    expect(db.orderContactAttempt.create).toHaveBeenCalledTimes(1);
  });
});

describe('everybody else is unbound', () => {
  it('a supervisor logs a call on an order nobody holds', async () => {
    holding(...AGENT, 'confirmation.supervise');
    expect((await record()).status).toBe(200);
    expect(db.orderContactAttempt.create).toHaveBeenCalledTimes(1);
  });

  it('a manager who can take any order (orders.unlock) or hand any order out (orders.assign), without the supervise key', async () => {
    for (const key of ['orders.unlock', 'orders.assign']) {
      vi.clearAllMocks();
      requireContext.mockResolvedValue({ user: ME, companyId: 'c1', storeId: 's1' });
      holding(...AGENT, key);
      orderIs({});
      db.$transaction.mockImplementation(async (fn: (tx: unknown) => Promise<unknown>) => fn(db));
      db.orderContactAttempt.count.mockResolvedValue(0);
      db.orderContactAttempt.findFirst.mockResolvedValue(null);
      db.orderContactAttempt.findMany.mockResolvedValue([]);
      db.orderContactAttempt.create.mockResolvedValue({ id: 'at1', attemptNumber: 1, createdAt: new Date() });
      db.order.update.mockResolvedValue({ ...ORDER, noAnswerCount: 1 });
      db.orderActivity.create.mockResolvedValue({});
      expect((await record()).status, key).toBe(200);
    }
  });

  it('the owner, who holds every key', async () => {
    can.mockReturnValue(true);
    authorize.mockReturnValue({ allowed: true });
    expect((await record()).status).toBe(200);
  });

  it('somebody who may log a call but is not an agent of the queue (no confirmation.work)', async () => {
    holding('orders.contact_log', 'orders.edit', 'orders.claim');
    expect((await record()).status).toBe(200);
  });
});

describe('the old refusals come first', () => {
  it('without the call key the answer is still «لا تملك صلاحية تسجيل نتيجة الاتصال», not NOT_HELD', async () => {
    holding('confirmation.work', 'orders.claim', 'orders.edit'); // no orders.contact_log
    const res = await record();
    expect(res.status).toBe(403);
    expect((await res.json()).code).toBe('CONTACT_LOG_NOT_ALLOWED');
  });
});
