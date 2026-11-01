import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * ═══════════════════════════════════════════════════════════════════════
 * THE ORDER SAYS WHICH LIVE OFFER EACH LINE WAS SOLD ON — AND CHANGES NOTHING.
 *
 * `OrderItem` has no offer column, so the lines editor cannot open a line on «٣ + ١» unless the server recognises it
 * by its figure: a whole number of a live offer's bundles at that offer's price, before the order's discount. The read
 * adds two optional keys to each line — `boundOfferId` and `giftUnits` — and leaves every stored column as it was.
 *
 * `null` means «fits no live offer» (a typed price, pieces left over, an offer that has ended). The keys are ABSENT
 * only when the live offers could not be read at all, and the order opens regardless.
 * ═══════════════════════════════════════════════════════════════════════
 */

const { db, requireContext, can, authorize, getPermissionScope, assertOrderReadable, noteCustomersHandedOut } =
  vi.hoisted(() => ({
    db: {
      order: { findUnique: vi.fn(), findFirst: vi.fn(), groupBy: vi.fn() },
      returnReceipt: { count: vi.fn() },
      offer: { findMany: vi.fn() },
    },
    requireContext: vi.fn(),
    can: vi.fn(),
    authorize: vi.fn(),
    getPermissionScope: vi.fn(),
    assertOrderReadable: vi.fn(),
    noteCustomersHandedOut: vi.fn(),
  }));

vi.mock('@/lib/db', () => ({ db }));
vi.mock('@/lib/geo-context', () => ({ requireContext: (...a: unknown[]) => requireContext(...a) }));
vi.mock('@/lib/authorization', () => ({
  can: (...a: unknown[]) => can(...a),
  authorize: (...a: unknown[]) => authorize(...a),
  getPermissionScope: (...a: unknown[]) => getPermissionScope(...a),
  requirePermission: vi.fn(),
}));
vi.mock('@/lib/rbac', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  assertOrderAccess: vi.fn(),
  assertOrderReadable: (...a: unknown[]) => assertOrderReadable(...a),
}));
vi.mock('@/lib/pii-alert', () => ({ noteCustomersHandedOut: (...a: unknown[]) => noteCustomersHandedOut(...a) }));
vi.mock('@/lib/api-error', () => ({
  apiError: (e: unknown) => ({ body: { error: `UNEXPECTED: ${(e as Error)?.message}` }, status: 500 }),
}));

import { GET } from './route';

const NOW = new Date('2026-10-15T06:00:00.000Z');

interface ItemRow {
  id: string;
  productId: string;
  productName: string;
  quantity: number;
  freeQuantity: number;
  unitPrice: number;
  discountShare: number;
  lineTotal: number;
  reservedQty: number;
  deliveredQty: number | null;
  returnedQty: number | null;
}

const item = (over: Partial<ItemRow> & { id: string; productId: string }): ItemRow => ({
  productName: over.productId,
  quantity: 3,
  freeQuantity: 1,
  unitPrice: 25,
  discountShare: 0,
  lineTotal: 75,
  reservedQty: 0,
  deliveredQty: null,
  returnedQty: null,
  ...over,
});

const baseOrder = (items: ItemRow[], over: Record<string, unknown> = {}) => ({
  id: 'o1',
  companyId: 'c1',
  storeId: 's1',
  orderNumber: 'ORD-5',
  createdAt: NOW,
  status: 'NEW',
  confirmationStatus: 'NEW',
  signatureStatus: 'UNSIGNED',
  claimedById: 'a1',
  totalAmount: 75,
  discountAmount: 0,
  offerId: null,
  quantity: 3,
  items,
  addOns: [],
  customer: { id: 'cu1', fullName: 'زبون', phone: '079', city: 'عمّان' },
  activities: [], statusLogs: [], contactAttempts: [], changeRequests: [], deliveryAttempts: [], notes: [],
  callLogs: [], commissions: [], shipments: [], payments: [], returnReceipts: [], claimHistory: [],
  ...over,
});

