import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * ONE COUNT OF THE SHOP, READ TWICE AND ADDED ONCE.
 *
 * The route asks for every concluded parcel and then for the ones that came
 * back — and the second answer is a SUBSET of the first. Adding it to the
 * denominator as well as the numerator is the mistake that halves every
 * return rate in the product, and it is invisible: the number still looks
 * like a plausible percentage. So the arithmetic is pinned here against
 * counts taken from the courier's own statements.
 */

const { db, requireContext, assertOrderReadable } = vi.hoisted(() => ({
  db: { order: { findFirst: vi.fn(), groupBy: vi.fn() } },
  requireContext: vi.fn(),
  assertOrderReadable: vi.fn(),
}));

vi.mock('@/lib/db', () => ({ db }));
vi.mock('@/lib/geo-context', () => ({ requireContext: (...a: unknown[]) => requireContext(...a) }));
vi.mock('@/lib/rbac', () => ({
  assertOrderReadable: (...a: unknown[]) => assertOrderReadable(...a),
  ORDER_ACCESS_STATUS: { NOT_FOUND: 404, WRONG_COMPANY: 404, NOT_ASSIGNED: 404 },
}));

import { GET } from './route';
import { ORDER_WORK_DOOR } from '@/lib/order-work-door';

const ORDER = {
  id: 'o1',
  orderNumber: 'SY-1',
  productId: 'scars',
  quantity: 1,
  regionId: 'homs',
  region: { name: 'حمص' },
  productNameSnapshot: null,
  product: { name: 'كريم إزالة الندبات' },
};

const row = (productId: string, quantity: number, regionId: string, n: number) => ({
  productId,
  quantity,
  regionId,
  _count: { _all: n },
});

/**
 * A miniature of the real record, scaled so every segment clears the floors:
 * the scar cream as one unit comes back far more often than the truffle water
 * as three, which is what the 4543 real parcels say.
 */
const CONCLUDED = [
  row('scars', 1, 'homs', 1365),
  row('scars', 3, 'homs', 50),
  row('truffle', 1, 'damascus', 999),
  row('truffle', 3, 'damascus', 757),
];
const RETURNED = [
  row('scars', 1, 'homs', 557),
  row('scars', 3, 'homs', 11),
  row('truffle', 1, 'damascus', 277),
  row('truffle', 3, 'damascus', 130),
];

const call = () => GET(new Request('http://x'), { params: Promise.resolve({ id: 'o1' }) });

beforeEach(() => {
  vi.resetAllMocks();
  requireContext.mockResolvedValue({ user: { id: 'u1' }, companyId: 'c1', storeId: 's1' });
  assertOrderReadable.mockResolvedValue({ allowed: true });
  db.order.findFirst.mockResolvedValue(ORDER);
  db.order.groupBy.mockResolvedValueOnce(CONCLUDED).mockResolvedValueOnce(RETURNED);
});

describe('GET /api/orders/:id/shape-risk', () => {
  it('counts a returned parcel once in the numerator and never in the denominator', async () => {
    const body = await (await call()).json();
    // 1365 + 50 + 999 + 757 = 3171 concluded; 975 of them came back.
    expect(body.shopShipments).toBe(3171);
    expect(body.shopRate).toBeCloseTo(975 / 3171, 6);
  });

  it('names the product and the single unit as drivers', async () => {
    const body = await (await call()).json();
    const dims = body.drivers.map((d: { dimension: string }) => d.dimension);
    expect(dims).toContain('product');
    expect(dims).toContain('units');
    expect(body.verdict).toBe('HIGH');
  });

  it('offers the bundle, with the points it is measured to be worth', async () => {
    const body = await (await call()).json();
    const units = body.levers.find((l: { dimension: string }) => l.dimension === 'units');
    expect(units.to).toBe('3 قطع');
    // one unit: 834 back of 2364 = 35.3% · three units: 141 of 807 = 17.5%
    expect(units.points).toBeCloseTo(17.8, 1);
  });

  /**
   * AND IT SAYS WHAT IT CANNOT MEASURE.
   *
   * شام كاش did not come back once in 195 parcels and cash came back 31.2%
   * of 4338 — and the order has no column for how it will be paid, so the
   * system can neither measure nor offer it. Silence there would hide the
   * largest number in the courier's file.
   */
  it('reports the payment lever as a missing capability, with its measured prize', async () => {
    const body = await (await call()).json();
    expect(body.paymentUnmeasured.why).toContain('لا يسجّل طريقة الدفع');
    expect(body.paymentUnmeasured.measuredElsewhere).toContain('195');
    expect(body.levers.some((l: { dimension: string }) => l.dimension === 'payment')).toBe(false);
  });

  it('opens the order through the reader’s own envelope before it counts anything', async () => {
    await call();
    // The door the order window opens it through — the work door, which admits
    // the order she holds without «عرض الطلبات» (order-work-door.ts).
    expect(assertOrderReadable).toHaveBeenCalledWith('o1', { id: 'u1' }, { companyId: 'c1', storeId: 's1' }, ORDER_WORK_DOOR);
  });

  it('an order outside the reader’s envelope gets nothing — not even its product or region', async () => {
    assertOrderReadable.mockResolvedValue({ allowed: false, reason: 'NOT_FOUND' });
    const res = await call();
    expect(res.status).toBe(404);
    expect(db.order.findFirst).not.toHaveBeenCalled();
    expect(db.order.groupBy).not.toHaveBeenCalled();
  });

  it('reads only inside this company and this store', async () => {
    await call();
    const where = db.order.groupBy.mock.calls[0][0].where;
    expect(where.companyId).toBe('c1');
    expect(where.storeId).toBe('s1');
    expect(db.order.findFirst.mock.calls[0][0].where).toMatchObject({ id: 'o1', companyId: 'c1', storeId: 's1' });
  });

  it('counts a parcel still out with the courier in neither column', async () => {
    await call();
    const statuses = db.order.groupBy.mock.calls.map((c: unknown[]) => (c[0] as { where: { shippingStatus: { in: string[] } } }).where.shippingStatus.in);
    const [concluded, returned] = statuses;
    expect(concluded).toEqual(['DELIVERED', 'PARTIALLY_DELIVERED', 'RETURNED', 'RETURN_REQUESTED']);
    expect(returned).toEqual(['RETURNED', 'RETURN_REQUESTED']);
    // SHIPPED and OUT_FOR_DELIVERY are in neither: an undecided parcel in the
    // denominator makes every rate look better than it is while the week is
    // still young.
    expect(concluded).not.toContain('SHIPPED');
    expect(concluded).not.toContain('OUT_FOR_DELIVERY');
  });

  it('refuses an order that is not this store’s', async () => {
    db.order.findFirst.mockResolvedValue(null);
    const res = await call();
    expect(res.status).toBe(404);
  });

  it('says nothing about a dimension the shop has never shipped', async () => {
    db.order.findFirst.mockResolvedValue({ ...ORDER, productId: 'never-shipped', regionId: 'never' });
    const body = await (await call()).json();
    const dims = body.drivers.map((d: { dimension: string }) => d.dimension);
    expect(dims).not.toContain('product');
    expect(dims).not.toContain('region');
  });
});
