import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * ═══════════════════════════════════════════════════════════════════════
 * «اظهر العنوان بالخانات» (the owner, 8/11) — THE ADDRESS ON «إنشاء شحنة», AND WHO IS GIVEN IT.
 *
 * `GET /api/ops/shipments` puts `address` on each row: the street the parcel goes to, by the rule dispatch applies
 * (`couriers/dispatch.ts`, «NO ADDRESS TO DELIVER TO»): the parcel's own address first, then the customer's; a blank
 * or spaces-only one counts as none, and none is `null`. A street is a customer's contact detail like the phone, so
 * it is in the answer ONLY for a holder of `customers.view` (the way `ops/labels` withholds it from the warehouse);
 * for everyone else the key is ABSENT — not an empty string, not null — and no other field of the row moves.
 *
 * Worked example: parcel «شارع الجلاء 12», customer «حي المزة» → the row says «شارع الجلاء 12». Parcel blank, customer
 * «حي المزة» → «حي المزة». Both blank → null. A warehouse user (packing key, no address-book key) → no `address`
 * on the row, and the street is nowhere in the answer, not even as `customer.address`.
 * ═══════════════════════════════════════════════════════════════════════
 */

const { db, requireContext, can, held, shipmentBlocks, resolveDeliveryFee } = vi.hoisted(() => ({
  db: { order: { findMany: vi.fn(), count: vi.fn() } },
  requireContext: vi.fn(),
  can: vi.fn(),
  held: { keys: new Set<string>() },
  shipmentBlocks: vi.fn(),
  resolveDeliveryFee: vi.fn(),
}));

vi.mock('@/lib/db', () => ({ db }));
vi.mock('@/lib/geo-context', () => ({ requireContext: (...a: unknown[]) => requireContext(...a) }));
vi.mock('@/lib/authorization', () => ({ requirePermission: vi.fn(), can: (...a: unknown[]) => can(...a) }));
vi.mock('@/lib/audit', () => ({ logAudit: vi.fn() }));
vi.mock('@/lib/pii-alert', () => ({ noteCustomersHandedOut: vi.fn() }));
vi.mock('@/lib/operations', () => ({ shipmentBlocks: (...a: unknown[]) => shipmentBlocks(...a) }));
vi.mock('@/lib/delivery-fees', async (orig) => ({
  ...(await orig<typeof import('@/lib/delivery-fees')>()),
  resolveDeliveryFee: (...a: unknown[]) => resolveDeliveryFee(...a),
}));

import { GET } from '@/app/api/ops/shipments/route';

const USER = { id: 'u1', role: 'WAREHOUSE' };
const holding = (...keys: string[]) => {
  held.keys = new Set(keys);
};

/** One confirmed, fully reserved order — ready, so the only thing that varies between tests is the address. */
const order = (n: number, over: Record<string, unknown> = {}, customerOver: Record<string, unknown> = {}) => ({
  id: `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`,
  orderNumber: `SY-2026-${String(n).padStart(4, '0')}`,
  merchantRef: null,
  createdAt: new Date('2026-10-01'),
  currency: 'SYP',
  shipHoldUntil: null,
  shipHoldReason: null,
  priceIncludesDelivery: false,
  deliveryFee: 0,
  regionId: 'r1',
  deliveryProviderId: null,
  customerId: 'cu1',
  companyId: 'c1',
  storeId: 's1',
  confirmationStatus: 'CONFIRMED',
  shippingStatus: 'NOT_READY',
  shippedAt: null,
  labelPrintedAt: null,
  shippingBatchId: null,
  version: 1,
  deliveryAddress: null,
  customer: { id: 'cu1', fullName: 'سامر', phone: '0790000000', city: 'دمشق', totalOrders: 1, address: null, ...customerOver },
  region: { id: 'r1', name: 'دمشق' },
  items: [{ productName: 'منتج', quantity: 1, freeQuantity: 0, unitPrice: 20, discountShare: 0, lineTotal: 20, reservedQty: 1 }],
  addOns: [],
  ...over,
});

type Row = { id: string; customer: Record<string, unknown>; address?: string | null } & Record<string, unknown>;

