import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * ═══════════════════════════════════════════════════════════════════════
 * THE REPLIES SYSTEM'S COMPANION — `POST /api/v1/orders/{id}/amend`, `…/cancel`, and `editable` on the status read.
 *
 * `the-systems-door.test.ts` sweeps the tree (every handler proves the key, every write is idempotent, no model, no company from
 * the request); this file holds what these three DECIDE:
 *
 *   · whose order it is — only one the calling system created, in the calling company; anything else is a 404
 *   · until when — the landing chat's own question (`order-editable.ts`), asked of the row and carried by the write
 *   · that the OMS prices, never the caller; that the phone and the blacklist are the order door's
 *   · that the same key is one change, and that the desk finds the difference in the order's history
 *
 * The token is the REAL guard (`requireSystemToken`) over a stored row, and the idempotency ledger is the REAL one over an
 * in-memory table — what is mocked is the database, the catalogue and the helper that ends an order at the courier.
 * ═══════════════════════════════════════════════════════════════════════
 */

const h = vi.hoisted(() => ({
  db: {
    order: { findFirst: vi.fn(), updateMany: vi.fn() },
    orderItem: { deleteMany: vi.fn(), createMany: vi.fn() },
    orderAddOn: { findMany: vi.fn() },
    orderActivity: { create: vi.fn() },
    orderContactAttempt: { findFirst: vi.fn(), create: vi.fn() },
    customer: { findFirst: vi.fn(), update: vi.fn() },
    product: { findMany: vi.fn() },
    region: { findMany: vi.fn() },
    user: { findFirst: vi.fn() },
    systemToken: { findUnique: vi.fn(), update: vi.fn() },
    idempotencyRecord: { create: vi.fn(), findUnique: vi.fn(), update: vi.fn(), deleteMany: vi.fn() },
    $transaction: vi.fn(),
  },
  activeOffersFor: vi.fn(),
  activeBlock: vi.fn(),
  unitCostsOf: vi.fn(),
  priceIncludesDeliveryFor: vi.fn(),
  endOrder: vi.fn(),
  afterCommit: vi.fn(),
  notify: vi.fn(),
  logAudit: vi.fn(),
}));

vi.mock('@/lib/db', () => ({ db: h.db }));
vi.mock('@/lib/offers', async () => {
  const real = await vi.importActual<typeof import('../offers')>('../offers');
  return { ...real, activeOffersFor: (...a: unknown[]) => h.activeOffersFor(...a) };
});
vi.mock('@/lib/blacklist', () => ({ activeBlock: (...a: unknown[]) => h.activeBlock(...a) }));
vi.mock('@/lib/product-fixed-cost', () => ({ unitCostsOf: (...a: unknown[]) => h.unitCostsOf(...a) }));
vi.mock('@/lib/delivery-fees', async () => {
  const real = await vi.importActual<typeof import('../delivery-fees')>('../delivery-fees');
  return { ...real, priceIncludesDeliveryFor: (...a: unknown[]) => h.priceIncludesDeliveryFor(...a) };
});
vi.mock('@/lib/order-cancel', async () => {
  const real = await vi.importActual<typeof import('../order-cancel')>('../order-cancel');
  return { ...real, endOrder: (...a: unknown[]) => h.endOrder(...a) };
});
vi.mock('@/lib/notify', () => ({ notify: (...a: unknown[]) => h.notify(...a) }));
vi.mock('@/lib/audit', () => ({ logAudit: (...a: unknown[]) => h.logAudit(...a) }));
vi.mock('@/lib/apps/events', () => ({ emitAppEvent: vi.fn() }));
vi.mock('@/lib/conversions/emit', () => ({ queueConversions: vi.fn() }));

import { Prisma } from '@prisma/client';
import { POST as amend } from '@/app/api/v1/orders/[id]/amend/route';
import { POST as cancel } from '@/app/api/v1/orders/[id]/cancel/route';
import { GET as getOrder } from '@/app/api/v1/orders/[id]/route';
import { REPLIES_SCOPES } from './system-token';
import { AMEND_ACTION, CANCEL_ACTION } from './order-amend';

const ROOT = process.cwd();

const TAKEN = new Prisma.PrismaClientKnownRequestError('taken', { code: 'P2002', clientVersion: 'test' });

/** The five scopes a replies key was minted with before 18/11. */
const OLD_REPLIES_SCOPES = ['products.read', 'customers.lookup', 'orders.create', 'orders.read', 'orders.note'];

