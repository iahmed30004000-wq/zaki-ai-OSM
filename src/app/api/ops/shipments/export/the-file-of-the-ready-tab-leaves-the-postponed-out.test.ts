import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * ═══════════════════════════════════════════════════════════════════════
 * «csv عند انشاء الشحنة استخرج الطلبات الجاهزة للشحن مش المؤجلة» (the owner, 3/11).
 *
 * `GET /api/ops/shipments/export` — the «جاهزة للشحن» tab of «إنشاء شحنة» as a CSV file. Held here:
 *   · the orders are asked with the tab's own question (`shipmentListWhere`, `held: false`) — the same where the list is
 *     read with — and never with the «مؤجَّلة الشحن» one;
 *   · of those, only the ones the shipment door would take (`assertReadyToShip`): a line not reserved stays out;
 *   · the answer says how many it left out and why, in its headers — the file itself is only the sheet;
 *   · the columns are the batch's Excel columns, and the amount is the one the shipment will record with THIS courier;
 *   · two keys, the courier is required and is the company's own, and the customers are counted.
 *
 * Worked example: ten orders under the filters, two of them postponed — the file has eight rows, and the answer says
 * «2 left out, postponed».
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

import { GET } from './route';
import { shipmentListWhere } from '@/lib/batching-guard';
import { BATCH_SHEET_HEADER } from '@/lib/batch-sheet';
import { activeFeeRowWhere } from '@/lib/operations';

const COURIER = '11111111-1111-4111-8111-111111111111';
const NOW = new Date('2026-11-03T09:00:00.000Z');

const call = (query = `courier=${COURIER}`) => GET(new Request(`http://localhost/api/ops/shipments/export?${query}`));

/** One order of the ready tab, its units reserved unless said otherwise. */
const order = (n: number, over: Record<string, unknown> = {}) => ({
  id: `o${n}`, orderNumber: `ORD-2026-${String(n).padStart(4, '0')}`, merchantRef: null, trackingNumber: null,
  totalAmount: 20, currency: 'USD', confirmationStatus: 'CONFIRMED', shippingStatus: 'NOT_READY',
  shippingBatchId: null, deliveryProviderId: null, regionId: 'r-sweida', priceIncludesDelivery: false,
  labelPrintedAt: null, createdAt: new Date('2026-11-01'), customerNotes: null, deliveryAddress: null,
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
  // Two kinds of read of the fee table: the active rows of the governorates (the door's NO_FEE_ROW question) — every
  // governorate asked has one unless a test says otherwise — and the typed city ids (none typed).
  db.deliveryFee.findMany.mockImplementation(async (args: { where: { isActive?: boolean; regionId?: { in: string[] } } }) =>
    args.where.isActive ? (args.where.regionId?.in ?? []).map((regionId) => ({ regionId })) : []
  );
  db.order.findMany.mockResolvedValue([]);
  db.order.count.mockResolvedValue(0);
  // The courier's fee for the governorate: 5 for THIS courier, anything else would be another courier's.
  resolveDeliveryFee.mockImplementation(async (_tx: unknown, p: { deliveryProviderId: string }) =>
    p.deliveryProviderId === COURIER
      ? { fee: 5, lateThresholdDays: 0, returnFee: 0, source: 'REGION' }
      : { fee: 999, lateThresholdDays: 0, returnFee: 0, source: 'REGION' }
  );
});
afterEach(() => vi.useRealTimers());

describe('the worked example: ten under the filters, two of them postponed', () => {
  it('the file has the eight, and the answer says two postponed were left out', async () => {
    db.order.findMany.mockResolvedValue(Array.from({ length: 8 }, (_, i) => order(i + 1)));
    db.order.count.mockResolvedValue(2);
    const res = await call();

    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Type')).toContain('text/csv');
    const rows = parse(await res.text());
    expect(rows).toHaveLength(1 + 8);
    expect(res.headers.get('X-Rows')).toBe('8');
    expect(res.headers.get('X-Left-Held')).toBe('2');
    expect(res.headers.get('X-Left-Unready')).toBe('0');
  });
});

