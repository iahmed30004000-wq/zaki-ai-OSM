import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SessionUser } from '@/types/auth';
import { ROLE_PERMISSIONS, type UserRole } from '@/types/auth';

/**
 * «تراجع عن المرتجع» (25/11) — `POST /api/ops/tracking/undo-return`: THE KEY, THE BODY, AND WHAT THE DOOR WRITES BESIDE THE PRESS.
 *
 * The key is the owner's `ops.undo_delivery` (the same box as «تراجع عن التسليم»), and it is tested with PEOPLE BUILT THE WAY A SESSION
 * BUILDS THEM: `computeEffectiveGrants` (role rows, personal overrides, a legacy account with no role row) and the real `can`. The undo itself
 * is `lib/return-undo.ts`, tested against a database that remembers; here only what the door adds: the order of the checks, the Arabic
 * refusals, the ONE audit line, and that a refusal of the press is said as the press said it.
 */

const { db, requireContext, requirePermission, audit, lib } = vi.hoisted(() => ({
  db: { $transaction: vi.fn() },
  requireContext: vi.fn(),
  requirePermission: vi.fn(),
  audit: vi.fn(),
  lib: { read: vi.fn(), undo: vi.fn() },
}));

vi.mock('@/lib/db', () => ({ db }));
vi.mock('@/lib/geo-context', () => ({ requireContext: (...a: unknown[]) => requireContext(...a) }));
vi.mock('@/lib/authorization', async (orig) => ({
  ...(await orig<typeof import('@/lib/authorization')>()),
  requirePermission: (...a: unknown[]) => requirePermission(...a),
}));
vi.mock('@/lib/audit', () => ({ logAudit: (...a: unknown[]) => audit(...a) }));
vi.mock('@/lib/return-undo', async (orig) => ({
  ...(await orig<typeof import('@/lib/return-undo')>()),
  readReturnUndoFacts: (...a: unknown[]) => lib.read(...a),
  undoReturn: (...a: unknown[]) => lib.undo(...a),
}));

import { attachGrants } from '@/lib/authorization';
import { computeEffectiveGrants } from '@/lib/permissions-core';
import { ReturnUndoStopped } from '@/lib/return-undo';
import { RETURN_UNDO_ACK_AR, RETURN_UNDO_ACTION, RETURN_UNDO_FORBIDDEN_AR, RETURN_UNDO_NOT_FOUND_AR, RETURN_UNDO_SUCCESS_AR } from '@/lib/return-undo-words';
import { POST } from './route';

const KEY = 'ops.undo_delivery';
const UUID = '11111111-1111-4111-8111-111111111111';

async function person(roleKeys: string[], deny: string[] = [], role = 'CUSTOM', roleId: string | null = 'r1'): Promise<SessionUser> {
  const base = { id: 'u1', email: 'u@x', name: 'سارة', role, roleId, status: 'ACTIVE', companyId: 'c1' } as unknown as SessionUser;
  return attachGrants(
    base,
    await computeEffectiveGrants(base as never, {
      roleRows: async () => roleKeys.map((k) => ({ permission: k, scope: 'ALL_COMPANY', scopeIds: null })),
      overrideRows: async () => deny.map((k) => ({ permission: k, effect: 'DENY', scope: null, scopeIds: null })),
    })
  );
}

const as = (user: SessionUser) => requireContext.mockResolvedValue({ user, companyId: 'c1', storeId: 's1' });
const call = (body: unknown) => POST(new Request('http://localhost/api/ops/tracking/undo-return', { method: 'POST', body: JSON.stringify(body) }));
const facts = {
  order: { id: UUID, orderNumber: 'ORD-1', courier: 'الباشا', shippingStatus: 'RETURNED', settlementStatus: 'PENDING_COLLECTION', version: 3, hasCollectedAmount: false, hasReturnReceipt: false, items: [], merchantRef: null, trackingNumber: null, deliveryProviderId: null, customerId: 'cu1' },
  marks: [{ id: 'm1', action: 'PARTIAL_DELIVERY_RECORDED', newStatus: 'RETURNED', at: new Date(Date.UTC(2026, 10, 1)) }],
  shippingLog: [],
  openRequests: 0,
  customer: { cancelledOrders: 1 },
  named: false,
};
const UNDO = { action: 'undo', orderId: UUID, reason: 'انسجّل مرتجع بالغلط', fingerprint: 'f'.repeat(24), acknowledged: true };

beforeEach(async () => {
  vi.clearAllMocks();
  requirePermission.mockResolvedValue({});
  db.$transaction.mockImplementation(async (fn: (tx: unknown) => unknown) => fn({}));
  lib.read.mockResolvedValue(facts);
  lib.undo.mockResolvedValue({ plan: { markId: 'm1', to: 'SHIPPED', toDefaulted: true, settlementFrom: 'PENDING_COLLECTION', items: [] }, orderNumber: 'ORD-1' });
  as(await person([], [], 'SUPER_ADMIN'));
});