let tokenSeq = 0;
/** The stored key the real guard reads. A fresh id each time: the guard's per-minute allowance is the token's. */
function useToken(over: { system?: string; companyId?: string; scopes?: readonly string[] } = {}) {
  h.db.systemToken.findUnique.mockResolvedValue({
    id: `tok_${++tokenSeq}`,
    companyId: over.companyId ?? 'c1',
    system: over.system ?? 'replies',
    scopes: JSON.stringify(over.scopes ?? REPLIES_SCOPES),
    rateLimitPerMin: 60,
    expiresAt: null,
    revokedAt: null,
    lastUsedAt: new Date(),
  });
}

/** An order the replies system created for company c1, nobody has touched: two packs of honey for 30, in Amman. */
const fixture = (over: Record<string, unknown> = {}) => ({
  id: 'o1',
  companyId: 'c1',
  orderNumber: 'SY-2026-0148',
  version: 3,
  source: 'replies',
  confirmationStatus: 'NEW',
  shippingStatus: 'NOT_READY',
  shippingBatchId: null,
  trackingNumber: null,
  labelPrintedAt: null,
  countryId: 'jo',
  storeId: 's1',
  regionId: 'amm',
  customerId: 'cu1',
  productId: 'p1',
  offerId: null,
  sellingPrice: 30,
  shippingCost: 0,
  discountAmount: 0,
  deliveryFee: null,
  totalAmount: 30,
  currency: 'JOD',
  deliveryAddress: null,
  customerNotes: null,
  moderatorId: null,
  assignedToId: null,
  currentOwnerId: null,
  nextFollowUpAt: null,
  followUpStatus: null,
  customer: { id: 'cu1', fullName: 'أحمد', phone: '790123456', rawPhone: '0790123456', address: 'شارع 5', city: 'عمّان' },
  store: { id: 's1', country: { id: 'jo', code: 'JO', currencyCode: 'JOD', minorUnit: 3 } },
  items: [{ id: 'l1', productName: 'عسل', quantity: 2, freeQuantity: 0, discountShare: 0, reservedQty: 0, deliveredQty: null, returnedQty: null }],
  ...over,
});

let stored: ReturnType<typeof fixture>;

const CATALOGUE = [
  { id: 'p1', sku: 'HON', name: 'عسل', image: null, basePrice: 15 },
  { id: 'p2', sku: 'OIL', name: 'زيت', image: null, basePrice: 8 },
];

const ledger = new Map<string, { requestHash: string; status: number; response: string }>();

const call = (path: 'amend' | 'cancel', payload: unknown, key: string | null = 'k1', id = 'o1') =>
  new Request(`https://oms.test/api/v1/orders/${id}/${path}`, {
    method: 'POST',
    body: JSON.stringify(payload),
    headers: { authorization: 'Bearer zk1_test', ...(key ? { 'idempotency-key': key } : {}), 'x-request-id': 'rep_1' },
  });
const params = (id = 'o1') => ({ params: Promise.resolve({ id }) });
const doAmend = (payload: unknown, key: string | null = 'k1', id = 'o1') => amend(call('amend', payload, key, id), params(id));
const doCancel = (payload: unknown, key: string | null = 'k1', id = 'o1') => cancel(call('cancel', payload, key, id), params(id));

/** Nothing was written anywhere. */
function expectUntouched() {
  expect(h.db.order.updateMany).not.toHaveBeenCalled();
  expect(h.db.customer.update).not.toHaveBeenCalled();
  expect(h.db.orderItem.deleteMany).not.toHaveBeenCalled();
  expect(h.db.orderItem.createMany).not.toHaveBeenCalled();
  expect(h.db.orderActivity.create).not.toHaveBeenCalled();
  expect(h.endOrder).not.toHaveBeenCalled();
}

