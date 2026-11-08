import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * ═══════════════════════════════════════════════════════════════════════
 * DEFINITION OF DONE — a pull refused «الشغل أول» names the order it is about (the owner, 8/11)
 *
 *  1. `WORK_FIRST` is a 409 with its code, the sentence, and the OLDEST order she owes — id and number — and how many she owes:
 *     the screen of a stale tab (a pull pressed before it learned she owes calls) opens that order, exactly as it opens the
 *     order of `UNTOUCHED_ORDER` (which the claim-by-id door has always named).
 *  2. `UNTOUCHED_ORDER` names its order here too — the same two fields; its status is what it was.
 *  3. Every other refusal is what it was: no extra keys, the empty queue still a 404.
 *
 * Blockers: no money, no permission change, no order creation.
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

import { POST } from './route';

const COUNTRY = { workHoursStart: '09:00', workHoursEnd: '17:00', weekendDays: [5, 6], timezone: 'Asia/Amman' };

beforeEach(() => {
  vi.clearAllMocks();
  requireContext.mockResolvedValue({ user: { id: 'huda', role: 'CONFIRMATION_AGENT' }, companyId: 'c1', storeId: 's1', country: COUNTRY });
  requirePermission.mockResolvedValue(undefined);
  reserve.mockResolvedValue(0);
});

describe('a pull refused for work she owes', () => {
  it('is a 409 that carries the code, the sentence, the oldest order and how many', async () => {
    pullNextOrder.mockResolvedValue({
      ok: false,
      released: 3,
      refusal: {
        code: 'WORK_FIRST',
        message: 'عندك 5 طلبات لازم ترني عليهم هلّق قبل سحب طلب جديد — أولها الطلب ORD-7.',
        orderId: 'o-7',
        orderNumber: 'ORD-7',
        count: 5,
      },
    });
    const res = await POST();
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({
      error: 'عندك 5 طلبات لازم ترني عليهم هلّق قبل سحب طلب جديد — أولها الطلب ORD-7.',
      code: 'WORK_FIRST',
      autoReleased: 3,
      orderId: 'o-7',
      orderNumber: 'ORD-7',
      count: 5,
    });
    // Nothing was taken, so nothing was read back or counted as handed out.
    expect(db.order.findUnique).not.toHaveBeenCalled();
  });

  it('the untouched-order refusal names its order the same way — and stays a 409', async () => {
    pullNextOrder.mockResolvedValue({
      ok: false,
      released: 0,
      refusal: { code: 'UNTOUCHED_ORDER', message: 'سجّل محاولة اتصال على الطلب ORD-9 قبل سحب طلب جديد.', orderId: 'o-9', orderNumber: 'ORD-9' },
    });
    const res = await POST();
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ code: 'UNTOUCHED_ORDER', orderId: 'o-9', orderNumber: 'ORD-9' });
  });

  it('NEGATIVE: the other refusals carry no order and no count — as they never did', async () => {
    pullNextOrder.mockResolvedValue({ ok: false, released: 0, refusal: { code: 'CAP_TOTAL', message: 'بلغت الحد الأقصى (500 طلب لديك).' } });
    const capped = await POST();
    expect(capped.status).toBe(409);
    expect(await capped.json()).toEqual({ error: 'بلغت الحد الأقصى (500 طلب لديك).', code: 'CAP_TOTAL', autoReleased: 0 });

    pullNextOrder.mockResolvedValue({ ok: false, released: 0, refusal: { code: 'QUEUE_EMPTY', message: 'لا توجد طلبات بانتظار التأكيد الآن.' } });
    const empty = await POST();
    expect(empty.status).toBe(404);
    expect(await empty.json()).toEqual({ error: 'لا توجد طلبات بانتظار التأكيد الآن.', code: 'QUEUE_EMPTY', autoReleased: 0 });
  });
});
