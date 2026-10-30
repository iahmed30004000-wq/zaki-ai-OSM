import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { OrderEditFacts, StoredLine } from '@/lib/order-line-edit';
import type { LinesChange } from '@/lib/change-request-fields';

/**
 * ═══════════════════════════════════════════════════════════════════════
 * WHAT A STORED `lines` REQUEST WOULD DO TODAY — the read the decider's screen draws its table from.
 *
 * The route here is the REAL `GET /api/control/change-requests/:id/preview`, with the real routing rule, the real lines
 * engine and the real review library. Only what reads the world is a fake: the database, the permission check and the
 * facts reader.
 *
 * Held: who may ask (and the SAME 404 for everyone who may not), that it is a READ (a database that fails on any write),
 * the rate budget it shares with the raising screen, and that the answer carries no cost and no profit.
 * ═══════════════════════════════════════════════════════════════════════
 */

const CREAM = 'prod-cream-0001';
const SOAP = 'prod-soap-00002';
const L1 = 'line-cream-1';
const L2 = 'line-soap-2';

type Fn = (...a: unknown[]) => unknown;

const { db, requireContext, can, rateLimit, logAudit, state } = vi.hoisted(() => ({
  db: {
    orderChangeRequest: {
      findFirst: vi.fn<(args: { where: Record<string, unknown> }) => Promise<unknown>>(),
      create: vi.fn<Fn>(),
      update: vi.fn<Fn>(),
      updateMany: vi.fn<Fn>(),
      delete: vi.fn<Fn>(),
    },
    order: { update: vi.fn<Fn>(), updateMany: vi.fn<Fn>() },
    orderItem: { createMany: vi.fn<Fn>(), deleteMany: vi.fn<Fn>(), update: vi.fn<Fn>() },
    orderNote: { create: vi.fn<Fn>() },
    $transaction: vi.fn<Fn>(),
  },
  requireContext: vi.fn<(...a: unknown[]) => Promise<unknown>>(),
  can: vi.fn<(...a: unknown[]) => boolean>(),
  rateLimit: vi.fn<(key: string, max: number, windowMs: number) => { allowed: boolean; retryAfterSec: number }>(),
  logAudit: vi.fn<Fn>(),
  state: { facts: null as unknown, facted: 0 },
}));

vi.mock('@/lib/db', () => ({ db }));
vi.mock('@/lib/geo-context', () => ({ requireContext: (...a: unknown[]) => requireContext(...a) }));
vi.mock('@/lib/authorization', () => ({ can: (...a: unknown[]) => can(...a) }));
vi.mock('@/lib/rate-limit', () => ({ rateLimit: (key: string, max: number, windowMs: number) => rateLimit(key, max, windowMs) }));
vi.mock('@/lib/audit', () => ({ logAudit: (...a: unknown[]) => logAudit(...a) }));
vi.mock('@/lib/reservation', () => ({ availableStock: vi.fn() }));
vi.mock('@/lib/order-edit-facts', () => ({
  readOrderEditFacts: async () => {
    state.facted += 1;
    return state.facts;
  },
}));

import { GET } from './route';
import { PREVIEWS_PER_MINUTE, previewRateKey } from '@/lib/change-request-raise-lines';

const stored = (over: Partial<StoredLine> & { id: string }): StoredLine => ({
  productId: CREAM,
  productName: 'كريم',
  quantity: 3,
  freeQuantity: 0,
  lineTotal: 36,
  reservedQty: 3,
  deliveredQty: null,
  returnedQty: null,
  ...over,
});

const factsOf = (): OrderEditFacts => ({
  minorUnit: 3,
  allowNegativeStock: false,
  order: {
    confirmed: true,
    closed: false,
    handed: false,
    labelled: false,
    statementLinked: false,
    priceIncludesDelivery: false,
    storedTotal: 48.5,
    shippingCost: 2.5,
    deliveryFee: null,
    discount: 0,
    version: 7,
  },
  lines: [stored({ id: L1 }), stored({ id: L2, productId: SOAP, productName: 'صابون', quantity: 2, lineTotal: 10, reservedQty: 2 })],
  addOns: [],
  products: [
    { id: CREAM, name: 'كريم', basePrice: 12, status: 'ACTIVE' },
    { id: SOAP, name: 'صابون', basePrice: 5, status: 'ACTIVE' },
  ],
  offers: [],
  orderOffer: null,
  available: { [CREAM]: 100, [SOAP]: 100 },
  shipmentCod: 48.5,
  customer: { phoneInvalid: false, altPhoneInvalid: false, phoneDuplicate: false, regionOutsideCountry: false, regionFee: null },
});

