import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * ═══════════════════════════════════════════════════════════════════════
 * THE READ OF ONE TROLLEY CARRIES WHAT THE PACKING TABLE’S PEN NEEDS (30/10).
 *
 * `GET /api/shipping-batches/[id]` gives each parcel its lines, its version, its governorate and its price, so the
 * screen can show what is in the box and open the edit form on it. Three things are held here:
 *
 *   · `canEditInBatch` is the key AND an open trolley — never the key alone;
 *   · the phone, the second number and the address go to the key’s holder on an OPEN trolley (she cannot correct what
 *     she is not shown), and to no one else without the customers key — a closed trolley is history;
 *   · each line carries its total BEFORE the order’s discount, the figure the form echoes back and the door ignores.
 * ═══════════════════════════════════════════════════════════════════════
 */

const { db, requireContext, can, noteCustomersHandedOut } = vi.hoisted(() => ({
  db: { shippingBatch: { findFirst: vi.fn() } },
  requireContext: vi.fn(),
  can: vi.fn(),
  noteCustomersHandedOut: vi.fn(async (..._a: unknown[]) => undefined),
}));

vi.mock('@/lib/db', () => ({ db }));
vi.mock('@/lib/geo-context', () => ({ requireContext: (...a: unknown[]) => requireContext(...a) }));
vi.mock('@/lib/authorization', () => ({ can: (...a: unknown[]) => can(...a), requirePermission: vi.fn() }));
vi.mock('@/lib/audit', () => ({ logAudit: vi.fn() }));
vi.mock('@/lib/apps/events', () => ({ emitAppEvent: vi.fn() }));
vi.mock('@/lib/pii-alert', async (orig) => ({
  ...(await orig<typeof import('@/lib/pii-alert')>()),
  noteCustomersHandedOut: (...a: unknown[]) => noteCustomersHandedOut(...a),
}));

import { GET } from './[id]/route';

const order = (discountAmount = 0, shares = [0, 0]) => ({
  id: 'o1', orderNumber: 'SY-1', merchantRef: null, totalAmount: 39, trackingNumber: null, shippingStatus: 'READY_FOR_PICKUP',
  version: 7, currency: 'JOD', confirmationStatus: 'CONFIRMED', regionId: 'r1', discountAmount,
  customer: { fullName: 'أبو محمد', phone: '0791234567', altPhone: '0781111111', address: 'شارع الجلاء', city: 'السويداء' },
  region: { id: 'r1', name: 'السويداء' },
  items: [
    { productId: 'prod-aaaa-1', productName: 'كريم', quantity: 3, freeQuantity: 1, lineTotal: 36 - shares[0], discountShare: shares[0] },
    { productId: 'prod-bbbb-2', productName: 'عطر', quantity: 1, freeQuantity: 0, lineTotal: 10 - shares[1], discountShare: shares[1] },
  ],
});

const batch = (status = 'READY', orders = [order()]) => ({
  id: 'b1', companyId: 'c1', storeId: 's1', status, batchNumber: 'BATCH-1', provider: null, creator: null, orders,
});

const grant = (...keys: string[]) => can.mockImplementation((_u: unknown, k: string) => keys.includes(k));
const get = async () => {
  const res = await GET(new Request('http://localhost/api/shipping-batches/b1'), { params: Promise.resolve({ id: 'b1' }) });
  return { status: res.status, body: (await res.json()) as Record<string, any> };
};

beforeEach(() => {
  vi.clearAllMocks();
  requireContext.mockResolvedValue({
    user: { id: 'u1', name: 'عامل', email: 'w@example.com' }, companyId: 'c1', storeId: 's1',
    country: { currencyCode: 'JOD', minorUnit: 2 },
  });
  db.shippingBatch.findFirst.mockResolvedValue(batch());
});

