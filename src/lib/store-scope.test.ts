import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Stage 2a store scoping: order access is confined to the selected store,
 * users without roleId inherit their system role template, and a Telegram
 * source without a store never creates an order.
 */

const { db } = vi.hoisted(() => ({
  db: {
    order: { findUnique: vi.fn(), count: vi.fn() },
    rolePermission: { findMany: vi.fn() },
    userPermission: { findMany: vi.fn() },
    user: { findFirst: vi.fn() },
    store: { findFirst: vi.fn() },
    $transaction: vi.fn(),
  },
}));

vi.mock('./db', () => ({ db }));
vi.mock('@/lib/db', () => ({ db }));
vi.mock('./audit', () => ({ logAudit: vi.fn() }));
vi.mock('../audit', () => ({ logAudit: vi.fn() }));
vi.mock('../notification', () => ({ createNotification: vi.fn() }));

import { assertOrderAccess } from './rbac';
import { attachGrants } from './authorization';
import { computeEffectiveGrants } from './permissions-core';
import { createTelegramOrder } from './telegram/order-creation';

const admin = attachGrants({ id: 'u1', role: 'COMPANY_ADMIN', status: 'ACTIVE', permissions: [] } as any, {
  fullAccess: false,
  grants: { 'orders.view': { scope: 'ALL_COMPANY' } },
});

beforeEach(() => {
  vi.clearAllMocks();
  db.userPermission.findMany.mockResolvedValue([]);
});

describe('assertOrderAccess — store boundary', () => {
  it('an order of another store in the same company is NOT_FOUND', async () => {
    db.order.findUnique.mockResolvedValue({ id: 'o1', companyId: 'c1', storeId: 'store-B' });
    await expect(assertOrderAccess('o1', admin, { companyId: 'c1', storeId: 'store-A' })).resolves.toEqual({
      allowed: false,
      reason: 'NOT_FOUND',
    });
  });

  it('an order without a store is not reachable from any store', async () => {
    db.order.findUnique.mockResolvedValue({ id: 'o1', companyId: 'c1', storeId: null });
    const res = await assertOrderAccess('o1', admin, { companyId: 'c1', storeId: 'store-A' });
    expect(res.allowed).toBe(false);
  });

  it('an order of the selected store is allowed', async () => {
    db.order.findUnique.mockResolvedValue({ id: 'o1', companyId: 'c1', storeId: 'store-A' });
    const res = await assertOrderAccess('o1', admin, { companyId: 'c1', storeId: 'store-A' });
    expect(res.allowed).toBe(true);
  });
});

describe('computeEffectiveGrants — DB templates are the single source', () => {
  it('a user without roleId inherits the system template named like their role', async () => {
    db.rolePermission.findMany.mockResolvedValue([{ permission: 'ops.prepare', scope: 'ALL_COMPANY', scopeIds: null }]);
    const g = await computeEffectiveGrants({ id: 'u2', role: 'WAREHOUSE', roleId: null });
    expect(db.rolePermission.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { role: { companyId: null, name: 'WAREHOUSE' } } })
    );
    expect(Object.keys(g.grants)).toEqual(['ops.prepare']);
  });

  it('falls back to the in-code legacy map only when no template exists', async () => {
    db.rolePermission.findMany.mockResolvedValue([]);
    const g = await computeEffectiveGrants({ id: 'u3', role: 'MODERATOR', roleId: null });
    expect(g.grants['orders.create']).toBeDefined();
  });
});

describe('createTelegramOrder — store required', () => {
  it('a source without a store is sent to review and creates no order', async () => {
    db.user.findFirst.mockResolvedValue({ id: 'actor' });
    const res = await createTelegramOrder({
      companyId: 'c1',
      storeId: null,
      customer: { id: 'cu1', firstOrderDate: null, totalOrders: 0 },
      product: { id: 'p1', name: 'x', image: null, basePrice: 10 },
      line: { product: { id: 'p1', name: 'x', image: null, basePrice: 10 }, offer: null, quantity: 1, freeQuantity: 0, unitPrice: 20, offerDiscount: 0 },
      address: 'addr',
      priceText: '20',
      telegram: { messageId: '1', chatId: '-100', threadId: null },
    });
    expect(res).toEqual({ ok: false, reason: 'NO_STORE' });
    expect(db.$transaction).not.toHaveBeenCalled();
  });
});