const FIVE: LinesChange = {
  v: 2,
  edits: [
    {
      lineId: L1,
      productId: { from: CREAM, to: CREAM },
      quantity: { from: 3, to: 5 },
      lineTotal: { from: 36, to: 60 },
      unitPrice: { from: 12, to: 12 },
      freeQuantity: { from: 0, to: 0 },
      basis: 'KEEP_UNIT',
    },
  ],
  snapshot: {
    orderVersion: 7,
    before: { cod: 48.5 },
    after: { cod: 72.5 },
  },
};

const ROW = (over: Record<string, unknown> = {}, orderOver: Record<string, unknown> = {}) => ({
  id: 'cr1',
  status: 'PENDING',
  appliedAt: null,
  requestedById: 'rim',
  changes: { lines: FIVE },
  order: {
    id: 'o1',
    countryId: 'jo',
    customerId: 'cu1',
    regionId: null,
    deliveryProviderId: null,
    confirmationStatus: 'CONFIRMED',
    claimedById: null,
    shippingStatus: 'NOT_READY',
    shippedAt: null,
    labelPrintedAt: null,
    trackingNumber: null,
    courierSendStartedAt: null,
    settlementStatus: 'NOT_APPLICABLE',
    priceIncludesDelivery: false,
    totalAmount: 48.5,
    shippingCost: 2.5,
    deliveryFee: null,
    discountAmount: 0,
    offerId: null,
    version: 7,
    shippingBatch: null,
    ...orderOver,
  },
  ...over,
});

const country = { code: 'JO', minorUnit: 3, allowNegativeStock: false };
const as = (id: string) => requireContext.mockResolvedValue({ user: { id, name: id, role: 'CUSTOM' }, companyId: 'c1', storeId: 's1', country });
const holds = (...keys: string[]) => can.mockImplementation((_user, key) => keys.includes(key as string));

const ask = async () => {
  const res = await GET(new Request('http://localhost/x'), { params: Promise.resolve({ id: 'cr1' }) });
  return { status: res.status, headers: res.headers, body: (await res.json()) as Record<string, any> };
};

const writers = [
  db.orderChangeRequest.create,
  db.orderChangeRequest.update,
  db.orderChangeRequest.updateMany,
  db.orderChangeRequest.delete,
  db.order.update,
  db.order.updateMany,
  db.orderItem.createMany,
  db.orderItem.deleteMany,
  db.orderItem.update,
  db.orderNote.create,
  db.$transaction,
  logAudit,
];

beforeEach(() => {
  vi.clearAllMocks();
  state.facts = factsOf();
  state.facted = 0;
  as('sami');
  holds('control.change_requests_view', 'control.change_requests', 'orders.change_price');
  db.orderChangeRequest.findFirst.mockResolvedValue(ROW());
  rateLimit.mockReturnValue({ allowed: true, retryAfterSec: 0 });
});

/* ─────────────────────────── 1 · the answer ─────────────────────────── */

describe('Ⅰ · the answer', () => {
  it('the supervisor gets the order now and with the request in it', async () => {
    const res = await ask();
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.requestId).toBe('cr1');
    expect(res.body.blocked).toBe(false);
    expect(res.body.before.cod).toBe(48.5);
    expect(res.body.after.cod).toBe(72.5);
    expect(res.body.lines[0]).toMatchObject({ lineId: L1, productName: { from: 'كريم', to: 'كريم' }, quantity: { from: 3, to: 5 } });
    expect(res.body.drift).toEqual({ known: true, moved: false, items: [] });
    expect(res.headers.get('Cache-Control')).toBe('no-store');
  });

  it('shuts the request that can no longer be carried out, with the reason in Arabic', async () => {
    state.facts = { ...factsOf(), available: { [CREAM]: 4, [SOAP]: 100 } };
    const res = await ask();
    expect(res.status).toBe(200);
    expect(res.body.blocked).toBe(true);
    const reason = (res.body.problems as Array<{ blocking: boolean; messageAr: string }>).find((p) => p.blocking);
    expect(reason?.messageAr).toContain('كريم');
  });

  it('carries no cost, no profit, no revenue and no shelf balance', async () => {
    const res = await ask();
    const text = JSON.stringify(res.body).toLowerCase();
    for (const word of ['revenue', 'profit', 'margin', 'cost', 'needed', 'missing', 'available']) expect(text, word).not.toContain(word);
  });
});

/* ─────────────────────────── 2 · who may ask ─────────────────────────── */

