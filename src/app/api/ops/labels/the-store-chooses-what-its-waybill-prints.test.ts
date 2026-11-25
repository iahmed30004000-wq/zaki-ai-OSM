import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * THE PRINT DOOR READS THE STORE'S CHOICE (25/11, F15) — and only its own store's.
 *
 * With nothing chosen the page is the page it was (the renderer's own bytes are pinned against main by
 * `src/lib/label-sheet.main-golden.test.ts`); with a choice, the left-off part is gone from the paper and the CSV for
 * the courier's upload is untouched — it is the courier's file, not the store's look.
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

const A = '11111111-1111-4111-8111-111111111111';
const STORE_LOGO = '/api/public/store-logo/55555555-5555-4555-8555-555555555555/aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee.webp';
const OWN = '/api/media/companies/c1/products/s1/bbbbbbbb-bbbb-4ccc-8ddd-eeeeeeeeeeee.webp';

const order = {
  id: A, orderNumber: 'SY-1111', merchantRef: null, trackingNumber: 'JO7000000123',
  totalAmount: 32.5, currency: 'JOD', confirmationStatus: 'CONFIRMED', shippingStatus: 'READY_FOR_PICKUP',
  shippingBatchId: null, deliveryProviderId: 'p1', regionId: 'r1', priceIncludesDelivery: false,
  labelPrintedAt: null, createdAt: new Date('2026-09-20'), customerNotes: 'اتصل قبل',
  customer: { fullName: 'محمد', phone: '0791234567', rawPhone: '0791234567', altPhone: null, city: 'طرطوس', address: 'طرطوس - بانياس' },
  region: { name: 'طرطوس' }, deliveryProvider: { name: 'LogesTechs' },
  items: [{ productName: 'منتج', quantity: 1, freeQuantity: 0, unitPrice: 20, discountShare: 0 }],
  addOns: [],
};

const stored = (doc: unknown) =>
  db.company.findUnique.mockResolvedValue({ settings: doc === undefined ? null : JSON.stringify({ other: 1, waybillPrint: doc }) });

async function sheet(format?: 'csv') {
  const t = await signLabelBatch({ storeId: 's1', orderIds: [A], width: 100, height: 150 } as never);
  const res = await GET(new Request(`http://localhost/x?t=${t}${format ? '&format=csv' : ''}`));
  expect(res.status).toBe(200);
  // The date in the title and the CSV's file name is the day's; a token differs per call.
  return (await res.text()).replace(/tok[^"]*"|"ey[^"]+"/g, '');
}
const strip = (html: string) => html.replace(/var TOKEN = [^;]+;/, '').replace(/<title>[^<]*<\/title>/, '');

beforeEach(() => {
  vi.clearAllMocks();
  requireContext.mockResolvedValue({ user: { id: 'u1', role: 'WAREHOUSE' }, companyId: 'c1', storeId: 's1', country: { minorUnit: 3, code: 'JO' } });
  db.store.findFirst.mockResolvedValue({ name: 'صحة بلس', logo: STORE_LOGO, supportPhone: '0999000000' });
  db.order.findMany.mockResolvedValue([order]);
  resolveDeliveryFee.mockResolvedValue({ fee: 3, lateThresholdDays: 5, returnFee: 0, source: 'TABLE' });
});

describe('nothing chosen — the page it always was', () => {
  it('no document, a document that hides nothing, another store’s document, and a read that throws all print the same page', async () => {
    stored(undefined);
    const none = strip(await sheet());
    expect(none).toContain(`src="${STORE_LOGO}"`);
    stored({ v: 1, stores: { s1: { hide: [], logo: 'store' } } });
    expect(strip(await sheet())).toBe(none);
    stored({ v: 1, stores: { s2: { hide: ['qr', 'items', 'note'], logo: 'none' } } });
    expect(strip(await sheet())).toBe(none);
    db.company.findUnique.mockRejectedValue(new Error('db down'));
    expect(strip(await sheet())).toBe(none);
  });
});

describe('a choice reaches the paper of its own store', () => {
  it('the QR off: the page has no QR; the barcode, the name, the phone, the address and the COD stay', async () => {
    stored({ v: 1, stores: { s1: { hide: ['qr'], logo: 'store' } } });
    const html = await sheet();
    expect(html).not.toContain('<figure class="qr">');
    for (const m of ['<figure class="barcode">', 'محمد', '0791234567', 'بانياس', 'class="cod"']) expect(html, m).toContain(m);
  });

  it('«شعار خاص» draws the store’s own waybill logo; «بلا شعار» draws none', async () => {
    stored({ v: 1, stores: { s1: { hide: [], logo: 'own', ownLogo: OWN } } });
    expect(await sheet()).toContain(`src="${OWN}"`);
    stored({ v: 1, stores: { s1: { hide: [], logo: 'none' } } });
    expect(await sheet()).not.toContain('class="logo"');
  });

  it('NEGATIVE: the courier’s CSV is the same file whatever the store chose', async () => {
    stored(undefined);
    const before = await sheet('csv');
    stored({ v: 1, stores: { s1: { hide: ['items', 'note', 'qr', 'storeName', 'courierName', 'ref', 'supportPhone'], logo: 'none' } } });
    expect(await sheet('csv')).toBe(before);
  });
});
