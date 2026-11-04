import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * ═══════════════════════════════════════════════════════════════════════
 * DEFINITION OF DONE — «اسحب الطلب التالي» makes the hold before it picks
 *
 * A returning customer's order that has just arrived is held for the agent who worked him last (order-reservation.ts). The job runs
 * every two minutes (the queue read made the hold too until 4/11), but the header chip comes from «شغلي», which makes none — so an agent
 * pulls on the strength of a number, and in that window the pull is the only door that can hold the order before it is taken.
 *
 *  1. The hold is made for THIS store, BEFORE the pick. Moved after it, the first agent to press takes the order that was hers.
 *  2. A hold that could not be written never stops a pull (the order is then the shared queue's, as before holds existed).
 *  3. Whoever may not pull is refused before anything is written (`confirmation.pull`).
 *  4. The refusals of the pick (empty queue, the caps) reach the screen as they did.
 *
 * Blockers: no money, no order creation.
 * ═══════════════════════════════════════════════════════════════════════
 */

const { db, requireContext, requirePermission, pullNextOrder, reserve } = vi.hoisted(() => ({
  db: { order: { findUnique: vi.fn() } },
  requireContext: vi.fn(),
  requirePermission: vi.fn(),
  pullNextOrder: vi.fn(),
  reserve: vi.fn(),
}));

vi.mock('@/lib/db', () => ({ db }));
vi.mock('@/lib/geo-context', () => ({ requireContext: (...a: unknown[]) => requireContext(...a) }));
vi.mock('@/lib/authorization', () => ({ requirePermission: (...a: unknown[]) => requirePermission(...a) }));
vi.mock('@/lib/pii-alert', () => ({ noteCustomersHandedOut: vi.fn() }));
vi.mock('@/lib/confirmation-queue', () => ({ pullNextOrder: (...a: unknown[]) => pullNextOrder(...a) }));
vi.mock('@/lib/reserve-returning-customers', () => ({ reserveReturningCustomers: (...a: unknown[]) => reserve(...a) }));
vi.mock('@/lib/api-error', () => ({
  apiErrorResponse: (e: unknown) => Response.json({ error: `UNEXPECTED: ${(e as Error)?.message}` }, { status: 500 }),
}));

import { Prisma } from '@prisma/client';
import { POST } from './route';

const COUNTRY = { workHoursStart: '09:00', workHoursEnd: '17:00', weekendDays: [5, 6], timezone: 'Asia/Amman' };

beforeEach(() => {
  vi.clearAllMocks();
  requireContext.mockResolvedValue({ user: { id: 'huda', role: 'CONFIRMATION_AGENT' }, companyId: 'c1', storeId: 's1', country: COUNTRY });
  requirePermission.mockResolvedValue(undefined);
  reserve.mockResolvedValue(0);
  pullNextOrder.mockResolvedValue({ ok: true, orderId: 'o1', released: 0 });
  db.order.findUnique.mockResolvedValue({ id: 'o1', orderNumber: 'ORD-1' });
});

describe('«اسحب الطلب التالي»', () => {
  it('makes the hold for this store before it picks', async () => {
    const res = await POST();
    expect(res.status).toBe(201);
    expect(reserve).toHaveBeenCalledTimes(1);
    expect(reserve.mock.calls[0][0]).toEqual({ companyId: 'c1', storeId: 's1' });
    expect(reserve.mock.invocationCallOrder[0]).toBeLessThan(pullNextOrder.mock.invocationCallOrder[0]);
  });

  it('never stops a pull because the hold could not be written', async () => {
    reserve.mockRejectedValue(new Error('the audience query failed'));
    const res = await POST();
    expect(res.status).toBe(201);
    expect(pullNextOrder).toHaveBeenCalledTimes(1);
  });

  it('NEGATIVE: somebody who may not pull is refused before any hold is written', async () => {
    requirePermission.mockRejectedValue(new Error('FORBIDDEN'));
    const res = await POST();
    expect(res.status).toBe(500);
    expect(reserve).not.toHaveBeenCalled();
    expect(pullNextOrder).not.toHaveBeenCalled();
  });

  it('an empty queue is a 404 with its code, and any other refusal a 409 — as before', async () => {
    pullNextOrder.mockResolvedValue({ ok: false, released: 0, refusal: { code: 'QUEUE_EMPTY', message: 'لا توجد طلبات' } });
    const empty = await POST();
    expect(empty.status).toBe(404);
    expect((await empty.json()).code).toBe('QUEUE_EMPTY');

    pullNextOrder.mockResolvedValue({ ok: false, released: 0, refusal: { code: 'CAP_REACHED', message: 'وصلت السقف' } });
    const capped = await POST();
    expect(capped.status).toBe(409);
    expect((await capped.json()).code).toBe('CAP_REACHED');
  });
});

/**
 * RV711 — A PULL THAT RUNS OUT OF TIME IS «PRESS AGAIN», NOT «SOMETHING BROKE».
 *
 * P2028 is what Prisma throws when the pull's transaction cannot get a connection within `maxWait` or is still running at its
 * `timeout`. The transaction rolled back, so the same press a moment later is safe: 503 with Retry-After and the sentence she
 * reads, never the shared mapper's 500.
 */
describe('«اسحب» when the queue is busy (RV711)', () => {
  const p2028 = () =>
    new Prisma.PrismaClientKnownRequestError('Transaction API error: Transaction already closed', {
      code: 'P2028',
      clientVersion: 'test',
    });

  it('a P2028 from the pull answers 503, the sentence, its code and Retry-After', async () => {
    pullNextOrder.mockRejectedValue(p2028());
    const res = await POST();
    expect(res.status).toBe(503);
    expect(res.headers.get('Retry-After')).toBe('1');
    const body = await res.json();
    expect(body.code).toBe('QUEUE_BUSY');
    expect(body.errorAr).toBe('الطابور مشغول لحظة — اضغط «اسحب» مرة تانية');
    expect(body.error).toBe(body.errorAr);
    // Nothing was pulled, so nothing is read or handed out.
    expect(db.order.findUnique).not.toHaveBeenCalled();
  });

  it('NEGATIVE: any other Prisma error still goes to the shared mapper, as before', async () => {
    pullNextOrder.mockRejectedValue(
      new Prisma.PrismaClientKnownRequestError('Unique constraint failed', { code: 'P2002', clientVersion: 'test' })
    );
    const res = await POST();
    expect(res.status).toBe(500);
    expect((await res.json()).error).toMatch(/^UNEXPECTED/);
  });

  it('NEGATIVE: a plain error that merely says P2028 is not mistaken for the timeout', async () => {
    pullNextOrder.mockRejectedValue(Object.assign(new Error('P2028'), { code: 'P2028' }));
    const res = await POST();
    expect(res.status).toBe(500);
  });

  it('a normal pull is unchanged: 201 with the order', async () => {
    const res = await POST();
    expect(res.status).toBe(201);
    expect((await res.json()).order).toEqual({ id: 'o1', orderNumber: 'ORD-1' });
  });
});