describe('Ⅱ · who may ask — and the same 404 for everyone who may not', () => {
  const NOT_FOUND = 'طلب التعديل غير موجود';

  it('asks the database for the request of THIS company and THIS store only', async () => {
    await ask();
    const where = db.orderChangeRequest.findFirst.mock.calls[0]?.[0].where;
    expect(where).toMatchObject({ id: 'cr1', companyId: 'c1', order: { storeId: 's1' } });
  });

  it('a request of another company or another store is not found — and nothing was read about it', async () => {
    db.orderChangeRequest.findFirst.mockResolvedValue(null);
    const res = await ask();
    expect(res.status).toBe(404);
    expect(res.body.errorAr).toBe(NOT_FOUND);
    expect(state.facted).toBe(0);
  });

  it('somebody who neither sees the desk, nor raised it, nor holds the order gets the same 404', async () => {
    as('stranger');
    holds();
    const res = await ask();
    expect(res.status).toBe(404);
    expect(res.body.errorAr).toBe(NOT_FOUND);
    expect(state.facted).toBe(0);
    expect(rateLimit).not.toHaveBeenCalled();
  });

  it('the person who raised it may look at it, and so may the agent holding the order before confirmation', async () => {
    as('rim');
    holds();
    expect((await ask()).status).toBe(200);

    as('holder');
    holds('control.change_requests');
    db.orderChangeRequest.findFirst.mockResolvedValue(ROW({}, { confirmationStatus: 'IN_PROGRESS', claimedById: 'holder' }));
    expect((await ask()).status).toBe(200);
  });

  it('the packing table may look while the parcel is still ours, and not after the courier has it', async () => {
    as('keeper');
    holds('ops.decide_changes');
    expect((await ask()).status).toBe(200);

    db.orderChangeRequest.findFirst.mockResolvedValue(ROW({}, { shippingStatus: 'SHIPPED', shippedAt: new Date('2026-10-20T10:00:00Z') }));
    expect((await ask()).status).toBe(404);
  });

  it('looking is not deciding: a supervisor without the price key still sees the table', async () => {
    holds('control.change_requests_view', 'control.change_requests');
    expect((await ask()).status).toBe(200);
  });
});

/* ─────────────────────────── 3 · what it will not preview ─────────────────────────── */

describe('Ⅲ · what it will not preview', () => {
  it('a request that edits no lines answers 400 and does not read the order', async () => {
    db.orderChangeRequest.findFirst.mockResolvedValue(ROW({ changes: { customerName: { from: 'أ', to: 'ب' } } }));
    const res = await ask();
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('NOT_LINES');
    expect(state.facted).toBe(0);
  });

  it('lines that cannot be read answer 422', async () => {
    db.orderChangeRequest.findFirst.mockResolvedValue(ROW({ changes: { lines: { v: 2, edits: [] } } }));
    const res = await ask();
    expect(res.status).toBe(422);
    expect(res.body.code).toBe('LINES_UNREADABLE');
  });

  it('a request already decided against, withdrawn or carried out has nothing left to check', async () => {
    for (const row of [
      ROW({ status: 'REJECTED' }),
      ROW({ status: 'CANCELLED' }),
      ROW({ status: 'APPROVED', appliedAt: new Date('2026-10-20T10:00:00Z') }),
    ]) {
      db.orderChangeRequest.findFirst.mockResolvedValue(row);
      const res = await ask();
      expect(res.status).toBe(409);
      expect(res.body.code).toBe('NOT_OPEN');
    }
    // Approved and not yet carried out is exactly the request the second tab holds.
    db.orderChangeRequest.findFirst.mockResolvedValue(ROW({ status: 'APPROVED' }));
    expect((await ask()).status).toBe(200);
  });
});

/* ─────────────────────────── 4 · a read, and a budget ─────────────────────────── */

describe('Ⅳ · it is a read', () => {
  it('writes, locks, notifies and logs nothing — whatever it answers', async () => {
    await ask();
    state.facts = { ...factsOf(), lines: factsOf().lines.map((l) => ({ ...l, quantity: 9 })) };
    await ask();
    db.orderChangeRequest.findFirst.mockResolvedValue(ROW({ changes: { lines: { v: 2, edits: [] } } }));
    await ask();
    for (const w of writers) expect(w).not.toHaveBeenCalled();
  });
});

describe('Ⅴ · the budget it shares with the raising screen', () => {
  it('draws on the same count per person, in the same company', async () => {
    await ask();
    expect(rateLimit).toHaveBeenCalledWith(previewRateKey('c1', 'sami'), PREVIEWS_PER_MINUTE, 60 * 1000);
  });

  it('answers 429 with the wait, and reads nothing when the budget is spent', async () => {
    rateLimit.mockReturnValue({ allowed: false, retryAfterSec: 12 });
    const res = await ask();
    expect(res.status).toBe(429);
    expect(res.headers.get('Retry-After')).toBe('12');
    expect(res.body.code).toBe('RATE_LIMITED');
    expect(state.facted).toBe(0);
  });
});