beforeEach(() => {
  vi.clearAllMocks();
  ledger.clear();
  useToken();
  stored = fixture();
  // The WHERE is the proof of ownership: only the company's, and only what THIS system created, is found.
  h.db.order.findFirst.mockImplementation(async ({ where }: { where: { id: string; companyId: string; source?: string } }) =>
    where.id === stored.id && where.companyId === stored.companyId && (where.source === undefined || where.source === stored.source) ? stored : null
  );
  h.db.order.updateMany.mockResolvedValue({ count: 1 });
  h.db.orderItem.deleteMany.mockResolvedValue({ count: 1 });
  h.db.orderItem.createMany.mockResolvedValue({ count: 1 });
  h.db.orderAddOn.findMany.mockResolvedValue([]);
  h.db.orderActivity.create.mockResolvedValue({});
  h.db.orderContactAttempt.findFirst.mockResolvedValue(null);
  h.db.orderContactAttempt.create.mockResolvedValue({});
  h.db.customer.findFirst.mockResolvedValue(null);
  h.db.customer.update.mockResolvedValue({});
  h.db.region.findMany.mockResolvedValue([{ id: 'amm', name: 'عمّان' }, { id: 'irb', name: 'إربد' }]);
  h.db.user.findFirst.mockResolvedValue({ id: 'admin1', role: 'COMPANY_ADMIN' });
  h.db.product.findMany.mockImplementation(async ({ where }: { where: { sku: { in: string[] } } }) =>
    CATALOGUE.filter((p) => where.sku.in.includes(p.sku))
  );
  h.db.systemToken.update.mockResolvedValue({});
  h.db.$transaction.mockImplementation((fn: (tx: unknown) => Promise<unknown>) => fn(h.db));
  h.db.idempotencyRecord.create.mockImplementation(async ({ data }: { data: { companyId: string; key: string; requestHash: string; status: number; response: string } }) => {
    const k = `${data.companyId}|${data.key}`;
    if (ledger.has(k)) throw TAKEN;
    ledger.set(k, { requestHash: data.requestHash, status: data.status, response: data.response });
    return {};
  });
  h.db.idempotencyRecord.findUnique.mockImplementation(
    async ({ where }: { where: { companyId_key: { companyId: string; key: string } } }) =>
      ledger.get(`${where.companyId_key.companyId}|${where.companyId_key.key}`) ?? null
  );
  h.db.idempotencyRecord.update.mockImplementation(
    async ({ where, data }: { where: { companyId_key: { companyId: string; key: string } }; data: { status: number; response: string } }) => {
      Object.assign(ledger.get(`${where.companyId_key.companyId}|${where.companyId_key.key}`)!, data);
      return {};
    }
  );
  h.db.idempotencyRecord.deleteMany.mockImplementation(async ({ where }: { where: { companyId: string; key: string; status: number } }) => {
    const k = `${where.companyId}|${where.key}`;
    if (ledger.get(k)?.status === where.status) ledger.delete(k);
    return { count: 1 };
  });
  h.activeOffersFor.mockResolvedValue([]);
  h.activeBlock.mockResolvedValue(null);
  h.unitCostsOf.mockResolvedValue(new Map());
  h.priceIncludesDeliveryFor.mockResolvedValue(false);
  h.afterCommit.mockResolvedValue(undefined);
  h.endOrder.mockResolvedValue({ ok: true, orderNumber: 'SY-2026-0148', attested: false, tookOff: false, courierCancelled: false, afterCommit: h.afterCommit });
});

