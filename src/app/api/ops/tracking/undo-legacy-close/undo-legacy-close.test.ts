import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * «تراجع عن إقفال القديمة» (25/11) — THE DOOR, GATE BY GATE.
 *
 * The rules and what the press writes are proved against a database that remembers in `src/lib/legacy-take-back.test.ts`. THIS file
 * holds the door's own shape, with people built the way a session builds them (`computeEffectiveGrants` + the REAL `can`): the close's
 * own key is asked FIRST, before the body is read and before a single order is; the measure writes nothing and opens no transaction; the
 * press is ONE transaction followed by ONE audit row; a refusal writes nothing and is said in Arabic.
 */

const { db, ctx, logAudit } = vi.hoisted(() => ({
  db: {
    order: { findFirst: vi.fn(), updateMany: vi.fn(), update: vi.fn() },
    orderActivity: { findMany: vi.fn(), count: vi.fn(), updateMany: vi.fn(), create: vi.fn() },
    orderStatusLog: { findMany: vi.fn(), create: vi.fn() },
    settlementMatch: { findMany: vi.fn() },
    walletMovement: { count: vi.fn(), create: vi.fn() },
    commissionEntry: { findMany: vi.fn(), updateMany: vi.fn(), create: vi.fn() },
    $transaction: vi.fn(async (fn: (tx: unknown) => unknown) => fn(db)),
  },
  ctx: { user: null as unknown },
  logAudit: vi.fn(),
}));

vi.mock('@/lib/db', () => ({ db }));
vi.mock('@/lib/geo-context', () => ({ requireContext: async () => ({ user: ctx.user, companyId: 'c1', storeId: 's1' }) }));
vi.mock('@/lib/authorization', async (orig) => {
  const real = await orig<typeof import('@/lib/authorization')>();
  return {
    ...real,
    // The session's own question, asked of the person this test built.
    requirePermission: async (key: string) => {
      if (!real.can(ctx.user as never, key as never)) throw new Error(`Forbidden: missing required permission ${key}`);
    },
  };
});
vi.mock('@/lib/audit', () => ({ logAudit: (...a: unknown[]) => logAudit(...a) }));

import type { SessionUser } from '@/types/auth';
import { attachGrants } from '@/lib/authorization';
import { computeEffectiveGrants } from '@/lib/permissions-core';
import { LEGACY_CLOSE_ACTION, LEGACY_CLOSE_NOTE } from '@/lib/legacy-closeout-words';
import { LEGACY_MARK_UNDONE, LEGACY_TAKE_BACK_ACTION, TAKE_BACK_FORBIDDEN_AR, TAKE_BACK_WHY_AR, type TakeBackMeasure } from '@/lib/legacy-take-back-words';
import { POST } from './route';

async function person(roleKeys: string[], role = 'CUSTOM', deny: string[] = []): Promise<SessionUser> {
  const base = { id: 'u1', email: 'u@x', name: 'سارة', role, roleId: role === 'CUSTOM' ? 'r1' : null, status: 'ACTIVE', companyId: 'c1' } as unknown as SessionUser;
  return attachGrants(
    base,
    await computeEffectiveGrants(base as never, {
      roleRows: async () => roleKeys.map((k) => ({ permission: k, scope: 'ALL_COMPANY', scopeIds: null })),
      overrideRows: async () => deny.map((k) => ({ permission: k, effect: 'DENY', scope: null, scopeIds: null })),
    })
  );
}

const UUID = '00000000-0000-4000-8000-000000000001';
const REASON = 'الشركة بتقول الطرد رجع — سطرو بالكشف بصفر';
const post = (body: unknown) =>
  POST(new Request('http://localhost/api/ops/tracking/undo-legacy-close', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }));

function closedOrder() {
  db.order.findFirst.mockResolvedValue({
    id: UUID, orderNumber: 'ORD-2026-0001', shippingStatus: 'DELIVERED', settlementStatus: 'SETTLED', version: 3, collectedAmount: null, deliveryProvider: { name: 'الباشا' },
  });
  db.orderActivity.findMany.mockResolvedValue([{ id: 'm1', action: LEGACY_CLOSE_ACTION, previousStatus: 'PENDING_COLLECTION', newStatus: 'SETTLED' }]);
  db.orderStatusLog.findMany.mockResolvedValue([{ id: 'l1', previousValue: 'PENDING_COLLECTION', newValue: 'SETTLED', note: LEGACY_CLOSE_NOTE }]);
  db.orderActivity.count.mockResolvedValue(0);
  db.walletMovement.count.mockResolvedValue(0);
  db.settlementMatch.findMany.mockResolvedValue([]);
  db.commissionEntry.findMany.mockResolvedValue([]);
  db.order.updateMany.mockResolvedValue({ count: 1 });
  db.orderActivity.updateMany.mockResolvedValue({ count: 1 });
}

const WRITES = [db.order.updateMany, db.order.update, db.orderActivity.updateMany, db.orderActivity.create, db.orderStatusLog.create, db.walletMovement.create, db.commissionEntry.updateMany, db.commissionEntry.create];
const nothingWritten = () => {
  for (const fn of WRITES) expect(fn).not.toHaveBeenCalled();
  expect(db.$transaction).not.toHaveBeenCalled();
  expect(logAudit).not.toHaveBeenCalled();
};

