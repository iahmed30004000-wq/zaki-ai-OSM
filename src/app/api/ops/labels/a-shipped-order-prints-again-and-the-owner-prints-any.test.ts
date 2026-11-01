import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * ═══════════════════════════════════════════════════════════════════════
 * DEFINITION OF DONE — «الطلب المشحون ينطبع، وعند المالك بكل الأحوال» (the owner, 1/11)
 *
 * His words, over the dialog «لا يُطبع إلا طلب مؤكَّد له شركة شحن — ORD-2026-0001 (مُغلق)»: «هاي قاعدة غلط، الطلب المشحون افرض
 * انطبع. ع كل حال لازم تظبط القاعدة. وعند المالك بقدر يطبع بكل الأحوال».
 *
 *  1. An order whose parcel has gone — delivered, partly delivered, returned — prints a waybill again (a torn label, the courier's
 *     request). It was refused as «مُغلق», under a sentence that was untrue of it: it WAS confirmed and HAD a courier. A cancelled
 *     shipment is still refused («مُلغى»), and so are an unconfirmed order, one with no courier, and one waiting for its courier's
 *     barcode — for everybody who does not hold the owner's key.
 *  2. That print is a COPY: it stamps nothing (`labelPrintedAt` seals the order and turns a cancellation into a return). Only a print
 *     the rule allows, of a parcel still to go, commits.
 *  3. `ops.labels_any` — the owner's key (full access holds it; nobody else unless he ticks it) — prints any order in any state. It
 *     is asked of the SESSION at the token door and again at the sheet; the token carries no person. What it printed past the rule
 *     is said back (`outsideTheRule`) and above the sheet, never on paper, and none of it is stamped.
 *  4. Every copy is still counted: the audit row of a print says how many were stamped and how many were copies.
 *  5. The dialog never states a rule of its own: when nothing could be printed it says so, and the reasons are one per order.
 *
 * Blockers: no money (the amount on a label is the same `waybillCod`), no order creation, no contract (`outsideTheRule` is a new key).
 * ═══════════════════════════════════════════════════════════════════════
 */

const { db, requireContext, grants, logAudit } = vi.hoisted(() => ({
  db: { order: { findMany: vi.fn(), updateMany: vi.fn() }, store: { findFirst: vi.fn() } },
  requireContext: vi.fn(),
  grants: { labelsAny: false },
  logAudit: vi.fn(),
}));
vi.mock('@/lib/db', () => ({ db }));
vi.mock('@/lib/geo-context', () => ({ requireContext: (...a: unknown[]) => requireContext(...a) }));
vi.mock('@/lib/authorization', () => ({
  requirePermission: vi.fn(),
  // Everything is allowed except the owner's key, which a test turns on when it is the subject.
  can: (_u: unknown, key: string) => (key === 'ops.labels_any' ? grants.labelsAny : true),
}));
vi.mock('@/lib/audit', () => ({ logAudit: (...a: unknown[]) => logAudit(...a) }));

process.env.APP_ENCRYPTION_KEY = 'b'.repeat(64);

import { POST as tokenPOST } from '@/app/api/ops/labels/route';
import { GET as printGET } from '@/app/api/ops/labels/print/route';
import { POST as printedPOST } from '@/app/api/ops/labels/printed/route';
import { signLabelBatch } from '@/lib/labels';
import { encryptJson } from '@/lib/secrets';
import { printRefusal, sealsOnPrint, WAITING_FOR_BARCODE } from '@/lib/waybill';

const ids = (n: number) => `${String(n).repeat(8)}-${String(n).repeat(4)}-4${String(n).repeat(3)}-8${String(n).repeat(3)}-${String(n).repeat(12)}`;
const [A, B, C, D, E] = [1, 2, 3, 4, 5].map(ids);
const BATCH = ids(9);

const account = encryptJson({
  email: 'shop@example.com', password: 'a-real-password', companyId: 744, originCityId: 445053,
  senderName: 'متجر', senderPhone: '0999000000',
});
const BASHA = { name: 'الباشا', code: 'BASHA', adapterCode: 'LOGESTECHS', apiEnabled: true, apiConfig: {}, apiCredentials: account };
const MANUAL = { name: 'ناقل', code: 'NAQEL', adapterCode: null, apiEnabled: false, apiConfig: null, apiCredentials: null };

/** The columns the doors read to decide. */
const decide = (id: string, orderNumber: string, over: Record<string, unknown> = {}) => ({
  id, orderNumber, confirmationStatus: 'CONFIRMED', shippingStatus: 'READY_FOR_PICKUP',
  deliveryProviderId: 'p1', trackingNumber: 'K1', deliveryProvider: MANUAL, ...over,
});