describe('amending an order the replies system created', () => {
  it('is 200, the values change on the order and the customer, and the desk gets a history line with the difference', async () => {
    const res = await doAmend({
      customer: { name: 'أحمد علي', phone: '0791234567', address: 'شارع 9، الدوار 7' },
      notes: 'بعد الساعة 5',
      reason: 'الزبون غيّر الرقم بالمحادثة',
    });
    expect(res.status).toBe(200);
    const answer = await res.json();
    expect(answer).toEqual({
      order_id: 'o1',
      order_number: 'SY-2026-0148',
      status: 'NEW',
      price_adjusted: false,
      // Read from the stored columns — the lines did not change, so nothing was recomputed.
      totals: { subtotal: '30.000', discount: '0.000', delivery_fee: '0.000', total: '30.000', currency: 'JOD' },
    });

    // The customer's own row: name, the number in both forms, the street.
    expect(h.db.customer.update).toHaveBeenCalledTimes(1);
    expect(h.db.customer.update.mock.calls[0][0]).toEqual({
      where: { id: 'cu1' },
      data: { fullName: 'أحمد علي', phone: '791234567', rawPhone: '0791234567', address: 'شارع 9، الدوار 7' },
    });
    // The order's own columns: the parcel's address and the note, under the row's version.
    const write = h.db.order.updateMany.mock.calls[0][0];
    expect(write.where).toMatchObject({ id: 'o1', companyId: 'c1', version: 3 });
    expect(write.data).toMatchObject({ deliveryAddress: 'شارع 9، الدوار 7', customerNotes: 'بعد الساعة 5', version: { increment: 1 } });

    // THE LINE THE CONFIRMATION STAFF SEE.
    expect(h.db.orderActivity.create).toHaveBeenCalledTimes(1);
    const line = h.db.orderActivity.create.mock.calls[0][0].data;
    expect(line).toMatchObject({ companyId: 'c1', orderId: 'o1', userId: null, action: AMEND_ACTION });
    const meta = JSON.parse(line.metadata);
    expect(meta.system).toBe('replies');
    expect(meta.amendReason).toBe('الزبون غيّر الرقم بالمحادثة');
    expect(meta.diff).toEqual(
      expect.arrayContaining([
        'اسم الزبون: أحمد ← أحمد علي',
        'رقم الهاتف: 0790123456 ← 0791234567',
        'العنوان: شارع 5 ← شارع 9، الدوار 7',
        'ملاحظات الزبون: — ← بعد الساعة 5',
      ])
    );
    // And the people holding the order are told.
    expect(h.notify).toHaveBeenCalledTimes(1);
    expect(h.notify.mock.calls[0][0]).toMatchObject({ companyId: 'c1', orderId: 'o1' });
  });

  it('and a value the order already holds is not a change: nothing is written, nobody is told', async () => {
    const res = await doAmend({ customer: { name: 'أحمد', phone: '0790123456', address: 'شارع 5' } });
    expect(res.status).toBe(200);
    expectUntouched();
    expect(h.notify).not.toHaveBeenCalled();
  });

  it('and a city is bound to a real governorate, the one the delivery table is keyed on', async () => {
    await doAmend({ customer: { city: 'إربد' } });
    expect(h.db.order.updateMany.mock.calls[0][0].data).toMatchObject({ regionId: 'irb' });
    expect(h.db.customer.update.mock.calls[0][0].data).toMatchObject({ city: 'إربد' });
  });

  it('and a body that asks for nothing is 422, with the key still free', async () => {
    const res = await doAmend({ reason: 'تجربة' });
    expect(res.status).toBe(422);
    expect((await res.json()).error.code).toBe('VALIDATION_FAILED');
    expect(h.db.idempotencyRecord.create).not.toHaveBeenCalled();
    expectUntouched();
  });

  it('and the refusal names fields, never values — a customer’s phone does not travel into an error log', async () => {
    const res = await doAmend({ customer: { phone: '1' } });
    expect(res.status).toBe(422);
    const text = JSON.stringify(await res.json());
    expect(text).toContain('customer.phone');
    expect(text).not.toContain('"1"');
  });

  it('and a key is required, as on every write', async () => {
    const res = await doAmend({ notes: 'x' }, null);
    expect(res.status).toBe(400);
    expect((await res.json()).error.code).toBe('IDEMPOTENCY_KEY_REQUIRED');
  });
});

describe('whose order it is', () => {
  it('another system’s order is 404 — and the source is in the WHERE, with the company, from the token', async () => {
    useToken({ system: 'mediabuyer', scopes: [...REPLIES_SCOPES] });
    const res = await doAmend({ notes: 'خذوا بالكم' });
    expect(res.status).toBe(404);
    expect((await res.json()).error.code).toBe('NOT_FOUND');
    expect(h.db.order.findFirst.mock.calls[0][0].where).toEqual({ id: 'o1', companyId: 'c1', source: 'mediabuyer' });
    // Before a key is burned, so the caller can retry with the right id.
    expect(h.db.idempotencyRecord.create).not.toHaveBeenCalled();
    expectUntouched();
  });

  it('another company’s order is 404, not 403 — a 403 would confirm the id exists', async () => {
    useToken({ companyId: 'c_other' });
    const res = await doAmend({ notes: 'x' });
    expect(res.status).toBe(404);
    expect(h.db.order.findFirst.mock.calls[0][0].where.companyId).toBe('c_other');
    expectUntouched();
  });

  it('and so are a cancel on either of them', async () => {
    useToken({ system: 'mediabuyer' });
    expect((await doCancel({ reason: 'x' })).status).toBe(404);
    useToken({ companyId: 'c_other' });
    expect((await doCancel({ reason: 'x' }, 'k2')).status).toBe(404);
    expectUntouched();
  });
});

