import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * THE WAYBILL ROUTES.
 *
 * Three promises, each with its negative test:
 *   only a confirmed order with a courier gets a label;
 *   opening, reloading or downloading commits nothing — only printing does;
 *   the amount printed is the amount the courier will collect.
 */

const { db, requireContext, resolveDeliveryFee } = vi.hoisted(() => ({
  db: {
    order: { findMany: vi.fn(), updateMany: vi.fn() },
    store: { findFirst: vi.fn() },
  },
  requireContext: vi.fn(),
  resolveDeliveryFee: vi.fn(),
}));

vi.mock('@/lib/db', () => ({ db }));
vi.mock('@/lib/geo-context', () => ({ requireContext: (...a: unknown[]) => requireContext(...a) }));
// Everything is allowed except the owner's key (`ops.labels_any`): «who gets a label» is asked of somebody who does not hold it.
vi.mock('@/lib/authorization', () => ({ requirePermission: vi.fn(), can: (_u: unknown, key: string) => key !== 'ops.labels_any' }));
vi.mock('@/lib/delivery-fees', async (orig) => ({
  ...(await orig<typeof import('@/lib/delivery-fees')>()),
  resolveDeliveryFee: (...a: unknown[]) => resolveDeliveryFee(...a),
}));

import { POST as tokenPOST } from '@/app/api/ops/labels/route';
import { GET as printGET } from '@/app/api/ops/labels/print/route';
import { POST as printedPOST } from '@/app/api/ops/labels/printed/route';
import { signLabelBatch } from '@/lib/labels';

const A = '11111111-1111-4111-8111-111111111111';
const B = '22222222-2222-4222-8222-222222222222';
const C = '33333333-3333-4333-8333-333333333333';
const BATCH = '44444444-4444-4444-8444-444444444444';

const order = (id: string, over: Record<string, unknown> = {}) => ({
  id, orderNumber: `SY-${id.slice(0, 4)}`, merchantRef: null, trackingNumber: 'JO7000000123',
  totalAmount: 32.5, currency: 'JOD', confirmationStatus: 'CONFIRMED', shippingStatus: 'READY_FOR_PICKUP',
  shippingBatchId: BATCH, deliveryProviderId: 'p1', regionId: 'r1', priceIncludesDelivery: false,
  labelPrintedAt: null, createdAt: new Date('2026-09-20'), customerNotes: null,
  customer: { fullName: 'محمد', phone: '0791234567', rawPhone: '0791234567', altPhone: null, city: 'طرطوس', address: 'طرطوس - طرطوس بانياس' },
  region: { name: 'طرطوس' }, deliveryProvider: { name: 'LogesTechs' },
  items: [{ productName: 'منتج', quantity: 1, freeQuantity: 0, unitPrice: 20, discountShare: 0 }],
  addOns: [],
  ...over,
});

