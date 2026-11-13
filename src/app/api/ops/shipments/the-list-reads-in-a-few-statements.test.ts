import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * ═══════════════════════════════════════════════════════════════════════
 * «إنشاء شحنة» — THE LIST DRAWS FROM A HANDFUL OF STATEMENTS, NOT ONE ROUND TRIP PER ORDER.
 *
 * It asked the tables, for each of up to 300 orders in turn: the courier's fee row, two counts of the customer's other
 * parcels, a fee-row existence check, the lines, the add-ons and three aggregates per line — about 2,700 statements, again
 * after every pause in typing and every return to the tab. It asks them once for the whole list now.
 *
 * This runs the REAL `shipmentBlocksBulk`, `resolveDeliveryFeesFor` and `stockPoolsFor` (nothing of them is mocked) over a
 * database that only counts, and holds three things:
 *   1. the number of statements for 300 orders is a handful, and none of the per-order reads is made;
 *   2. the answer still has a row per order, with the blocks the shelf and the fee give it;
 *   3. the payload did not grow: the read of each line's product (needed to ask the shelf) is not in the row.
 * ═══════════════════════════════════════════════════════════════════════
 */

const { db, requireContext } = vi.hoisted(() => ({
  db: {
    order: { findMany: vi.fn(), count: vi.fn() },
    orderItem: { findMany: vi.fn(), aggregate: vi.fn(), groupBy: vi.fn() },
    orderAddOn: { findMany: vi.fn(), aggregate: vi.fn(), groupBy: vi.fn() },
    productionBatch: { aggregate: vi.fn(), groupBy: vi.fn() },
    deliveryFee: { findFirst: vi.fn(), findMany: vi.fn() },
    shippingBatch: { findUnique: vi.fn(), findFirst: vi.fn() },
  },
  requireContext: vi.fn(),
}));

vi.mock('@/lib/db', () => ({ db }));
vi.mock('@/lib/geo-context', () => ({ requireContext: (...a: unknown[]) => requireContext(...a) }));
vi.mock('@/lib/authorization', () => ({ requirePermission: vi.fn(), can: () => false }));
vi.mock('@/lib/audit', () => ({ logAudit: vi.fn() }));
vi.mock('@/lib/pii-alert', () => ({ noteCustomersHandedOut: vi.fn() }));

import { GET } from '@/app/api/ops/shipments/route';

const COURIER = '11111111-1111-4111-8111-111111111111';
const idOf = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

const listed = (n: number) => ({
  id: idOf(n), orderNumber: `SY-2026-${String(n).padStart(4, '0')}`, merchantRef: null, createdAt: new Date('2026-10-01'), currency: 'SYP',
  shipHoldUntil: null, shipHoldReason: null, priceIncludesDelivery: false, deliveryFee: 0, regionId: `r${n % 5}`, deliveryProviderId: COURIER,
  customerId: `cu${n % 40}`, companyId: 'c1', storeId: 's1', confirmationStatus: 'CONFIRMED', shippingStatus: 'NOT_READY', shippedAt: null,
  labelPrintedAt: null, shippingBatchId: null, deliveryAddress: null,
  customer: { id: `cu${n % 40}`, fullName: 'سامر', phone: '0790000000', city: 'دمشق', totalOrders: 2, address: null },
  region: { id: `r${n % 5}`, name: 'دمشق' },
  items: [
    { productId: `p${n % 12}`, productName: `منتج ${n % 12}`, quantity: 2, freeQuantity: 1, unitPrice: 20, discountShare: 0, lineTotal: 40, reservedQty: 3 },
    { productId: `p${(n + 5) % 12}`, productName: `منتج ${(n + 5) % 12}`, quantity: 1, freeQuantity: 0, unitPrice: 10, discountShare: 0, lineTotal: 10, reservedQty: 1 },
  ],
  addOns: [{ productId: `p${(n + 7) % 12}`, productName: `منتج ${(n + 7) % 12}`, quantity: 1, price: 5, reservedQty: 1 }],
});

const statements = () =>
  [db.order, db.orderItem, db.orderAddOn, db.productionBatch, db.deliveryFee, db.shippingBatch].reduce(
    (sum, table) => sum + Object.values(table).reduce((s, fn) => s + (fn as ReturnType<typeof vi.fn>).mock.calls.length, 0),
    0
  );

beforeEach(() => {
  vi.clearAllMocks();
  requireContext.mockResolvedValue({
    user: { id: 'u1', role: 'WAREHOUSE' }, companyId: 'c1', storeId: 's1', country: { minorUnit: 2, allowNegativeStock: false },
  });
  const rows = Array.from({ length: 300 }, (_, i) => listed(i + 1));
  // The list read carries `customer` in its select; the reads of the customers' parcels carry only ids.
  db.order.findMany.mockImplementation(async (args: { select?: Record<string, unknown> }) => (args.select && 'customer' in args.select ? rows : []));
  db.order.count.mockResolvedValue(0);
  db.orderItem.groupBy.mockResolvedValue([]);
  db.orderAddOn.groupBy.mockResolvedValue([]);
  db.productionBatch.groupBy.mockResolvedValue([]);
  db.deliveryFee.findMany.mockResolvedValue([]);
});