describe('until when', () => {
  const NOT_EDITABLE_STATES: [string, Record<string, unknown>][] = [
    ['confirmed', { confirmationStatus: 'CONFIRMED' }],
    ['rejected', { confirmationStatus: 'REJECTED' }],
    ['cancelled', { confirmationStatus: 'CANCELLED' }],
    ['on a batch', { shippingBatchId: 'b1' }],
    ['with a barcode', { trackingNumber: 'T-1' }],
    ['with a printed label', { labelPrintedAt: new Date('2026-11-17T10:00:00Z') }],
    ['past «not ready»', { shippingStatus: 'PACKED' }],
  ];

  it.each(NOT_EDITABLE_STATES)('an order %s is 409 NOT_EDITABLE, and nothing about it changes', async (_name, over) => {
    stored = fixture(over);
    const res = await doAmend({ customer: { address: 'عنوان جديد' }, notes: 'x' });
    expect(res.status).toBe(409);
    expect((await res.json()).error.code).toBe('NOT_EDITABLE');
    expectUntouched();
    // The key is given back: a 409 about the order is a fact the retry meets afresh.
    expect(ledger.size).toBe(0);
  });

  it('and one confirmed (or put on a trolley) between the read and the write is refused by the write itself', async () => {
    h.db.order.updateMany.mockResolvedValue({ count: 0 });
    const res = await doAmend({ notes: 'متأخر' });
    expect(res.status).toBe(409);
    expect((await res.json()).error.code).toBe('NOT_EDITABLE');
    // The same condition the read asked, carried by the write.
    const where = h.db.order.updateMany.mock.calls[0][0].where;
    expect(where).toMatchObject({
      version: 3,
      confirmationStatus: { notIn: ['CONFIRMED', 'REJECTED', 'CANCELLED'] },
      shippingStatus: 'NOT_READY',
      shippingBatchId: null,
      trackingNumber: null,
      labelPrintedAt: null,
    });
    expect(h.db.orderActivity.create).not.toHaveBeenCalled();
  });

  it.each(NOT_EDITABLE_STATES.filter(([n]) => n !== 'rejected' && n !== 'cancelled'))(
    'and a cancel of an order %s is 409 NOT_EDITABLE too — a person’s call from there',
    async (_name, over) => {
      stored = fixture(over);
      const res = await doCancel({ reason: 'تراجع' });
      expect(res.status).toBe(409);
      expect((await res.json()).error.code).toBe('NOT_EDITABLE');
      expectUntouched();
    }
  );
});

describe('the same key', () => {
  it('twice answers the same reply, and the order is amended once', async () => {
    const body = { customer: { address: 'شارع 9' }, notes: 'x' };
    const first = await doAmend(body, 'rev1');
    const again = await doAmend(body, 'rev1');
    expect(first.status).toBe(200);
    expect(again.status).toBe(200);
    expect(await again.json()).toEqual(await first.json());
    expect(h.db.order.updateMany).toHaveBeenCalledTimes(1);
    expect(h.db.orderActivity.create).toHaveBeenCalledTimes(1);
    expect(h.notify).toHaveBeenCalledTimes(1);
  });

  it('with a different body is 409 IDEMPOTENCY_CONFLICT, and the second change is not made', async () => {
    await doAmend({ notes: 'الأولى' }, 'rev1');
    const res = await doAmend({ notes: 'الثانية' }, 'rev1');
    expect(res.status).toBe(409);
    expect((await res.json()).error.code).toBe('IDEMPOTENCY_CONFLICT');
    expect(h.db.order.updateMany).toHaveBeenCalledTimes(1);
  });

  it('on a cancel twice is one end, answered the same', async () => {
    const first = await doCancel({ reason: 'تراجع' }, 'c1');
    const again = await doCancel({ reason: 'تراجع' }, 'c1');
    expect(await again.json()).toEqual(await first.json());
    expect(h.endOrder).toHaveBeenCalledTimes(1);
  });

  it('and one key used on the other door is a conflict, not a replay of the wrong answer', async () => {
    await doAmend({ notes: 'x' }, 'shared');
    const res = await doCancel({ notes: 'x' }, 'shared');
    expect(res.status).toBe(409);
    expect((await res.json()).error.code).toBe('IDEMPOTENCY_CONFLICT');
  });
});

