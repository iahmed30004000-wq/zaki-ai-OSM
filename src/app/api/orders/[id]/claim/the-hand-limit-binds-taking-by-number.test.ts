import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * ═══════════════════════════════════════════════════════════════════════
 * THE HAND LIMIT BINDS TAKING AN ORDER BY ITS NUMBER (the owner, 9/11: «الطلب يرجع للطابور فوراً»)
 *
 * `POST /api/orders/[id]/claim` — for the accounts that may still take an order by id (a moderator, a manager) — asks the same cap
 * the pull asks (`taking-one-obeys-the-same-caps.test.ts`). With the mode ON that cap is the HAND LIMIT, five, in the owner’s
 * sentence; with it OFF the cap of 500 and its own words, untouched. (An agent bound to the orders she holds is refused before any
 * of this — `an-agent-pulls-she-does-not-claim-by-number.test.ts`.)
 *
 * The same mocks as `taking-one-obeys-the-same-caps.test.ts`, the two switches answered by this test.
 * Blockers: no money, no order creation, no migration.
 * ═══════════════════════════════════════════════════════════════════════
 */

const { db, requireContext, can, assertOrderAccess, atomicClaim, logAudit, sw, rsw } = vi.hoisted(() => ({
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
  sw: { value: { enabled: false, enabledAt: null } as { enabled: boolean; enabledAt: Date | null } },
  rsw: { value: { enabled: false, enabledAt: null } as { enabled: boolean; enabledAt: Date | null } },
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
  apiError: (e: unknown) => new Response(JSON.stringify({ error: `UNEXPECTED: ${(e as Error)?.message}` }), { status: 500 }),
}));
vi.mock('@/lib/no-answer-rounds-switch', () => ({ roundsSwitch: async () => sw.value }));
vi.mock('@/lib/no-answer-returns-switch', () => ({ returnsSwitch: async () => rsw.value }));

import { POST } from './route';
import { CLAIM_CAPS } from '@/lib/confirmation-queue';

const ON = { enabled: true, enabledAt: new Date('2026-11-01T06:00:00.000Z') };
const OFF = { enabled: false, enabledAt: null };
const QUEUED = { id: 'o1', companyId: 'c1', orderNumber: 'ORD-9', claimedById: null, signatureStatus: 'UNSIGNED', confirmationStatus: 'NEW' };
const take = () => POST(new Request('http://localhost/api/orders/o1/claim', { method: 'POST' }), { params: Promise.resolve({ id: 'o1' }) });

/** Her desk, as `ownedCounts` reads it: total, then without-attempt, then (held for her) — and the untouched order, if any. */
function desk({ total = 0, withoutAttempt = 0 }: { total?: number; withoutAttempt?: number }) {
  db.order.count.mockResolvedValueOnce(total).mockResolvedValueOnce(withoutAttempt);
  // The first `findFirst` is the claim door asking «is it held for a colleague?» (nobody holds it); the next is the untouched order.
  db.order.findFirst.mockResolvedValueOnce(null).mockResolvedValue(null);
}

beforeEach(() => {
  vi.clearAllMocks();
  sw.value = ON;
  rsw.value = ON;
  // A moderator: she may claim, and no key binds her to the orders she holds.
  requireContext.mockResolvedValue({ user: { id: 'm1', name: 'مودريتور', role: 'MODERATOR' }, companyId: 'c1', storeId: 's1' });
  can.mockImplementation((_u: unknown, k: string) => k === 'orders.claim');
  assertOrderAccess.mockResolvedValue({ allowed: true, order: QUEUED });
  atomicClaim.mockResolvedValue(true);
  db.order.findUnique.mockResolvedValue(QUEUED);
  db.order.update.mockResolvedValue(QUEUED);
  db.$transaction.mockImplementation(async (fn: (tx: unknown) => Promise<unknown>) => fn(db));
  logAudit.mockResolvedValue(undefined);
});

describe('ON — five in her hands is the end of it', () => {
  it('the fifth is taken; the sixth is refused, in the owner’s sentence, and nothing is claimed', async () => {
    desk({ total: 4 });
    const fifth = await take();
    expect(fifth.status, await fifth.clone().text()).toBeLessThan(400);
    expect(atomicClaim).toHaveBeenCalledTimes(1);

    vi.clearAllMocks();
    atomicClaim.mockResolvedValue(true);
    db.order.findUnique.mockResolvedValue(QUEUED);
    desk({ total: 5 });
    const sixth = await take();
    const body = await sixth.json();
    expect(sixth.status, JSON.stringify(body)).toBe(409);
    expect(body.code).toBe('CAP_TOTAL');
    expect(body.errorAr).toBe('وصلت للحد (5) — خلّصي واحد أو اضغطي «أعِدْه إلى الطابور»');
    expect(atomicClaim, 'انحجز الطلب رغم بلوغ حدّ اليد').not.toHaveBeenCalled();
  });

  it('the cap of 40 without an attempt is still asked (it can never be reached under five, and it is not removed)', async () => {
    desk({ total: 2, withoutAttempt: CLAIM_CAPS.withoutAttempt });
    const res = await take();
    expect(res.status).toBe(409);
    expect((await res.json()).code).toBe('CAP_WITHOUT_ATTEMPT');
  });
});

describe('OFF — the cap is 500 and its words are the old ones', () => {
  it.each([
    ['its own switch off', () => { rsw.value = OFF; }],
    ['the rounds off, whatever the mode’s own switch holds', () => { sw.value = OFF; }],
  ])('%s: five in her hands is nothing, 500 is the end', async (_name, set) => {
    set();
    desk({ total: 5 });
    expect((await take()).status).toBeLessThan(400);

    vi.clearAllMocks();
    atomicClaim.mockResolvedValue(true);
    db.order.findUnique.mockResolvedValue(QUEUED);
    desk({ total: CLAIM_CAPS.total });
    const refused = await take();
    const body = await refused.json();
    expect(refused.status).toBe(409);
    expect(body.errorAr).toContain('500');
    expect(body.errorAr).not.toContain('أعِدْه إلى الطابور');
  });
});
