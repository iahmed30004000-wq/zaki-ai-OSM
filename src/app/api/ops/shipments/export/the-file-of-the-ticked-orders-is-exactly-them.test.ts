import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * ═══════════════════════════════════════════════════════════════════════
 * «خليها تنزل الي بحددو من المؤجل او جاهز» (the owner, 3/11).
 *
 * `POST /api/ops/shipments/export` — the orders ticked on «إنشاء شحنة», from either tab, as the CSV file. Held here:
 *   · the ids are the file, read under BOTH lists' question (ready or postponed, `shipmentListWhere`) — an id that is in
 *     neither any more (shipped, cancelled, another store) is not printed and is counted in `X-Left-Gone`;
 *   · a postponed order that is ticked IS in the file — its units were given back on purpose, so the stock question is
 *     not asked of a ticked order — while the fee question still is;
 *   · the same two keys as the tab's file; a courier named must be the company's; ids are uuids, at least one.
 *
 * Worked example: three ticked — two from «جاهزة», one from «مؤجَّلة» whose units were handed back — the file has the three.
 * ═══════════════════════════════════════════════════════════════════════
 */

const { db, requireContext, can, noteCustomersHandedOut, resolveDeliveryFee } = vi.hoisted(() => ({
  db: {
    deliveryProvider: { findFirst: vi.fn() },
    order: { findMany: vi.fn(), count: vi.fn() },
    deliveryFee: { findMany: vi.fn() },
  },
  requireContext: vi.fn(),
  can: vi.fn(),
  noteCustomersHandedOut: vi.fn(),
  resolveDeliveryFee: vi.fn(),
}));

vi.mock('@/lib/db', () => ({ db }));
vi.mock('@/lib/geo-context', () => ({ requireContext: (...a: unknown[]) => requireContext(...a) }));
vi.mock('@/lib/authorization', () => ({ can: (...a: unknown[]) => can(...a), requirePermission: vi.fn() }));
vi.mock('@/lib/pii-alert', () => ({ noteCustomersHandedOut: (...a: unknown[]) => noteCustomersHandedOut(...a) }));
vi.mock('@/lib/delivery-fees', async (orig) => ({
  ...(await orig<typeof import('@/lib/delivery-fees')>()),
  resolveDeliveryFee: (...a: unknown[]) => resolveDeliveryFee(...a),
}));

import { POST } from './route';
import { shipmentListWhere } from '@/lib/batching-guard';

const COURIER = '11111111-1111-4111-8111-111111111111';
const NOW = new Date('2026-11-03T09:00:00.000Z');
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

const post = (body: unknown) =>
  POST(new Request('http://localhost/api/ops/shipments/export', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  }));

/** One order; `reservedQty` 2 unless said — a postponed one has 0, its units given back. */
const order = (n: number, over: Record<string, unknown> = {}) => ({
  id: id(n), orderNumber: `ORD-2026-${String(n).padStart(4, '0')}`, merchantRef: null, trackingNumber: null,
  totalAmount: 20, currency: 'USD', confirmationStatus: 'CONFIRMED', shippingStatus: 'NOT_READY',
  shippingBatchId: null, deliveryProviderId: null, regionId: 'r-sweida', priceIncludesDelivery: false,
  labelPrintedAt: null, createdAt: new Date('2026-11-01'), customerNotes: null, deliveryAddress: null, shipHoldUntil: null,
  customer: { fullName: `زبون ${n}`, phone: '963991234567', rawPhone: '0991234567', altPhone: null, city: 'السويداء', address: 'حي المطار' },
  region: { name: 'السويداء' }, deliveryProvider: null,
  items: [{ productName: 'كريم', quantity: 2, freeQuantity: 0, unitPrice: 10, discountShare: 0, lineTotal: 20, reservedQty: 2 }],
  addOns: [],
  ...over,
});
const postponed = (n: number) =>
  order(n, {
    shipHoldUntil: new Date('2026-11-10'),
    items: [{ productName: 'كريم', quantity: 2, freeQuantity: 0, unitPrice: 10, discountShare: 0, lineTotal: 20, reservedQty: 0 }],
  });

const asKeys = (keys: string[]) => can.mockImplementation((_u: unknown, k: string) => keys.includes(k));

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW);
  requireContext.mockResolvedValue({
    user: { id: 'u1', name: 'قباص' }, companyId: 'c1', storeId: 's1',
    country: { minorUnit: 2, currencyCode: 'USD', code: 'SY' },
  });
  asKeys(['ops.ship', 'customers.view']);
  db.deliveryProvider.findFirst.mockResolvedValue({ id: COURIER, code: 'BASHA', adapterCode: null });
  db.deliveryFee.findMany.mockImplementation(async (args: { where: { isActive?: boolean; regionId?: { in: string[] } } }) =>
    args.where.isActive ? (args.where.regionId?.in ?? []).map((regionId) => ({ regionId })) : []
  );
  db.order.findMany.mockResolvedValue([]);
  db.order.count.mockResolvedValue(0);
  resolveDeliveryFee.mockResolvedValue({ fee: 5, lateThresholdDays: 0, returnFee: 0, source: 'REGION' });
});
afterEach(() => vi.useRealTimers());

