import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * An order moves sideways, never into hands that cannot work it.
 *
 * Transfer accepted any active colleague, so a confirmation order could be handed to the warehouse: a pair of hands that cannot do the
 * next thing it needs, and a queue that would never show it again.
 *
 *  · AN AGENT giving an order up hands it to someone of the SAME ROLE — unchanged.
 *  · WHOEVER ASSIGNS (`orders.assign`: the owner, the supervisor) used to be held to that too: «same role as the holder», and the holder
 *    was the owner who had just taken the order, so «سحبت الطلب اجيت اعطيه لموظفة التأكيد مش ملاقيها» (the owner, 1/11) — the list held
 *    only people of HIS role. What the rule protects is that the order lands in hands that can WORK it, so for him that is what is
 *    asked: the target holds `confirmation.work`. The warehouse is still refused, as it was.
 */

const { db, requireContext, assertOrderAccess, authorize, can, logAudit, resolveAudience } = vi.hoisted(() => ({
  db: {
    user: { findUnique: vi.fn(), findMany: vi.fn() },
    order: { updateMany: vi.fn(), findUnique: vi.fn() },
    orderClaimHistory: { create: vi.fn() },
    orderActivity: { create: vi.fn() },
  },
  requireContext: vi.fn(),
  assertOrderAccess: vi.fn(),
  authorize: vi.fn(),
  can: vi.fn(),
  logAudit: vi.fn(),
  resolveAudience: vi.fn(),
}));

vi.mock('@/lib/db', () => ({ db }));
vi.mock('@/lib/geo-context', () => ({ requireContext: (...a: unknown[]) => requireContext(...a) }));
vi.mock('@/lib/rbac', () => ({
  assertOrderAccess: (...a: unknown[]) => assertOrderAccess(...a),
  // Reads go through the list's envelope; the same verdict feeds both
  // here, because these tests are about what follows a verdict.
  assertOrderReadable: (...a: unknown[]) => assertOrderAccess(...a),
  ORDER_ACCESS_STATUS: { NOT_FOUND: 404, WRONG_COMPANY: 404, NOT_ASSIGNED: 404 },
}));
vi.mock('@/lib/order-locks', () => ({ ownershipSnapshot: vi.fn() }));
vi.mock('@/lib/audit', () => ({ logAudit: (...a: unknown[]) => logAudit(...a) }));
vi.mock('@/lib/authorization', () => ({
  authorize: (...a: unknown[]) => authorize(...a),
  can: (...a: unknown[]) => can(...a),
}));
vi.mock('@/lib/notification-audience', () => ({ resolveAudience: (...a: unknown[]) => resolveAudience(...a) }));

import { POST, GET } from './[id]/transfer/route';

const ORDER_ID = '55555555-5555-4555-8555-555555555555';
const params = { params: Promise.resolve({ id: ORDER_ID }) };

const HOLDER = { id: 'agent-1', name: 'سارة', companyId: 'c1', status: 'ACTIVE', role: 'CONFIRMATION_AGENT', roleId: 'role-conf' };
const PEER = { id: 'agent-2', name: 'ليلى', companyId: 'c1', status: 'ACTIVE', role: 'CONFIRMATION_AGENT', roleId: 'role-conf' };
const WAREHOUSE = { id: 'wh-1', name: 'أبو أحمد', companyId: 'c1', status: 'ACTIVE', role: 'WAREHOUSE', roleId: 'role-wh' };
/** A confirmation employee on ANOTHER role than the owner's (and than the first agent's): the one he could not find. */
const ABEER = { id: 'agent-3', name: 'عبير', companyId: 'c1', status: 'ACTIVE', role: 'CONFIRMATION_AGENT_2', roleId: 'role-conf-2' };
const OWNER = { id: 'owner', name: 'أحمد', companyId: 'c1', status: 'ACTIVE', role: 'COMPANY_ADMIN', roleId: 'role-admin' };
const MOHAMMED = { id: 'admin-2', name: 'Mohammed kiw', companyId: 'c1', status: 'ACTIVE', role: 'COMPANY_ADMIN', roleId: 'role-admin' };