describe('which orders the file asks for', () => {
  it('the ready tab’s own question — `held: false`, the filters as the list reads them — and the postponed tab is only counted', async () => {
    await call(`courier=${COURIER}&q=%20سارة%20&region=r1&product=p9&from=2026-10-01&to=2026-11-02`);
    const filters = {
      companyId: 'c1', storeId: 's1', regionId: 'r1', productId: 'p9', search: 'سارة',
      from: new Date('2026-10-01'), to: new Date('2026-11-02'),
    };
    expect(db.order.findMany.mock.calls[0][0].where).toEqual(shipmentListWhere({ ...filters, held: false, now: NOW }));
    expect(db.order.count.mock.calls[0][0].where).toEqual(shipmentListWhere({ ...filters, held: true, now: NOW }));
  });

  it('NEGATIVE: the question never lets a hold whose day has not come into the file', async () => {
    await call();
    const where = db.order.findMany.mock.calls[0][0].where;
    // The unpacked branch takes no hold or a hold already due; the packed branch only a hold already due.
    expect(where.OR[0].OR).toEqual([{ shipHoldUntil: null }, { shipHoldUntil: { lte: NOW } }]);
    expect(where.OR[1].shipHoldUntil).toEqual({ lte: NOW });
    expect(where.shipHoldUntil).toBeUndefined();
  });

  it('it is the list’s question: the «جاهزة للشحن» tab is read with the very same where, filter for filter', async () => {
    const { GET: list } = await import('../route');
    const query = `courier=${COURIER}&q=0991&region=r1&from=2026-10-01`;
    await list(new Request(`http://localhost/api/ops/shipments?${query}`));
    const listWhere = db.order.findMany.mock.calls[0][0].where;
    await call(query);
    expect(db.order.findMany.mock.calls[1][0].where).toEqual(listWhere);
    // And the confirmed ones only, as the list: nothing about the file widens it (RV888).
    expect(db.order.findMany.mock.calls[1][0].where.confirmationStatus).toBe('CONFIRMED');
  });

  it('an order the shipment door would refuse (a line not reserved) is left out and counted as such', async () => {
    db.order.findMany.mockResolvedValue([
      order(1),
      order(2, { items: [{ productName: 'كريم', quantity: 2, freeQuantity: 1, unitPrice: 10, discountShare: 0, lineTotal: 20, reservedQty: 2 }] }),
      order(3, { addOns: [{ productName: 'هدية', quantity: 1, price: 3, reservedQty: 0 }] }),
    ]);
    db.order.count.mockResolvedValue(1);
    const res = await call();
    const rows = parse(await res.text());
    expect(rows.slice(1).map((r) => r[0])).toEqual(['ORD-2026-0001']);
    expect(res.headers.get('X-Left-Unready')).toBe('2');
    expect(res.headers.get('X-Left-Held')).toBe('1');
  });

  it('the before and after (RV886): 25,000 to a governorate with no fee row at this courier was in the file at 25,000 — it is left out now, and counted', async () => {
    const goods = [{ productName: 'خلاط', quantity: 1, freeQuantity: 0, unitPrice: 25000, discountShare: 0, lineTotal: 25000, reservedQty: 1 }];
    db.order.findMany.mockResolvedValue([
      order(1),
      order(2, { regionId: 'r-quneitra', region: { name: 'القنيطرة' }, totalAmount: 25000, items: goods }),
    ]);
    // Only Sweida is priced at this courier.
    db.deliveryFee.findMany.mockImplementation(async (args: { where: { isActive?: boolean } }) =>
      args.where.isActive ? [{ regionId: 'r-sweida' }] : []
    );
    const res = await call();
    const rows = parse(await res.text());
    expect(rows.slice(1).map((r) => r[0])).toEqual(['ORD-2026-0001']);
    expect(rows.some((r) => r.includes('25000'))).toBe(false);
    expect(res.headers.get('X-Left-Blocked')).toBe('1');
    expect(res.headers.get('X-Left-Unready')).toBe('0');
  });

  it('the fee rows are the door’s question — active, this courier, the governorates of the list — read once', async () => {
    db.order.findMany.mockResolvedValue([order(1), order(2, { regionId: 'r-dam', region: { name: 'دمشق' } }), order(3)]);
    await call();
    const feeReads = db.deliveryFee.findMany.mock.calls.filter((c) => (c[0] as { where: { isActive?: boolean } }).where.isActive);
    expect(feeReads).toHaveLength(1);
    expect(feeReads[0][0].where).toEqual(activeFeeRowWhere(COURIER, { in: ['r-sweida', 'r-dam'] }));
  });

  it('an order with no governorate is left out and counted with the blocked ones', async () => {
    db.order.findMany.mockResolvedValue([order(1), order(2, { regionId: null, region: null })]);
    const res = await call();
    expect(parse(await res.text()).slice(1).map((r) => r[0])).toEqual(['ORD-2026-0001']);
    expect(res.headers.get('X-Left-Blocked')).toBe('1');
  });

  it('nothing ready because of the fee: refused, and the count of the blocked is in the answer', async () => {
    db.order.findMany.mockResolvedValue([order(1, { regionId: null, region: null })]);
    const res = await call();
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ code: 'NOTHING_READY', blocked: 1, unready: 0 });
  });

  it('nothing ready: refused with the counts, not answered with an empty file', async () => {
    db.order.findMany.mockResolvedValue([order(1, { items: [] })]);
    db.order.count.mockResolvedValue(4);
    const res = await call();
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body).toMatchObject({ code: 'NOTHING_READY', held: 4, unready: 1 });
    expect(noteCustomersHandedOut).not.toHaveBeenCalled();
  });
});

