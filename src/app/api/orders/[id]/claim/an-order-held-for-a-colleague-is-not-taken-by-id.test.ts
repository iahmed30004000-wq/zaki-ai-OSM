import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * ═══════════════════════════════════════════════════════════════════════
 * DEFINITION OF DONE — the claim door and the release door, on a returning customer's order
 *
 * An order held for the agent who worked the customer last (order-reservation.ts):
 *
 *  1. Taking it BY ID is refused to everybody but her: 409 `RESERVED_FOR_COLLEAGUE`, her name in the sentence, nothing claimed,
 *     nothing written. She, and an order nobody holds, go through as before.
 *  2. The hold is made (best-effort) for THIS order before it is read, and a failure to make it never stops a claim.
 *  3. The owner's override («استلمه أنا») is not asked this question — it is the way through for the owner and the supervisor.
 *  4. A release — hers, or the owner's pulling it back — writes `assignedAt: null`, so what she gave back is not held for her
 *     a second time; the NAME stays (history), and a pull-back clears it as it did before.
 *
 * Blockers: no money, no order creation.
 * ═══════════════════════════════════════════════════════════════════════
 */

const { db, requireContext, can, assertOrderAccess, atomicClaim, logAudit, reserve } = vi.hoisted(() => ({
  db: {
    order: { findUnique: vi.fn(), count: vi.fn(), findFirst: vi.fn(), update: vi.fn(), updateMany: vi.fn() },
    user: { findUnique: vi.fn() },
    orderActivity: { create: vi.fn() },
    orderClaimHistory: { create: vi.fn() },
  },
  requireContext: vi.fn(),
  can: vi.fn(),
  assertOrderAccess: vi.fn(),
  atomicClaim: vi.fn(),
  logAudit: vi.fn(),
  reserve: vi.fn(),
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
vi.mock('@/lib/reserve-returning-customers', () => ({ reserveReturningCustomers: (...a: unknown[]) => reserve(...a) }));
vi.mock('@/lib/api-error', () => ({
  apiError: (e: unknown) => ({ body: { error: `UNEXPECTED: ${(e as Error)?.message}` }, status: 500 }),
}));

import { DELETE, POST } from './route';
import { reservedMessage } from '@/lib/order-reservation';

const QUEUED = { id: 'o1', companyId: 'c1', orderNumber: 'ORD-9', claimedById: null, signatureStatus: 'UNSIGNED', confirmationStatus: 'NEW' };

const take = (query = '') =>
  POST(new Request(`http://localhost/api/orders/o1/claim${query}`, { method: 'POST' }), { params: Promise.resolve({ id: 'o1' }) });

beforeEach(() => {
  vi.clearAllMocks();
  requireContext.mockResolvedValue({ user: { id: 'a1', name: 'هدى', role: 'CONFIRMATION_AGENT' }, companyId: 'c1', storeId: 's1' });
  can.mockImplementation((_u: unknown, k: string) => k === 'orders.claim');
  assertOrderAccess.mockResolvedValue({ allowed: true, order: QUEUED });
  atomicClaim.mockResolvedValue(true);
  reserve.mockResolvedValue(0);
  // `findFirst` is read twice by a normal claim: «is it held for a colleague?», then the untouched order of her desk.
  db.order.findFirst.mockResolvedValue(null);
  db.order.count.mockResolvedValue(0);
  db.order.findUnique.mockResolvedValue(QUEUED);
  logAudit.mockResolvedValue(undefined);
});

describe('taking an order by its id', () => {
  it('is refused when it is held for a colleague — her name in the sentence, nothing claimed, nothing written', async () => {
    db.order.findFirst.mockResolvedValueOnce({ assignee: { name: 'سارة' } });

    const res = await take();
    const body = await res.json();

    expect(res.status).toBe(409);
    expect(body.code).toBe('RESERVED_FOR_COLLEAGUE');
    expect(body.errorAr).toBe(reservedMessage('سارة'));
    expect(body.heldFor).toBe('سارة');
    expect(atomicClaim).not.toHaveBeenCalled();
    expect(db.orderClaimHistory.create).not.toHaveBeenCalled();
    expect(db.orderActivity.create).not.toHaveBeenCalled();
    expect(logAudit).not.toHaveBeenCalled();
  });

  it('asks the held-for-others filter of THIS order and THIS agent', async () => {
    await take();
    const asked = db.order.findFirst.mock.calls[0][0];
    expect(asked.where.id).toBe('o1');
    expect(JSON.stringify(asked.where)).toContain('"assignedToId":{"not":"a1"}');
    expect(JSON.stringify(asked.where)).toContain('"claimedById":null');
  });

  it('goes through when it is not held for anybody else — and when it is held for HER (the filter excludes hers)', async () => {
    const res = await take();
    expect(res.status).toBe(200);
    expect(atomicClaim).toHaveBeenCalledTimes(1);
  });

  it('makes the hold for this one order first, before it reads it', async () => {
    await take();
    expect(reserve).toHaveBeenCalledTimes(1);
    expect(reserve.mock.calls[0][0]).toEqual({ companyId: 'c1', storeId: 's1' });
    expect(reserve.mock.calls[0][2]).toEqual({ orderIds: ['o1'] });
    expect(reserve.mock.invocationCallOrder[0]).toBeLessThan(assertOrderAccess.mock.invocationCallOrder[0]);
  });

  it('never stops a claim because the hold could not be made', async () => {
    reserve.mockRejectedValue(new Error('the audience query failed'));
    const res = await take();
    expect(res.status).toBe(200);
    expect(atomicClaim).toHaveBeenCalledTimes(1);
  });

  it('NEGATIVE: somebody who may not claim at all triggers no hold write — the assigner and its audience reads are not for any signed-in user', async () => {
    can.mockImplementation(() => false);
    const res = await take();
    expect(res.status).toBe(403);
    expect(reserve).not.toHaveBeenCalled();
    expect(atomicClaim).not.toHaveBeenCalled();
  });

  it('a hold that lands AFTER the check, and is refused by the write, answers «تابع لـ…» — nobody claimed it', async () => {
    atomicClaim.mockResolvedValue(false);
    // the held-check (not held yet), the untouched-order read of her desk, then the read after the refused write (held now)
    db.order.findFirst.mockResolvedValueOnce(null).mockResolvedValueOnce(null).mockResolvedValueOnce({ assignee: { name: 'سارة' } });

    const res = await take();
    const body = await res.json();

    expect(res.status).toBe(409);
    expect(body.code).toBe('RESERVED_FOR_COLLEAGUE');
    expect(body.errorAr).toBe(reservedMessage('سارة'));
    expect(body.heldFor).toBe('سارة');
    expect(db.orderClaimHistory.create).not.toHaveBeenCalled();
  });

  it('NEGATIVE: losing the race to a colleague who CLAIMED it still says «already claimed»', async () => {
    atomicClaim.mockResolvedValue(false);
    const res = await take();
    expect(res.status).toBe(409);
    expect((await res.json()).code).toBe('ALREADY_CLAIMED');
  });

  it('is not asked of the person who already holds it (finishing a claim is not taking one)', async () => {
    assertOrderAccess.mockResolvedValue({ allowed: true, order: { ...QUEUED, claimedById: 'a1', signatureStatus: 'SIGNED' } });
    const res = await take();
    expect((await res.json()).alreadyClaimed).toBe(true);
    expect(db.order.findFirst).not.toHaveBeenCalled();
  });

  it('is not asked of the owner’s override — «استلمه أنا» is the way through', async () => {
    can.mockImplementation((_u: unknown, k: string) => k === 'orders.unlock');
    db.order.updateMany.mockResolvedValue({ count: 1 });
    const res = await take('?mode=override').catch(() => null);
    expect(res).not.toBeNull();
    expect(db.order.findFirst).not.toHaveBeenCalled();
  });
});

describe('giving an order back', () => {
  const HELD = { id: 'o1', companyId: 'c1', claimedById: 'a1', currentOwnerId: 'a1', assignedToId: 'a1', lockedById: null, version: 4, confirmationStatus: 'IN_PROGRESS', shippingStatus: 'NOT_READY' };
  const release = (reason = 'انتهى دوامي') =>
    DELETE(new Request(`http://localhost/api/orders/o1/claim?reason=${encodeURIComponent(reason)}`, { method: 'DELETE' }), {
      params: Promise.resolve({ id: 'o1' }),
    });

  it('her own release writes `assignedAt: null` and keeps the name — what she gave back is not held for her again', async () => {
    can.mockImplementation((_u: unknown, k: string) => k === 'orders.release');
    assertOrderAccess.mockResolvedValue({ allowed: true, order: HELD });
    db.order.updateMany.mockResolvedValue({ count: 1 });

    const res = await release();

    expect(res.status).toBe(200);
    const data = db.order.updateMany.mock.calls[0][0].data;
    expect(data).toMatchObject({ claimedById: null, assignedAt: null, confirmationStatus: 'NEW' });
    expect(data).not.toHaveProperty('assignedToId');
  });

  it('the owner’s pull-back clears the name as well, as it did before', async () => {
    can.mockImplementation((_u: unknown, k: string) => k === 'orders.release' || k === 'orders.unlock');
    assertOrderAccess.mockResolvedValue({ allowed: true, order: { ...HELD, claimedById: 'agent1', currentOwnerId: 'agent1' } });
    db.order.updateMany.mockResolvedValue({ count: 1 });

    const res = await release('الزبون طلب موظفة تانية');

    expect(res.status).toBe(200);
    expect(db.order.updateMany.mock.calls[0][0].data).toMatchObject({ claimedById: null, assignedAt: null, assignedToId: null });
  });
});
