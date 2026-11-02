import { beforeEach, describe, expect, it, vi } from 'vitest';
import { orderSearchOr } from '@/lib/order-filters';

/**
 * ═══════════════════════════════════════════════════════════════════════
 * «صندوق بحث داخل الباتش عن طلب» — THE DOOR (the owner, 3/11).
 *
 * `GET /api/shipping-batches/[id]?q=` narrows the batch's parcels to the ones that match. Held here:
 *   · the question is the orders list's own (`orderSearchOr`), not a second one;
 *   · it is asked of THIS batch inside the session's company and store — a parcel of another trolley or another store
 *     is never in the answer, even if the database were to hand one back;
 *   · the phone is matched only for whoever is shown the phone;
 *   · no `q` is the batch as it always was (no second query, no `search` in the answer);
 *   · the alarm counts what left — the matches, not the whole batch.
 * ═══════════════════════════════════════════════════════════════════════
 */

const { db, requireContext, can, authorize, noteCustomersHandedOut } = vi.hoisted(() => ({
  db: { shippingBatch: { findFirst: vi.fn() }, order: { findMany: vi.fn() } },
  requireContext: vi.fn(),
  can: vi.fn(),
  authorize: vi.fn(),
  noteCustomersHandedOut: vi.fn(async (..._a: unknown[]) => undefined),
}));

vi.mock('@/lib/db', () => ({ db }));
vi.mock('@/lib/geo-context', () => ({ requireContext: (...a: unknown[]) => requireContext(...a) }));
vi.mock('@/lib/authorization', () => ({
  can: (...a: unknown[]) => can(...a),
  authorize: (...a: unknown[]) => authorize(...a),
  requirePermission: vi.fn(),
}));
vi.mock('@/lib/audit', () => ({ logAudit: vi.fn() }));
vi.mock('@/lib/apps/events', () => ({ emitAppEvent: vi.fn() }));
vi.mock('@/lib/pii-alert', async (orig) => ({
  ...(await orig<typeof import('@/lib/pii-alert')>()),
  noteCustomersHandedOut: (...a: unknown[]) => noteCustomersHandedOut(...a),
}));

import { GET } from './[id]/route';

const parcel = (n: number, name: string, phone: string) => ({
  id: `o${n}`, orderNumber: `SY-2026-000${n}`, merchantRef: null, totalAmount: 20, trackingNumber: `TRK${n}`,
  shippingStatus: 'READY_FOR_PICKUP', version: 1, currency: 'JOD', confirmationStatus: 'CONFIRMED', regionId: 'r1',
  discountAmount: 0, customer: { fullName: name, phone, altPhone: null, address: 'شارع', city: 'السويداء' },
  region: { id: 'r1', name: 'السويداء' }, items: [],
});
const MEMBERS = [parcel(1, 'أبو محمد', '0791111111'), parcel(2, 'سارة', '0792222222'), parcel(3, 'ليلى', '0793333333')];

const grant = (...keys: string[]) => can.mockImplementation((_u: unknown, k: string) => keys.includes(k));
const get = async (q?: string) => {
  const url = `http://localhost/api/shipping-batches/b1${q === undefined ? '' : `?q=${encodeURIComponent(q)}`}`;
  const res = await GET(new Request(url), { params: Promise.resolve({ id: 'b1' }) });
  return { status: res.status, body: (await res.json()) as Record<string, any> };
};
const askedWhere = () => (db.order.findMany.mock.calls[0][0] as { where: Record<string, any> }).where;

beforeEach(() => {
  vi.clearAllMocks();
  requireContext.mockResolvedValue({
    user: { id: 'u1', name: 'عامل', email: 'w@example.com' }, companyId: 'c1', storeId: 's1',
    country: { currencyCode: 'JOD', minorUnit: 2 },
  });
  db.shippingBatch.findFirst.mockResolvedValue({
    id: 'b1', companyId: 'c1', storeId: 's1', status: 'SHIPPED', batchNumber: 'BATCH-1', provider: null, creator: null,
    orders: MEMBERS,
  });
  authorize.mockReturnValue({ allowed: true });
  grant('ops.batches', 'customers.view');
});

describe('no search: the batch as it always was', () => {
  it('every parcel, no second query, nothing called «search» in the answer', async () => {
    const { body } = await get();
    expect(body.batch.orders.map((o: any) => o.id)).toEqual(['o1', 'o2', 'o3']);
    expect(db.order.findMany).not.toHaveBeenCalled();
    expect(body.search).toBeUndefined();
  });

  it('a box of spaces is no search', async () => {
    const { body } = await get('   ');
    expect(body.batch.orders).toHaveLength(3);
    expect(db.order.findMany).not.toHaveBeenCalled();
  });
});

