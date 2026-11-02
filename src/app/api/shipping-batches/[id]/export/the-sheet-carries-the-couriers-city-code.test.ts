import { beforeEach, describe, expect, it, vi } from 'vitest';
import { readXlsxRows } from '@/lib/xlsx-reader';

/**
 * ═══════════════════════════════════════════════════════════════════════
 * DEFINITION OF DONE — the Excel file for the courier's portal carries the governorate's city code by itself
 *
 * The owner, 2/11: the governorate's city code is adopted for every city, village and neighbourhood, nobody types it.
 * The file «رمز المدينة عند الشركة» column is the same number the press sends the courier's API:
 *
 *  1. A Basha batch whose governorates have no typed code carries the code from Basha's own list — all fourteen of ours,
 *     asserted against the owner's sheet.
 *  2. A typed code wins over the list — except a number the list proves is a Region Id (3003): that is not a city, so the
 *     file carries the list's city for the governorate instead (an empty cell when the list has none), exactly as the press
 *     sends it.
 *  3. A governorate the list does not name, a courier we hold no list for, and a batch with no courier keep an empty cell.
 *
 * Blockers: no money arithmetic (the amount is read by `waybillCod`, untouched), no order written, no migration.
 * ═══════════════════════════════════════════════════════════════════════
 */

const { db, requireContext, can, noteCustomersHandedOut } = vi.hoisted(() => ({
  db: {
    shippingBatch: { findFirst: vi.fn() },
    order: { findMany: vi.fn() },
    deliveryFee: { findMany: vi.fn() },
  },
  requireContext: vi.fn(),
  can: vi.fn(),
  noteCustomersHandedOut: vi.fn(),
}));

vi.mock('@/lib/db', () => ({ db }));
vi.mock('@/lib/geo-context', () => ({ requireContext: (...a: unknown[]) => requireContext(...a) }));
vi.mock('@/lib/authorization', () => ({ can: (...a: unknown[]) => can(...a), requirePermission: vi.fn() }));
vi.mock('@/lib/pii-alert', () => ({ noteCustomersHandedOut: (...a: unknown[]) => noteCustomersHandedOut(...a) }));

import { GET } from './route';

const ID = '99999999-9999-4999-8999-999999999999';
const call = () => GET(new Request(`http://localhost/api/shipping-batches/${ID}/export`), { params: Promise.resolve({ id: ID }) });

/** One order to this governorate (region id, name). */
const order = (n: number, region: { id: string; name: string } | null, over: Record<string, unknown> = {}) => ({
  id: `o${n}`, orderNumber: `ORD-2026-0${n}`, merchantRef: null, trackingNumber: null,
  totalAmount: 32.5, currency: 'USD', confirmationStatus: 'CONFIRMED', shippingStatus: 'READY_FOR_PICKUP',
  shippingBatchId: ID, deliveryProviderId: 'p1', regionId: region?.id ?? null, priceIncludesDelivery: false,
  labelPrintedAt: null, createdAt: new Date('2026-10-30'), customerNotes: null, deliveryAddress: null,
  customer: { fullName: 'محمد', phone: '963991234567', rawPhone: '0991234567', altPhone: null, city: region?.name ?? '', address: 'حي المطار' },
  region: region ? { name: region.name } : null, deliveryProvider: { name: 'الباشا' },
  items: [{ productName: 'كريم', quantity: 1, freeQuantity: 0, unitPrice: 10, discountShare: 0, lineTotal: 10 }],
  addOns: [],
  ...over,
});

/** The «رمز المدينة عند الشركة» cell of each order, in the file's order. */
const codes = async () => readXlsxRows(Buffer.from(await (await call()).arrayBuffer())).slice(1).map((r) => r[6] ?? '');

const batchOf = (code: string | null) => ({
  id: ID, batchNumber: 'BATCH-2026-0004', deliveryProviderId: code ? 'p1' : null, provider: code ? { code } : null,
});

beforeEach(() => {
  vi.clearAllMocks();
  requireContext.mockResolvedValue({
    user: { id: 'u1', name: 'قباص' }, companyId: 'c1', storeId: 's1',
    country: { minorUnit: 2, currencyCode: 'USD', code: 'SY' },
  });
  can.mockImplementation((_u: unknown, k: string) => ['ops.batches', 'customers.view'].includes(k));
  db.shippingBatch.findFirst.mockResolvedValue(batchOf('BASHA'));
  db.deliveryFee.findMany.mockResolvedValue([]);
});

// Our governorates and the number the owner's sheet gives each (the same table as `couriers/places.test.ts`).
const FOURTEEN: [string, number][] = [
  ['دمشق', 445053], ['ريف دمشق', 445143], ['حلب', 705991], ['حمص', 570272], ['حماة', 445146], ['اللاذقية', 705992], ['طرطوس', 705993],
  ['إدلب', 570148], ['دير الزور', 949546], ['الحسكة', 445152], ['الرقة', 445151], ['درعا', 570150], ['السويداء', 445153], ['القنيطرة', 566122],
];