const order = {
  id: ORDER_ID, companyId: 'c1', version: 2, status: 'NEW',
  claimedById: HOLDER.id, currentOwnerId: HOLDER.id,
};

const post = (body: unknown) =>
  POST(
    new Request('http://localhost/x', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }),
    params
  );

/** Who `confirmation.work` reaches, as `resolveAudience` returns them (sessions with ids and names). */
const WORKERS = [
  { id: HOLDER.id, name: HOLDER.name, email: 's@x.com' },
  { id: PEER.id, name: PEER.name, email: 'l@x.com' },
  { id: ABEER.id, name: ABEER.name, email: 'a@x.com' },
];

/** The actor is somebody who ASSIGNS — a manager, who is not the holder. */
function asReassigner(holder: typeof HOLDER | typeof OWNER = HOLDER) {
  requireContext.mockResolvedValue({ user: { id: 'manager', name: 'المدير', role: 'MANAGER' }, companyId: 'c1', storeId: 's1' });
  authorize.mockReturnValue({ allowed: true });
  can.mockReturnValue(true);
  const held = { ...order, claimedById: holder.id, currentOwnerId: holder.id };
  assertOrderAccess.mockResolvedValue({ allowed: true, order: held });
  db.order.findUnique.mockResolvedValue(held);
}
/** The actor is the agent who HOLDS the order and may only give it up. */
function asHolderAgent() {
  requireContext.mockResolvedValue({ user: { id: HOLDER.id, name: HOLDER.name, role: HOLDER.role }, companyId: 'c1', storeId: 's1' });
  authorize.mockReturnValue({ allowed: false });
  can.mockImplementation((_u: unknown, key: string) => key === 'orders.release');
  assertOrderAccess.mockResolvedValue({ allowed: true, order });
  db.order.findUnique.mockResolvedValue(order);
}

beforeEach(() => {
  vi.clearAllMocks();
  asReassigner();
  db.order.updateMany.mockResolvedValue({ count: 1 });
  resolveAudience.mockResolvedValue(WORKERS);
  db.user.findUnique.mockImplementation(async ({ where }: any) => {
    const all = [HOLDER, PEER, WAREHOUSE, ABEER, OWNER, MOHAMMED];
    return all.find((u) => u.id === where.id) ?? null;
  });
});

describe('an agent giving an order up stays within the same job — as before', () => {
  beforeEach(asHolderAgent);

  it('hands the order to a colleague of the same role', async () => {
    const res = await post({ targetUserId: PEER.id, reason: 'إجازة سارة' });
    expect(res.status).toBe(200);
    expect(db.order.updateMany).toHaveBeenCalled();
    expect(resolveAudience, 'an agent is not asked about who can work: rank is her rule').not.toHaveBeenCalled();
  });

  it('refuses to hand a confirmation order to the warehouse — DIFFERENT_RANK', async () => {
    const res = await post({ targetUserId: WAREHOUSE.id, reason: 'تجربة' });
    expect(res.status).toBe(409);
    expect((await res.json()).code).toBe('DIFFERENT_RANK');
    expect(db.order.updateMany).not.toHaveBeenCalled();
  });

  it('NEGATIVE: and not to a confirmation employee of ANOTHER role either — that door is for whoever assigns', async () => {
    const res = await post({ targetUserId: ABEER.id, reason: 'تجربة' });
    expect(res.status).toBe(409);
    expect((await res.json()).code).toBe('DIFFERENT_RANK');
    expect(db.order.updateMany).not.toHaveBeenCalled();
  });
});

