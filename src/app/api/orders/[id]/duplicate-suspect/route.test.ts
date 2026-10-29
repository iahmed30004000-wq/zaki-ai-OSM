import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * THE WINDOW ASKS WHETHER THIS ORDER WAS FLAGGED — AND ANSWERS WITH NUMBERS ONLY.
 */

const { db, requireContext, assertOrderReadable } = vi.hoisted(() => ({
  db: { orderActivity: { findFirst: vi.fn() } },
  requireContext: vi.fn(),
  assertOrderReadable: vi.fn(),
}));

vi.mock('@/lib/db', () => ({ db }));
vi.mock('@/lib/geo-context', () => ({ requireContext: (...a: unknown[]) => requireContext(...a) }));
vi.mock('@/lib/rbac', () => ({
  ORDER_ACCESS_STATUS: { NOT_FOUND: 404, FORBIDDEN: 403 },
  assertOrderReadable: (...a: unknown[]) => assertOrderReadable(...a),
}));

import { GET } from './route';

const call = (id = 'o1') => GET(new Request(`http://localhost/api/orders/${id}/duplicate-suspect`), { params: Promise.resolve({ id }) });

beforeEach(() => {
  vi.clearAllMocks();
  requireContext.mockResolvedValue({ user: { id: 'u1' }, companyId: 'c1', storeId: 's1' });
  assertOrderReadable.mockResolvedValue({ allowed: true });
});

describe('GET /api/orders/:id/duplicate-suspect', () => {
  it('says so, with the earlier orders’ numbers and the window', async () => {
    db.orderActivity.findFirst.mockResolvedValue({
      metadata: JSON.stringify({ windowMinutes: 10, twins: [{ id: 'x1', orderNumber: 'SY-1' }, { id: 'x2', orderNumber: 'SY-2' }] }),
    });
    const body = await (await call()).json();
    expect(body).toEqual({ suspect: true, twins: [{ orderNumber: 'SY-1' }, { orderNumber: 'SY-2' }], windowMinutes: 10 });
  });

  it('and gives no id, no name and no phone — the number is what she says out loud', async () => {
    db.orderActivity.findFirst.mockResolvedValue({ metadata: JSON.stringify({ twins: [{ id: 'secret-id', orderNumber: 'SY-1' }] }) });
    const text = JSON.stringify(await (await call()).json());
    expect(text).not.toContain('secret-id');
  });

  it('is quiet for an order that was not flagged', async () => {
    db.orderActivity.findFirst.mockResolvedValue(null);
    expect(await (await call()).json()).toEqual({ suspect: false, twins: [], windowMinutes: 10 });
  });

  it('is quiet when the stored note is not a flag', async () => {
    db.orderActivity.findFirst.mockResolvedValue({ metadata: 'garbage' });
    expect((await (await call()).json()).suspect).toBe(false);
  });

  it('reads only this company’s history of this order, for the flag’s own action', async () => {
    db.orderActivity.findFirst.mockResolvedValue(null);
    await call('o9');
    expect(db.orderActivity.findFirst.mock.calls[0][0].where).toEqual({ orderId: 'o9', companyId: 'c1', action: 'DUPLICATE_SUSPECT' });
  });

  it('and an order she may not open answers as the other order doors do, reading nothing', async () => {
    assertOrderReadable.mockResolvedValue({ allowed: false, reason: 'NOT_FOUND' });
    const res = await call();
    expect(res.status).toBe(404);
    expect(db.orderActivity.findFirst).not.toHaveBeenCalled();
  });

  it('asks who is knocking: a stranger gets the sign-in answer', async () => {
    requireContext.mockRejectedValue(new Error('Unauthorized'));
    expect((await call()).status).toBe(401);
    expect(db.orderActivity.findFirst).not.toHaveBeenCalled();
  });
});
