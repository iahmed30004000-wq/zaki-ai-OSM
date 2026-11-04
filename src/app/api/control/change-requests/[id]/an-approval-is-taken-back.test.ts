import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SessionUser } from '@/types/auth';

/**
 * ═══════════════════════════════════════════════════════════════════════
 * DECIDING, ON AN OPEN TROLLEY — AND TAKING AN APPROVAL BACK (the owner's ruling 4/11).
 *
 * ORD-2026-1584: a cancel on a READY trolley, approved by mistake, never carried out. The press «إغلاق الشحنة» refused the
 * trolley for it (PENDING_CHANGES), and nothing could take the approval back: this PATCH refused anything not PENDING, and
 * the DELETE is the requester's and PENDING-only.
 *
 *   · APPROVING a request whose order is on an open trolley is refused ON_OPEN_TROLLEY. REJECTING it is not — that is how a
 *     pending one is cleared so the press can close.
 *   · «تراجع عن الموافقة» (`decision: 'REVOKED'`): an APPROVED request nobody carried out is taken back by whoever
 *     `mayDecide` names for the order — never its requester — with a written reason. It is STORED as REJECTED (no reader of
 *     `status` learns a new word), written CONDITIONALLY so a carry-out that lands first wins (409), audited as
 *     CHANGE_REQUEST_APPROVAL_REVOKED, and the requester is told. Whatever the trolley's state: it only ever un-blocks.
 *
 * Through the REAL permission engine; only the database and the side effects are fakes.
 * ═══════════════════════════════════════════════════════════════════════
 */

const { db, tx, requireContext, createNotification, logAudit } = vi.hoisted(() => {
  const tx = {
    orderChangeRequest: {
      update: vi.fn(async ({ data }: { data: object }) => ({ id: 'cr1', changes: {}, ...data })),
      updateMany: vi.fn(async (..._a: unknown[]) => ({ count: 1 })),
      findFirst: vi.fn(async (..._a: unknown[]) => ({ id: 'cr1', status: 'REJECTED' })),
    },
    orderNote: { create: vi.fn(async (..._a: unknown[]) => ({})) },
  };
  return {
    tx,
    db: {
      orderChangeRequest: { findFirst: vi.fn() },
      $transaction: vi.fn(async (fn: (t: unknown) => unknown) => fn(tx)),
    },
    requireContext: vi.fn(),
    createNotification: vi.fn(async (..._a: unknown[]) => 1),
    logAudit: vi.fn(),
  };
});

vi.mock('@/lib/db', () => ({ db }));
vi.mock('@/lib/geo-context', () => ({ requireContext: (...a: unknown[]) => requireContext(...a) }));
vi.mock('@/lib/audit', () => ({ logAudit: (...a: unknown[]) => logAudit(...a) }));
vi.mock('@/lib/notification', () => ({ createNotification: (...a: unknown[]) => createNotification(...a) }));
vi.mock('@/lib/notify', () => ({ afterResponse: (fn: () => Promise<void>) => void fn() }));

import { attachGrants } from '@/lib/authorization';
import { computeEffectiveGrants } from '@/lib/permissions-core';
import { ON_TROLLEY_AR } from '@/lib/order-seal';
import { PATCH } from './route';

const SUPERVISOR = ['orders.view', 'control.change_requests', 'control.change_requests_view', 'orders.change_price'];
const AGENT = ['orders.view', 'orders.request_change', 'confirmation.work'];

async function person(id: string, keys: string[], role = 'CUSTOM', name = id): Promise<SessionUser> {
  const base = { id, email: `${id}@x`, name, role, roleId: `r-${id}`, status: 'ACTIVE', companyId: 'c1' } as unknown as SessionUser;
  return attachGrants(
    base,
    await computeEffectiveGrants(base as never, {
      roleRows: async () => keys.map((k) => ({ permission: k, scope: 'ALL_COMPANY', scopeIds: null })),
      overrideRows: async () => [],
    })
  );
}

const REQ_ID = '11111111-2222-4333-8444-555555555555';

/** ORD-2026-1584's request: a cancel on a READY trolley, approved by mistake, never carried out. */
const request = (over: Record<string, unknown> = {}, order: Record<string, unknown> = {}) => ({
  id: REQ_ID, orderId: 'o1', companyId: 'c1', requestedById: 'agent', intent: 'CANCEL', status: 'APPROVED',
  appliedAt: null, decidedById: 'sup-who-approved', changes: {}, reason: 'الزبون تراجع',
  order: {
    id: 'o1', orderNumber: 'ORD-2026-1584', confirmationStatus: 'CONFIRMED', claimedById: 'agent',
    shippingStatus: 'READY_FOR_PICKUP', shippedAt: null, shippingBatchId: 'b1', shippingBatch: { status: 'READY' },
    ...order,
  },
  ...over,
});

