import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * GET /api/ops/tracking — THE LIST MUST SURVIVE ITS OWN ROWS.
 *
 * This screen is the only place a person can see a parcel's state, and it is
 * read all day. One strange row in two hundred must cost that row's own
 * figure and nothing else — not the screen.
 *
 * The row that proved it: `confirmation/winback/route.ts` creates a real
 * order and writes NO `OrderItem` rows (there is no `orderItem` call in that
 * file). It is born `NOT_READY` and stays there, because `assertReadyToShip`
 * (`order-state.ts:238`) refuses an order with no lines. So it is invisible
 * on the default «قيد الشحن» filter and appears the moment the operator
 * picks «الكل» or «غير جاهز» — and then `expectedAmountFor` threw on it and
 * the whole response became a 500 with an empty screen behind it.
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

const get = (qs = '') => new Request(`http://localhost/api/ops/tracking${qs}`);

/** A healthy delivered parcel, as the route's own select returns one. */
const healthy = (over: Record<string, unknown> = {}) => ({
  id: 'o-healthy', orderNumber: 'SY-2026-0001', merchantRef: 'SY-2026-0001',
  trackingNumber: 'BC-1', confirmationStatus: 'CONFIRMED', updatedAt: new Date('2026-09-01'),
  shippingStatus: 'DELIVERED', settlementStatus: 'PENDING_COLLECTION',
  shippedAt: new Date('2026-08-28'), outForDeliveryAt: null, deliveryFailureReason: null,
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

/**
 * The winback order, exactly as that route writes it: a real order with an
 * empty `items` array, because no `OrderItem` row was ever created for it.
 */
const lineless = () =>
  healthy({
    id: 'o-winback', orderNumber: 'SY-2026-0099', merchantRef: 'SY-2026-0099',
    trackingNumber: null, confirmationStatus: 'NEW',
    shippingStatus: 'NOT_READY', settlementStatus: 'NOT_APPLICABLE',
    shippedAt: null, items: [], totalAmount: 17.5,
  });

beforeEach(() => {
  vi.clearAllMocks();
  requireContext.mockResolvedValue({
    user: { id: 'u1', name: 'موظف تتبّع' },
    companyId: 'c1', storeId: 's1',
    country: { minorUnit: 2, currencyCode: 'USD', code: 'SY' },
  });
  requirePermission.mockResolvedValue({});
  db.orderStatusLog.findMany.mockResolvedValue([]);
  db.orderChangeRequest.findMany.mockResolvedValue([]);
  db.orderActivity.findMany.mockResolvedValue([]);
  db.deliveryFee.findMany.mockResolvedValue([{ deliveryProviderId: 'p1', regionId: 'r1', lateThresholdDays: 3 }]);
  db.deliveryProvider.findMany.mockResolvedValue([{ id: 'p1', name: 'أبو علي' }]);
  db.settlementMatch.findMany.mockResolvedValue([]);
  db.region.findMany.mockResolvedValue([{ id: 'r1', name: 'دمشق' }]);
  noteCustomersHandedOut.mockResolvedValue(undefined);
});

describe('«الكل» and «غير جاهز» — the filters that reach an order with no lines', () => {
  it('lists the lineless order and every healthy row beside it, instead of 500-ing the screen', async () => {
    /*
     * MEASURED BEFORE THE GUARD: status=all drops the status filter
     * (`route.ts:38-40`), the winback order's `items: []` reaches
     * `expectedAmountFor`, `settlement.ts:363` throws
     *
     *   expectedAmountFor: order has no lines — spread SETTLEMENT_ORDER_SELECT…
     *
     * which matches no branch in `api-error.ts`, so the response was
     *
     *   500 { error: 'حدث خطأ داخلي' }   and `orders` undefined
     *
     * — the blank screen, with the two healthy rows here (and ~199 in
     * production) taken down with it.
     */
    db.order.findMany.mockResolvedValue([
      healthy(),
      lineless(),
      healthy({ id: 'o-healthy-2', orderNumber: 'SY-2026-0002', totalAmount: 15, deliveryFee: 4 }),
    ]);

    const res = await GET(get('?status=all'));
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.count).toBe(3);
    // 21/10: the ROUTE sorts now — worst first, the oldest shipped first within that — because the page is cut from the
    // sorted list and the screen no longer holds the whole of it. Two parcels owed money (rank 6) come before one that
    // needs nothing (rank 7), each group in the database's own order.
    expect(body.orders.map((o: { orderNumber: string }) => o.orderNumber)).toEqual([
      'SY-2026-0001', 'SY-2026-0002', 'SY-2026-0099',
    ]);
  });

  it('answers «no expectation» for the lineless row — not 0, which would mean «owes nothing»', async () => {
    db.order.findMany.mockResolvedValue([lineless()]);

    const body = await (await GET(get('?status=all'))).json();
    const row = body.orders[0];

    expect(row.orderNumber).toBe('SY-2026-0099');
    // `null`, not `0`: 0 is the settled answer the rule gives a RETURNED
    // parcel, and this order's collection is unknown, not nil.
    expect(row.expectedCollection).toBeNull();
  });

  it('still answers with the rule for every row that has lines — 20 less a 3 fee', async () => {
    // The guard above must cost the lineless row its figure and NOTHING
    // else. A guard that answered null for everything would pass the two
    // tests above and silently empty the collect bar of every real parcel.
    db.order.findMany.mockResolvedValue([healthy(), lineless()]);

    const body = await (await GET(get('?status=all'))).json();
    const rows: { orderNumber: string; expectedCollection: number | null }[] = body.orders;

    expect(rows.find((r) => r.orderNumber === 'SY-2026-0001')?.expectedCollection).toBe(17);
    expect(rows.find((r) => r.orderNumber === 'SY-2026-0099')?.expectedCollection).toBeNull();
  });

  it('survives the named «غير جاهز» filter too — the other way to that row', async () => {
    db.order.findMany.mockResolvedValue([lineless()]);

    const res = await GET(get('?status=NOT_READY'));
    expect(res.status).toBe(200);
    // And it really is the NOT_READY filter that was asked of the database — as its own clause of the question.
    expect(db.order.findMany.mock.calls[0][0].where.AND).toEqual([{ shippingStatus: 'NOT_READY' }]);
  });

  it('never sends the lines or the return receipt to the browser', async () => {
    // They are what the expectation is BUILT from, not something the screen
    // prints — and a row carrying every unit of every parcel is a lot of
    // somebody's order history in a browser.
    db.order.findMany.mockResolvedValue([healthy()]);

    const row = (await (await GET(get('?status=all'))).json()).orders[0];
    expect(row).not.toHaveProperty('items');
    expect(row).not.toHaveProperty('returnReceipt');
  });
});