describe('what the file carries', () => {
  it('the batch’s Excel columns, in their order', async () => {
    db.order.findMany.mockResolvedValue([order(1)]);
    const rows = parse(await (await call()).text());
    expect(rows[0]).toEqual([...BATCH_SHEET_HEADER]);
  });

  it('one row: the reference, the receiver, the phone as typed, the place, the courier’s city id, the amount with THIS courier’s fee, the contents', async () => {
    db.order.findMany.mockResolvedValue([order(1)]);
    const [, row] = parse(await (await call()).text());
    expect(row).toEqual([
      'ORD-2026-0001', '', 'زبون 1', '0991234567', '', 'السويداء', '445153', 'حي المطار', '25', 'USD', 'كريم x2', '',
    ]);
    expect(resolveDeliveryFee.mock.calls.every((c) => (c[1] as { deliveryProviderId: string }).deliveryProviderId === COURIER)).toBe(true);
  });

  it('a customer’s «=…» stays text', async () => {
    db.order.findMany.mockResolvedValue([order(1, { customer: { fullName: '=HYPERLINK("x")', phone: '1', rawPhone: '1', altPhone: null, city: '', address: '' } })]);
    const [, row] = parse(await (await call()).text());
    expect(row[2].startsWith("'=")).toBe(true);
  });

  it('the customers who left are counted, as the rows of the file', async () => {
    db.order.findMany.mockResolvedValue([order(1), order(2)]);
    await call();
    expect(noteCustomersHandedOut).toHaveBeenCalledTimes(1);
    expect((noteCustomersHandedOut.mock.calls[0][0] as { rows: unknown[] }).rows).toHaveLength(2);
  });
});

describe('who may, and with what', () => {
  it('NEGATIVE: without the screen’s key — 403, nothing read', async () => {
    asKeys(['customers.view']);
    expect((await call()).status).toBe(403);
    expect(db.order.findMany).not.toHaveBeenCalled();
  });

  it('NEGATIVE: without the address-book key — 403, nothing read', async () => {
    asKeys(['ops.ship']);
    expect((await call()).status).toBe(403);
    expect(db.order.findMany).not.toHaveBeenCalled();
  });

  it('NEGATIVE: no courier chosen — 400, nothing read', async () => {
    const res = await call('');
    expect(res.status).toBe(400);
    expect((await res.json()).code).toBe('NO_COURIER');
    expect(db.order.findMany).not.toHaveBeenCalled();
  });

  it('NEGATIVE: a courier of another company is not found, and nothing is read', async () => {
    db.deliveryProvider.findFirst.mockResolvedValue(null);
    expect((await call()).status).toBe(404);
    expect(db.deliveryProvider.findFirst.mock.calls[0][0].where).toEqual({ id: COURIER, companyId: 'c1' });
    expect(db.order.findMany).not.toHaveBeenCalled();
  });
});