describe('the sheet of a Basha batch with nothing typed', () => {
  it('carries the city code of every one of the fourteen governorates, by itself', async () => {
    db.order.findMany.mockResolvedValue(FOURTEEN.map(([name], i) => order(i + 1, { id: `r${i}`, name })));
    expect(await codes()).toEqual(FOURTEEN.map(([, code]) => String(code)));
  });

  it('asks the courier’s code with the batch — that is what picks the list', async () => {
    db.order.findMany.mockResolvedValue([order(1, { id: 'r1', name: 'السويداء' })]);
    await call();
    expect(db.shippingBatch.findFirst.mock.calls[0][0].select).toMatchObject({ provider: { select: { code: true } } });
  });

  it('a fee row that carries no code changes nothing — the list still answers', async () => {
    db.order.findMany.mockResolvedValue([order(1, { id: 'r1', name: 'السويداء' })]);
    db.deliveryFee.findMany.mockResolvedValue([]);
    expect(await codes()).toEqual(['445153']);
  });

  it('NEGATIVE: a governorate their list does not name keeps its cell empty', async () => {
    db.order.findMany.mockResolvedValue([order(1, { id: 'r1', name: 'بغداد' }), order(2, null)]);
    expect(await codes()).toEqual(['', '']);
  });
});

describe('the sheet when a code was typed', () => {
  it('the typed code wins over the list — also for a governorate the list does not name', async () => {
    db.deliveryFee.findMany.mockResolvedValue([{ regionId: 'r1', courierCityId: 999001 }, { regionId: 'r2', courierCityId: 999002 }]);
    db.order.findMany.mockResolvedValue([
      order(1, { id: 'r1', name: 'السويداء' }),
      order(2, { id: 'r2', name: 'بغداد' }),
      order(3, { id: 'r3', name: 'دمشق' }),
    ]);
    expect(await codes()).toEqual(['999001', '999002', '445053']);
  });

  it('only this courier’s rows are asked for, and only those that carry a code', async () => {
    db.order.findMany.mockResolvedValue([order(1, { id: 'r1', name: 'دمشق' })]);
    await call();
    expect(db.deliveryFee.findMany.mock.calls[0][0].where).toEqual({ deliveryProviderId: 'p1', courierCityId: { not: null } });
  });
});

describe('the sheet when the typed number is a Region Id', () => {
  const sweida = { id: 'r1', name: 'السويداء' };
  const typedFor = (n: number) => db.deliveryFee.findMany.mockResolvedValue([{ regionId: 'r1', courierCityId: n }]);

  it('typed 3003 for السويداء: the cell carries 445153, the city the press sends — never the Region Id', async () => {
    typedFor(3003);
    db.order.findMany.mockResolvedValue([order(1, sweida)]);
    expect(await codes()).toEqual(['445153']);
  });

  it('typed 445153: 445153; typed 566117 (a city of the list): 566117; typed 999999999 (unknown to the list): 999999999', async () => {
    db.order.findMany.mockResolvedValue([order(1, sweida)]);
    for (const [n, cell] of [[445153, '445153'], [566117, '566117'], [999999999, '999999999']] as const) {
      typedFor(n);
      expect(await codes(), String(n)).toEqual([cell]);
    }
  });

  it('a Region Id for a governorate the list does not name: nothing to fall back on — an empty cell', async () => {
    db.deliveryFee.findMany.mockResolvedValue([{ regionId: 'r2', courierCityId: 3003 }]);
    db.order.findMany.mockResolvedValue([order(1, { id: 'r2', name: 'بغداد' })]);
    expect(await codes()).toEqual(['']);
  });

  it('NEGATIVE: a courier we hold no list for — 3003 is only a number, and stays as typed', async () => {
    db.shippingBatch.findFirst.mockResolvedValue(batchOf('HALA'));
    typedFor(3003);
    db.order.findMany.mockResolvedValue([order(1, sweida)]);
    expect(await codes()).toEqual(['3003']);
  });
});

describe('where the list does not apply', () => {
  it('a courier we hold no list for: only what was typed', async () => {
    db.shippingBatch.findFirst.mockResolvedValue(batchOf('HALA'));
    db.deliveryFee.findMany.mockResolvedValue([{ regionId: 'r1', courierCityId: 777001 }]);
    db.order.findMany.mockResolvedValue([order(1, { id: 'r1', name: 'السويداء' }), order(2, { id: 'r2', name: 'دمشق' })]);
    expect(await codes()).toEqual(['777001', '']);
  });

  it('a batch with no courier at all: no fee row is read, every cell is empty', async () => {
    db.shippingBatch.findFirst.mockResolvedValue(batchOf(null));
    db.order.findMany.mockResolvedValue([order(1, { id: 'r1', name: 'دمشق' })]);
    expect(await codes()).toEqual(['']);
    expect(db.deliveryFee.findMany).not.toHaveBeenCalled();
  });

  it('a batch whose courier row was deleted (the link is null) is the same: nothing to look up', async () => {
    db.shippingBatch.findFirst.mockResolvedValue({ id: ID, batchNumber: 'BATCH-2026-0004', deliveryProviderId: 'p1', provider: null });
    db.order.findMany.mockResolvedValue([order(1, { id: 'r1', name: 'دمشق' })]);
    expect(await codes()).toEqual(['']);
  });
});