const json = (body: unknown) =>
  new Request('http://localhost/x', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

const tokenFor = (over: Record<string, unknown> = {}) =>
  signLabelBatch({ storeId: 's1', orderIds: [A, B], width: 100, height: 150, ...over } as never);

beforeEach(() => {
  vi.clearAllMocks();
  requireContext.mockResolvedValue({
    user: { id: 'u1', role: 'WAREHOUSE' },
    companyId: 'c1', storeId: 's1',
    country: { minorUnit: 3, currencyCode: 'JOD' },
  });
  db.store.findFirst.mockResolvedValue({ name: 'صحة بلس', logo: null, supportPhone: '0999000000' });
  db.order.updateMany.mockResolvedValue({ count: 0 });
  resolveDeliveryFee.mockResolvedValue({ fee: 3, lateThresholdDays: 5, returnFee: 0, source: 'TABLE' });
});

describe('POST /api/ops/labels — who gets a label', () => {
  it('names the orders it will not print, and why, and keeps them out of the token', async () => {
    db.order.findMany.mockResolvedValue([
      { id: A, orderNumber: 'SY-A', confirmationStatus: 'CONFIRMED', shippingStatus: 'READY_FOR_PICKUP', deliveryProviderId: 'p1' },
      { id: B, orderNumber: 'SY-B', confirmationStatus: 'NEW', shippingStatus: 'NOT_READY', deliveryProviderId: 'p1' },
      { id: C, orderNumber: 'SY-C', confirmationStatus: 'CONFIRMED', shippingStatus: 'NOT_READY', deliveryProviderId: null },
    ]);
    const res = await tokenPOST(json({ orderIds: [C, B, A], width: 100, height: 150 }));
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.count).toBe(1);
    expect(body.refused).toEqual([
      { orderNumber: 'SY-B', reason: 'لم يُؤكَّد' },
      { orderNumber: 'SY-C', reason: 'بلا شركة شحن' },
    ]);
    expect(body.pdfPath).toContain('mode=pdf');
  });

  it('refuses outright when nothing can be printed — an unconfirmed order never gets a label', async () => {
    db.order.findMany.mockResolvedValue([
      { id: A, orderNumber: 'SY-A', confirmationStatus: 'NEW', shippingStatus: 'NOT_READY', deliveryProviderId: 'p1' },
    ]);
    const res = await tokenPOST(json({ orderIds: [A], width: 100, height: 150 }));
    expect(res.status).toBe(409);
    expect((await res.json()).code).toBe('NOTHING_PRINTABLE');
  });

  it('prints a whole batch by its id, whatever its size', async () => {
    db.order.findMany.mockResolvedValue([
      { id: A, orderNumber: 'SY-A', confirmationStatus: 'CONFIRMED', shippingStatus: 'READY_FOR_PICKUP', deliveryProviderId: 'p1' },
    ]);
    const res = await tokenPOST(json({ batchId: BATCH, width: 100, height: 150 }));
    expect(res.status).toBe(200);
    expect(db.order.findMany.mock.calls[0][0].where).toMatchObject({ shippingBatchId: BATCH, companyId: 'c1', storeId: 's1' });
  });
});

describe('GET /api/ops/labels/print — reading commits nothing', () => {
  it('does not stamp a single order when the sheet is opened', async () => {
    // The old route stamped labelPrintedAt on every request, sealing orders
    // that were only previewed.
    db.order.findMany.mockResolvedValue([order(A), order(B)]);
    const res = await printGET(new Request(`http://localhost/x?t=${await tokenFor()}`));
    expect(res.status).toBe(200);
    expect(db.order.updateMany).not.toHaveBeenCalled();
  });

  it('does not stamp on a CSV download either', async () => {
    db.order.findMany.mockResolvedValue([order(A)]);
    await printGET(new Request(`http://localhost/x?t=${await tokenFor()}&format=csv`));
    expect(db.order.updateMany).not.toHaveBeenCalled();
  });

  it('prints in the order the orders were chosen, not the database’s', async () => {
    db.order.findMany.mockResolvedValue([order(B), order(A)]);
    const html = await (await printGET(new Request(`http://localhost/x?t=${await tokenFor()}`))).text();
    expect(html.indexOf(`data-order="${A}"`)).toBeLessThan(html.indexOf(`data-order="${B}"`));
  });

  it('prints the snapshot amount of a batched order with the currency’s decimals', async () => {
    db.order.findMany.mockResolvedValue([order(A)]);
    const html = await (await printGET(new Request(`http://localhost/x?t=${await tokenFor({ orderIds: [A] })}`))).text();
    expect(html).toContain('32.500 JOD');
    expect(html).not.toContain('>32.5 JOD<');
  });

  it('computes the amount an unbatched order WILL collect — add-ons and fee included', async () => {
    db.order.findMany.mockResolvedValue([
      order(A, { shippingBatchId: null, totalAmount: 20, addOns: [{ productName: 'مقشر', quantity: 1, price: 12 }] }),
    ]);
    const html = await (await printGET(new Request(`http://localhost/x?t=${await tokenFor({ orderIds: [A] })}`))).text();
    expect(html).toContain('35.000 JOD'); // 20 + 12 + fee 3
    expect(html).toContain('مقشر');
  });

  it('prints the governorate once', async () => {
    db.order.findMany.mockResolvedValue([order(A)]);
    const html = await (await printGET(new Request(`http://localhost/x?t=${await tokenFor({ orderIds: [A] })}`))).text();
    expect(html).toContain('طرطوس — بانياس');
    expect(html).not.toContain('طرطوس - طرطوس');
  });

  it('leaves an unconfirmed order off the sheet and says so', async () => {
    db.order.findMany.mockResolvedValue([order(A), order(B, { confirmationStatus: 'CANCELLED' })]);
    const html = await (await printGET(new Request(`http://localhost/x?t=${await tokenFor()}`))).text();
    expect(html).not.toContain(`data-order="${B}"`);
    expect(html).toContain('لم يُؤكَّد');
  });

  it('draws the store’s own logo, and never one from another host', async () => {
    db.order.findMany.mockResolvedValue([order(A)]);
    db.store.findFirst.mockResolvedValue({ name: 'صحة بلس', logo: 'https://cdn.example/logo.png', supportPhone: null });
    const outside = await (await printGET(new Request(`http://localhost/x?t=${await tokenFor({ orderIds: [A] })}`))).text();
    expect(outside).not.toContain('cdn.example');

    db.store.findFirst.mockResolvedValue({ name: 'صحة بلس', logo: '/api/public/store-logo/s1/a.webp', supportPhone: null });
    const own = await (await printGET(new Request(`http://localhost/x?t=${await tokenFor({ orderIds: [A] })}`))).text();
    expect(own).toContain('/api/public/store-logo/s1/a.webp');
  });

  it('refuses a token from another store', async () => {
    const t = await signLabelBatch({ storeId: 'other', orderIds: [A], width: 100, height: 150 });
    expect((await printGET(new Request(`http://localhost/x?t=${t}`))).status).toBe(403);
  });

  it('keeps a customer-typed formula from running in the CSV, and a phone number intact', async () => {
    db.order.findMany.mockResolvedValue([
      order(A, { customer: { ...order(A).customer, fullName: '=HYPERLINK("http://x","y")', rawPhone: '+962791234567' } }),
    ]);
    const csv = await (await printGET(new Request(`http://localhost/x?t=${await tokenFor({ orderIds: [A] })}&format=csv`))).text();
    expect(csv).toContain(`"'=HYPERLINK`);
    expect(csv).toContain('"+962791234567"');
    expect(csv).toContain('"32.500"');
  });
});

