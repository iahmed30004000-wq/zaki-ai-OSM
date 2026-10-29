import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * THE ORDER FORM, WITH A REPEAT: SAVED EXACTLY AS IT WAS GOING TO BE, PLUS ONE HISTORY ROW.
 *
 * The detector is `src/lib/recent-twin-order.ts`; `recent-twin-order.test.ts` holds what counts as a twin and
 * `a-repeat-order-is-flagged-at-every-door.test.ts` holds that every door calls it. This is the one that drives the
 * door itself: a customer who ordered the same product three minutes ago still gets their order — same price, same
 * total, same lines, same status — and the confirmation window learns about it from a row.
 */

const { db, requireContext, requirePermission, logAudit, activeBlock } = vi.hoisted(() => ({
  db: {
    customer: { findUnique: vi.fn(), findFirst: vi.fn(), create: vi.fn(), update: vi.fn() },
    product: { findMany: vi.fn(), findFirst: vi.fn() },
    offer: { findFirst: vi.fn(), findMany: vi.fn(async (): Promise<unknown[]> => []) },
    store: { findFirst: vi.fn() },
    region: { findFirst: vi.fn() },
    user: { findFirst: vi.fn() },
    order: { create: vi.fn(), count: vi.fn(), findFirst: vi.fn(), findMany: vi.fn() },
    orderItem: { createMany: vi.fn(), create: vi.fn() },
    orderActivity: { create: vi.fn() },
    orderStatusLog: { create: vi.fn() },
    productionBatch: { findMany: vi.fn() },
    $transaction: vi.fn(),
  },
  requireContext: vi.fn(),
  requirePermission: vi.fn(),
  logAudit: vi.fn(),
  activeBlock: vi.fn(),
}));

vi.mock('@/lib/db', () => ({ db }));
vi.mock('@/lib/geo-context', () => ({ requireContext: (...a: unknown[]) => requireContext(...a) }));
vi.mock('@/lib/audit', () => ({ logAudit: (...a: unknown[]) => logAudit(...a) }));
vi.mock('@/lib/blacklist', () => ({ activeBlock: (...a: unknown[]) => activeBlock(...a) }));
vi.mock('@/lib/notification', () => ({ createNotification: vi.fn(async () => undefined) }));
vi.mock('@/lib/rbac', () => ({ applyQueueFilter: (_u: unknown, w: unknown) => w }));
vi.mock('@/lib/authorization', () => ({
  requirePermission: (...a: unknown[]) => requirePermission(...a),
  getPermissionScope: () => ({ scope: 'ALL_COMPANY' }),
  can: () => true,
}));
vi.mock('@/lib/order-ref', () => ({
  orderRefFields: async () => ({ orderNumber: 'SY-2026-0200', merchantRef: 'SY-2026-0200' }),
}));

import { POST } from './route';

const CREAM = { id: 'prod-cream-0001', name: 'كريم حرير', image: null, basePrice: 20, batches: [{ costPerUnit: 5 }] };
const syria = {
  id: 'co-sy', code: 'SY', name: 'سوريا', currencyCode: 'USD', minorUnit: 2,
  timezone: 'Asia/Damascus', orderPrefix: 'SY', allowNegativeStock: false,
};

const post = () =>
  POST(
    new Request('http://localhost/api/orders', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        customerName: 'محمد الحسن',
        customerPhone: '0944555666',
        customerAddress: 'دوما',
        source: 'Manual',
        productId: CREAM.id,
        quantity: 2,
        sellingPrice: 40,
      }),
    })
  );

/** The twin search is the only `order.findMany` that names a customer; the queue's own sweep uses the same method. */
const twinsAre = (rows: unknown[] | Error) =>
  db.order.findMany.mockImplementation(async ({ where }: any) => {
    if (!where?.customerId) return [];
    if (rows instanceof Error) throw rows;
    return rows;
  });

const flagRows = () =>
  db.orderActivity.create.mock.calls.map((c) => c[0].data).filter((d: { action: string }) => d.action === 'DUPLICATE_SUSPECT');