describe('whoever assigns hands an order to anybody who can work it — the owner, 1/11', () => {
  it('the owner took the order (he is the holder) and gives it to a confirmation employee of another role ⇒ done', async () => {
    asReassigner(OWNER);
    const res = await post({ targetUserId: ABEER.id, reason: 'تتابعه موظفة التأكيد' });
    expect(res.status, JSON.stringify(await res.clone().json())).toBe(200);
    const w = db.order.updateMany.mock.calls[0][0];
    expect(w.data).toMatchObject({ claimedById: ABEER.id, currentOwnerId: ABEER.id, assignedToId: ABEER.id });
  });

  it('a manager hands an agent’s order to a colleague of another role who can work it ⇒ done', async () => {
    const res = await post({ targetUserId: ABEER.id, reason: 'قرار إداري' });
    expect(res.status).toBe(200);
    expect(db.order.updateMany).toHaveBeenCalled();
  });

  it('asks the engine who can WORK, for the company and the store: confirmation.work', async () => {
    await post({ targetUserId: PEER.id, reason: 'تصحيح' });
    expect(resolveAudience).toHaveBeenCalledWith({ companyId: 'c1', storeId: 's1', audience: { permission: 'confirmation.work' } });
  });

  it('still refuses the warehouse — hands that cannot work it — with its own sentence', async () => {
    const res = await post({ targetUserId: WAREHOUSE.id, reason: 'قرار إداري' });
    const body = await res.json();
    expect(res.status).toBe(409);
    expect(body.code).toBe('CANNOT_WORK_IT');
    expect(body.errorAr).toContain(WAREHOUSE.name);
    expect(body.errorAr).toContain('موظف تأكيد');
    expect(db.order.updateMany).not.toHaveBeenCalled();
  });

  it('NEGATIVE: a confirmation employee whose key was unticked (not among those who can work) is refused too', async () => {
    resolveAudience.mockResolvedValue(WORKERS.filter((u) => u.id !== ABEER.id));
    const res = await post({ targetUserId: ABEER.id, reason: 'تجربة' });
    expect(res.status).toBe(409);
    expect((await res.json()).code).toBe('CANNOT_WORK_IT');
    expect(db.order.updateMany).not.toHaveBeenCalled();
  });

  it('NEGATIVE: an employee of ANOTHER company or an inactive account never gets this far', async () => {
    db.user.findUnique.mockImplementation(async ({ where }: any) =>
      where.id === 'x1' ? { id: 'x1', name: 'غريب', companyId: 'c-other', status: 'ACTIVE', role: 'CONFIRMATION_AGENT', roleId: 'role-conf' } : where.id === 'x2' ? { ...PEER, id: 'x2', status: 'INACTIVE' } : null
    );
    for (const id of ['x1', 'x2']) {
      const res = await post({ targetUserId: id, reason: 'تجربة' });
      expect(res.status, id).toBe(400);
    }
    expect(db.order.updateMany).not.toHaveBeenCalled();
  });
});

describe('what did not move', () => {
  it('still demands a reason', async () => {
    const res = await post({ targetUserId: PEER.id });
    expect(res.status).toBe(400);
    expect(db.order.updateMany).not.toHaveBeenCalled();
  });

  it('still refuses a closed order — read from the state, not the legacy column', async () => {
    // The legacy `status` is not written by the courier feed or by the
    // door-side recorder, so an order delivered either way stayed
    // transferable. Both of these carry the legacy column of an OPEN order.
    for (const shippingStatus of ['DELIVERED', 'PARTIALLY_DELIVERED', 'RETURNED']) {
      assertOrderAccess.mockResolvedValue({
        allowed: true,
        order: { ...order, status: 'CONFIRMED', shippingStatus },
      });
      const res = await post({ targetUserId: PEER.id, reason: 'تصحيح' });
      expect((await res.json()).code, shippingStatus).toBe('TERMINAL_STATUS');
    }
  });

  it('still allows transferring an order that is still open', async () => {
    assertOrderAccess.mockResolvedValue({
      allowed: true,
      order: { ...order, confirmationStatus: 'CONFIRMED', shippingStatus: 'NOT_READY' },
    });
    expect((await post({ targetUserId: PEER.id, reason: 'تصحيح' })).status).toBe(200);
  });

  it('still refuses a stale version', async () => {
    db.order.updateMany.mockResolvedValue({ count: 0 });
    const res = await post({ targetUserId: PEER.id, reason: 'إجازة سارة' });
    expect((await res.json()).code).toBe('VERSION_CONFLICT');
  });

  it('still refuses somebody who neither assigns nor holds the order', async () => {
    requireContext.mockResolvedValue({ user: { id: 'nobody', name: 'م', role: 'X' }, companyId: 'c1', storeId: 's1' });
    authorize.mockReturnValue({ allowed: false });
    can.mockImplementation((_u: unknown, key: string) => key === 'orders.release');
    const res = await post({ targetUserId: PEER.id, reason: 'تجربة' });
    expect(res.status).toBe(403);
    expect(db.order.updateMany).not.toHaveBeenCalled();
  });
});