describe('the phone', () => {
  it('on the blacklist is 422 CUSTOMER_BLACKLISTED, and the reason is not sent', async () => {
    h.activeBlock.mockResolvedValue({ reason: 'احتيال' });
    const res = await doAmend({ customer: { phone: '0791234567' } });
    expect(res.status).toBe(422);
    const answer = await res.json();
    expect(answer.error.code).toBe('CUSTOMER_BLACKLISTED');
    expect(JSON.stringify(answer)).not.toContain('احتيال');
    // Asked on the number as sent, which is what the blacklist canonicalises.
    expect(h.activeBlock.mock.calls[0][2]).toBe('0791234567');
    expectUntouched();
  });

  it('that is not a number of the store’s country is 422 INVALID_PHONE', async () => {
    const res = await doAmend({ customer: { phone: '1234567' } });
    expect(res.status).toBe(422);
    expect((await res.json()).error.code).toBe('INVALID_PHONE');
    expectUntouched();
  });

  it('that another customer of the store already holds is 409 DUPLICATE_PHONE, as the staff screen refuses it', async () => {
    h.db.customer.findFirst.mockResolvedValue({ id: 'cu2' });
    const res = await doAmend({ customer: { phone: '0791234567' } });
    expect(res.status).toBe(409);
    expect((await res.json()).error.code).toBe('DUPLICATE_PHONE');
    expect(h.db.customer.findFirst.mock.calls[0][0].where).toMatchObject({ companyId: 'c1', storeId: 's1', id: { not: 'cu1' } });
    expectUntouched();
  });
});

describe('the lines', () => {
  it('are repriced from the OMS catalogue — nothing the caller sends is a price', async () => {
    const res = await doAmend({
      items: [
        // A price the caller invented is read by nothing.
        { product_code: 'HON', quantity: 1, unit_price: '0.01', line_total: '0.01' },
        { product_code: 'OIL', quantity: 3 },
      ],
      totals: { delivery_fee: '0.00', total: '0.02' },
    });
    expect(res.status).toBe(200);
    const answer = await res.json();
    // 1 × 15 + 3 × 8 = 39, no discount, no fee.
    expect(answer.totals).toEqual({ subtotal: '39.000', discount: '0.000', delivery_fee: '0.000', total: '39.000', currency: 'JOD' });
    expect(answer.price_adjusted).toBe(false);

    expect(h.db.order.updateMany.mock.calls[0][0].data).toMatchObject({
      productId: 'p1',
      quantity: 4,
      sellingPrice: 39,
      totalAmount: 39,
      shippingCost: 0,
      productNameSnapshot: 'عسل',
    });
    expect(h.db.orderItem.deleteMany).toHaveBeenCalledWith({ where: { orderId: 'o1' } });
    const lines = h.db.orderItem.createMany.mock.calls[0][0].data;
    expect(lines).toHaveLength(2);
    expect(lines[0]).toMatchObject({ orderId: 'o1', productId: 'p1', quantity: 1, unitPrice: 15, lineTotal: 15, addedStage: 'INTAKE' });
    expect(lines[1]).toMatchObject({ productId: 'p2', quantity: 3, unitPrice: 8, lineTotal: 24 });

    const meta = JSON.parse(h.db.orderActivity.create.mock.calls[0][0].data.metadata);
    expect(meta.diff).toEqual(expect.arrayContaining(['البنود: عسل ×2 ← عسل ×1 + زيت ×3', 'المجموع: 30 ← 39']));
    expect(meta.total).toBe(39);
  });

  it('honour an advertised bundle on its exact quantity, as the order door does', async () => {
    h.activeOffersFor.mockResolvedValue([{ id: 'of2', name: 'عبوتان', quantity: 2, freeQuantity: 0, price: 25, listPrice: 30, deliveryIncluded: false }]);
    stored = fixture({ totalAmount: 15, sellingPrice: 15, items: [{ ...fixture().items[0], quantity: 1 }] });
    const res = await doAmend({ items: [{ product_code: 'HON', quantity: 2 }] });
    const answer = await res.json();
    expect(answer.totals).toMatchObject({ subtotal: '30.000', discount: '5.000', total: '25.000' });
    expect(h.db.order.updateMany.mock.calls[0][0].data).toMatchObject({ offerId: 'of2', totalAmount: 25 });
  });

  it('say price_adjusted when our catalogue disagrees with the subtotal the customer was quoted', async () => {
    const res = await doAmend({ items: [{ product_code: 'HON', quantity: 3 }], totals: { subtotal: '40.00' } });
    const answer = await res.json();
    expect(answer.totals.subtotal).toBe('45.000');
    expect(answer.price_adjusted).toBe(true);
    const agreed = await doAmend({ items: [{ product_code: 'HON', quantity: 4 }], totals: { subtotal: '60.00' } }, 'k2');
    expect((await agreed.json()).price_adjusted).toBe(false);
  });

  it('only of this order’s own store: a code that is not on sale there is 422 PRODUCT_UNKNOWN', async () => {
    const res = await doAmend({ items: [{ product_code: 'NOPE', quantity: 1 }] });
    expect(res.status).toBe(422);
    const answer = await res.json();
    expect(answer.error.code).toBe('PRODUCT_UNKNOWN');
    expect(h.db.product.findMany.mock.calls[0][0].where).toMatchObject({ companyId: 'c1', storeId: 's1', status: 'ACTIVE' });
    expectUntouched();
  });

  it.each([
    ['a discount a person gave', { discountAmount: 3 }],
    ['a delivery fee a person set', { shippingCost: 2 }],
    ['a delivery fee the courier table wrote', { deliveryFee: 2 }],
    ['goods the warehouse reserved', { items: [{ ...fixture().items[0], reservedQty: 2 }] }],
  ])('are not rewritten on an order with %s — 409 NOT_EDITABLE LINES_LOCKED, while the customer data may still change', async (_name, over) => {
    stored = fixture(over);
    const res = await doAmend({ items: [{ product_code: 'HON', quantity: 1 }] });
    expect(res.status).toBe(409);
    const answer = await res.json();
    expect(answer.error.code).toBe('NOT_EDITABLE');
    expect(answer.error.details).toEqual({ reason: 'LINES_LOCKED' });
    expectUntouched();

    const still = await doAmend({ customer: { address: 'شارع 9' } }, 'k2');
    expect(still.status).toBe(200);
    expect(h.db.orderItem.deleteMany).not.toHaveBeenCalled();
  });
});

