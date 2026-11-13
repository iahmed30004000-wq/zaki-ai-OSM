import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * «تراجع عن التسليم» (13/11) — THE LIST SAYS WHO HOLDS THE KEY, so the screen draws the button for them and nobody else.
 *
 * The door that undoes (`undo-delivery/route.ts`) is what refuses; this is only what the follow-up list tells the screen to DRAW:
 * `acts.undoDelivery` is `ops.undo_delivery` and nothing else — not the delivery key, not the old-ones press, not the money keys, not the
 * tracking key. And `closeLegacy` does not stand in for it either: two owner-only presses, two keys.
 */

const { db, requireContext, requirePermission, held } = vi.hoisted(() => ({
  db: {
    order: { findMany: vi.fn() },
    orderStatusLog: { findMany: vi.fn() },
    orderChangeRequest: { findMany: vi.fn() },
    orderActivity: { findMany: vi.fn() },
    deliveryFee: { findMany: vi.fn() },
    deliveryProvider: { findMany: vi.fn() },
    region: { findMany: vi.fn() },
  },
  requireContext: vi.fn(),
  requirePermission: vi.fn(),
  held: new Set<string>(),
}));

vi.mock('@/lib/db', () => ({ db }));
vi.mock('@/lib/geo-context', () => ({ requireContext: (...a: unknown[]) => requireContext(...a) }));
vi.mock('@/lib/authorization', () => ({
  requirePermission: (...a: unknown[]) => requirePermission(...a),
  can: (_user: unknown, key: string) => held.has(key),
}));
vi.mock('@/lib/pii-alert', () => ({ noteCustomersHandedOut: vi.fn().mockResolvedValue(undefined) }));

import { GET } from './route';

beforeEach(() => {
  vi.clearAllMocks();
  held.clear();
  held.add('ops.track');
  requireContext.mockResolvedValue({
    user: { id: 'u1', name: 'موظف' },
    companyId: 'c1',
    storeId: 's1',
    country: { minorUnit: 2, currencyCode: 'USD', code: 'SY' },
  });
  requirePermission.mockResolvedValue({});
  db.order.findMany.mockResolvedValue([]);
  db.orderStatusLog.findMany.mockResolvedValue([]);
  db.orderChangeRequest.findMany.mockResolvedValue([]);
  db.orderActivity.findMany.mockResolvedValue([]);
  db.deliveryFee.findMany.mockResolvedValue([]);
  db.deliveryProvider.findMany.mockResolvedValue([]);
  db.region.findMany.mockResolvedValue([]);
});

const acts = async () => (await (await GET(new Request('http://localhost/api/ops/tracking'))).json()).acts;

describe('what the list tells the screen about the owner’s «تراجع عن التسليم»', () => {
  it('the holder of `ops.undo_delivery` is told «yes» — and the other acts keep following their own keys', async () => {
    held.add('ops.undo_delivery');
    expect(await acts()).toEqual({ deliver: false, transfer: false, writeOff: false, closeLegacy: false, undoDelivery: true, decide: false });
  });

  it('NEGATIVE: the keys that are near it do not stand in for it — delivery, the old-ones press, courier money, settlement, write-off', async () => {
    for (const k of ['ops.deliver', 'ops.transfer', 'ops.write_off', 'ops.close_legacy', 'ops.returns', 'finance.cashbox', 'finance.cashbox_view', 'settlement.view', 'settlement.approve', 'finance.update', 'orders.unlock']) held.add(k);
    const a = await acts();
    expect(a.undoDelivery).toBe(false);
    expect(a).toMatchObject({ deliver: true, transfer: true, writeOff: true, closeLegacy: true });
  });

  it('NEGATIVE: with only the tracking key the answer says «no» (a boolean, not a missing field)', async () => {
    expect((await acts()).undoDelivery).toBe(false);
  });

  it('the two owner-only presses are two keys: holding this one does not draw the old-ones press', async () => {
    held.add('ops.undo_delivery');
    expect((await acts()).closeLegacy).toBe(false);
  });
});