/** The columns a label is drawn from. */
const full = (id: string, orderNumber: string, over: Record<string, unknown> = {}) => ({
  id, orderNumber, merchantRef: orderNumber, trackingNumber: 'K1', totalAmount: 40, currency: 'JOD',
  confirmationStatus: 'CONFIRMED', shippingStatus: 'READY_FOR_PICKUP', shippingBatchId: BATCH, deliveryProviderId: 'p1',
  regionId: 'r1', priceIncludesDelivery: false, labelPrintedAt: null, createdAt: new Date('2026-10-20'), customerNotes: null,
  customer: { fullName: 'محمد', phone: '0791234567', rawPhone: '0791234567', altPhone: null, city: 'عمّان', address: 'عمّان - شارع' },
  region: { name: 'عمّان' }, deliveryProvider: MANUAL,
  items: [{ productName: 'منتج', quantity: 1, freeQuantity: 0, unitPrice: 40, discountShare: 0 }], addOns: [],
  ...over,
});

const json = (body: unknown) =>
  new Request('http://localhost/x', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
const tokenFor = (orderIds: string[]) => signLabelBatch({ storeId: 's1', orderIds, width: 100, height: 150 } as never);
const sheet = async (orderIds: string[]) => (await printGET(new Request(`http://localhost/x?t=${await tokenFor(orderIds)}`))).text();

beforeEach(() => {
  vi.clearAllMocks();
  grants.labelsAny = false;
  requireContext.mockResolvedValue({
    user: { id: 'u1', role: 'WAREHOUSE' }, companyId: 'c1', storeId: 's1', country: { minorUnit: 3, currencyCode: 'JOD', code: 'JO' },
  });
  db.store.findFirst.mockResolvedValue({ name: 'متجر', logo: null, supportPhone: null });
  db.order.updateMany.mockResolvedValue({ count: 1 });
});

describe('the rule — an order whose parcel has gone prints a waybill again', () => {
  const base = { confirmationStatus: 'CONFIRMED', deliveryProviderId: 'p1', trackingNumber: null, deliveryProvider: MANUAL };

  it('delivered, partly delivered and returned are no longer «مُغلق»', () => {
    for (const shippingStatus of ['DELIVERED', 'PARTIALLY_DELIVERED', 'RETURNED']) {
      expect(printRefusal({ ...base, shippingStatus }), shippingStatus).toBeNull();
    }
  });

  it('a shipped or out-for-delivery parcel printed before and still does', () => {
    for (const shippingStatus of ['READY_FOR_PICKUP', 'SHIPPED', 'OUT_FOR_DELIVERY']) {
      expect(printRefusal({ ...base, shippingStatus }), shippingStatus).toBeNull();
    }
  });

  it('NEGATIVE: a cancelled shipment is still refused, in its own words', () => {
    expect(printRefusal({ ...base, shippingStatus: 'CANCELLED' })).toBe('مُلغى');
  });

  it('NEGATIVE: an unconfirmed order and one with no courier are still refused, even when over', () => {
    expect(printRefusal({ ...base, shippingStatus: 'DELIVERED', confirmationStatus: 'NEW' })).toBe('لم يُؤكَّد');
    expect(printRefusal({ ...base, shippingStatus: 'DELIVERED', deliveryProviderId: null, deliveryProvider: null })).toBe('بلا شركة شحن');
  });

  it('an order that is over never waits for a courier’s barcode — there is no scan left; a parcel still to go does', () => {
    const waiting = { ...base, deliveryProvider: BASHA, trackingNumber: null };
    expect(printRefusal({ ...waiting, shippingStatus: 'DELIVERED' })).toBeNull();
    expect(printRefusal({ ...waiting, shippingStatus: 'RETURNED' })).toBeNull();
    expect(printRefusal({ ...waiting, shippingStatus: 'READY_FOR_PICKUP' })).toBe(WAITING_FOR_BARCODE);
  });
});

describe('a print commits only when the parcel is still to go and the rule allowed it', () => {
  const live = { confirmationStatus: 'CONFIRMED', shippingStatus: 'READY_FOR_PICKUP', deliveryProviderId: 'p1', trackingNumber: 'K1', deliveryProvider: MANUAL };

  it('a live parcel seals, as it always did', () => {
    expect(sealsOnPrint(live)).toBe(true);
  });

  it('NEGATIVE: a copy of a delivered or returned order seals nothing', () => {
    expect(sealsOnPrint({ ...live, shippingStatus: 'DELIVERED' })).toBe(false);
    expect(sealsOnPrint({ ...live, shippingStatus: 'RETURNED' })).toBe(false);
  });

  it('NEGATIVE: what the rule would refuse never seals, whoever printed it', () => {
    expect(sealsOnPrint({ ...live, confirmationStatus: 'NEW' })).toBe(false);
    expect(sealsOnPrint({ ...live, deliveryProviderId: null, deliveryProvider: null })).toBe(false);
    expect(sealsOnPrint({ ...live, shippingStatus: 'CANCELLED' })).toBe(false);
  });
});

describe('the token door — the owner’s own screenshot', () => {
  it('ORD-2026-0001, delivered, with a courier: the batch prints (it used to answer «مُغلق»)', async () => {
    db.order.findMany.mockResolvedValue([decide(A, 'ORD-2026-0001', { shippingStatus: 'DELIVERED' })]);
    const res = await tokenPOST(json({ batchId: BATCH, width: 150, height: 100 }));
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.count).toBe(1);
    expect(body.refused).toEqual([]);
    expect(body.outsideTheRule).toEqual([]);
  });

  it('NEGATIVE: nothing printable says so and states no rule — the reason is in the list', async () => {
    db.order.findMany.mockResolvedValue([decide(A, 'ORD-2026-0002', { shippingStatus: 'CANCELLED' })]);
    const res = await tokenPOST(json({ orderIds: [A], width: 100, height: 150 }));
    const body = await res.json();
    expect(res.status).toBe(409);
    expect(body.code).toBe('NOTHING_PRINTABLE');
    expect(body.error).toBe('ما انطبع ولا طلب');
    expect(body.error).not.toContain('لا يُطبع إلا');
    expect(body.refused).toEqual([{ orderNumber: 'ORD-2026-0002', reason: 'مُلغى' }]);
  });
});

