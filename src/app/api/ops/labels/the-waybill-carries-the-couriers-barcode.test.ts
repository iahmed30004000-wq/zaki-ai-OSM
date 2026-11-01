import QRCode from 'qrcode';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * «باركود الشحنة و ال QR تبعنا ضروري يظهر بالبوليصة».
 *
 * The label draws a Code128 of the courier's barcode (falling back to our reference) and a QR of our order number.
 * Printed BEFORE the courier answered, a label carried our reference twice and no barcode of theirs, which the courier
 * cannot scan. So for a courier we send to by API, an order with no tracking number is not printed: the door says what
 * to press first and prints the others. A manual courier prints as it always did. These run the REAL `adapterFor`
 * (a stored, encrypted account) behind the door, so «an API courier» means what dispatch means by it.
 */

const { db, requireContext } = vi.hoisted(() => ({
  db: { order: { findMany: vi.fn(), updateMany: vi.fn() }, store: { findFirst: vi.fn() } },
  requireContext: vi.fn(),
}));
vi.mock('@/lib/db', () => ({ db }));
vi.mock('@/lib/geo-context', () => ({ requireContext: (...a: unknown[]) => requireContext(...a) }));
// Everything is allowed except the owner's key (`ops.labels_any`): the barcode rule is what these tests are about.
vi.mock('@/lib/authorization', () => ({ requirePermission: vi.fn(), can: (_u: unknown, key: string) => key !== 'ops.labels_any' }));
vi.mock('@/lib/audit', () => ({ logAudit: vi.fn() }));

process.env.APP_ENCRYPTION_KEY = 'b'.repeat(64);

import { POST as tokenPOST } from '@/app/api/ops/labels/route';
import { GET as printGET } from '@/app/api/ops/labels/print/route';
import { POST as printedPOST } from '@/app/api/ops/labels/printed/route';
import { signLabelBatch } from '@/lib/labels';
import { encryptJson } from '@/lib/secrets';
import { printRefusal, WAITING_FOR_BARCODE } from '@/lib/waybill';

const ids = (n: number) => `${String(n).repeat(8)}-${String(n).repeat(4)}-4${String(n).repeat(3)}-8${String(n).repeat(3)}-${String(n).repeat(12)}`;
const [A, B, C, D] = [1, 2, 3, 4].map(ids);
const BATCH = ids(9);

const account = encryptJson({
  email: 'shop@example.com', password: 'a-real-password', companyId: 744, originCityId: 445053,
  senderName: 'متجر', senderPhone: '0999000000',
});
const BASHA = { name: 'الباشا', code: 'BASHA', adapterCode: 'LOGESTECHS', apiEnabled: true, apiConfig: {}, apiCredentials: account };
const BASHA_SWITCHED_OFF = { ...BASHA, apiEnabled: false };
const BASHA_NO_ACCOUNT = { ...BASHA, apiCredentials: null };
const MANUAL = { name: 'ناقل', code: 'NAQEL', adapterCode: null, apiEnabled: false, apiConfig: null, apiCredentials: null };

/** The columns the door reads to decide. */
const row = (id: string, n: string, trackingNumber: string | null, deliveryProvider: unknown) => ({
  id, orderNumber: n, confirmationStatus: 'CONFIRMED', shippingStatus: 'READY_FOR_PICKUP',
  deliveryProviderId: 'p1', trackingNumber, deliveryProvider,
});

