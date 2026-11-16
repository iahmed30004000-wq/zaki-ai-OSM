import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * THE WINDOW ASKS WHAT THE INTAKE FILTER WROTE ON THIS ORDER — AND THE ANSWER IS A NUMBER AND A YES OR NO, NOTHING ELSE.
 *  · it reads through the same envelope the window opens the order with (a reader who may not open it gets the refusal, not the flags);
 *  · the only question it asks the database is this order's two flag rows; it gives no id, no name, no phone;
 *  · an order the filter never touched answers «nothing» (so the notice is silent).
 */
const { db, requireContext, assertOrderReadable } = vi.hoisted(() => ({
  db: { orderActivity: { findMany: vi.fn() } },
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

const call = (id = 'o1') => GET(new Request(`http://localhost/api/orders/${id}/intake-flags`), { params: Promise.resolve({ id }) });

beforeEach(() => {
  vi.clearAllMocks();
  requireContext.mockResolvedValue({ user: { id: 'u1' }, companyId: 'c1', storeId: 's1' });
  assertOrderReadable.mockResolvedValue({ allowed: true });
});

describe('GET /api/orders/:id/intake-flags', () => {
  it('names the first order and says the number is suspect, with the window in hours', async () => {
    db.orderActivity.findMany.mockResolvedValue([
      { action: 'INTAKE_DUPLICATE', metadata: JSON.stringify({ firstOrderId: 'secret-id', firstOrderNumber: 'SY-1', windowHours: 24 }) },
      { action: 'INTAKE_SUSPECT_NUMBER', metadata: JSON.stringify({ reason: 'SHAPE' }) },
    ]);
    const body = await (await call()).json();
    expect(body).toEqual({ duplicateOf: 'SY-1', suspectNumber: true, windowHours: 24 });
    expect(JSON.stringify(body)).not.toContain('secret-id');
  });

  it('asks only this order’s two flag rows, of this company', async () => {
    db.orderActivity.findMany.mockResolvedValue([]);
    await call('o9');
    expect(db.orderActivity.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { orderId: 'o9', companyId: 'c1', action: { in: ['INTAKE_DUPLICATE', 'INTAKE_SUSPECT_NUMBER'] } } })
    );
  });

  it('is quiet for an order the filter never touched, and for a broken note', async () => {
    db.orderActivity.findMany.mockResolvedValue([]);
    expect(await (await call()).json()).toEqual({ duplicateOf: null, suspectNumber: false, windowHours: 24 });
    db.orderActivity.findMany.mockResolvedValue([{ action: 'INTAKE_DUPLICATE', metadata: '{oops' }]);
    expect((await (await call()).json()).duplicateOf).toBeNull();
  });

  it('a reader who may not open the order gets the refusal and no flags', async () => {
    assertOrderReadable.mockResolvedValue({ allowed: false, reason: 'NOT_FOUND' });
    const res = await call();
    expect(res.status).toBe(404);
    expect(db.orderActivity.findMany).not.toHaveBeenCalled();
  });
});
