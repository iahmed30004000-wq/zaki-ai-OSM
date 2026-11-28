import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * THE PRINT DOOR AND THE NEW DESIGNS (27/11). A store that chose the current waybill — or chose a design and then went
 * back to it — gets the page it always got, and the door asks the database nothing more. A store that chose a design
 * gets its lines with variant and shape and the saved offer's name, read inside its own company and store. The courier's
 * CSV is the same file either way, and the extra labels stamp nothing: the page reports each order once.
 */

const { db, requireContext, resolveDeliveryFee } = vi.hoisted(() => ({
  db: {
    order: { findMany: vi.fn(), updateMany: vi.fn() },
    store: { findFirst: vi.fn() },
    company: { findUnique: vi.fn() },
  },
  requireContext: vi.fn(),
  resolveDeliveryFee: vi.fn(),
}));

vi.mock('@/lib/db', () => ({ db }));
vi.mock('@/lib/geo-context', () => ({ requireContext: (...a: unknown[]) => requireContext(...a) }));
vi.mock('@/lib/authorization', () => ({ requirePermission: vi.fn(), can: (_u: unknown, key: string) => key !== 'ops.labels_any' }));
vi.mock('@/lib/pii-alert', () => ({ noteCustomersHandedOut: vi.fn() }));
vi.mock('@/lib/delivery-fees', async (orig) => ({
  ...(await orig<typeof import('@/lib/delivery-fees')>()),
  resolveDeliveryFee: (...a: unknown[]) => resolveDeliveryFee(...a),
}));

import { GET } from '@/app/api/ops/labels/print/route';
import { signLabelBatch } from '@/lib/labels';
import { PARCEL_SELECT, parcelOf, type ParcelOrder } from '@/lib/waybill';

const A = '11111111-1111-4111-8111-111111111111';

const order = {
  id: A, orderNumber: 'SY-1111', merchantRef: null, trackingNumber: 'JO7000000123',
  totalAmount: 32.5, currency: 'JOD', confirmationStatus: 'CONFIRMED', shippingStatus: 'READY_FOR_PICKUP',
  shippingBatchId: null, deliveryProviderId: 'p1', regionId: 'r1', priceIncludesDelivery: false,
  labelPrintedAt: null, createdAt: new Date('2026-09-20'), customerNotes: 'اتصل قبل',
  customer: { fullName: 'محمد', phone: '0791234567', rawPhone: '0791234567', altPhone: null, city: 'طرطوس', address: 'طرطوس - بانياس' },
  region: { name: 'طرطوس' }, deliveryProvider: { name: 'LogesTechs' },
  items: [{ productName: 'كريم', quantity: 2, freeQuantity: 1, unitPrice: 20, discountShare: 0, variantSummary: 'كبير' }],
  addOns: [],
};

const parcelRow = (over: Partial<ParcelOrder> = {}): ParcelOrder => ({
  id: A,
  productId: 'prod-1',
  offer: { name: '🎁 قطعتين + قطعة هدية', productId: 'prod-1', quantity: 2, freeQuantity: 1 },
  items: [{ productId: 'prod-1', productName: 'كريم', quantity: 2, freeQuantity: 1, variantSummary: 'كبير' }],
  addOns: [],
  ...over,
});

const stored = (waybillPrint: unknown, productShapes?: unknown) =>
  db.company.findUnique.mockResolvedValue({ settings: JSON.stringify({ waybillPrint, productShapes }) });

async function sheet(format?: 'csv', paper: { width: number; height: number } = { width: 100, height: 150 }) {
  const t = await signLabelBatch({ storeId: 's1', orderIds: [A], ...paper } as never);
  const res = await GET(new Request(`http://localhost/x?t=${t}${format ? '&format=csv' : ''}`));
  expect(res.status).toBe(200);
  return (await res.text()).replace(/var TOKEN = [^;]+;/, '').replace(/<title>[^<]*<\/title>/, '');
}