async function decide(user: SessionUser, body: Record<string, unknown>) {
  requireContext.mockResolvedValue({ user, companyId: 'c1', storeId: 's1' });
  const res = await PATCH(
    new Request('http://x/api', { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }),
    { params: Promise.resolve({ id: REQ_ID }) }
  );
  await new Promise((r) => setTimeout(r, 0));
  return { status: res.status, body: (await res.json()) as Record<string, any> };
}

const nothingWritten = () => {
  expect(tx.orderChangeRequest.update).not.toHaveBeenCalled();
  expect(tx.orderChangeRequest.updateMany).not.toHaveBeenCalled();
  expect(tx.orderNote.create).not.toHaveBeenCalled();
  expect(logAudit).not.toHaveBeenCalled();
  expect(createNotification).not.toHaveBeenCalled();
};

beforeEach(() => {
  vi.clearAllMocks();
  db.orderChangeRequest.findFirst.mockResolvedValue(request());
  tx.orderChangeRequest.updateMany.mockResolvedValue({ count: 1 });
});

describe('deciding a PENDING request whose order is on an open trolley', () => {
  beforeEach(() => db.orderChangeRequest.findFirst.mockResolvedValue(request({ status: 'PENDING', decidedById: null })));

  it('APPROVING is refused ON_OPEN_TROLLEY, and nothing is written', async () => {
    const sup = await person('sup', SUPERVISOR);

    const res = await decide(sup, { decision: 'APPROVED' });

    expect(res.status).toBe(409);
    expect(res.body).toMatchObject({ code: 'ON_OPEN_TROLLEY', errorAr: ON_TROLLEY_AR });
    nothingWritten();
  });

  it('…and a trolley the order names but nobody can read counts as open (fail closed)', async () => {
    const sup = await person('sup', SUPERVISOR);
    db.orderChangeRequest.findFirst.mockResolvedValue(request({ status: 'PENDING' }, { shippingBatch: null }));

    const res = await decide(sup, { decision: 'APPROVED' });

    expect(res.status).toBe(409);
    expect(res.body.code).toBe('ON_OPEN_TROLLEY');
    nothingWritten();
  });

  it('REJECTING is allowed — that is how a pending one is cleared so the press can close', async () => {
    const sup = await person('sup', SUPERVISOR);

    const res = await decide(sup, { decision: 'REJECTED', note: 'الطرد على الدفعة' });

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(tx.orderChangeRequest.update.mock.calls[0][0]).toMatchObject({ where: { id: REQ_ID }, data: { status: 'REJECTED' } });
  });

  it('NEGATIVE: after the handover approving is the decision it always was', async () => {
    const sup = await person('sup', SUPERVISOR);
    db.orderChangeRequest.findFirst.mockResolvedValue(request({ status: 'PENDING' }, { shippingBatch: { status: 'SHIPPED' } }));

    const res = await decide(sup, { decision: 'APPROVED' });

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(tx.orderChangeRequest.update.mock.calls[0][0].data).toMatchObject({ status: 'APPROVED' });
  });

  it('NEGATIVE: an order on no trolley is approved as before', async () => {
    const sup = await person('sup', SUPERVISOR);
    db.orderChangeRequest.findFirst.mockResolvedValue(request({ status: 'PENDING' }, { shippingBatchId: null, shippingBatch: null, shippingStatus: 'NOT_READY' }));

    const res = await decide(sup, { decision: 'APPROVED' });

    expect(res.status, JSON.stringify(res.body)).toBe(200);
  });
});

