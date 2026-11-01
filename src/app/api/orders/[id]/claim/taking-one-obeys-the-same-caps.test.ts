import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * ═══════════════════════════════════════════════════════════════════════
 * TAKING THIS ORDER IS THE SAME ACT AS PULLING THE NEXT ONE.
 *
 * «اسحب الطلب التالي» asks `pullRefusal` before it hands anything over:
 * the 300 total, the 40 without a contact attempt, and C1's rule that an
 * untouched order already in your hands comes before a new one.
 *
 * `POST /api/orders/[id]/claim` — take THIS order, by id — asked none of
 * them. No screen offers it, which is exactly why it went unnoticed; the
 * queue it draws from is the same queue, and one hand-written request
 * could cherry-pick the good orders out of it all day, with no cap and no
 * contact-first rule, while the agents who use the button wait their turn.
 *
 * Asked at the door: the status, and whether the order was claimed.
 * ═══════════════════════════════════════════════════════════════════════
 */

const { db, requireContext, can, assertOrderAccess, atomicClaim, logAudit } = vi.hoisted(() => ({
  db: {
    order: { findUnique: vi.fn(), count: vi.fn(), findFirst: vi.fn(), update: vi.fn() },
    user: { findUnique: vi.fn() },
    orderActivity: { create: vi.fn() },
    orderClaimHistory: { create: vi.fn() },
    $transaction: vi.fn(),
  },
  requireContext: vi.fn(),
  can: vi.fn(),
  assertOrderAccess: vi.fn(),
  atomicClaim: vi.fn(),
  logAudit: vi.fn(),
}));

vi.mock('@/lib/db', () => ({ db }));
vi.mock('@/lib/geo-context', () => ({ requireContext: (...a: unknown[]) => requireContext(...a) }));
vi.mock('@/lib/authorization', () => ({ can: (...a: unknown[]) => can(...a) }));
vi.mock('@/lib/rbac', () => ({
  ORDER_ACCESS_STATUS: { NOT_FOUND: 404, WRONG_COMPANY: 404, NOT_ASSIGNED: 403 },
  assertOrderAccess: (...a: unknown[]) => assertOrderAccess(...a),
}));
vi.mock('@/lib/order-locks', () => ({
  atomicClaim: (...a: unknown[]) => atomicClaim(...a),
  isLockActive: () => false,
  lockConfig: () => ({ lockDurationMs: 60_000 }),
  ownershipSnapshot: () => ({ previousOwnerId: null }),
}));
vi.mock('@/lib/audit', () => ({ logAudit: (...a: unknown[]) => logAudit(...a) }));
vi.mock('@/lib/api-error', () => ({
  apiError: (e: unknown) =>
    new Response(JSON.stringify({ error: `UNEXPECTED: ${(e as Error)?.message}` }), { status: 500 }),
}));

import { POST } from './route';
import { CLAIM_CAPS } from '@/lib/confirmation-queue';

/** An unclaimed order sitting in the queue. */
const QUEUED = {
  id: 'o1',
  companyId: 'c1',
  orderNumber: 'ORD-9',
  claimedById: null,
  signatureStatus: 'UNSIGNED',
  confirmationStatus: 'NEW',
};

const take = () =>
  POST(new Request('http://localhost/api/orders/o1/claim', { method: 'POST' }), {
    params: Promise.resolve({ id: 'o1' }),
  });

/**
 * What her desk looks like. `ownedCounts` reads two counts and one row, in
 * that order — total, then without-attempt, then the untouched order it
 * names in the refusal.
 */
function desk({ total = 0, withoutAttempt = 0, untouched = null as null | { id: string; orderNumber: string } }) {
  db.order.count.mockResolvedValueOnce(total).mockResolvedValueOnce(withoutAttempt);
  // The first `findFirst` is the claim door asking «is it held for a colleague?» (nobody holds it); the next is the untouched order.
  db.order.findFirst.mockResolvedValueOnce(null).mockResolvedValue(untouched);
}

beforeEach(() => {
  vi.clearAllMocks();
  requireContext.mockResolvedValue({
    user: { id: 'a1', name: 'سارة', role: 'CONFIRMATION_AGENT' },
    companyId: 'c1',
    storeId: 's1',
  });
  can.mockImplementation((_u: unknown, k: string) => k === 'orders.claim');
  assertOrderAccess.mockResolvedValue({ allowed: true, order: QUEUED });
  atomicClaim.mockResolvedValue(true);
  db.order.findUnique.mockResolvedValue(QUEUED);
  db.order.update.mockResolvedValue(QUEUED);
  db.$transaction.mockImplementation(async (fn: (tx: unknown) => Promise<unknown>) => fn(db));
  logAudit.mockResolvedValue(undefined);
});

describe('taking one order by its id', () => {
  it('is refused at the total cap, and nothing is claimed', async () => {
    desk({ total: CLAIM_CAPS.total });

    const res = await take();
    const body = await res.json();

    expect(res.status, JSON.stringify(body)).toBe(409);
    expect(body.code).toBe('CAP_TOTAL');
    expect(atomicClaim, 'انحجز الطلب رغم بلوغ الحدّ').not.toHaveBeenCalled();
  });

  it('and at the without-attempt cap', async () => {
    desk({ total: 50, withoutAttempt: CLAIM_CAPS.withoutAttempt });

    const res = await take();
    const body = await res.json();

    expect(res.status).toBe(409);
    expect(body.code).toBe('CAP_WITHOUT_ATTEMPT');
    expect(atomicClaim).not.toHaveBeenCalled();
  });

  it('and while an untouched order is still in her hands — named, so she can open it', async () => {
    // C1's rule. The refusal carries the order it is about, because the
    // first version of that message named nothing and linked nowhere.
    desk({ total: 3, withoutAttempt: 1, untouched: { id: 'o-stuck', orderNumber: 'ORD-7' } });

    const res = await take();
    const body = await res.json();

    expect(res.status).toBe(409);
    expect(body.code).toBe('UNTOUCHED_ORDER');
    expect(body.orderId).toBe('o-stuck');
    expect(body.orderNumber).toBe('ORD-7');
    expect(atomicClaim).not.toHaveBeenCalled();
  });

  it('and goes through when her desk is clear', async () => {
    desk({ total: 3, withoutAttempt: 0 });

    const res = await take();
    expect(res.status, await res.clone().text()).toBeLessThan(400);
    expect(atomicClaim).toHaveBeenCalledTimes(1);
  });
});

describe('and finishing a claim she already holds is not a new order', () => {
  it('the caps do not refuse an order already in her hands', async () => {
    /*
     * She holds it and the signature did not complete — the screen retries.
     * Refusing that at the cap would strand an order she is already counted
     * for: the number it is measured against includes this very order.
     */
    assertOrderAccess.mockResolvedValue({
      allowed: true,
      order: { ...QUEUED, claimedById: 'a1', signatureStatus: 'UNSIGNED' },
    });
    desk({ total: CLAIM_CAPS.total });

    const res = await take();
    expect(res.status, await res.clone().text()).toBeLessThan(400);
    expect(atomicClaim).toHaveBeenCalledTimes(1);
    expect(db.order.count, 'حسب الطلبات رغم إنّه طلبها هي').not.toHaveBeenCalled();
  });
});