describe('canEditInBatch', () => {
  it('is true for the key’s holder on an open trolley', async () => {
    grant('ops.batches', 'ops.edit_in_batch');
    expect((await get()).body.canEditInBatch).toBe(true);
  });

  it('NEGATIVE: false without the key — whatever else is held', async () => {
    grant('ops.batches', 'customers.view', 'orders.edit', 'orders.change_price');
    expect((await get()).body.canEditInBatch).toBe(false);
  });

  it('NEGATIVE: false on a trolley already handed over, key or not', async () => {
    grant('ops.batches', 'ops.edit_in_batch');
    for (const status of ['SHIPPED', 'CLOSED']) {
      db.shippingBatch.findFirst.mockResolvedValue(batch(status));
      expect((await get()).body.canEditInBatch, status).toBe(false);
    }
  });
});

describe('who is shown the numbers and the address', () => {
  it('the key’s holder on an open trolley, without the customers key', async () => {
    grant('ops.batches', 'ops.edit_in_batch');
    const c = (await get()).body.batch.orders[0].customer;
    expect(c).toMatchObject({ fullName: 'أبو محمد', phone: '0791234567', altPhone: '0781111111', address: 'شارع الجلاء' });
  });

  it('NEGATIVE: the batches screen alone sees the name and the city, no number and no address', async () => {
    grant('ops.batches');
    const c = (await get()).body.batch.orders[0].customer;
    expect(c.fullName).toBe('أبو محمد');
    expect(c.phone).toBeUndefined();
    expect(c.altPhone).toBeUndefined();
    expect(c.address).toBeUndefined();
  });

  it('NEGATIVE: the key on a CLOSED trolley shows no number — history goes only with the customers key', async () => {
    grant('ops.batches', 'ops.edit_in_batch');
    db.shippingBatch.findFirst.mockResolvedValue(batch('SHIPPED'));
    const c = (await get()).body.batch.orders[0].customer;
    expect(c.phone).toBeUndefined();
    expect(c.address).toBeUndefined();
  });

  it('the alarm counts what left: a holder shown the numbers is counted, one shown none is not', async () => {
    grant('ops.batches', 'ops.edit_in_batch');
    await get();
    expect((noteCustomersHandedOut.mock.calls[0][0] as { rows: unknown[] }).rows).toHaveLength(1);

    noteCustomersHandedOut.mockClear();
    grant('ops.batches');
    await get();
    expect((noteCustomersHandedOut.mock.calls[0][0] as { rows: unknown[] }).rows).toHaveLength(0);
  });
});

describe('what each parcel carries for the screen', () => {
  it('its version, its governorate, its price and its lines', async () => {
    grant('ops.batches');
    const o = (await get()).body.batch.orders[0];
    expect(o).toMatchObject({ version: 7, regionId: 'r1', region: { id: 'r1', name: 'السويداء' }, totalAmount: 39, currency: 'JOD' });
    expect(o.items.map((l: any) => [l.productName, l.quantity, l.freeQuantity])).toEqual([['كريم', 3, 1], ['عطر', 1, 0]]);
  });

  it('each line’s figure is its total BEFORE the discount, so the form can echo it and the door can ignore it', async () => {
    grant('ops.batches');
    db.shippingBatch.findFirst.mockResolvedValue(batch('READY', [order(4, [3, 1])]));
    const items = (await get()).body.batch.orders[0].items;
    expect(items.map((l: any) => l.unitPrice)).toEqual([36, 10]);
  });

  it('the order’s discount and the line rows’ own columns do not travel', async () => {
    grant('ops.batches');
    const o = (await get()).body.batch.orders[0];
    expect(o.discountAmount).toBeUndefined();
    expect(o.items[0].lineTotal).toBeUndefined();
    expect(o.items[0].discountShare).toBeUndefined();
  });

  it('the store’s currency comes with it, so the price is written the way every screen writes it', async () => {
    grant('ops.batches');
    expect((await get()).body.currency).toEqual({ code: 'JOD', minorUnit: 2 });
  });
});
