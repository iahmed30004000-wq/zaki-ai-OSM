import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * ═══════════════════════════════════════════════════════════════════════
 * DEFINITION OF DONE
 *
 * The order sheet draws «سحبه منه» on an order somebody else holds, and the
 * release door answered the owner «ليس بين يديك» — three times in a row.
 *
 *  1. The owner and the supervisor (`orders.unlock`) pull back ANY order that
 *     is still at the confirmation desk, with a written reason.
 *  2. Everybody else is still refused: «ليس بين يديك», 403, nothing written.
 *  3. Past confirmation (confirmed, shipped, closed) it is refused, so a
 *     released order never reopens a settled step.
 *  4. Nobody holds it → 409; no reason → 400. Nothing is written for any refusal.
 *  5. The holder releasing his own order is unchanged.
 *
 * Blockers: money untouched, order creation untouched, the take-over door
 * (`?mode=override`) untouched.
 * ═══════════════════════════════════════════════════════════════════════
 */

const { db, requireContext, can, assertOrderAccess, logAudit } = vi.hoisted(() => ({
  db: {
    order: { updateMany: vi.fn(), findUnique: vi.fn() },
    orderActivity: { create: vi.fn() },
    orderClaimHistory: { create: vi.fn() },
  },
  requireContext: vi.fn(),
  can: vi.fn(),
  assertOrderAccess: vi.fn(),
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
  atomicClaim: vi.fn(),
  isLockActive: () => false,
  lockConfig: () => ({ lockDurationMs: 60_000 }),
  ownershipSnapshot: () => ({}),
}));
vi.mock('@/lib/audit', () => ({ logAudit: (...a: unknown[]) => logAudit(...a) }));
vi.mock('@/lib/api-error', () => ({
  apiError: (e: unknown) => ({ body: { error: `UNEXPECTED: ${(e as Error)?.message}` }, status: 500 }),
}));

import { DELETE } from './route';

/** An order an agent is working at the confirmation desk. */
const HELD = {
  id: 'o1',
  companyId: 'c1',
  claimedById: 'agent1',
  currentOwnerId: 'agent1',
  lockedById: 'agent1',
  version: 4,
  confirmationStatus: 'NEW',
  shippingStatus: 'NOT_READY',
};

const pullBack = (reason: string | null = 'هاد طلب 10 قطع') =>
  DELETE(
    new Request(`http://localhost/api/orders/o1/claim${reason === null ? '' : `?reason=${encodeURIComponent(reason)}`}`, { method: 'DELETE' }),
    { params: Promise.resolve({ id: 'o1' }) },
  );

const as = (id: string, keys: string[]) => {
  requireContext.mockResolvedValue({ user: { id, name: 'س', role: 'X' }, companyId: 'c1', storeId: 's1' });
  can.mockImplementation((_u: unknown, k: string) => keys.includes(k));
};

beforeEach(() => {
  vi.clearAllMocks();
  assertOrderAccess.mockResolvedValue({ allowed: true, order: { ...HELD } });
  db.order.updateMany.mockResolvedValue({ count: 1 });
  db.order.findUnique.mockResolvedValue({ ...HELD, claimedById: null });
});

describe('the owner pulls back an order somebody else holds', () => {
  it('releases it to the queue, breaks his lock and writes who did it and why', async () => {
    as('owner1', ['orders.release', 'orders.unlock']);
    const res = await pullBack();
    expect(res.status).toBe(200);

    const call = db.order.updateMany.mock.calls[0][0];
    expect(call.where).toMatchObject({ id: 'o1', claimedById: 'agent1', version: 4 });
    expect(call.data).toMatchObject({
      claimedById: null, currentOwnerId: null, assignedToId: null,
      confirmationStatus: 'NEW', signatureStatus: 'UNSIGNED',
      lockedById: null,
    });
    expect(db.orderClaimHistory.create.mock.calls[0][0].data).toMatchObject({
      userId: 'owner1', action: 'RELEASED', reason: 'هاد طلب 10 قطع',
    });
    expect(JSON.parse(db.orderClaimHistory.create.mock.calls[0][0].data.metadata)).toMatchObject({
      previousOwner: 'agent1', pulledBackBy: 'owner1',
    });
    expect(logAudit.mock.calls[0][0].previousData).toEqual({ claimedById: 'agent1' });
  });

  it('works on an order held as NO_ANSWER or POSTPONED too (still the confirmation desk)', async () => {
    as('owner1', ['orders.release', 'orders.unlock']);
    assertOrderAccess.mockResolvedValue({ allowed: true, order: { ...HELD, confirmationStatus: 'NO_ANSWER' } });
    expect((await pullBack()).status).toBe(200);
  });
});

