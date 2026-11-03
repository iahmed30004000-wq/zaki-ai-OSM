import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * ═══════════════════════════════════════════════════════════════════════
 * «بدي بهاي الخانة فقط أقدر انزل ال csv بدون ما اختار شركة … الهدف مش السعر … الهدف اسحب الطلبات فقط اوزع المناطق ع
 * شركات الشحن» (the owner, 3/11).
 *
 * `POST /api/ops/shipments/export` with the ticked ids and NO courier: a sheet for sharing the governorates out between
 * the couriers, not for collecting. Held here:
 *   · it answers the file — the same header row, the same orders, the same columns;
 *   · it carries NO money: «المبلغ المطلوب» and «العملة» are empty for every order, and nothing is read or worked out for
 *     them (no fee lookup, no courier, no stored total printed);
 *   · «رمز المدينة عند الشركة» is empty — it is a courier's own id;
 *   · the fee question is a courier's, so no order is held back for it;
 *   · the answer says it was made without a courier (`X-No-Courier: 1`, its own file name);
 *   · WITH a courier the file is byte for byte what it was before this change;
 *   · the same keys, the same store, the same tally, the same ceiling.
 *
 * Worked example: one order, 2 × 10 = 20 stored, at a courier whose fee is 5 and a price that does not include delivery.
 * With the courier its line says 25 USD; without one it says nothing at all in either money cell.
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

import { GET, POST } from './route';
import { BATCH_SHEET_HEADER } from '@/lib/batch-sheet';

const COURIER = '11111111-1111-4111-8111-111111111111';
const NOW = new Date('2026-11-03T09:00:00.000Z');
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

const post = (body: unknown) =>
  POST(new Request('http://localhost/api/ops/shipments/export', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  }));

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

/** The file's cells, row by row, header first — the BOM gone and each quoted cell read back. */
const parse = (text: string) =>
  text
    .replace(/^﻿/, '')
    .split('\r\n')
    .map((line) => [...line.matchAll(/"((?:[^"]|"")*)"/g)].map((m) => m[1].replace(/""/g, '"')));

const AMOUNT = BATCH_SHEET_HEADER.indexOf('المبلغ المطلوب');
const CURRENCY = BATCH_SHEET_HEADER.indexOf('العملة');
const CITY_ID = BATCH_SHEET_HEADER.indexOf('رمز المدينة عند الشركة');

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

describe('the worked example: the same order, with a courier and without one', () => {
  it('with the courier: 25 USD (20 + its fee of 5); without: both money cells empty — neither 20 nor 25', async () => {
    db.order.findMany.mockResolvedValue([order(1)]);
    const [, withCourier] = parse(await (await post({ courier: COURIER, ids: [id(1)] })).text());
    expect(withCourier[AMOUNT]).toBe('25');
    expect(withCourier[CURRENCY]).toBe('USD');

    db.order.findMany.mockResolvedValue([order(1)]);
    const res = await post({ ids: [id(1)] });
    expect(res.status).toBe(200);
    const [header, without] = parse(await res.text());
    expect(header).toEqual([...BATCH_SHEET_HEADER]);
    expect(without).toEqual(['ORD-2026-0001', '', 'زبون 1', '0991234567', '', 'السويداء', '', 'حي المطار', '', '', 'كريم x2', '']);
  });
});