const json = (body: unknown) =>
  new Request('http://localhost/x', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

beforeEach(() => {
  vi.clearAllMocks();
  requireContext.mockResolvedValue({
    user: { id: 'u1', role: 'WAREHOUSE' }, companyId: 'c1', storeId: 's1', country: { minorUnit: 0, currencyCode: 'SYP' },
  });
  db.store.findFirst.mockResolvedValue({ name: 'متجر', logo: null, supportPhone: null });
  db.order.updateMany.mockResolvedValue({ count: 0 });
});

describe('printRefusal: an API courier owes a barcode', () => {
  const base = { confirmationStatus: 'CONFIRMED', shippingStatus: 'READY_FOR_PICKUP', deliveryProviderId: 'p1' };
  it('refuses an API order with no tracking number, with the sentence', () => {
    expect(printRefusal({ ...base, trackingNumber: null, deliveryProvider: BASHA })).toBe(WAITING_FOR_BARCODE);
    expect(WAITING_FOR_BARCODE).toBe('رحّل الطلب للشركة أول، عشان يطلع باركود الشحنة على البوليصة');
  });
  it('NEGATIVE: lets through an API order that has its barcode', () => {
    expect(printRefusal({ ...base, trackingNumber: 'KSA100422577363', deliveryProvider: BASHA })).toBeNull();
  });
  it('NEGATIVE: a manual courier, a switched-off one and one with no account never owed a barcode', () => {
    for (const p of [MANUAL, BASHA_SWITCHED_OFF, BASHA_NO_ACCOUNT]) {
      expect(printRefusal({ ...base, trackingNumber: null, deliveryProvider: p }), String(p.code)).toBeNull();
    }
  });
  it('NEGATIVE: the older rules keep their own sentences first', () => {
    expect(printRefusal({ ...base, confirmationStatus: 'NEW', trackingNumber: null, deliveryProvider: BASHA })).toBe('لم يُؤكَّد');
    expect(printRefusal({ ...base, deliveryProviderId: null, trackingNumber: null, deliveryProvider: null })).toBe('بلا شركة شحن');
  });
});

describe('POST /api/ops/labels: the others print, this one waits', () => {
  it('a mixed batch: the API order with no barcode is named and kept out; the sent, manual and switched-off ones print', async () => {
    db.order.findMany.mockResolvedValue([
      row(A, 'ORD-A', null, BASHA),
      row(B, 'ORD-B', 'KSA100422577363', BASHA),
      row(C, 'ORD-C', null, MANUAL),
      row(D, 'ORD-D', null, BASHA_SWITCHED_OFF),
    ]);
    const res = await tokenPOST(json({ batchId: BATCH, width: 100, height: 150 }));
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.count).toBe(3);
    expect(body.refused).toEqual([{ orderNumber: 'ORD-A', reason: WAITING_FOR_BARCODE }]);
  });

  it('every order waiting: nothing prints, and the sentence is the answer, not «لا يُطبع إلا طلب مؤكَّد»', async () => {
    db.order.findMany.mockResolvedValue([row(A, 'ORD-A', null, BASHA), row(B, 'ORD-B', null, BASHA)]);
    const res = await tokenPOST(json({ batchId: BATCH, width: 100, height: 150 }));
    const body = await res.json();
    expect(res.status).toBe(409);
    expect(body.code).toBe('NOTHING_PRINTABLE');
    expect(body.error).toBe(WAITING_FOR_BARCODE);
    expect(body.refused).toHaveLength(2);
  });

  it('nothing printable for another reason: the sentence states no rule — the reason is in the list, one per order', async () => {
    // The old sentence was «لا يُطبع إلا طلب مؤكَّد له شركة شحن», and it was said over an order that WAS confirmed and HAD a courier.
    db.order.findMany.mockResolvedValue([{ ...row(A, 'ORD-A', 'K1', BASHA), confirmationStatus: 'NEW' }]);
    const res = await tokenPOST(json({ orderIds: [A], width: 100, height: 150 }));
    const body = await res.json();
    expect(body.error).toBe('ما انطبع ولا طلب');
    expect(body.refused).toEqual([{ orderNumber: 'ORD-A', reason: 'لم يُؤكَّد' }]);
  });

  it('the account is read to decide, and never comes back out', async () => {
    db.order.findMany.mockResolvedValue([row(A, 'ORD-A', null, BASHA)]);
    const text = await (await tokenPOST(json({ batchId: BATCH, width: 100, height: 150 }))).text();
    expect(text).not.toContain('a-real-password');
    expect(text).not.toContain(account);
  });
});