describe('who may press — people built the way a session builds them', () => {
  it('the owner (SUPER_ADMIN): the measure answers', async () => {
    const res = await call({ action: 'measure', orderId: UUID });
    expect(res.status).toBe(200);
    expect((await res.json()).allowed).toBe(true);
  });

  it('a role the owner ticked the key for may press', async () => {
    as(await person(['ops.track', KEY]));
    expect((await call({ action: 'measure', orderId: UUID })).status).toBe(200);
  });

  it('NEGATIVE: a «منع» on the key beats the role that holds it — 403 in Arabic, nothing read', async () => {
    as(await person(['ops.track', KEY], [KEY]));
    const res = await call({ action: 'measure', orderId: UUID });
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ code: 'FORBIDDEN', errorAr: RETURN_UNDO_FORBIDDEN_AR });
    expect(lib.read).not.toHaveBeenCalled();
  });

  it('NEGATIVE: the desk that records the door, takes returns and closes lost parcels does not hold it — and is refused before the body is read', async () => {
    as(
      await person([
        'ops.track', 'ops.deliver', 'ops.transfer', 'ops.write_off', 'ops.close_legacy', 'ops.returns', 'ops.returns_receive_all',
        'finance.cashbox', 'settlement.view', 'settlement.approve', 'settlement.review', 'orders.unlock', 'orders.change_status',
      ])
    );
    const res = await POST(new Request('http://localhost/api/ops/tracking/undo-return', { method: 'POST', body: 'not json' }));
    expect(res.status).toBe(403);
    expect(lib.read).not.toHaveBeenCalled();
    expect(lib.undo).not.toHaveBeenCalled();
  });

  it('NEGATIVE: no legacy role (no role row — the in-code fallback) may press', async () => {
    for (const role of Object.keys(ROLE_PERMISSIONS) as UserRole[]) {
      if (role === 'SUPER_ADMIN') continue;
      as(await person([], [], role, null));
      const res = await call({ action: 'measure', orderId: UUID });
      expect(res.status, role).toBe(403);
    }
    expect(lib.read).not.toHaveBeenCalled();
  });

  it('the tracking key is asked first', async () => {
    await call({ action: 'measure', orderId: UUID });
    expect(requirePermission).toHaveBeenCalledWith('ops.track');
  });
});

describe('the body, and the answers', () => {
  it('a reason under five characters, or no acknowledgement, is refused in Arabic and nothing is pressed', async () => {
    let res = await call({ ...UNDO, reason: 'غلط' });
    expect(res.status).toBe(400);
    res = await call({ ...UNDO, acknowledged: false });
    expect(res.status).toBe(400);
    expect((await res.json()).errorAr).toBe(RETURN_UNDO_ACK_AR);
    expect(lib.undo).not.toHaveBeenCalled();
  });

  it('an order of another store: 404 in Arabic', async () => {
    lib.read.mockResolvedValue(null);
    const res = await call({ action: 'measure', orderId: UUID });
    expect(res.status).toBe(404);
    expect(await res.json()).toMatchObject({ code: 'NOT_FOUND', errorAr: RETURN_UNDO_NOT_FOUND_AR });
  });

  it('the measure writes nothing: no transaction, no audit', async () => {
    await call({ action: 'measure', orderId: UUID });
    expect(db.$transaction).not.toHaveBeenCalled();
    expect(audit).not.toHaveBeenCalled();
  });

  it('the press: one transaction, ONE audit line in the presser’s name, and the Arabic sentence back', async () => {
    const res = await call(UNDO);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({ undone: true, from: 'RETURNED', to: 'SHIPPED', message: RETURN_UNDO_SUCCESS_AR('ORD-1', 'مشحون') });
    expect(db.$transaction).toHaveBeenCalledTimes(1);
    expect(lib.undo.mock.calls[0][1]).toMatchObject({ scope: { companyId: 'c1', storeId: 's1' }, orderId: UUID, reason: UNDO.reason, fingerprint: UNDO.fingerprint });
    expect(audit).toHaveBeenCalledTimes(1);
    expect(audit.mock.calls[0][0]).toMatchObject({ companyId: 'c1', userId: 'u1', action: RETURN_UNDO_ACTION, entity: 'Order', entityId: UUID });
  });

  it('a refusal of the press is said as the press said it, with its code, and no audit line', async () => {
    lib.undo.mockRejectedValue(new ReturnUndoStopped(409, { code: 'RETURN_COUNTED', error: 'انعدّ' }));
    const res = await call(UNDO);
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ code: 'RETURN_COUNTED', error: 'انعدّ', errorAr: 'انعدّ' });
    expect(audit).not.toHaveBeenCalled();
  });
});