describe('the owner’s key — any order, in any state', () => {
  const four = () => [
    decide(A, 'ORD-NEW', { confirmationStatus: 'NEW', shippingStatus: 'NOT_READY' }),
    decide(B, 'ORD-NOCOURIER', { deliveryProviderId: null, deliveryProvider: null, trackingNumber: null }),
    decide(C, 'ORD-WAITING', { deliveryProvider: BASHA, trackingNumber: null }),
    decide(D, 'ORD-CANCELLED', { shippingStatus: 'CANCELLED' }),
  ];

  it('prints all four past the rule, and says which rule each one was past', async () => {
    grants.labelsAny = true;
    db.order.findMany.mockResolvedValue(four());
    const res = await tokenPOST(json({ orderIds: [A, B, C, D], width: 100, height: 150 }));
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.count).toBe(4);
    expect(body.refused).toEqual([]);
    expect(body.outsideTheRule).toEqual([
      { orderNumber: 'ORD-NEW', reason: 'لم يُؤكَّد' },
      { orderNumber: 'ORD-NOCOURIER', reason: 'بلا شركة شحن' },
      { orderNumber: 'ORD-WAITING', reason: WAITING_FOR_BARCODE },
      { orderNumber: 'ORD-CANCELLED', reason: 'مُلغى' },
    ]);
  });

  it('NEGATIVE: the same four, asked by somebody without the key, all stay out and the answer is a refusal', async () => {
    db.order.findMany.mockResolvedValue(four());
    const res = await tokenPOST(json({ orderIds: [A, B, C, D], width: 100, height: 150 }));
    expect(res.status).toBe(409);
    expect((await res.json()).refused.map((r: { orderNumber: string }) => r.orderNumber)).toEqual([
      'ORD-NEW', 'ORD-NOCOURIER', 'ORD-WAITING', 'ORD-CANCELLED',
    ]);
  });

  it('a whole batch goes by its id, for the owner too — including the parcels that were never sent to the courier', async () => {
    grants.labelsAny = true;
    db.order.findMany.mockResolvedValue([
      decide(A, 'ORD-1', { deliveryProvider: BASHA, trackingNumber: null }),
      decide(B, 'ORD-2', { deliveryProvider: BASHA, trackingNumber: null }),
    ]);
    const body = await (await tokenPOST(json({ batchId: BATCH, width: 150, height: 100 }))).json();
    expect(body.count).toBe(2);
    expect(body.outsideTheRule).toHaveLength(2);
  });

  it('the sheet carries every label and says above them which orders it printed past the rule', async () => {
    grants.labelsAny = true;
    db.order.findMany.mockResolvedValue([
      full(A, 'ORD-NEW', { confirmationStatus: 'NEW', shippingStatus: 'NOT_READY' }),
      full(B, 'ORD-NOCOURIER', { deliveryProviderId: null, deliveryProvider: null, trackingNumber: null }),
      full(C, 'ORD-WAITING', { deliveryProvider: BASHA, trackingNumber: null }),
    ]);
    const html = await sheet([A, B, C]);
    for (const id of [A, B, C]) expect(html).toContain(`data-order="${id}"`);
    const banner = html.match(/<div class="outside">([\s\S]*?)<\/div>/)![1];
    expect(banner).toContain('ORD-NEW (لم يُؤكَّد)');
    expect(banner).toContain('ORD-NOCOURIER (بلا شركة شحن)');
    expect(banner).toContain('ORD-WAITING');
    expect(banner).toContain('ما بتنسجّل مطبوعة');
    // above the labels and off the paper
    expect(html).toContain('.bar, .skipped, .outside { display: none; }');
    expect(html).not.toMatch(/class="skipped"/);
  });

  it('NEGATIVE: a token made by the owner and opened by somebody without the key — the key is the session’s, not the token’s', async () => {
    db.order.findMany.mockResolvedValue([full(A, 'ORD-NEW', { confirmationStatus: 'NEW', shippingStatus: 'NOT_READY' }), full(B, 'ORD-OK')]);
    const html = await sheet([A, B]);
    expect(html).not.toContain(`data-order="${A}"`);
    expect(html).toContain(`data-order="${B}"`);
    expect(html).toContain('لم تُطبع 1: ORD-NEW (لم يُؤكَّد)');
    expect(html).not.toMatch(/class="outside"/);
  });

  it('a sheet with nothing past the rule has no such banner (the owner printing an ordinary order)', async () => {
    grants.labelsAny = true;
    db.order.findMany.mockResolvedValue([full(A, 'ORD-OK')]);
    const html = await sheet([A]);
    expect(html).toContain(`data-order="${A}"`);
    expect(html).not.toMatch(/class="outside"/);
  });
});