describe('cancelling', () => {
  it('ends the order through endOrder as REJECTED — «غيّر رأيه» — and leaves the history line', async () => {
    const res = await doCancel({ reason: 'العميل تراجع بالمحادثة' });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ order_id: 'o1', order_number: 'SY-2026-0148', status: 'REJECTED', already: false });

    expect(h.endOrder).toHaveBeenCalledTimes(1);
    expect(h.endOrder.mock.calls[0][0]).toMatchObject({
      orderId: 'o1',
      companyId: 'c1',
      door: 'CONFIRMATION',
      kind: 'CANCEL',
      endAs: 'REJECTED',
      reason: 'CUSTOMER_CHANGED_MIND',
      rejectionNote: 'العميل تراجع بالمحادثة',
      expectedVersion: 3,
    });
    // A name on the bookkeeping rows, and never a client-supplied identity.
    expect(h.endOrder.mock.calls[0][0].by).toMatchObject({ id: 'admin1', role: 'COMPANY_ADMIN' });
    expect(h.db.orderContactAttempt.create.mock.calls[0][0].data).toMatchObject({ orderId: 'o1', result: 'REJECTED' });
    expect(h.db.orderActivity.create.mock.calls[0][0].data).toMatchObject({ orderId: 'o1', userId: null, action: CANCEL_ACTION });
    // Announced only after the commit, as every door that ends an order does.
    expect(h.afterCommit).toHaveBeenCalledTimes(1);
  });

  it('a second cancel — with a new key, after it has ended — is 200 already:true and ends nothing twice', async () => {
    await doCancel({ reason: 'تراجع' }, 'c1');
    // The order is REJECTED now.
    stored = fixture({ confirmationStatus: 'REJECTED' });
    h.endOrder.mockClear();
    const again = await doCancel({ reason: 'تراجع' }, 'c2');
    expect(again.status).toBe(200);
    expect(await again.json()).toEqual({ order_id: 'o1', order_number: 'SY-2026-0148', status: 'REJECTED', already: true });
    expect(h.endOrder).not.toHaveBeenCalled();
  });

  it('an order the desk got to first is the same «already», and a body without a reason is allowed', async () => {
    h.endOrder.mockResolvedValue({ ok: false, status: 409, code: 'ALREADY_ENDED', error: 'x' });
    const res = await doCancel({});
    expect(res.status).toBe(200);
    expect((await res.json()).already).toBe(true);
  });

  it('refused by the courier or the trolley is 409 NOT_EDITABLE, with the helper’s own code as the reason', async () => {
    h.endOrder.mockResolvedValue({ ok: false, status: 409, code: 'ON_OPEN_TROLLEY', error: 'x' });
    const res = await doCancel({ reason: 'تراجع' });
    expect(res.status).toBe(409);
    const answer = await res.json();
    expect(answer.error.code).toBe('NOT_EDITABLE');
    expect(answer.error.details).toEqual({ reason: 'ON_OPEN_TROLLEY' });
  });
});