/** The answer as the screen gets it, plus its raw text — the street must be nowhere in it for someone who may not read it. */
const ask = async (qs = '') => {
  const res = await GET(new Request(`http://localhost/api/ops/shipments${qs}`));
  const raw = await res.text();
  return { status: res.status, raw, orders: (JSON.parse(raw).orders ?? []) as Row[] };
};

/** The one row of a one-order list. */
const rowOf = async (o: ReturnType<typeof order>, qs = '') => {
  db.order.findMany.mockResolvedValue([o]);
  const { orders } = await ask(qs);
  expect(orders).toHaveLength(1);
  return orders[0];
};

beforeEach(() => {
  vi.clearAllMocks();
  holding();
  requireContext.mockResolvedValue({
    user: USER, companyId: 'c1', storeId: 's1', country: { minorUnit: 2, allowNegativeStock: false },
  });
  can.mockImplementation((_user: unknown, key: string) => held.keys.has(key));
  db.order.count.mockResolvedValue(0);
  shipmentBlocks.mockResolvedValue([]);
  resolveDeliveryFee.mockResolvedValue({ fee: 3, lateThresholdDays: 5, returnFee: 0, source: 'TABLE' });
});

describe('the holder of the address-book key gets the street the parcel goes to', () => {
  beforeEach(() => holding('customers.view'));

  it('the parcel’s own address wins over the customer’s', async () => {
    const row = await rowOf(order(1, { deliveryAddress: 'شارع الجلاء 12' }, { address: 'حي المزة' }));
    expect(row.address).toBe('شارع الجلاء 12');
  });

  it('a parcel with none takes the customer’s', async () => {
    const row = await rowOf(order(1, { deliveryAddress: null }, { address: 'حي المزة' }));
    expect(row.address).toBe('حي المزة');
  });

  it('a spaces-only parcel address counts as none: the customer’s is used', async () => {
    const row = await rowOf(order(1, { deliveryAddress: '   ' }, { address: 'حي المزة' }));
    expect(row.address).toBe('حي المزة');
  });

  it('an address is trimmed, as dispatch hands it to the courier', async () => {
    expect((await rowOf(order(1, { deliveryAddress: '  شارع الجلاء 12 \n' }))).address).toBe('شارع الجلاء 12');
    expect((await rowOf(order(2, { deliveryAddress: null }, { address: '\t حي المزة  ' }))).address).toBe('حي المزة');
  });

  it('none anywhere — nothing, spaces, or an empty string — is null, and the key is THERE (it says «none», not «not told»)', async () => {
    for (const [parcel, customer] of [[null, null], ['   ', '  '], ['', ''], [null, '']] as const) {
      const row = await rowOf(order(1, { deliveryAddress: parcel }, { address: customer }));
      expect('address' in row, JSON.stringify([parcel, customer])).toBe(true);
      expect(row.address, JSON.stringify([parcel, customer])).toBeNull();
    }
  });

  it('an Arabic address with digits goes through as written (Arabic-Indic and Western digits both)', async () => {
    const written = 'دمشق - المزة - شارع ٧، بناء 12، طابق ٣';
    expect((await rowOf(order(1, { deliveryAddress: written }))).address).toBe(written);
  });

  it('a long address is carried whole — the server cuts nothing, the screen wraps it', async () => {
    const long = `${'شارع الملك الحسين بن طلال - '.repeat(60)}بناء 12`;
    expect(long.length).toBeGreaterThan(1500);
    expect((await rowOf(order(1, { deliveryAddress: long }))).address).toBe(long);
  });

  it('each row gets ITS OWN order’s address (three orders, three answers)', async () => {
    db.order.findMany.mockResolvedValue([
      order(1, { deliveryAddress: 'عنوان الطرد' }, { address: 'عنوان الزبون' }),
      order(2, { deliveryAddress: null }, { id: 'cu2', address: 'عنوان الزبون الثاني' }),
      order(3, { deliveryAddress: ' ' }, { id: 'cu3', address: null }),
    ]);
    const { orders } = await ask();
    expect(orders.map((o) => o.address)).toEqual(['عنوان الطرد', 'عنوان الزبون الثاني', null]);
  });

  it('the postponed tab carries it too — it is the same row', async () => {
    const row = await rowOf(order(1, { deliveryAddress: 'شارع الجلاء 12', shipHoldUntil: new Date('2026-11-20') }), '?held=only');
    expect(row.address).toBe('شارع الجلاء 12');
  });

  it('the key is asked by name, once for the whole list', async () => {
    await rowOf(order(1));
    expect(can).toHaveBeenCalledWith(USER, 'customers.view');
    expect(can.mock.calls.filter(([, k]) => k === 'customers.view')).toHaveLength(1);
  });

  it('the street is read from the database — the select asks for the parcel’s address and the customer’s', async () => {
    await rowOf(order(1));
    const { select } = db.order.findMany.mock.calls[0][0];
    expect(select.deliveryAddress).toBe(true);
    expect(select.customer.select.address).toBe(true);
  });
});