beforeEach(() => {
  vi.clearAllMocks();
  requireContext.mockResolvedValue({ user: { id: 'u1', role: 'WAREHOUSE' }, companyId: 'c1', storeId: 's1', country: { minorUnit: 3, code: 'JO' } });
  db.store.findFirst.mockResolvedValue({ name: 'صحة بلس', logo: null, supportPhone: '0999000000' });
  db.order.findMany.mockImplementation(async ({ select }: { select: unknown }) => (select === PARCEL_SELECT ? [parcelRow()] : [order]));
  resolveDeliveryFee.mockResolvedValue({ fee: 3, lateThresholdDays: 5, returnFee: 0, source: 'TABLE' });
});

describe('«التصميم الأساسي» — the page it always was', () => {
  it('never chosen, and chosen again after a design: the same page, and no second read of the order', async () => {
    db.company.findUnique.mockResolvedValue({ settings: null });
    const never = await sheet();
    expect(never).not.toContain('wb-');
    expect(db.order.findMany).toHaveBeenCalledTimes(1);

    stored({ v: 1, stores: { s1: { hide: [], logo: 'store', design: 'a' } } }, { 'prod-1': 'jar' });
    expect(await sheet()).not.toBe(never);

    db.order.findMany.mockClear();
    // What the door stores for «التصميم الأساسي»: no design key. The offer's switch means nothing there.
    stored({ v: 1, stores: { s1: { hide: [], logo: 'store' } } }, { 'prod-1': 'jar' });
    expect(await sheet()).toBe(never);
    stored({ v: 1, stores: { s1: { hide: ['offer'], logo: 'store' } } }, { 'prod-1': 'jar' });
    expect(await sheet()).toBe(never);
    expect(db.order.findMany).toHaveBeenCalledTimes(2);
  });

  it('another store’s design changes nothing here', async () => {
    db.company.findUnique.mockResolvedValue({ settings: null });
    const never = await sheet();
    stored({ v: 1, stores: { s2: { hide: [], logo: 'store', design: 'b' } } });
    expect(await sheet()).toBe(never);
  });
});

describe('a sticker under 70 mm prints the current waybill, whatever was chosen', () => {
  const TINY = [{ width: 60, height: 40 }, { width: 69, height: 150 }, { width: 150, height: 69 }, { width: 40, height: 40 }];

  it.each(TINY)('$width×$height: the same page as a store that never chose, and no second read of the order', async (paper) => {
    db.company.findUnique.mockResolvedValue({ settings: null });
    const never = await sheet(undefined, paper);
    for (const hide of [[], ['offer']]) {
      for (const design of ['a', 'b']) {
        db.order.findMany.mockClear();
        stored({ v: 1, stores: { s1: { hide, logo: 'store', design } } }, { 'prod-1': 'jar' });
        expect(await sheet(undefined, paper)).toBe(never);
        expect(db.order.findMany).toHaveBeenCalledTimes(1);
      }
    }
    expect(never).not.toContain('wb-');
  });

  it('from 70×70 the chosen design prints', async () => {
    stored({ v: 1, stores: { s1: { hide: [], logo: 'store', design: 'a' } } });
    expect(await sheet(undefined, { width: 70, height: 70 })).toContain('wb wb-a ');
  });
});