describe('the scopes', () => {
  it('a key minted before them is 403 SCOPE_MISSING on both, naming the scope it lacks', async () => {
    useToken({ scopes: OLD_REPLIES_SCOPES });
    const a = await doAmend({ notes: 'x' });
    expect(a.status).toBe(403);
    expect((await a.json()).error).toMatchObject({ code: 'SCOPE_MISSING', details: { required: 'orders.amend' } });
    const c = await doCancel({ reason: 'x' }, 'k2');
    expect(c.status).toBe(403);
    expect((await c.json()).error).toMatchObject({ code: 'SCOPE_MISSING', details: { required: 'orders.cancel' } });
    expectUntouched();
    expect(h.db.order.findFirst).not.toHaveBeenCalled();
  });

  it('and one scope is not the other', async () => {
    useToken({ scopes: [...OLD_REPLIES_SCOPES, 'orders.amend'] });
    expect((await doAmend({ notes: 'x' })).status).toBe(200);
    expect((await doCancel({ reason: 'x' }, 'k2')).status).toBe(403);
  });

  it('a new replies key starts with both; the old five are what a key made before keeps', () => {
    expect(REPLIES_SCOPES).toEqual(expect.arrayContaining([...OLD_REPLIES_SCOPES, 'orders.amend', 'orders.cancel']));
    expect(REPLIES_SCOPES).toHaveLength(7);
  });

  it('and the old keys still read, create and note exactly as before', async () => {
    useToken({ scopes: OLD_REPLIES_SCOPES });
    h.db.order.findFirst.mockResolvedValue({ ...stored, updatedAt: new Date('2026-11-18T10:00:00Z'), store: { country: { timezone: 'Asia/Amman' } } });
    const res = await getOrder(new Request('https://oms.test/api/v1/orders/o1', { headers: { authorization: 'Bearer zk1_test' } }), params());
    expect(res.status).toBe(200);
  });
});

describe('the status read says whether the order is still editable', () => {
  const read = async (over: Record<string, unknown>) => {
    h.db.order.findFirst.mockResolvedValue({
      id: 'o1',
      orderNumber: 'SY-2026-0148',
      confirmationStatus: 'NEW',
      shippingStatus: 'NOT_READY',
      shippingBatchId: null,
      trackingNumber: null,
      labelPrintedAt: null,
      updatedAt: new Date('2026-11-18T10:00:00Z'),
      store: { country: { timezone: 'Asia/Amman' } },
      ...over,
    });
    const res = await getOrder(new Request('https://oms.test/api/v1/orders/o1', { headers: { authorization: 'Bearer zk1_test' } }), params());
    return res.json();
  };

  it('true before the confirmation, false after it', async () => {
    expect((await read({})).editable).toBe(true);
    expect((await read({ confirmationStatus: 'FOLLOW_UP_REQUIRED' })).editable).toBe(true);
    const after = await read({ confirmationStatus: 'CONFIRMED' });
    expect(after.editable).toBe(false);
    expect(after.status).toBe('CONFIRMED');
  });

  it('false on a shipment and once ended', async () => {
    expect((await read({ shippingBatchId: 'b1' })).editable).toBe(false);
    expect((await read({ trackingNumber: 'T-1' })).editable).toBe(false);
    expect((await read({ labelPrintedAt: new Date() })).editable).toBe(false);
    expect((await read({ shippingStatus: 'SHIPPED' })).editable).toBe(false);
    expect((await read({ confirmationStatus: 'REJECTED' })).editable).toBe(false);
  });

  it('and the amend answers 409 exactly where the read says false', async () => {
    stored = fixture({ confirmationStatus: 'CONFIRMED' });
    expect((await read({ confirmationStatus: 'CONFIRMED' })).editable).toBe(false);
    expect((await doAmend({ notes: 'x' })).status).toBe(409);
  });
});

describe('one answer to «is it editable?», not three', () => {
  const src = (p: string) => readFileSync(join(ROOT, p), 'utf8');

  it('the landing chat, the status read and the amend door all ask `order-editable.ts` — none holds a copy', () => {
    const chat = src('src/lib/v1/landing-chat.ts');
    expect(chat).toMatch(/from '\.\.\/order-editable'/);
    expect(chat).not.toMatch(/function onShipment|function chatEditable|const DECIDED/);
    expect(src('src/app/api/v1/orders/[id]/route.ts')).toMatch(/orderEditable\(order\)/);
    const door = src('src/lib/v1/order-amend.ts');
    expect(door).toMatch(/from '\.\.\/order-editable'/);
    expect(door).not.toMatch(/function onShipment|const DECIDED/);
  });
});