describe('«تراجع عن الموافقة» — an approval nobody carried out, taken back', () => {
  it('by a decider, with a reason: stored REJECTED, conditionally, with a note that says it was a take-back', async () => {
    const sup = await person('sup', SUPERVISOR, 'CUSTOM', 'ريم');

    const res = await decide(sup, { decision: 'REVOKED', note: 'انوافق عليه بالغلط' });

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(tx.orderChangeRequest.updateMany).toHaveBeenCalledTimes(1);
    expect(tx.orderChangeRequest.updateMany.mock.calls[0][0]).toMatchObject({
      where: { id: REQ_ID, status: 'APPROVED', appliedAt: null },
      data: { status: 'REJECTED', decidedById: 'sup', decisionNote: 'ريم تراجع عن الموافقة: انوافق عليه بالغلط' },
    });
    // Never the unconditional write the approval uses.
    expect(tx.orderChangeRequest.update).not.toHaveBeenCalled();
    expect((tx.orderNote.create.mock.calls[0][0] as { data: { body: string } }).data.body).toContain('انوافق عليه بالغلط');
    expect(res.body.fieldsToApply).toBeNull();
  });

  it('is audited as CHANGE_REQUEST_APPROVAL_REVOKED, with the approval it took back', async () => {
    const sup = await person('sup', SUPERVISOR);

    await decide(sup, { decision: 'REVOKED', note: 'انوافق عليه بالغلط' });

    expect(logAudit).toHaveBeenCalledTimes(1);
    expect(logAudit.mock.calls[0][0]).toMatchObject({
      action: 'CHANGE_REQUEST_APPROVAL_REVOKED', entity: 'OrderChangeRequest', entityId: REQ_ID, userId: 'sup',
      previousData: { status: 'APPROVED', decidedById: 'sup-who-approved' },
      newData: { status: 'REJECTED', note: 'انوافق عليه بالغلط' },
    });
  });

  it('tells the requester, the way a rejection does — and nobody else', async () => {
    const sup = await person('sup', SUPERVISOR);

    await decide(sup, { decision: 'REVOKED', note: 'انوافق عليه بالغلط' });

    expect(createNotification).toHaveBeenCalledTimes(1);
    const told = createNotification.mock.calls[0][0] as unknown as Record<string, any>;
    expect(told.audience).toEqual({ userIds: ['agent'] });
    expect(told.title).toContain('ORD-2026-1584');
    expect(told.message).toContain('انوافق عليه بالغلط');
  });

  it('is allowed whatever the trolley’s state — it only ever un-blocks (open, pressed, none)', async () => {
    const sup = await person('sup', SUPERVISOR);
    for (const order of [{}, { shippingBatch: { status: 'SHIPPED' } }, { shippingBatchId: null, shippingBatch: null }]) {
      vi.clearAllMocks();
      tx.orderChangeRequest.updateMany.mockResolvedValue({ count: 1 });
      db.orderChangeRequest.findFirst.mockResolvedValue(request({}, order));

      const res = await decide(sup, { decision: 'REVOKED', note: 'انوافق عليه بالغلط' });

      expect(res.status, JSON.stringify(order)).toBe(200);
    }
  });

  it('is refused for its REQUESTER — nobody decides their own request — and nothing is written', async () => {
    const agent = await person('agent', [...SUPERVISOR]);

    const res = await decide(agent, { decision: 'REVOKED', note: 'غلطت' });

    expect(res.status).toBe(403);
    expect(res.body.code).toBe('SELF_APPROVAL');
    nothingWritten();
  });

  it('is refused without a written reason — and nothing is written', async () => {
    const sup = await person('sup', SUPERVISOR);

    for (const body of [{ decision: 'REVOKED' }, { decision: 'REVOKED', note: '   ' }]) {
      const res = await decide(sup, body);
      expect(res.status, JSON.stringify(body)).toBe(400);
      expect(res.body.code).toBe('REASON_REQUIRED');
    }
    nothingWritten();
  });

  it('is refused once the approval was carried out — taking the word back would not take the change back', async () => {
    const sup = await person('sup', SUPERVISOR);
    db.orderChangeRequest.findFirst.mockResolvedValue(request({ appliedAt: new Date() }));

    const res = await decide(sup, { decision: 'REVOKED', note: 'انوافق عليه بالغلط' });

    expect(res.status).toBe(409);
    expect(res.body.code).toBe('ALREADY_APPLIED');
    nothingWritten();
  });

  it.each(['PENDING', 'REJECTED', 'CANCELLED'])('is refused for a %s request — there is no approval to take back', async (status) => {
    const sup = await person('sup', SUPERVISOR);
    db.orderChangeRequest.findFirst.mockResolvedValue(request({ status }));

    const res = await decide(sup, { decision: 'REVOKED', note: 'انوافق عليه بالغلط' });

    expect(res.status).toBe(409);
    expect(res.body.code).toBe('NOT_APPROVED');
    nothingWritten();
  });

  it('THE RACE: a carry-out (or another decider) landed first — the conditional write finds nothing, 409, no audit, nobody told', async () => {
    const sup = await person('sup', SUPERVISOR);
    tx.orderChangeRequest.updateMany.mockResolvedValue({ count: 0 });

    const res = await decide(sup, { decision: 'REVOKED', note: 'انوافق عليه بالغلط' });

    expect(res.status).toBe(409);
    expect(res.body.code).toBe('ALREADY_DECIDED');
    expect(tx.orderNote.create).not.toHaveBeenCalled();
    expect(logAudit).not.toHaveBeenCalled();
    expect(createNotification).not.toHaveBeenCalled();
  });

  it('is refused for somebody `mayDecide` does not name — the same routing the approval used', async () => {
    const colleague = await person('colleague', AGENT);

    const res = await decide(colleague, { decision: 'REVOKED', note: 'انوافق عليه بالغلط' });

    expect(res.status).toBe(403);
    nothingWritten();
  });
});