beforeEach(() => {
  vi.clearAllMocks();
  closedOrder();
});

describe('the key — the close’s own, asked first', () => {
  it('the owner (SUPER_ADMIN, full access) measures and presses', async () => {
    ctx.user = await person([], 'SUPER_ADMIN');
    const m = (await (await post({ action: 'measure', orderId: UUID })).json()) as TakeBackMeasure;
    expect(m.allowed).toBe(true);
    const res = await post({ action: 'undo', orderId: UUID, reason: REASON, fingerprint: m.fingerprint, acknowledged: true });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ undone: true, from: 'SETTLED', to: 'PENDING_COLLECTION' });
  });

  it('NEGATIVE: a role that follows parcels, records deliveries, collects, undoes deliveries and approves statements — but not the close’s key — is refused BEFORE anything is read', async () => {
    ctx.user = await person(['ops.track', 'ops.deliver', 'ops.undo_delivery', 'ops.returns', 'finance.cashbox', 'settlement.view', 'settlement.review', 'settlement.approve', 'orders.unlock']);
    for (const body of [{ action: 'measure', orderId: UUID }, { action: 'undo', orderId: UUID, reason: REASON, fingerprint: 'x'.repeat(24), acknowledged: true }, null]) {
      const res = await post(body);
      expect(res.status).toBe(403);
      expect(await res.json()).toEqual({ error: 'ناقصك مفتاح ops.close_legacy', errorAr: TAKE_BACK_FORBIDDEN_AR, code: 'FORBIDDEN' });
    }
    expect(db.order.findFirst).not.toHaveBeenCalled();
    nothingWritten();
  });

  it('NEGATIVE: no legacy role holds it through the in-code fallback (a roleId-null account)', async () => {
    for (const role of ['ADMIN', 'MANAGER', 'ACCOUNTANT', 'WAREHOUSE', 'CONFIRMATION_AGENT']) {
      ctx.user = await person([], role);
      const res = await post({ action: 'measure', orderId: UUID });
      expect(res.status, role).toBe(403);
    }
    expect(db.order.findFirst).not.toHaveBeenCalled();
  });

  it('a role the owner ticked holds it — and a «منع» on it beats the role', async () => {
    ctx.user = await person(['ops.track', 'ops.close_legacy']);
    expect((await post({ action: 'measure', orderId: UUID })).status).toBe(200);
    vi.clearAllMocks();
    closedOrder();
    ctx.user = await person(['ops.track', 'ops.close_legacy'], 'CUSTOM', ['ops.close_legacy']);
    expect((await post({ action: 'measure', orderId: UUID })).status).toBe(403);
    nothingWritten();
  });
});

describe('the door’s shape', () => {
  beforeEach(async () => {
    ctx.user = await person([], 'SUPER_ADMIN');
  });

  it('the measure writes nothing and opens no transaction', async () => {
    expect((await post({ action: 'measure', orderId: UUID })).status).toBe(200);
    nothingWritten();
  });

  it('a press with no reason, a short one, or no tick is refused in Arabic and writes nothing', async () => {
    for (const over of [{ reason: '' }, { reason: 'قص' }, { acknowledged: false }]) {
      const res = await post({ action: 'undo', orderId: UUID, reason: REASON, fingerprint: 'x'.repeat(24), acknowledged: true, ...over });
      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.errorAr).toBe(body.error);
    }
    nothingWritten();
  });

  it('a refusal of the rules is a 409 in Arabic and writes nothing (one press, one order)', async () => {
    db.order.findFirst.mockResolvedValue({ id: UUID, orderNumber: 'ORD-2026-0001', shippingStatus: 'DELIVERED', settlementStatus: 'PENDING_COLLECTION', version: 3, collectedAmount: null, deliveryProvider: null });
    const res = await post({ action: 'undo', orderId: UUID, reason: REASON, fingerprint: 'x'.repeat(24), acknowledged: true });
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ code: 'NOT_SETTLED', error: TAKE_BACK_WHY_AR.notSettled('لم يُحصَّل'), errorAr: TAKE_BACK_WHY_AR.notSettled('لم يُحصَّل') });
    for (const fn of WRITES) expect(fn).not.toHaveBeenCalled();
    expect(logAudit).not.toHaveBeenCalled();
  });

  it('the press: ONE transaction, then ONE audit row naming the order, the reason and the renamed mark', async () => {
    const m = (await (await post({ action: 'measure', orderId: UUID })).json()) as TakeBackMeasure;
    await post({ action: 'undo', orderId: UUID, reason: REASON, fingerprint: m.fingerprint, acknowledged: true });
    expect(db.$transaction).toHaveBeenCalledTimes(1);
    expect(logAudit).toHaveBeenCalledTimes(1);
    expect(logAudit.mock.calls[0][0]).toMatchObject({
      action: LEGACY_TAKE_BACK_ACTION,
      entity: 'Order',
      entityId: UUID,
      previousData: { settlementStatus: 'SETTLED' },
      newData: { settlementStatus: 'PENDING_COLLECTION', reason: REASON, renamedTo: LEGACY_MARK_UNDONE, orderNumber: 'ORD-2026-0001' },
    });
    expect(db.walletMovement.create).not.toHaveBeenCalled();
    expect(db.commissionEntry.updateMany).not.toHaveBeenCalled();
  });
});
