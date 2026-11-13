import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * «أقفل القديمة بلا باركود» (12/11) — THE LIST SAYS WHO HOLDS THE KEY, so the screen draws the button for them and nobody else.
 *
 * The door that closes (`close-legacy/route.ts`) is what refuses; this is only what the follow-up list tells the screen to DRAW:
 * `acts.closeLegacy` is `ops.close_legacy` and nothing else — not the courier-money key, not the write-off box, not the tracking key.
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
    settlementMatch: { findMany: vi.fn() },
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
  db.settlementMatch.findMany.mockResolvedValue([]);
  db.region.findMany.mockResolvedValue([]);
});

const acts = async () => (await (await GET(new Request('http://localhost/api/ops/tracking'))).json()).acts;

describe('what the list tells the screen about the owner’s one-time press', () => {
  it('the holder of `ops.close_legacy` is told «yes» — and the three parcel acts keep following their own keys', async () => {
    held.add('ops.close_legacy');
    // `undoDelivery` (13/11) is the second owner-only act and `decide` is «فيه فرق»'s own key (`settlement.review`): different keys, so
    // holding this one says nothing about either — both are «no» here, like the other three.
    expect(await acts()).toEqual({ deliver: false, transfer: false, writeOff: false, closeLegacy: true, undoDelivery: false, decide: false });
  });

  it('NEGATIVE: the keys that are near it do not stand in for it — tracking, courier money, settlement, the write-off box', async () => {
    for (const k of ['ops.write_off', 'ops.deliver', 'ops.transfer', 'finance.cashbox', 'finance.cashbox_view', 'settlement.view', 'settlement.approve', 'finance.update']) held.add(k);
    const a = await acts();
    expect(a.closeLegacy).toBe(false);
    expect(a).toMatchObject({ deliver: true, transfer: true, writeOff: true });
  });

  it('NEGATIVE: with only the tracking key the answer says «no» (a boolean, not a missing field)', async () => {
    expect((await acts()).closeLegacy).toBe(false);
  });
});