describe('POST /api/ops/labels/printed — only printing commits', () => {
  it('stamps the printed orders the token names, first print only', async () => {
    db.order.findMany.mockResolvedValue([
      { id: A, confirmationStatus: 'CONFIRMED', shippingStatus: 'READY_FOR_PICKUP', deliveryProviderId: 'p1' },
    ]);
    db.order.updateMany.mockResolvedValue({ count: 1 });
    const res = await printedPOST(json({ t: await tokenFor(), orderIds: [A] }));
    expect((await res.json()).stamped).toBe(1);
    expect(db.order.updateMany).toHaveBeenCalledWith({
      where: { id: { in: [A] }, companyId: 'c1', storeId: 's1', labelPrintedAt: null },
      data: { labelPrintedAt: expect.any(Date) },
    });
  });

  it('ignores an id the token does not name — it cannot seal an order somebody merely knows', async () => {
    const res = await printedPOST(json({ t: await tokenFor(), orderIds: [C] }));
    expect((await res.json()).stamped).toBe(0);
    expect(db.order.findMany).not.toHaveBeenCalled();
    expect(db.order.updateMany).not.toHaveBeenCalled();
  });

  it('never stamps an order that may not be printed', async () => {
    db.order.findMany.mockResolvedValue([
      { id: A, confirmationStatus: 'NEW', shippingStatus: 'NOT_READY', deliveryProviderId: 'p1' },
    ]);
    await printedPOST(json({ t: await tokenFor(), orderIds: [A] }));
    expect(db.order.updateMany).not.toHaveBeenCalled();
  });

  it('keeps a batch token to its own batch', async () => {
    db.order.findMany.mockResolvedValue([]);
    const t = await signLabelBatch({ storeId: 's1', orderIds: [], batchId: BATCH, width: 100, height: 150 });
    await printedPOST(json({ t, orderIds: [C] }));
    expect(db.order.findMany.mock.calls[0][0].where).toMatchObject({ shippingBatchId: BATCH });
  });

  it('refuses a token from another store', async () => {
    const t = await signLabelBatch({ storeId: 'other', orderIds: [A], width: 100, height: 150 });
    expect((await printedPOST(json({ t, orderIds: [A] }))).status).toBe(403);
  });
});