describe('the worked example: two ready and one postponed, ticked', () => {
  it('the file has the three — the postponed one too — and nothing is said left out', async () => {
    db.order.findMany.mockResolvedValue([order(1), order(2), postponed(3)]);
    const res = await post({ courier: COURIER, ids: [id(1), id(2), id(3)] });

    expect(res.status).toBe(200);
    expect(res.headers.get('X-Rows')).toBe('3');
    expect(res.headers.get('X-Left-Held')).toBe('0');
    expect(res.headers.get('X-Left-Unready')).toBe('0');
    expect(res.headers.get('X-Left-Gone')).toBe('0');
    expect(res.headers.get('Content-Disposition')).toContain('picked-to-ship-');
    const text = await res.text();
    for (const n of ['ORD-2026-0001', 'ORD-2026-0002', 'ORD-2026-0003']) expect(text).toContain(n);
    // The postponed tab is not counted when the rows were ticked: nothing was left out for being postponed.
    expect(db.order.count).not.toHaveBeenCalled();
  });
});

describe('which orders the file asks for', () => {
  it('exactly the ticked ids, under the question of BOTH lists — ready or postponed, this company and store', async () => {
    await post({ courier: COURIER, ids: [id(1), id(3)] });
    const where = db.order.findMany.mock.calls[0][0].where;
    const base = { companyId: 'c1', storeId: 's1', now: NOW };
    expect(where).toEqual({
      AND: [
        { id: { in: [id(1), id(3)] } },
        { OR: [shipmentListWhere({ ...base, held: false }), shipmentListWhere({ ...base, held: true })] },
      ],
    });
  });

  it('a ticked id that left both lists since (shipped, cancelled) is not printed, and is counted as gone', async () => {
    db.order.findMany.mockResolvedValue([order(1)]);
    const res = await post({ courier: COURIER, ids: [id(1), id(2)] });
    expect(res.status).toBe(200);
    expect(res.headers.get('X-Rows')).toBe('1');
    expect(res.headers.get('X-Left-Gone')).toBe('1');
  });

  it('the same id ticked twice is one row', async () => {
    db.order.findMany.mockResolvedValue([order(1)]);
    await post({ courier: COURIER, ids: [id(1), id(1)] });
    expect(db.order.findMany.mock.calls[0][0].where.AND[0]).toEqual({ id: { in: [id(1)] } });
  });

  it('NEGATIVE: the fee question is still asked — a ticked order with no fee row at this courier is left out and counted', async () => {
    db.order.findMany.mockResolvedValue([order(1), order(2, { regionId: 'r-nowhere' })]);
    db.deliveryFee.findMany.mockImplementation(async (args: { where: { isActive?: boolean } }) =>
      args.where.isActive ? [{ regionId: 'r-sweida' }] : []
    );
    const res = await post({ courier: COURIER, ids: [id(1), id(2)] });
    expect(res.headers.get('X-Rows')).toBe('1');
    expect(res.headers.get('X-Left-Blocked')).toBe('1');
  });

  it('none of the ticked can go in: refused with the counts, not an empty file', async () => {
    db.order.findMany.mockResolvedValue([]);
    const res = await post({ courier: COURIER, ids: [id(1)] });
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.code).toBe('NOTHING_READY');
    expect(body.gone).toBe(1);
  });
});

describe('who may, and with what', () => {
  it('NEGATIVE: without the screen’s key — 403, nothing read', async () => {
    asKeys(['customers.view']);
    expect((await post({ courier: COURIER, ids: [id(1)] })).status).toBe(403);
    expect(db.order.findMany).not.toHaveBeenCalled();
  });

  it('NEGATIVE: without the address-book key — 403, nothing read', async () => {
    asKeys(['ops.ship']);
    expect((await post({ courier: COURIER, ids: [id(1)] })).status).toBe(403);
    expect(db.order.findMany).not.toHaveBeenCalled();
  });

  // No courier is no longer refused here: the ticked orders go without one, as a sheet with no money in it (the owner,
  // 3/11) — held in `the-file-of-the-ticked-orders-goes-without-a-courier.test.ts`.
  it('NEGATIVE: no ids, or an id that is not one, or no body — 400, nothing read', async () => {
    for (const body of [{ courier: COURIER, ids: [] }, { courier: COURIER, ids: ['o1'] }, { ids: [] }, null]) {
      expect((await post(body)).status).toBe(400);
    }
    expect(db.order.findMany).not.toHaveBeenCalled();
  });
});