describe('the sheet of a dispatched order carries both codes', () => {
  const full = (id: string, tracking: string | null, ref: string) => ({
    id, orderNumber: ref, merchantRef: ref, trackingNumber: tracking, totalAmount: 60000, currency: 'SYP',
    confirmationStatus: 'CONFIRMED', shippingStatus: 'READY_FOR_PICKUP', shippingBatchId: BATCH, deliveryProviderId: 'p1',
    regionId: 'r1', priceIncludesDelivery: false, labelPrintedAt: null, createdAt: new Date('2026-10-20'), customerNotes: null,
    customer: { fullName: 'محمد', phone: '0990123456', rawPhone: '0990123456', altPhone: null, city: 'دمشق', address: 'دمشق - شارع' },
    region: { name: 'دمشق' }, deliveryProvider: BASHA,
    items: [{ productName: 'منتج', quantity: 1, freeQuantity: 0, unitPrice: 60000, discountShare: 0 }], addOns: [],
  });
  const tokenFor = (orderIds: string[]) => signLabelBatch({ storeId: 's1', orderIds, width: 100, height: 150 } as never);
  const qrOf = (v: string) => QRCode.toString(v, { type: 'svg', errorCorrectionLevel: 'M', margin: 4 });

  it('Code128 holds the courier’s barcode and the QR holds our order number', async () => {
    db.order.findMany.mockResolvedValue([full(A, 'KSA100422577363', 'ORD-2026-0004')]);
    const html = await (await printGET(new Request(`http://localhost/x?t=${await tokenFor([A])}`))).text();

    const barcode = html.match(/<figure class="barcode">([\s\S]*?)<\/figure>/)![1];
    expect(barcode).toContain('aria-label="KSA100422577363"');
    expect(barcode).toContain('<figcaption dir="ltr">KSA100422577363</figcaption>');
    expect(barcode).not.toContain('ORD-2026-0004');

    const qr = html.match(/<figure class="qr">([\s\S]*?)<\/figure>/)![1];
    expect(qr).toContain(await qrOf('ORD-2026-0004'));
    expect(qr).not.toContain(await qrOf('KSA100422577363'));
    expect(qr).toContain('<figcaption dir="ltr">ORD-2026-0004</figcaption>');
  });

  it('an API order with no barcode never reaches the sheet, since it would have printed our reference twice', async () => {
    db.order.findMany.mockResolvedValue([full(A, null, 'ORD-2026-0004'), full(B, 'KSA100422577363', 'ORD-2026-0005')]);
    const html = await (await printGET(new Request(`http://localhost/x?t=${await tokenFor([A, B])}`))).text();
    expect(html).not.toContain(`data-order="${A}"`);
    expect(html).toContain(`data-order="${B}"`);
    // And the sheet says which one was left out and why.
    expect(html).toContain(WAITING_FOR_BARCODE);
  });

  it('a manual courier prints as before: its reference stands in the barcode row', async () => {
    db.order.findMany.mockResolvedValue([{ ...full(C, null, 'ORD-2026-0006'), deliveryProvider: MANUAL }]);
    const html = await (await printGET(new Request(`http://localhost/x?t=${await tokenFor([C])}`))).text();
    expect(html).toContain(`data-order="${C}"`);
    expect(html.match(/<figure class="barcode">([\s\S]*?)<\/figure>/)![1]).toContain('ORD-2026-0006');
  });

  it('a waiting order is never stamped printed', async () => {
    db.order.findMany.mockResolvedValue([row(A, 'ORD-A', null, BASHA)]);
    const res = await printedPOST(json({ t: await tokenFor([A]), orderIds: [A] }));
    expect((await res.json()).stamped).toBe(0);
    expect(db.order.updateMany).not.toHaveBeenCalled();
  });

  it('a sent order is stamped printed, as before', async () => {
    db.order.findMany.mockResolvedValue([row(A, 'ORD-A', 'KSA1', BASHA)]);
    db.order.updateMany.mockResolvedValue({ count: 1 });
    const res = await printedPOST(json({ t: await tokenFor([A]), orderIds: [A] }));
    expect((await res.json()).stamped).toBe(1);
  });
});