describe('what printing commits — and what it only counts', () => {
  const tell = async (rows: unknown[], orderIds: string[]) => {
    db.order.findMany.mockResolvedValue(rows);
    return (await printedPOST(json({ t: await tokenFor(orderIds), orderIds }))).json();
  };
  const audited = () => logAudit.mock.calls.map((c) => c[0]).filter((a) => a.action === 'LABELS_PRINTED');

  it('a live parcel is stamped, as before, and counted as printed', async () => {
    const out = await tell([decide(A, 'ORD-OK')], [A]);
    expect(out.stamped).toBe(1);
    expect(db.order.updateMany).toHaveBeenCalledTimes(1);
    expect(audited()[0].newData).toMatchObject({ printed: 1, copies: 0 });
  });

  it('a copy of a delivered order stamps nothing — and is still counted in the audit row', async () => {
    const out = await tell([decide(A, 'ORD-2026-0001', { shippingStatus: 'DELIVERED' })], [A]);
    expect(out.stamped).toBe(0);
    expect(db.order.updateMany).not.toHaveBeenCalled();
    expect(audited()).toHaveLength(1);
    expect(audited()[0].newData).toMatchObject({ printed: 0, copies: 1 });
  });

  it('what the owner’s key printed past the rule stamps nothing: an unconfirmed order is not sealed by a sheet of paper', async () => {
    grants.labelsAny = true;
    const out = await tell(
      [decide(A, 'ORD-NEW', { confirmationStatus: 'NEW', shippingStatus: 'NOT_READY' }), decide(B, 'ORD-OK')],
      [A, B]
    );
    expect(out.stamped).toBe(1);
    expect(db.order.updateMany.mock.calls[0][0].where.id).toEqual({ in: [B] });
    expect(audited()[0].newData).toMatchObject({ printed: 1, copies: 1 });
  });

  it('NEGATIVE: somebody without the key reporting an order the rule refuses is ignored altogether — no stamp, no audit row', async () => {
    const out = await tell([decide(A, 'ORD-NEW', { confirmationStatus: 'NEW', shippingStatus: 'NOT_READY' })], [A]);
    expect(out.stamped).toBe(0);
    expect(db.order.updateMany).not.toHaveBeenCalled();
    expect(audited()).toHaveLength(0);
  });

  it('NEGATIVE: the owner’s key does not widen what a token names — an id the token does not hold is ignored', async () => {
    grants.labelsAny = true;
    db.order.findMany.mockResolvedValue([]);
    const out = await (await printedPOST(json({ t: await tokenFor([A]), orderIds: [E] }))).json();
    expect(out.stamped).toBe(0);
    expect(db.order.findMany).not.toHaveBeenCalled();
    expect(db.order.updateMany).not.toHaveBeenCalled();
  });
});