const liveRow = (over: Record<string, unknown> & { id: string; productId: string }) => ({
  name: over.id, quantity: 3, freeQuantity: 1, sellingPrice: 75, discount: 0, compareAtPrice: null,
  isDefault: false, deliveryIncluded: true, endsAt: null, ...over,
});

const open = () => GET(new Request('http://localhost/api/orders/o1'), { params: Promise.resolve({ id: 'o1' }) });
const lines = async (res: Response) => ((await res.json()) as any).order.items as any[];

function seed(order: ReturnType<typeof baseOrder>) {
  db.order.findUnique.mockResolvedValue(order);
  assertOrderReadable.mockResolvedValue({ allowed: true, order });
}

beforeEach(() => {
  vi.clearAllMocks();
  requireContext.mockResolvedValue({
    user: { id: 'a1', name: 'سارة', role: 'CONFIRMATION_AGENT' },
    companyId: 'c1',
    storeId: 's1',
    country: { id: 'co', code: 'JO', currencyCode: 'JOD', minorUnit: 3, timezone: 'Asia/Amman' },
  });
  getPermissionScope.mockReturnValue({ scope: 'ASSIGNED' });
  can.mockImplementation((_u: unknown, k: string) => k === 'orders.view');
  authorize.mockImplementation((_u: unknown, k: string) => ({ allowed: k === 'orders.view' }));
  db.returnReceipt.count.mockResolvedValue(0);
  db.order.groupBy.mockResolvedValue([]);
  db.order.findFirst.mockResolvedValue(null);
  noteCustomersHandedOut.mockResolvedValue(undefined);
  db.offer.findMany.mockResolvedValue([liveRow({ id: 'o3', productId: 'P1' })]);
});

describe('a line that is a whole number of a live offer’s bundles is bound to it', () => {
  it('3 + 1 for 75 is bound, with its gift; 6 for 150 is the same offer with two', async () => {
    seed(baseOrder([
      item({ id: 'i1', productId: 'P1', quantity: 3, freeQuantity: 1, lineTotal: 75 }),
      item({ id: 'i2', productId: 'P1', quantity: 6, freeQuantity: 2, lineTotal: 150 }),
    ]));
    const [a, b] = await lines(await open());
    expect(a).toMatchObject({ boundOfferId: 'o3', giftUnits: 1 });
    expect(b).toMatchObject({ boundOfferId: 'o3', giftUnits: 2 });
  });

  it('the order’s own discount is taken off the other side: a stored 70 with a 5 share is still the 75 line', async () => {
    seed(baseOrder([item({ id: 'i1', productId: 'P1', lineTotal: 70, discountShare: 5 })], { discountAmount: 5 }));
    const [a] = await lines(await open());
    expect(a.beforeDiscount).toBe(75);
    expect(a.boundOfferId).toBe('o3');
  });

  it('NEGATIVE: the same stored 70 WITHOUT the discount behind it is a typed price, bound to nothing', async () => {
    seed(baseOrder([item({ id: 'i1', productId: 'P1', lineTotal: 70, discountShare: 0 })]));
    const [a] = await lines(await open());
    expect(a.beforeDiscount).toBe(70);
    expect(a.boundOfferId).toBeNull();
    expect(a.giftUnits).toBeNull();
  });
});