describe('GET /api/ops/shipments over 300 orders', () => {
  it('reads the tables a handful of times, and never the way it used to: one order at a time', async () => {
    const res = await GET(new Request(`http://localhost/api/ops/shipments?courier=${COURIER}`));
    expect(res.status).toBe(200);
    // The list (1) + the held count (1) + the customers' parcels on the road and returned (2) + the fee rows for the COD (1)
    // + the fee-row existence (1) + the shelf (5) = 11 for one store.
    expect(statements()).toBeLessThanOrEqual(14);
    // None of the per-order reads: not the fee row, not the lines, not the add-ons, not the per-product aggregates.
    expect(db.deliveryFee.findFirst).not.toHaveBeenCalled();
    expect(db.orderItem.findMany).not.toHaveBeenCalled();
    expect(db.orderAddOn.findMany).not.toHaveBeenCalled();
    expect(db.orderItem.aggregate).not.toHaveBeenCalled();
    expect(db.orderAddOn.aggregate).not.toHaveBeenCalled();
    expect(db.productionBatch.aggregate).not.toHaveBeenCalled();
    // The only count is the postponed tally on the tab.
    expect(db.order.count).toHaveBeenCalledTimes(1);
  });

  it('still answers a row per order, with the shelf’s and the fee’s blocks on it', async () => {
    const res = await GET(new Request(`http://localhost/api/ops/shipments?courier=${COURIER}`));
    const body = (await res.json()) as { count: number; orders: { id: string; blocks: { code: string }[]; selectable: boolean; items: Record<string, unknown>[] }[] };
    expect(body.count).toBe(300);
    expect(body.orders).toHaveLength(300);
    // No batches on the shelf and no fee rows in this world: every order is short, and every one has no fee row.
    for (const row of body.orders) {
      const codes = row.blocks.map((b) => b.code);
      expect(codes).toContain('NO_FEE_ROW');
      expect(codes).toContain('STOCK_SHORTAGE');
      expect(row.selectable).toBe(false);
    }
  });

  it('the payload did not grow: a line’s product, read to ask the shelf, is not in the row', async () => {
    const res = await GET(new Request(`http://localhost/api/ops/shipments?courier=${COURIER}`));
    const body = (await res.json()) as { orders: { items: Record<string, unknown>[] }[] };
    expect(Object.keys(body.orders[0].items[0]).sort()).toEqual(['freeQuantity', 'productName', 'quantity']);
    // …and it IS read: the shelf cannot be asked about a line without knowing which product it is.
    const select = db.order.findMany.mock.calls[0][0].select;
    expect(select.items.select).toMatchObject({ productId: true, productName: true });
    expect(select.addOns.select).toMatchObject({ productId: true, productName: true });
  });

  it('with the shelf stocked and a fee row, the same list has no blocks at all', async () => {
    db.productionBatch.groupBy.mockResolvedValue(Array.from({ length: 12 }, (_, i) => ({ productId: `p${i}`, _sum: { quantityRemaining: 100000 } })));
    db.deliveryFee.findMany.mockResolvedValue(
      Array.from({ length: 5 }, (_, i) => ({ deliveryProviderId: COURIER, regionId: `r${i}`, fee: '3', lateThresholdDays: 3, returnFee: '1' }))
    );
    const res = await GET(new Request(`http://localhost/api/ops/shipments?courier=${COURIER}`));
    const body = (await res.json()) as { orders: { blocks: unknown[]; selectable: boolean; cod: { feeSource: string } }[] };
    expect(body.orders.every((r) => r.blocks.length === 0 && r.selectable)).toBe(true);
    expect(body.orders.every((r) => r.cod.feeSource === 'TABLE')).toBe(true);
  });

  it('prices each order at the courier the screen asks about — the shipment’s TARGET — and asks nothing about the fee when there is none', async () => {
    // Orders waiting for a courier have none of their own: the courier on the screen is the one whose fee row is read.
    const rows = Array.from({ length: 3 }, (_, i) => ({ ...listed(i + 1), deliveryProviderId: null }));
    db.order.findMany.mockImplementation(async (args: { select?: Record<string, unknown> }) => (args.select && 'customer' in args.select ? rows : []));
    db.productionBatch.groupBy.mockResolvedValue(Array.from({ length: 12 }, (_, i) => ({ productId: `p${i}`, _sum: { quantityRemaining: 100000 } })));
    db.deliveryFee.findMany.mockResolvedValue(
      [1, 2, 3].map((i) => ({ deliveryProviderId: COURIER, regionId: `r${i}`, fee: '3', lateThresholdDays: 3, returnFee: '1' }))
    );

    const asked = (await (await GET(new Request(`http://localhost/api/ops/shipments?courier=${COURIER}`))).json()) as {
      orders: { blocks: unknown[]; cod: { feeSource: string } }[];
    };
    expect(asked.orders.every((r) => r.cod.feeSource === 'TABLE' && r.blocks.length === 0)).toBe(true);
    expect(db.deliveryFee.findMany.mock.calls[0][0].where.OR[0]).toMatchObject({ deliveryProviderId: COURIER, isActive: true });

    vi.clearAllMocks();
    db.order.findMany.mockImplementation(async (args: { select?: Record<string, unknown> }) => (args.select && 'customer' in args.select ? rows : []));
    db.order.count.mockResolvedValue(0);
    db.productionBatch.groupBy.mockResolvedValue(Array.from({ length: 12 }, (_, i) => ({ productId: `p${i}`, _sum: { quantityRemaining: 100000 } })));
    db.orderItem.groupBy.mockResolvedValue([]);
    db.orderAddOn.groupBy.mockResolvedValue([]);
    const unasked = (await (await GET(new Request('http://localhost/api/ops/shipments'))).json()) as {
      orders: { blocks: { code: string }[]; cod: { feeSource: string } }[];
    };
    expect(unasked.orders.every((r) => r.cod.feeSource === 'NONE' && !r.blocks.some((b) => b.code === 'NO_FEE_ROW'))).toBe(true);
    expect(db.deliveryFee.findMany).not.toHaveBeenCalled();
  });
});
