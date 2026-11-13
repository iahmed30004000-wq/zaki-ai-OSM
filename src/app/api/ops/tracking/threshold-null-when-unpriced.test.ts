import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * THE WIRE TELLS «NO FEE ROW» APART FROM «A THRESHOLD OF ZERO».
 *
 * `route.ts` read the late threshold as
 *
 *     thresholdOf.get(`${o.deliveryProviderId}|${o.regionId}`) ?? 0
 *
 * so a courier with no fee row for a region arrived at the browser as a
 * threshold of **0** — the same number as a courier whose threshold is
 * deliberately zero. The tracking screen showed a blank for both, and the
 * two facts are not the same one: the first is an unpriced lane with a named
 * cause, the second is a decision somebody made.
 *
 * THIS GUARD IS WHAT KEEPS THE SCREEN'S THIRD BRANCH ALIVE.
 * `tracking-threshold-three-states.test.tsx` asserts the screen renders
 * «بلا أجرة» for a `null`. If this `?? null` goes back to `?? 0`, the screen
 * still passes its own tests and the branch becomes unreachable — a guard
 * reporting itself clean over a state nothing can produce, which this audit
 * has caught eight times. So the number is asserted here, at the source.
 *
 * `late` is UNCHANGED by all of this, and that is asserted too: an unpriced
 * lane has no threshold to miss, exactly as a zero one has none, so neither
 * is ever late. Only what may be SAID about them differs.
 */

const { db, requireContext, requirePermission, noteCustomersHandedOut } = vi.hoisted(() => ({
  db: {
    order: { findMany: vi.fn() },
    orderStatusLog: { findMany: vi.fn() },
    orderChangeRequest: { findMany: vi.fn() },
    orderActivity: { findMany: vi.fn() },
    deliveryFee: { findMany: vi.fn() },
    // The list is read lean first — every parcel the question matches — and the names beside the dropdowns come with it.
    deliveryProvider: { findMany: vi.fn() },
    region: { findMany: vi.fn() },
    settlementMatch: { findMany: vi.fn() },
  },
  requireContext: vi.fn(),
  requirePermission: vi.fn(),
  noteCustomersHandedOut: vi.fn(),
}));

vi.mock('@/lib/db', () => ({ db }));
vi.mock('@/lib/geo-context', () => ({ requireContext: (...a: unknown[]) => requireContext(...a) }));
vi.mock('@/lib/authorization', () => ({
  requirePermission: (...a: unknown[]) => requirePermission(...a),
  can: () => true,
}));
vi.mock('@/lib/pii-alert', () => ({ noteCustomersHandedOut: (...a: unknown[]) => noteCustomersHandedOut(...a) }));

import { GET } from './route';

/** Shipped four days ago, so three days is passed and zero days is not. */
const SHIPPED_AT = new Date(Date.now() - 4 * 24 * 60 * 60 * 1000);

const order = (over: Record<string, unknown> = {}) => ({
  id: 'o1', orderNumber: 'SY-2026-0001', merchantRef: 'SY-2026-0001',
  trackingNumber: 'BC-1', confirmationStatus: 'CONFIRMED', updatedAt: new Date('2026-09-01'),
  shippingStatus: 'SHIPPED', settlementStatus: 'PENDING_COLLECTION',
  shippedAt: SHIPPED_AT, outForDeliveryAt: null, deliveryFailureReason: null,
  totalAmount: 20, deliveryFee: 3, priceIncludesDelivery: false, collectedAmount: null,
  items: [{ quantity: 1, freeQuantity: 0, unitPrice: 20, discountShare: 0, deliveredQty: null }],
  returnReceipt: null,
  currency: 'USD', regionId: 'r1', deliveryProviderId: 'p1',
  customer: { fullName: 'زبون', phone: '0912345678', city: 'دمشق' },
  region: { id: 'r1', name: 'دمشق' },
  deliveryProvider: { id: 'p1', name: 'أبو علي', kind: 'AGENT' },
  _count: { deliveryAttempts: 0, notes: 0 },
  ...over,
});

async function rowFor(fees: { deliveryProviderId: string; regionId: string; lateThresholdDays: number }[]) {
  db.deliveryFee.findMany.mockResolvedValue(fees);
  const res = await GET(new Request('http://localhost/api/ops/tracking'));
  expect(res.status).toBe(200);
  const body = (await res.json()) as { orders: { lateThresholdDays: number | null; late: boolean }[] };
  return body.orders[0];
}

beforeEach(() => {
  vi.clearAllMocks();
  requireContext.mockResolvedValue({
    user: { id: 'u1', name: 'موظف تتبّع' },
    companyId: 'c1', storeId: 's1',
    country: { minorUnit: 2, currencyCode: 'USD', code: 'SY' },
  });
  requirePermission.mockResolvedValue({});
  db.order.findMany.mockResolvedValue([order()]);
  db.orderStatusLog.findMany.mockResolvedValue([]);
  db.orderChangeRequest.findMany.mockResolvedValue([]);
  db.orderActivity.findMany.mockResolvedValue([]);
  db.deliveryProvider.findMany.mockResolvedValue([{ id: 'p1', name: 'أبو علي' }]);
  db.settlementMatch.findMany.mockResolvedValue([]);
  db.region.findMany.mockResolvedValue([{ id: 'r1', name: 'دمشق' }]);
  noteCustomersHandedOut.mockResolvedValue(undefined);
});

describe('the late threshold on the wire', () => {
  it('is null — not 0 — when this courier has no fee row for this region', async () => {
    const row = await rowFor([]);
    // THE ASSERTION THAT `?? 0` BREAKS.
    expect(row.lateThresholdDays).toBeNull();
    expect(row.lateThresholdDays).not.toBe(0);
    // And nothing about lateness changed: no threshold, never late.
    expect(row.late).toBe(false);
  });

  it('is 0 when a row says 0, and that is a different answer from null', async () => {
    const row = await rowFor([{ deliveryProviderId: 'p1', regionId: 'r1', lateThresholdDays: 0 }]);
    expect(row.lateThresholdDays).toBe(0);
    expect(row.lateThresholdDays).not.toBeNull();
    // A zero threshold is «never flag these late», not «late immediately».
    expect(row.late).toBe(false);
  });

  it('is the stored number when a row says 3, and the parcel is late at four days', async () => {
    const row = await rowFor([{ deliveryProviderId: 'p1', regionId: 'r1', lateThresholdDays: 3 }]);
    expect(row.lateThresholdDays).toBe(3);
    expect(row.late).toBe(true);
  });
});