describe('and only that line', () => {
  it('pieces left over, a typed price, another product, and a product with no offer are bound to NOTHING', async () => {
    seed(baseOrder([
      item({ id: 'left-over', productId: 'P1', quantity: 4, lineTotal: 100 }),
      item({ id: 'typed', productId: 'P1', quantity: 3, lineTotal: 60 }),
      item({ id: 'other-product', productId: 'P2', quantity: 3, lineTotal: 75 }),
      item({ id: 'short', productId: 'P1', quantity: 2, lineTotal: 50, freeQuantity: 0 }),
    ]));
    const got = await lines(await open());
    expect(got.map((l) => l.id)).toEqual(['left-over', 'typed', 'other-product', 'short']);
    for (const l of got) {
      expect(l.boundOfferId, l.id).toBeNull();
      expect(l.giftUnits, l.id).toBeNull();
    }
  });

  it('an offer that has ended (the live reader returns nothing) binds nothing, and the stored gift is not touched', async () => {
    db.offer.findMany.mockResolvedValue([]);
    seed(baseOrder([item({ id: 'i1', productId: 'P1' })]));
    const [a] = await lines(await open());
    expect(a.boundOfferId).toBeNull();
    expect(a.freeQuantity).toBe(1);
  });

  it('the offers are asked for the live ones only, and for the lines’ products, once', async () => {
    seed(baseOrder([item({ id: 'i1', productId: 'P1' }), item({ id: 'i2', productId: 'P2', quantity: 2, lineTotal: 50 })]));
    await open();
    expect(db.offer.findMany).toHaveBeenCalledTimes(1);
    const where = db.offer.findMany.mock.calls[0]?.[0]?.where;
    expect(where).toMatchObject({ companyId: 'c1', productId: { in: ['P1', 'P2'] }, status: 'ACTIVE', postOrderOffer: false });
  });

  it('B2 — a plain 3 pieces with no gift at the price of a «3 + 1» is not bound to it', async () => {
    seed(baseOrder([item({ id: 'plain', productId: 'P1', quantity: 3, freeQuantity: 0, lineTotal: 75 })]));
    const [a] = await lines(await open());
    expect(a.boundOfferId).toBeNull();
    expect(a.giftUnits).toBeNull();
    expect(a.freeQuantity).toBe(0);
  });

  it('does not scan delivered orders for a struck-through price it never shows', async () => {
    seed(baseOrder([item({ id: 'i1', productId: 'P1' })]));
    await open();
    expect(db.order.groupBy).not.toHaveBeenCalled();
  });

  it('two live offers fit one line: the order’s own offer settles it', async () => {
    db.offer.findMany.mockResolvedValue([
      liveRow({ id: 'o3', productId: 'P1' }),
      liveRow({ id: 'o6', productId: 'P1', quantity: 6, freeQuantity: 2, sellingPrice: 150 }),
    ]);
    seed(baseOrder([item({ id: 'i1', productId: 'P1', quantity: 6, freeQuantity: 2, lineTotal: 150 })], { offerId: 'o6' }));
    const [a] = await lines(await open());
    expect(a.boundOfferId).toBe('o6');
    seed(baseOrder([item({ id: 'i1', productId: 'P1', quantity: 6, freeQuantity: 2, lineTotal: 150 })], { offerId: null }));
    expect((await lines(await open()))[0].boundOfferId).toBe('o3');
  });
});

describe('the read changes nothing', () => {
  it('every stored column goes out exactly as before, beside the two new keys', async () => {
    const row = item({ id: 'i1', productId: 'P1', quantity: 3, freeQuantity: 1, unitPrice: 25, lineTotal: 75, reservedQty: 4 });
    seed(baseOrder([row]));
    const [a] = await lines(await open());
    expect(a).toMatchObject({ ...row, beforeDiscount: 75, boundOfferId: 'o3', giftUnits: 1 });
  });

  it('when the live offers cannot be read the order still opens, without the two keys', async () => {
    db.offer.findMany.mockRejectedValue(new Error('boom'));
    seed(baseOrder([item({ id: 'i1', productId: 'P1' })]));
    const res = await open();
    expect(res.status).toBe(200);
    const [a] = await lines(res);
    expect(a).toMatchObject({ id: 'i1', quantity: 3, freeQuantity: 1, beforeDiscount: 75 });
    expect(Object.keys(a)).not.toContain('boundOfferId');
    expect(Object.keys(a)).not.toContain('giftUnits');
  });

  it('an order with no lines asks the offers table nothing', async () => {
    seed(baseOrder([]));
    const res = await open();
    expect(res.status).toBe(200);
    expect(db.offer.findMany).not.toHaveBeenCalled();
  });
});