describe('everyone else gets a row with no address on it at all', () => {
  const STREET = 'شارع الجلاء 12 - بناء السلام';
  const CUSTOMER_STREET = 'حي المزة - خلف الجامع';
  const withStreets = () => order(1, { deliveryAddress: STREET }, { address: CUSTOMER_STREET });

  it('a packing-key holder without the address-book key: the row has NO `address` property', async () => {
    holding('ops.ship');
    const row = await rowOf(withStreets());
    expect('address' in row).toBe(false);
    expect(Object.keys(row)).not.toContain('address');
    expect(row.address).toBeUndefined();
  });

  it('and the street is nowhere in the answer: not the parcel’s, not the customer’s, not `customer.address`, not `deliveryAddress`', async () => {
    holding('ops.ship');
    db.order.findMany.mockResolvedValue([withStreets()]);
    const { status, raw, orders } = await ask();
    expect(status).toBe(200);
    expect(orders).toHaveLength(1);
    expect(raw).not.toContain(STREET);
    expect(raw).not.toContain(CUSTOMER_STREET);
    expect(raw).not.toContain('deliveryAddress');
    expect('address' in orders[0].customer).toBe(false);
  });

  it('NEGATIVE: every other key a shipper or a packer may hold opens nothing — only `customers.view` does', async () => {
    holding('ops.ship', 'ops.labels', 'ops.batches', 'ops.track', 'orders.view', 'customers.view_basic', 'finance.view');
    const row = await rowOf(withStreets());
    expect('address' in row).toBe(false);
  });

  it('the postponed tab withholds it just the same', async () => {
    holding('ops.ship');
    const row = await rowOf(order(1, { deliveryAddress: STREET, shipHoldUntil: new Date('2026-11-20') }), '?held=only');
    expect('address' in row).toBe(false);
  });

  it('an order with NO address at all is not a hint either: the key stays absent (nothing to tell, nothing to withhold)', async () => {
    holding('ops.ship');
    const row = await rowOf(order(1, { deliveryAddress: null }, { address: null }));
    expect('address' in row).toBe(false);
  });
});

describe('the key changes the address and nothing else', () => {
  const o = () => order(1, { deliveryAddress: 'شارع الجلاء 12' }, { address: 'حي المزة' });

  it('the same order, with and without the key: the rows differ by `address` alone — the customer object is the same five fields', async () => {
    holding('customers.view');
    const withKey = await rowOf(o());
    holding('ops.ship');
    const withoutKey = await rowOf(o());

    const { address, ...rest } = withKey;
    expect(address).toBe('شارع الجلاء 12');
    expect(rest).toEqual(withoutKey);
    expect(Object.keys(withKey.customer).sort()).toEqual(['city', 'fullName', 'id', 'phone', 'totalOrders']);
  });

  it('the money, the blocks and the selection of the row do not move with the key', async () => {
    holding('customers.view');
    const a = await rowOf(o());
    holding();
    const b = await rowOf(o());
    for (const field of ['cod', 'blocks', 'selectable', 'hardBlocked', 'standDownBlocked', 'region', 'items', 'previousOrders']) {
      expect(a[field], field).toEqual(b[field]);
    }
  });
});