describe('without a courier', () => {
  it('every money cell of every order is empty, and so is the city id — even an order already given to a courier', async () => {
    db.order.findMany.mockResolvedValue([
      order(1),
      // Already given to another courier, its price not including delivery, with an add-on: the courier path would add a
      // fee and the add-on. Here nothing is added — nothing is printed.
      order(2, { deliveryProviderId: 'p-other', addOns: [{ productName: 'هدية', quantity: 1, price: 3, reservedQty: 1 }] }),
      order(3, { priceIncludesDelivery: true, totalAmount: 35 }),
    ]);
    const res = await post({ ids: [id(1), id(2), id(3)] });
    const [, ...rows] = parse(await res.text());
    expect(rows).toHaveLength(3);
    for (const row of rows) {
      expect(row[AMOUNT]).toBe('');
      expect(row[CURRENCY]).toBe('');
      expect(row[CITY_ID]).toBe('');
    }
    // The rest of the sheet is the same sheet.
    expect(rows[1][10]).toBe('كريم x2 | هدية x1 (إضافة)');
    // Nothing was read or worked out for the money, and no courier was looked up.
    expect(resolveDeliveryFee).not.toHaveBeenCalled();
    expect(db.deliveryProvider.findFirst).not.toHaveBeenCalled();
    expect(db.deliveryFee.findMany).not.toHaveBeenCalled();
  });

  it('the answer says it was made without a courier, under its own file name', async () => {
    db.order.findMany.mockResolvedValue([order(1)]);
    const res = await post({ ids: [id(1)] });
    expect(res.headers.get('X-No-Courier')).toBe('1');
    expect(res.headers.get('Content-Disposition')).toContain('picked-no-courier-to-ship-2026-11-03.csv');
    expect(res.headers.get('X-Rows')).toBe('1');
  });

  it('the fee question is a courier’s: no governorate, or none priced anywhere, is not held back', async () => {
    db.order.findMany.mockResolvedValue([order(1, { regionId: null, region: null }), order(2, { regionId: 'r-nowhere' })]);
    db.deliveryFee.findMany.mockResolvedValue([]);
    const res = await post({ ids: [id(1), id(2)] });
    expect(res.status).toBe(200);
    expect(res.headers.get('X-Rows')).toBe('2');
    expect(res.headers.get('X-Left-Blocked')).toBe('0');
    const [, first] = parse(await res.text());
    // No governorate chosen: the place the customer typed, as the courier sheet always printed it.
    expect(first[5]).toBe('السويداء');
  });

  it('the customers who left are counted, as the rows of the file', async () => {
    db.order.findMany.mockResolvedValue([order(1), order(2)]);
    await post({ ids: [id(1), id(2)] });
    expect(noteCustomersHandedOut).toHaveBeenCalledTimes(1);
    const tally = noteCustomersHandedOut.mock.calls[0][0] as { rows: unknown[]; storeId: string; companyId: string };
    expect(tally.rows).toHaveLength(2);
    expect([tally.companyId, tally.storeId]).toEqual(['c1', 's1']);
  });

  it('NEGATIVE: another store’s ids are asked under this store’s question, and what does not come back is not printed', async () => {
    db.order.findMany.mockResolvedValue([order(1)]);
    const res = await post({ ids: [id(1), id(9)] });
    const where = JSON.stringify(db.order.findMany.mock.calls[0][0].where);
    expect(where).toContain('"storeId":"s1"');
    expect(where).toContain('"companyId":"c1"');
    expect(res.headers.get('X-Left-Gone')).toBe('1');
    expect(await res.text()).not.toContain('ORD-2026-0009');
  });

  it('NEGATIVE: without the address-book key — 403, nothing read', async () => {
    asKeys(['ops.ship']);
    expect((await post({ ids: [id(1)] })).status).toBe(403);
    expect(db.order.findMany).not.toHaveBeenCalled();
  });

  it('NEGATIVE: without the screen’s key — 403, nothing read', async () => {
    asKeys(['customers.view']);
    expect((await post({ ids: [id(1)] })).status).toBe(403);
    expect(db.order.findMany).not.toHaveBeenCalled();
  });

  it('NEGATIVE: more than 2000 ids — 400, nothing read', async () => {
    const ids = Array.from({ length: 2001 }, (_, i) => id(i + 1));
    expect((await post({ ids })).status).toBe(400);
    expect(db.order.findMany).not.toHaveBeenCalled();
  });

  it('NEGATIVE: a courier named that is not the company’s — still 404, as before', async () => {
    db.deliveryProvider.findFirst.mockResolvedValue(null);
    expect((await post({ courier: COURIER, ids: [id(1)] })).status).toBe(404);
    expect(db.order.findMany).not.toHaveBeenCalled();
  });

  it('NEGATIVE: the whole tab (GET) still needs its courier — NO_COURIER, nothing read', async () => {
    const res = await GET(new Request('http://localhost/api/ops/shipments/export'));
    expect(res.status).toBe(400);
    expect((await res.json()).code).toBe('NO_COURIER');
    expect(db.order.findMany).not.toHaveBeenCalled();
  });
});

describe('with a courier: byte for byte what it was', () => {
  it('the ticked file with a courier is the same bytes as before this change', async () => {
    db.order.findMany.mockResolvedValue([
      order(1),
      order(2, { deliveryProviderId: 'p-other', addOns: [{ productName: 'هدية', quantity: 1, price: 3, reservedQty: 1 }] }),
      order(3, { priceIncludesDelivery: true, totalAmount: 35, customerNotes: 'بعد العصر' }),
    ]);
    const res = await post({ courier: COURIER, ids: [id(1), id(2), id(3)] });
    expect(res.headers.get('X-No-Courier')).toBeNull();
    expect(res.headers.get('Content-Disposition')).toContain('picked-to-ship-2026-11-03.csv');
    const bytes = new Uint8Array(await res.arrayBuffer());
    // The snapshot below was written by the code BEFORE this change. The BOM and the CRLF are held apart: decoding drops
    // the BOM, and a snapshot reads line ends as one.
    expect([...bytes.slice(0, 3)]).toEqual([0xef, 0xbb, 0xbf]);
    const text = new TextDecoder().decode(bytes);
    expect(text.split('\r\n')).toHaveLength(4);
    expect(text).toMatchInlineSnapshot(`
      ""رقم الطلب","باركود الشركة","اسم المستلم","الهاتف","هاتف إضافي","المحافظة","رمز المدينة عند الشركة","العنوان","المبلغ المطلوب","العملة","المحتويات","ملاحظات الزبون"
      "ORD-2026-0001","","زبون 1","0991234567","","السويداء","445153","حي المطار","25","USD","كريم x2",""
      "ORD-2026-0002","","زبون 2","0991234567","","السويداء","445153","حي المطار","28","USD","كريم x2 | هدية x1 (إضافة)",""
      "ORD-2026-0003","","زبون 3","0991234567","","السويداء","445153","حي المطار","20","USD","كريم x2","بعد العصر""
    `);
  });
});
