import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * ═══════════════════════════════════════════════════════════════════════
 * DEFINITION OF DONE — «اسحب» refused for its PACE answers like every other refusal of the pull (the owner, 8/11)
 *
 *  1. `PULL_TOO_FAST` is a 409 with `{ error, code, autoReleased }` — the family `CAP_TOTAL` and `UNTOUCHED_ORDER` answer in. The empty
 *     queue stays the only 404.
 *  2. The sentence that reaches the screen is the one the rule wrote (`pullPaceRefusal`) — the route adds, drops and rewrites nothing.
 *  3. A refused pull reads no order and hands no customer out.
 *  4. An account without `confirmation.pull` is refused by the key BEFORE the pull — and so before the pace — as today.
 *
 * The rule is the real one; only the transaction behind the pull is stood in for.
 *
 * Blockers: no money, no order creation.
 * ═══════════════════════════════════════════════════════════════════════
 */

const { db, requireContext, requirePermission, pullNextOrder, reserve, handedOut } = vi.hoisted(() => ({
  db: { order: { findUnique: vi.fn() } },
  requireContext: vi.fn(),
  requirePermission: vi.fn(),
  pullNextOrder: vi.fn(),
  reserve: vi.fn(),
  handedOut: vi.fn(),
}));

vi.mock('@/lib/db', () => ({ db }));
vi.mock('@/lib/geo-context', () => ({ requireContext: (...a: unknown[]) => requireContext(...a) }));
vi.mock('@/lib/authorization', () => ({ requirePermission: (...a: unknown[]) => requirePermission(...a) }));
vi.mock('@/lib/pii-alert', () => ({ noteCustomersHandedOut: (...a: unknown[]) => handedOut(...a) }));
vi.mock('@/lib/reserve-returning-customers', () => ({ reserveReturningCustomers: (...a: unknown[]) => reserve(...a) }));
vi.mock('@/lib/api-error', () => ({
  apiErrorResponse: (e: unknown) => Response.json({ error: `UNEXPECTED: ${(e as Error)?.message}` }, { status: 500 }),
}));
// The real rule and the real sentences; only the pull itself (a transaction) is stood in for.
vi.mock('@/lib/confirmation-queue', async (importOriginal) => {
  const real = await importOriginal<typeof import('@/lib/confirmation-queue')>();
  return { ...real, pullNextOrder: (...a: unknown[]) => pullNextOrder(...a) };
});

import { pullPaceRefusal } from '@/lib/confirmation-queue';
import { POST } from './route';

const COUNTRY = { workHoursStart: '09:00', workHoursEnd: '17:00', weekendDays: [5, 6], timezone: 'Asia/Amman' };
const NOW = new Date('2026-11-08T12:00:00.000Z');
/** Forty pulls, the first of them 53 minutes ago. */
const FORTY = [new Date(NOW.getTime() - 53 * 60_000), ...Array.from({ length: 39 }, () => new Date(NOW.getTime() - 5 * 60_000))];

beforeEach(() => {
  vi.clearAllMocks();
  requireContext.mockResolvedValue({ user: { id: 'huda', role: 'CONFIRMATION_AGENT' }, companyId: 'c1', storeId: 's1', country: COUNTRY });
  requirePermission.mockResolvedValue(undefined);
  reserve.mockResolvedValue(0);
  pullNextOrder.mockResolvedValue({ ok: true, orderId: 'o1', released: 0 });
  db.order.findUnique.mockResolvedValue({ id: 'o1', orderNumber: 'ORD-1' });
});

describe('«اسحب» refused for its pace', () => {
  it('is a 409 with its code and the rule\'s own sentence', async () => {
    const refusal = pullPaceRefusal(FORTY, NOW);
    expect(refusal?.code).toBe('PULL_TOO_FAST');
    pullNextOrder.mockResolvedValue({ ok: false, released: 0, refusal });

    const res = await POST();
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({
      error: 'سحبت 40 طلباً خلال آخر 60 دقيقة — الحد 40. اشتغل على اللي بإيدك، والسحب بيفتح بعد 7 دقائق.',
      code: 'PULL_TOO_FAST',
      autoReleased: 0,
    });
  });

  it('is the same family as the caps and the untouched order: 409; only the empty queue is a 404', async () => {
    const statusOf = async (refusal: { code: string; message: string }) => {
      pullNextOrder.mockResolvedValue({ ok: false, released: 0, refusal });
      return (await POST()).status;
    };
    expect(await statusOf({ code: 'CAP_TOTAL', message: 'بلغت الحد الأقصى (500 طلب لديك).' })).toBe(409);
    expect(await statusOf({ code: 'UNTOUCHED_ORDER', message: 'سجّل محاولة اتصال.' })).toBe(409);
    expect(await statusOf(pullPaceRefusal(FORTY, NOW)!)).toBe(409);
    expect(await statusOf({ code: 'QUEUE_EMPTY', message: 'لا توجد طلبات بانتظار التأكيد الآن.' })).toBe(404);
  });

  it('reads no order and hands no customer out', async () => {
    pullNextOrder.mockResolvedValue({ ok: false, released: 0, refusal: pullPaceRefusal(FORTY, NOW) });
    await POST();
    expect(db.order.findUnique).not.toHaveBeenCalled();
    expect(handedOut).not.toHaveBeenCalled();
  });

  it('NEGATIVE: an account without confirmation.pull is refused by the key, before the pull and so before the pace', async () => {
    requirePermission.mockRejectedValue(new Error('FORBIDDEN'));
    const res = await POST();
    expect(res.status).toBe(500); // the shared mapper stands in here: the point is that nothing below ran
    expect(requirePermission).toHaveBeenCalledWith('confirmation.pull');
    expect(reserve).not.toHaveBeenCalled();
    expect(pullNextOrder).not.toHaveBeenCalled();
  });

  it('a pull inside the pace is unchanged: 201 with the order', async () => {
    const res = await POST();
    expect(res.status).toBe(201);
    expect((await res.json()).order).toEqual({ id: 'o1', orderNumber: 'ORD-1' });
  });
});