describe('the screen is offered exactly what the server accepts', () => {
  it('an agent giving an order up: only colleagues of the holder’s role', async () => {
    asHolderAgent();
    db.user.findMany.mockResolvedValue([{ id: PEER.id, name: PEER.name, email: 'l@x.com' }]);

    const body = await (await GET(new Request('http://localhost/x'), params)).json();

    expect(body.mayTransfer).toBe(true);
    expect(body.scope).toBe('SAME_RANK');
    expect(body.holder.name).toBe('سارة');
    expect(db.user.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ companyId: 'c1', status: 'ACTIVE', roleId: 'role-conf' }),
      })
    );
    expect(body.candidates).toHaveLength(1);
    expect(resolveAudience).not.toHaveBeenCalled();
  });

  it('whoever assigns: every employee who can work the order — the confirmation employee he could not find is in the list', async () => {
    asReassigner(OWNER);
    // The list belongs to the HOLDER's side: the owner is the holder and is not offered to himself.
    resolveAudience.mockResolvedValue([{ id: OWNER.id, name: OWNER.name, email: 'o@x.com' }, ...WORKERS]);

    const body = await (await GET(new Request('http://localhost/x'), params)).json();

    expect(body.mayTransfer).toBe(true);
    expect(body.scope).toBe('ANY_AGENT');
    expect(body.candidates.map((c: { id: string }) => c.id).sort()).toEqual([ABEER.id, HOLDER.id, PEER.id].sort());
    expect(body.candidates.find((c: { id: string }) => c.id === OWNER.id), 'the holder is offered to himself').toBeUndefined();
    expect(db.user.findMany, 'the same-role query is not the owner’s list any more').not.toHaveBeenCalled();
  });

  it('whoever assigns: what is offered is exactly what the POST accepts (the same list is asked)', async () => {
    asReassigner(OWNER);
    const offered = (await (await GET(new Request('http://localhost/x'), params)).json()).candidates as Array<{ id: string }>;
    for (const c of offered) {
      vi.clearAllMocks();
      asReassigner(OWNER);
      db.order.updateMany.mockResolvedValue({ count: 1 });
      resolveAudience.mockResolvedValue(WORKERS);
      db.user.findUnique.mockImplementation(async ({ where }: any) => [HOLDER, PEER, ABEER, OWNER].find((u) => u.id === where.id) ?? null);
      expect((await post({ targetUserId: c.id, reason: 'تصحيح' })).status, c.id).toBe(200);
    }
  });

  it('the list is sorted by name and holds at most fifty', async () => {
    asReassigner(OWNER);
    const many = Array.from({ length: 70 }, (_v, i) => ({ id: `w${i}`, name: `موظف ${String(70 - i).padStart(2, '0')}`, email: null }));
    resolveAudience.mockResolvedValue(many);
    const body = await (await GET(new Request('http://localhost/x'), params)).json();
    expect(body.candidates).toHaveLength(50);
    const names = body.candidates.map((c: { name: string }) => c.name);
    expect(names).toEqual([...names].sort((a: string, b: string) => a.localeCompare(b, 'ar')));
  });

  it('offers nobody when this person may not transfer at all', async () => {
    authorize.mockReturnValue({ allowed: false });
    can.mockReturnValue(false);

    const body = await (await GET(new Request('http://localhost/x'), params)).json();
    expect(body.mayTransfer).toBe(false);
    expect(body.candidates).toEqual([]);
  });

  it('never offers the holder themselves (the agent’s list)', async () => {
    asHolderAgent();
    db.user.findMany.mockResolvedValue([]);
    await GET(new Request('http://localhost/x'), params);
    expect(db.user.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ id: { not: HOLDER.id } }) })
    );
  });
});