describe('nobody else may', () => {
  it('an agent without the key is told it is not in his hands, and nothing is written', async () => {
    as('agent2', ['orders.release']);
    const res = await pullBack();
    expect(res.status).toBe(403);
    expect((await res.json()).errorAr).toContain('ليس بين يديك');
    expect(db.order.updateMany).not.toHaveBeenCalled();
    expect(db.orderClaimHistory.create).not.toHaveBeenCalled();
    expect(logAudit).not.toHaveBeenCalled();
  });

  it('a reassigner without the unlock key is refused as well', async () => {
    as('lead1', ['orders.release', 'orders.assign']);
    expect((await pullBack()).status).toBe(403);
    expect(db.order.updateMany).not.toHaveBeenCalled();
  });
});

describe('what the owner is refused, and why', () => {
  it.each([
    ['confirmed', { confirmationStatus: 'CONFIRMED' }],
    ['in the warehouse', { confirmationStatus: 'CONFIRMED', shippingStatus: 'PACKING' }],
    ['shipped', { confirmationStatus: 'CONFIRMED', shippingStatus: 'SHIPPED' }],
    ['delivered', { confirmationStatus: 'CONFIRMED', shippingStatus: 'DELIVERED' }],
  ])('an order already %s does not go back to the queue', async (_label, patch) => {
    as('owner1', ['orders.release', 'orders.unlock']);
    assertOrderAccess.mockResolvedValue({ allowed: true, order: { ...HELD, ...patch } });
    const res = await pullBack();
    expect(res.status).toBe(409);
    expect((await res.json()).code).toBe('PAST_CONFIRMATION');
    expect(db.order.updateMany).not.toHaveBeenCalled();
  });

  it('an order nobody holds is already in the queue', async () => {
    as('owner1', ['orders.release', 'orders.unlock']);
    assertOrderAccess.mockResolvedValue({ allowed: true, order: { ...HELD, claimedById: null, currentOwnerId: null, lockedById: null } });
    const res = await pullBack();
    expect(res.status).toBe(409);
    expect((await res.json()).code).toBe('ALREADY_IN_QUEUE');
    expect(db.order.updateMany).not.toHaveBeenCalled();
  });

  it.each([null, '', 'ab'])('no reason (%j) is refused before anything is written', async (reason) => {
    as('owner1', ['orders.release', 'orders.unlock']);
    const res = await pullBack(reason);
    expect(res.status).toBe(400);
    expect((await res.json()).code).toBe('REASON_REQUIRED');
    expect(db.order.updateMany).not.toHaveBeenCalled();
  });

  it('a save that raced the pull-back is told to reload, with no history written', async () => {
    as('owner1', ['orders.release', 'orders.unlock']);
    db.order.updateMany.mockResolvedValue({ count: 0 });
    const res = await pullBack();
    expect(res.status).toBe(409);
    expect((await res.json()).code).toBe('VERSION_CONFLICT');
    expect(db.orderClaimHistory.create).not.toHaveBeenCalled();
  });
});

describe('the holder giving his own order back is unchanged', () => {
  it('releases it with his own id in the guard and without clearing «assigned»', async () => {
    as('agent1', ['orders.release']);
    const res = await pullBack('انتهى دوامي');
    expect(res.status).toBe(200);
    const call = db.order.updateMany.mock.calls[0][0];
    expect(call.where.claimedById).toBe('agent1');
    expect(call.data).not.toHaveProperty('assignedToId');
    expect(JSON.parse(db.orderClaimHistory.create.mock.calls[0][0].data.metadata)).toEqual({ previousOwner: 'agent1' });
  });
});

describe('the holder is only a current owner, and the unlock key alone is not enough', () => {
  it('claimedById null with currentOwnerId set: matches IS NULL, writes the owner as the one pulled back', async () => {
    as('owner1', ['orders.release', 'orders.unlock']);
    assertOrderAccess.mockResolvedValue({ allowed: true, order: { ...HELD, claimedById: null, lockedById: null } });
    const res = await pullBack();
    expect(res.status).toBe(200);
    expect(db.order.updateMany.mock.calls[0][0].where.claimedById).toBeNull();
    expect(JSON.parse(db.orderClaimHistory.create.mock.calls[0][0].data.metadata)).toMatchObject({ previousOwner: 'agent1' });
  });

  it('unlock without release is refused at the first door, nothing written', async () => {
    as('owner1', ['orders.unlock']);
    const res = await pullBack();
    expect(res.status).toBe(403);
    expect(db.order.updateMany).not.toHaveBeenCalled();
  });
});