beforeEach(() => {
  vi.clearAllMocks();
  requireContext.mockResolvedValue({
    user: { id: 'u1', name: 'سارة', role: 'MODERATOR' },
    companyId: 'c1', storeId: 's1', countryId: 'co-sy', country: syria,
  });
  requirePermission.mockResolvedValue({ id: 'u1', companyId: 'c1' });
  activeBlock.mockResolvedValue(null);
  db.customer.findUnique.mockResolvedValue({ id: 'cu1', fullName: 'محمد الحسن', totalOrders: 0 });
  db.customer.findFirst.mockResolvedValue({ id: 'cu1', fullName: 'محمد الحسن', totalOrders: 0 });
  db.product.findMany.mockImplementation(async ({ where }: any) => [CREAM].filter((p) => where.id.in.includes(p.id)));
  db.offer.findFirst.mockResolvedValue(null);
  db.store.findFirst.mockResolvedValue({ priceIncludesDelivery: true });
  db.user.findFirst.mockResolvedValue({ id: 'u1', commissionRate: 0 });
  db.order.create.mockResolvedValue({ id: 'o-new', orderNumber: 'SY-2026-0200', createdAt: new Date('2026-10-29T12:00:00Z') });
  db.order.findMany.mockResolvedValue([]);
  db.productionBatch.findMany.mockResolvedValue([{ productId: CREAM.id, quantityRemaining: 100, costPerUnit: 5 }]);
  db.$transaction.mockImplementation(async (fn: any) => fn(db));
});

describe('a customer who ordered the same product minutes ago', () => {
  it('still gets the order — 200, one order written, one set of lines', async () => {
    twinsAre([{ id: 'o-earlier', orderNumber: 'SY-2026-0199' }]);
    const res = await post();
    expect(res.status).toBe(200);
    expect(db.order.create).toHaveBeenCalledTimes(1);
    expect(db.orderItem.createMany).toHaveBeenCalledTimes(1);
  });

  it('with the SAME money and status as a first-time order — the flag moves no number', async () => {
    await post();
    const clean = db.order.create.mock.calls[0][0].data;
    const cleanLines = db.orderItem.createMany.mock.calls[0][0].data;

    vi.clearAllMocks();
    db.order.create.mockResolvedValue({ id: 'o-new', orderNumber: 'SY-2026-0200', createdAt: new Date('2026-10-29T12:00:00Z') });
    twinsAre([{ id: 'o-earlier', orderNumber: 'SY-2026-0199' }]);
    db.$transaction.mockImplementation(async (fn: any) => fn(db));
    await post();
    const repeat = db.order.create.mock.calls[0][0].data;

    expect(repeat).toEqual(clean);
    expect(db.orderItem.createMany.mock.calls[0][0].data).toEqual(cleanLines);
    for (const k of ['totalAmount', 'sellingPrice', 'shippingCost', 'estimatedCostOfGoods', 'confirmationStatus', 'status']) {
      expect(repeat[k], k).toBeDefined();
    }
  });

  it('and the order’s history gets one row naming the earlier order', async () => {
    twinsAre([{ id: 'o-earlier', orderNumber: 'SY-2026-0199' }]);
    await post();
    const rows = flagRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ companyId: 'c1', orderId: 'o-new', userId: 'u1' });
    expect(JSON.parse(rows[0].metadata).twins).toEqual([{ id: 'o-earlier', orderNumber: 'SY-2026-0199' }]);
  });

  it('asked about THIS customer, THIS product and THIS company', async () => {
    await post();
    const where = db.order.findMany.mock.calls[0][0].where;
    expect(where.companyId).toBe('c1');
    expect(where.customerId).toBe('cu1');
    expect(where.id).toEqual({ not: 'o-new' });
    expect(JSON.stringify(where.OR)).toContain(CREAM.id);
  });

  it('a failing search does not fail the order the customer already thinks they placed', async () => {
    const quiet = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    twinsAre(new Error('db down'));
    const res = await post();
    expect(res.status).toBe(200);
    expect((await res.json()).success).toBe(true);
    quiet.mockRestore();
  });

  it('a failing history write does not either', async () => {
    const quiet = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    twinsAre([{ id: 'o-earlier', orderNumber: 'SY-2026-0199' }]);
    db.orderActivity.create.mockImplementation(async ({ data }: any) => {
      if (data.action === 'DUPLICATE_SUSPECT') throw new Error('write failed');
      return data;
    });
    const res = await post();
    expect(res.status).toBe(200);
    quiet.mockRestore();
  });
});

describe('a customer with no earlier order', () => {
  it('gets no flag row at all', async () => {
    await post();
    expect(flagRows()).toEqual([]);
    expect(db.order.create).toHaveBeenCalledTimes(1);
  });
});