describe('a chosen design', () => {
  it.each(['a', 'b'])('«%s»: the product’s shape and word, the variant and the saved offer — read inside this company and store', async (design) => {
    stored({ v: 1, stores: { s1: { hide: [], logo: 'store', design } } }, { 'prod-1': 'jar' });
    const html = await sheet();
    expect(html).toContain(`wb wb-${design} `);
    expect(html).toContain('wb-shape-jar');
    expect(html).toContain('مرطبانات');
    expect(html).toContain('كبير');
    expect(html).toContain('<span>قطعتين + قطعة هدية</span>');
    expect(html).not.toContain('🎁');
    expect([...html.matchAll(/data-order="([^"]+)"/g)].map((m) => m[1])).toEqual([A]);
    const asked = db.order.findMany.mock.calls.find((c) => c[0].select === PARCEL_SELECT)![0];
    expect(asked.where).toEqual({ id: { in: [A] }, companyId: 'c1', storeId: 's1' });
    // Reading and printing the page still writes nothing: stamping is the printed door's, unchanged.
    expect(db.order.updateMany).not.toHaveBeenCalled();
  });

  it('a product nobody gave a shape is «قطعة»; the offer’s switch takes the ticket off', async () => {
    stored({ v: 1, stores: { s1: { hide: ['offer'], logo: 'store', design: 'a' } } });
    const html = await sheet();
    expect(html).toContain('wb-shape-generic');
    expect(html).toContain('3 قطع');
    expect(html).not.toContain('class="wb-ticket"');
  });

  it('NEGATIVE: the courier’s CSV is the same file', async () => {
    db.company.findUnique.mockResolvedValue({ settings: null });
    const before = await sheet('csv');
    stored({ v: 1, stores: { s1: { hide: [], logo: 'store', design: 'b' } } }, { 'prod-1': 'jar' });
    expect(await sheet('csv')).toBe(before);
  });
});

describe('the parcel of an order', () => {
  it('lists the main product first, paid and free together, and marks the add-ons', () => {
    const p = parcelOf(
      parcelRow({
        offer: null,
        items: [
          { productId: 'prod-2', productName: 'ثاني', quantity: 1, freeQuantity: 0, variantSummary: null },
          { productId: 'prod-1', productName: 'أساسي', quantity: 2, freeQuantity: 1, variantSummary: '' },
        ],
        addOns: [{ productId: 'prod-3', productName: 'إضافي', quantity: 2 }],
      }),
      { 'prod-2': 'shoe', 'prod-3': 'tube' }
    );
    expect(p).toEqual({
      offer: null,
      lines: [
        { name: 'أساسي', variant: null, qty: 3, shape: 'generic', main: true },
        { name: 'ثاني', variant: null, qty: 1, shape: 'shoe' },
        { name: 'إضافي', qty: 2, shape: 'tube', addOn: true },
      ],
    });
  });

  it('the saved offer, cleaned, while the main product’s pieces are whole bundles of it', () => {
    expect(parcelOf(parcelRow(), {}).offer).toBe('قطعتين + قطعة هدية');
    // Two bundles, spread over two lines of the same product (two sizes).
    const twice = parcelRow({
      items: [
        { productId: 'prod-1', productName: 'كريم', quantity: 2, freeQuantity: 1, variantSummary: 'S' },
        { productId: 'prod-1', productName: 'كريم', quantity: 2, freeQuantity: 1, variantSummary: 'L' },
      ],
    });
    expect(parcelOf(twice, {}).offer).toBe('قطعتين + قطعة هدية');
    expect(parcelOf(twice, {}).lines.filter((l) => l.main)).toHaveLength(1);
  });

  it('NEGATIVE: no offer, another product’s offer, an edited quantity, or no line of the main product — no ticket', () => {
    expect(parcelOf(parcelRow({ offer: null }), {}).offer).toBeNull();
    expect(parcelOf(parcelRow({ offer: { name: 'عرض', productId: 'prod-9', quantity: 1, freeQuantity: 0 } }), {}).offer).toBeNull();
    const edited = parcelRow({ items: [{ productId: 'prod-1', productName: 'كريم', quantity: 1, freeQuantity: 0, variantSummary: null }] });
    expect(parcelOf(edited, {}).offer).toBeNull();
    const gone = parcelRow({ items: [{ productId: 'prod-2', productName: 'غيره', quantity: 3, freeQuantity: 0, variantSummary: null }] });
    expect(parcelOf(gone, {}).offer).toBeNull();
    expect(parcelOf(gone, {}).lines.some((l) => l.main)).toBe(false);
    expect(parcelOf(parcelRow({ offer: { name: '🔥', productId: 'prod-1', quantity: 3, freeQuantity: 0 } }), {}).offer).toBeNull();
  });

  it('asks for no money and no customer detail', () => {
    const asked = JSON.stringify(PARCEL_SELECT);
    for (const k of ['customer', 'totalAmount', 'sellingPrice', 'unitPrice', 'price', 'phone', 'address', 'Notes']) expect(asked, k).not.toContain(k);
  });
});