describe('a search', () => {
  it('asks the orders list’s own question, of this batch, inside the company and the store', async () => {
    db.order.findMany.mockResolvedValue([{ id: 'o2' }]);
    await get('سارة');
    const where = askedWhere();
    expect(where.shippingBatchId).toBe('b1');
    expect(where.companyId).toBe('c1');
    expect(where.storeId).toBe('s1');
    expect(where.AND).toEqual([{ OR: orderSearchOr('سارة', { withPhone: true }) }]);
  });

  it('answers with the matches only, and says what was asked out of how many', async () => {
    db.order.findMany.mockResolvedValue([{ id: 'o2' }]);
    const { body } = await get('  سارة ');
    expect(body.batch.orders.map((o: any) => o.orderNumber)).toEqual(['SY-2026-0002']);
    expect(body.search).toEqual({ q: 'سارة', total: 3 });
  });

  it('NEGATIVE: an id of another trolley or another store is never in the answer, whatever the query returned', async () => {
    db.order.findMany.mockResolvedValue([{ id: 'o2' }, { id: 'other-batch-order' }, { id: 'other-store-order' }]);
    const { body } = await get('0');
    expect(body.batch.orders.map((o: any) => o.id)).toEqual(['o2']);
  });

  it('nothing matches: an empty list with the count, not the whole batch', async () => {
    db.order.findMany.mockResolvedValue([]);
    const { body } = await get('لا أحد');
    expect(body.batch.orders).toEqual([]);
    expect(body.search).toEqual({ q: 'لا أحد', total: 3 });
  });

  it('a long paste is cut to a hundred letters before it is asked', async () => {
    db.order.findMany.mockResolvedValue([]);
    const { body } = await get('x'.repeat(250));
    expect(body.search.q).toHaveLength(100);
  });

  it('the alarm counts the matches that left, not the batch', async () => {
    db.order.findMany.mockResolvedValue([{ id: 'o1' }]);
    await get('أبو');
    expect((noteCustomersHandedOut.mock.calls[0][0] as { rows: unknown[] }).rows).toHaveLength(1);
  });
});

describe('the phone is matched for whoever is shown it', () => {
  it('with the address-book key, the phone clauses are in the question', async () => {
    db.order.findMany.mockResolvedValue([]);
    await get('0792222222');
    expect(JSON.stringify(askedWhere())).toContain('"phone"');
  });

  it('NEGATIVE: without it (the batches key alone), no phone clause — a number the row hides finds nothing', async () => {
    grant('ops.batches');
    db.order.findMany.mockResolvedValue([]);
    await get('0792222222');
    const asked = JSON.stringify(askedWhere());
    expect(asked).not.toContain('"phone"');
    expect(asked).not.toContain('"rawPhone"');
    expect(askedWhere().AND).toEqual([{ OR: orderSearchOr('0792222222', { withPhone: false }) }]);
  });

  it('the packing table’s pen on an OPEN trolley is shown the phone, so it may search by it', async () => {
    grant('ops.batches', 'ops.edit_in_batch');
    db.shippingBatch.findFirst.mockResolvedValue({
      id: 'b1', companyId: 'c1', storeId: 's1', status: 'READY', batchNumber: 'BATCH-1', provider: null, creator: null, orders: MEMBERS,
    });
    db.order.findMany.mockResolvedValue([]);
    await get('0792222222');
    expect(JSON.stringify(askedWhere())).toContain('"phone"');
  });
});

describe('`orderSearchOr` stays what every other caller asked', () => {
  it('by default it still matches the phone, as typed and normalised', () => {
    expect(JSON.stringify(orderSearchOr('0791234567'))).toContain('"phone"');
    expect(JSON.stringify(orderSearchOr('0791234567'))).toContain('"rawPhone"');
  });

  it('`withPhone: false` drops exactly the two phone clauses and nothing else', () => {
    const all = orderSearchOr('x', { withCity: true });
    const without = orderSearchOr('x', { withCity: true, withPhone: false });
    expect(all.length - without.length).toBe(2);
    expect(without).toEqual(all.filter((c) => !/"(phone|rawPhone)"/.test(JSON.stringify(c))));
  });
});
