import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The landing confirmation chat's six doors (contract oms-lp.v1 §8), answering.
 * `the-systems-door.test.ts` sweeps them for the key, the idempotency and the absence of a model; this file holds what
 * they decide: who may ask, what each decision writes, and that nothing is written twice.
 */

const h = vi.hoisted(() => ({
  db: {
    order: { findFirst: vi.fn(), updateMany: vi.fn(), update: vi.fn() },
    orderItem: { update: vi.fn() },
    orderAddOn: { count: vi.fn(), findMany: vi.fn() },
    orderActivity: { count: vi.fn(), create: vi.fn() },
    orderContactAttempt: { findFirst: vi.fn(), create: vi.fn() },
    orderStatusLog: { create: vi.fn() },
    orderNote: { create: vi.fn() },
    customer: { update: vi.fn() },
    user: { findFirst: vi.fn() },
    country: { findFirst: vi.fn() },
    region: { findMany: vi.fn() },
    deliveryFee: { findMany: vi.fn() },
    store: { findFirst: vi.fn() },
    product: { findFirst: vi.fn() },
    company: { findUnique: vi.fn() },
    $transaction: vi.fn(),
  },
  requireSystemToken: vi.fn(),
  claimIdempotency: vi.fn(),
  rememberIdempotency: vi.fn(),
  releaseIdempotency: vi.fn(),
  verifyAddonTokenWithin: vi.fn(),
  activeOffersFor: vi.fn(),
  unitCostsOf: vi.fn(),
  guardConfirmAgainstTwins: vi.fn(),
  reserveOrderLines: vi.fn(),
  endOrder: vi.fn(),
  afterCommit: vi.fn(),
  emitAppEvent: vi.fn(),
  queueConversions: vi.fn(),
  notify: vi.fn(),
  logAudit: vi.fn(),
}));

vi.mock('@/lib/db', () => ({ db: h.db }));
vi.mock('@/lib/v1/system-token', async () => {
  const real = await vi.importActual<typeof import('./system-token')>('./system-token');
  return { ...real, requireSystemToken: (...a: unknown[]) => h.requireSystemToken(...a) };
});
vi.mock('@/lib/v1/idempotency', async () => {
  const real = await vi.importActual<typeof import('./idempotency')>('./idempotency');
  return {
    ...real,
    claimIdempotency: (...a: unknown[]) => h.claimIdempotency(...a),
    rememberIdempotency: (...a: unknown[]) => h.rememberIdempotency(...a),
    releaseIdempotency: (...a: unknown[]) => h.releaseIdempotency(...a),
  };
});
vi.mock('@/lib/landing-pages', async () => {
  const real = await vi.importActual<typeof import('../landing-pages')>('../landing-pages');
  return { ...real, verifyAddonTokenWithin: (...a: unknown[]) => h.verifyAddonTokenWithin(...a) };
});
vi.mock('@/lib/offers', async () => {
  const real = await vi.importActual<typeof import('../offers')>('../offers');
  return { ...real, activeOffersFor: (...a: unknown[]) => h.activeOffersFor(...a) };
});
vi.mock('@/lib/product-fixed-cost', () => ({ unitCostsOf: (...a: unknown[]) => h.unitCostsOf(...a) }));
vi.mock('@/lib/confirmed-twin', async () => {
  const real = await vi.importActual<typeof import('../confirmed-twin')>('../confirmed-twin');
  return { ...real, guardConfirmAgainstTwins: (...a: unknown[]) => h.guardConfirmAgainstTwins(...a) };
});
vi.mock('@/lib/reservation', async () => {
  const real = await vi.importActual<typeof import('../reservation')>('../reservation');
  return { ...real, reserveOrderLines: (...a: unknown[]) => h.reserveOrderLines(...a) };
});
vi.mock('@/lib/order-cancel', async () => {
  const real = await vi.importActual<typeof import('../order-cancel')>('../order-cancel');
  return { ...real, endOrder: (...a: unknown[]) => h.endOrder(...a) };
});
vi.mock('@/lib/apps/events', () => ({ emitAppEvent: (...a: unknown[]) => h.emitAppEvent(...a) }));
vi.mock('@/lib/conversions/emit', () => ({ queueConversions: (...a: unknown[]) => h.queueConversions(...a) }));
vi.mock('@/lib/notify', () => ({ notify: (...a: unknown[]) => h.notify(...a) }));
vi.mock('@/lib/audit', () => ({ logAudit: (...a: unknown[]) => h.logAudit(...a) }));

import { CHAT_ACTION, CHAT_ACTOR_AR } from './landing-chat';
import { GET as getOrder } from '@/app/api/v1/landing/orders/[orderNumber]/route';
import { POST as confirm } from '@/app/api/v1/landing/orders/[orderNumber]/confirm/route';
import { POST as cancel } from '@/app/api/v1/landing/orders/[orderNumber]/cancel/route';
import { POST as address } from '@/app/api/v1/landing/orders/[orderNumber]/address/route';
import { POST as offer } from '@/app/api/v1/landing/orders/[orderNumber]/offer/route';
import { POST as followUp } from '@/app/api/v1/landing/orders/[orderNumber]/follow-up/route';

const N = 'JO-2026-0007';
const TOKEN = 't'.repeat(40);
const CALLER = { tokenId: 't', companyId: 'c1', system: 'landing', scopes: [] };
const STORE = { id: 's1', name: 'متجر', status: 'ACTIVE', countryId: 'jo', theme: null, country: { code: 'JO', currencyCode: 'JOD', orderPrefix: 'JO', minorUnit: 3 } };
const PRODUCT = { id: 'p1', sku: 'A', name: 'عسل', description: null, image: null, basePrice: 15, status: 'ACTIVE', storeId: 's1', store: STORE };
const catalogue = (id: string, name: string, quantity: number, price: number) => ({
  id, name, quantity, freeQuantity: 0, price, listPrice: null, compareAtPrice: null, isDefault: id === 'o2', deliveryIncluded: false, endsAt: null,
});
const ONE = catalogue('o1', 'عبوة', 1, 15);
const TWO = catalogue('o2', 'عبوتان', 2, 22);
const THREE = catalogue('o3', '3 عبوات', 3, 30);

/** An order the landing door placed an hour ago: two packs for 22, in Amman, nobody has touched it. */
const row = (over: Record<string, unknown> = {}) => ({
  id: 'ord1', orderNumber: N, version: 2, createdAt: new Date(Date.now() - 3_600_000), source: 'Landing Page', landingPageId: null,
  status: 'NEW', confirmationStatus: 'NEW', shippingStatus: 'NOT_READY', shippingBatchId: null, trackingNumber: null, labelPrintedAt: null,
  currency: 'JOD', totalAmount: 22, priceIncludesDelivery: false, productId: 'p1', offerId: 'o2', storeId: 's1', countryId: 'jo',
  customerId: 'cu1', replacesOrderId: null, regionId: 'amm', confirmedAt: null, nextFollowUpAt: null, followUpStatus: null, moderatorId: null,
  deliveryAddress: 'شارع 5', customerNotes: null, discountAmount: 0, shippingCost: 0, deliveryFee: null,
  region: { name: 'عمّان' }, store: { name: 'متجر', countryId: 'jo' }, offer: { id: 'o2', name: 'عبوتان' },
  customer: { fullName: 'أحمد', phone: '962790123456', rawPhone: '0790123456', address: 'شارع 5', city: 'عمّان' },
  items: [{ id: 'line1', productId: 'p1', productName: 'عسل', quantity: 2, freeQuantity: 0, lineTotal: 22, reservedQty: 0, deliveredQty: null }],
  _count: { contactAttempts: 0 },
  ...over,
});

const ctx = (orderNumber = N) => ({ params: Promise.resolve({ orderNumber }) });
const post = (path: string, body: object, key: string | null = 'k1') =>
  new Request(`https://x.test/api/v1/landing/orders/${N}/${path}`, {
    method: 'POST',
    headers: key ? { 'idempotency-key': key } : {},
    body: JSON.stringify({ token: TOKEN, ...body }),
  });
const read = (token = TOKEN) => getOrder(new Request(`https://x.test/api/v1/landing/orders/${N}?token=${token}`), ctx());
const activities = () => h.db.orderActivity.create.mock.calls.map((c) => c[0].data);

beforeEach(() => {
  vi.clearAllMocks();
  h.requireSystemToken.mockResolvedValue(CALLER);
  h.claimIdempotency.mockResolvedValue(null);
  h.verifyAddonTokenWithin.mockResolvedValue({ orderId: 'ord1', orderNumber: N });
  h.db.order.findFirst.mockResolvedValue(row());
  h.db.order.updateMany.mockResolvedValue({ count: 1 });
  h.db.order.update.mockResolvedValue({ id: 'ord1' });
  h.db.orderContactAttempt.findFirst.mockResolvedValue(null);
  h.db.orderAddOn.findMany.mockResolvedValue([]);
  h.db.user.findFirst.mockResolvedValue({ id: 'admin', role: 'COMPANY_ADMIN' });
  h.db.country.findFirst.mockResolvedValue({ allowNegativeStock: false });
  h.db.region.findMany.mockResolvedValue([{ id: 'amm', name: 'عمّان' }, { id: 'irb', name: 'إربد' }]);
  h.db.deliveryFee.findMany.mockResolvedValue([{ fee: 2.5 }]);
  h.db.store.findFirst.mockResolvedValue({ priceIncludesDelivery: false });
  h.db.product.findFirst.mockResolvedValue(PRODUCT);
  h.db.$transaction.mockImplementation((fn: (tx: unknown) => unknown) => fn(h.db));
  h.activeOffersFor.mockResolvedValue([ONE, TWO, THREE]);
  h.unitCostsOf.mockResolvedValue(new Map([['p1', 4]]));
  h.guardConfirmAgainstTwins.mockResolvedValue([]);
  h.reserveOrderLines.mockResolvedValue({ reserved: 1, shortages: [] });
  h.afterCommit.mockResolvedValue(undefined);
  h.endOrder.mockResolvedValue({ ok: true, orderNumber: N, attested: false, tookOff: false, courierCancelled: false, afterCommit: h.afterCommit });
});

describe('who may ask', () => {
  it('a wrong or expired token is 401, before anything is read', async () => {
    h.verifyAddonTokenWithin.mockResolvedValue(null);
    const res = await read();
    expect(res.status).toBe(401);
    expect(typeof (await res.json()).error).toBe('string');
    expect(h.db.order.findFirst).not.toHaveBeenCalled();
    expect(h.verifyAddonTokenWithin.mock.calls[0][1]).toBe(72);
  });

  it('a token for another order is 401 too', async () => {
    h.verifyAddonTokenWithin.mockResolvedValue({ orderId: 'ord9', orderNumber: 'JO-2026-0009' });
    expect((await read()).status).toBe(401);
    expect((await confirm(post('confirm', {}), ctx())).status).toBe(401);
    expect(h.db.order.updateMany).not.toHaveBeenCalled();
  });

  it('another company’s order is 404, looked up under the key’s company only', async () => {
    h.db.order.findFirst.mockResolvedValue(null);
    const res = await read();
    expect(res.status).toBe(404);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe('NOT_FOUND');
    expect(h.db.order.findFirst.mock.calls[0][0].where).toEqual({ companyId: 'c1', id: 'ord1', orderNumber: N });
  });

  it('an order that did not come through the landing door is 404', async () => {
    for (const other of [{ source: 'Manual' }, { landingPageId: 'lp-in-oms' }]) {
      h.db.order.findFirst.mockResolvedValue(row(other));
      expect((await read()).status).toBe(404);
    }
  });

  it('72 hours after the order the token no longer opens it', async () => {
    h.db.order.findFirst.mockResolvedValue(row({ createdAt: new Date(Date.now() - 73 * 3_600_000) }));
    expect((await read()).status).toBe(401);
  });
});

describe('the order as the chat reads it', () => {
  it('is the stored total, the fee the quote shows, and the product’s live offers', async () => {
    const res = await read();
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      orderNumber: N, confirmationStatus: 'NEW', editable: true, storeName: 'متجر', currency: 'JOD', minorUnit: 3, paymentMethod: 'COD',
      customer: { name: 'أحمد', phone: '0790123456', city: 'عمّان', address: 'شارع 5', notes: '' },
      items: [{ productId: 'p1', name: 'عسل', offerId: 'o2', offerName: 'عبوتان', quantity: 2, freeQuantity: 0, price: 22 }],
      offers: [{ id: 'o1', price: 15 }, { id: 'o2', price: 22 }, { id: 'o3', price: 30 }],
      total: 22, cod: 24.5, deliveryFee: 2.5, deliveryIncluded: false, feeKnown: true, feeExact: true,
    });
  });

  it('is not editable once confirmed or on a shipment', async () => {
    for (const over of [{ confirmationStatus: 'CONFIRMED' }, { shippingBatchId: 'b1' }, { confirmationStatus: 'REJECTED' }]) {
      h.db.order.findFirst.mockResolvedValue(row(over));
      expect((await (await read()).json()).editable).toBe(false);
    }
  });
});

describe('confirm', () => {
  it('confirms the way the agent does: attempt, the write, the stock, the logs, then order.confirmed once', async () => {
    const res = await confirm(post('confirm', {}), ctx());
    expect(res.status).toBe(200);
    expect(h.db.orderContactAttempt.create.mock.calls[0][0].data).toMatchObject({ result: 'CONFIRMED', contactMethod: 'OTHER', attemptNumber: 1, employeeId: 'admin' });
    const write = h.db.order.updateMany.mock.calls[0][0];
    expect(write.where).toEqual({ id: 'ord1', companyId: 'c1', version: 2 });
    expect(write.data).toMatchObject({ confirmationStatus: 'CONFIRMED', status: 'CONFIRMED', confirmedById: null });
    expect(h.guardConfirmAgainstTwins).toHaveBeenCalledTimes(1);
    expect(h.reserveOrderLines).toHaveBeenCalledWith(h.db, 'ord1', { allowNegativeStock: false });
    expect(h.db.orderStatusLog.create.mock.calls[0][0].data).toMatchObject({ previousValue: 'NEW', newValue: 'CONFIRMED', statusType: 'CONFIRMATION' });
    expect(activities().map((a) => a.action)).toEqual(['STATUS_CHANGED', CHAT_ACTION.CONFIRMED]);
    expect(JSON.parse(activities()[1].metadata).source).toBe(CHAT_ACTOR_AR);
    expect(h.emitAppEvent).toHaveBeenCalledTimes(1);
    expect(h.emitAppEvent.mock.calls[0][1]).toBe('order.confirmed');
    expect(h.emitAppEvent.mock.calls[0][2]).toMatchObject({ orderId: 'ord1', orderNumber: N, confirmationStatus: 'CONFIRMED', total: 22, currency: 'JOD' });
    expect(h.logAudit.mock.calls[0][0]).toMatchObject({ action: 'ORDER_CONFIRMED', userId: null });
    expect((await res.json()).order.orderNumber).toBe(N);
    expect(h.rememberIdempotency).toHaveBeenCalledWith('c1', 'k1', 200, expect.objectContaining({ order: expect.any(Object) }));
  });

  it('an order already confirmed answers already:true, and nothing is logged, reserved or announced again', async () => {
    h.db.order.findFirst.mockResolvedValue(row({ confirmationStatus: 'CONFIRMED', status: 'CONFIRMED' }));
    const res = await confirm(post('confirm', {}), ctx());
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.already).toBe(true);
    expect(body.order.confirmationStatus).toBe('CONFIRMED');
    expect(h.db.orderContactAttempt.create).not.toHaveBeenCalled();
    expect(h.db.order.updateMany).not.toHaveBeenCalled();
    expect(h.db.orderStatusLog.create).not.toHaveBeenCalled();
    expect(h.reserveOrderLines).not.toHaveBeenCalled();
    expect(h.emitAppEvent).not.toHaveBeenCalled();
  });

  it('a rejected or cancelled order is 409 NOT_ELIGIBLE', async () => {
    for (const status of ['REJECTED', 'CANCELLED']) {
      h.db.order.findFirst.mockResolvedValue(row({ confirmationStatus: status }));
      const res = await confirm(post('confirm', {}), ctx());
      expect(res.status).toBe(409);
      expect(await res.json()).toMatchObject({ reason: 'NOT_ELIGIBLE' });
    }
    expect(h.db.order.updateMany).not.toHaveBeenCalled();
    expect(h.releaseIdempotency).toHaveBeenCalledTimes(2);
  });

  it('never answers the confirmed-twin question for a person: 409, nothing announced', async () => {
    h.guardConfirmAgainstTwins.mockResolvedValue([{ id: 'other', orderNumber: 'JO-2026-0001' }]);
    const res = await confirm(post('confirm', {}), ctx());
    expect(res.status).toBe(409);
    expect((await res.json()).reason).toBe('TWIN_CONFIRMED');
    expect(h.db.order.updateMany).not.toHaveBeenCalled();
    expect(h.emitAppEvent).not.toHaveBeenCalled();
  });
});

describe('cancel', () => {
  it('ends the order through endOrder, as the agent’s «رفض» for a customer who changed their mind', async () => {
    const res = await cancel(post('cancel', { reason: 'غيرت رأيي' }), ctx());
    expect(res.status).toBe(200);
    expect(h.endOrder).toHaveBeenCalledTimes(1);
    expect(h.endOrder.mock.calls[0][0]).toMatchObject({
      orderId: 'ord1', companyId: 'c1', door: 'CONFIRMATION', kind: 'CANCEL', endAs: 'REJECTED',
      reason: 'CUSTOMER_CHANGED_MIND', rejectionNote: 'غيرت رأيي', expectedVersion: 2, tx: h.db,
      by: { id: 'admin', name: CHAT_ACTOR_AR, role: 'COMPANY_ADMIN' },
    });
    expect(h.afterCommit).toHaveBeenCalledTimes(1);
    expect(h.db.orderContactAttempt.create.mock.calls[0][0].data.result).toBe('REJECTED');
    expect(activities().map((a) => a.action)).toEqual([CHAT_ACTION.CANCELLED]);
  });

  it('a second cancel answers already:true and ends nothing', async () => {
    h.db.order.findFirst.mockResolvedValue(row({ confirmationStatus: 'REJECTED' }));
    const res = await cancel(post('cancel', { reason: 'x' }), ctx());
    expect(res.status).toBe(200);
    expect((await res.json()).already).toBe(true);
    expect(h.endOrder).not.toHaveBeenCalled();
  });

  it('a confirmed order, or one on a shipment, is 409', async () => {
    for (const over of [{ confirmationStatus: 'CONFIRMED' }, { shippingBatchId: 'b1' }]) {
      h.db.order.findFirst.mockResolvedValue(row(over));
      expect((await cancel(post('cancel', { reason: 'x' }), ctx())).status).toBe(409);
    }
    expect(h.endOrder).not.toHaveBeenCalled();
  });
});

describe('address', () => {
  it('a city that is not one of the regions is 400 with fieldErrors.city', async () => {
    const res = await address(post('address', { city: 'Paris', address: 'Rue 1' }), ctx());
    expect(res.status).toBe(400);
    expect((await res.json()).fieldErrors.city).toMatch(/المدينة/);
    expect(h.db.order.updateMany).not.toHaveBeenCalled();
  });

  it('is 409 once the order is no longer editable', async () => {
    h.db.order.findFirst.mockResolvedValue(row({ confirmationStatus: 'CONFIRMED' }));
    const res = await address(post('address', { city: 'إربد', address: 'شارع 9' }), ctx());
    expect(res.status).toBe(409);
    expect(h.db.order.updateMany).not.toHaveBeenCalled();
  });

  it('writes the governorate and the parcel’s street, under the version', async () => {
    const res = await address(post('address', { city: 'إربد', address: 'شارع 9' }), ctx());
    expect(res.status).toBe(200);
    expect(h.db.order.updateMany.mock.calls[0][0]).toMatchObject({
      where: { id: 'ord1', companyId: 'c1', version: 2 },
      data: { regionId: 'irb', deliveryAddress: 'شارع 9' },
    });
    expect(h.db.customer.update.mock.calls[0][0]).toEqual({ where: { id: 'cu1' }, data: { address: 'شارع 9' } });
    expect(activities().map((a) => a.action)).toEqual([CHAT_ACTION.ADDRESS]);
  });
});

describe('offer', () => {
  it('rewrites the line to another catalogue offer, at the catalogue’s price', async () => {
    const res = await offer(post('offer', { offerId: 'o3' }), ctx());
    expect(res.status).toBe(200);
    expect(h.db.orderItem.update.mock.calls[0][0]).toEqual({
      where: { id: 'line1' },
      data: { quantity: 3, freeQuantity: 0, unitPrice: 10, discountShare: 0, lineTotal: 30 },
    });
    const head = h.db.order.update.mock.calls[1][0].data;
    expect(head).toMatchObject({ offerId: 'o3', quantity: 3, sellingPrice: 30, totalAmount: 30, estimatedCostOfGoods: 12 });
    const line = activities().find((a) => a.action === CHAT_ACTION.OFFER)!;
    expect(JSON.parse(line.metadata)).toMatchObject({ from: { offerId: 'o2', total: 22 }, to: { offerId: 'o3', total: 30 }, by: CHAT_ACTOR_AR });
  });

  it('can go down as well as up — no «larger only», no «once»', async () => {
    h.db.orderActivity.count.mockResolvedValue(3);
    const res = await offer(post('offer', { offerId: 'o1' }), ctx());
    expect(res.status).toBe(200);
    expect(h.db.order.update.mock.calls[1][0].data).toMatchObject({ offerId: 'o1', totalAmount: 15 });
  });

  it('an offer that is not the product’s is 404; a non-editable order is 409', async () => {
    expect((await offer(post('offer', { offerId: 'nope' }), ctx())).status).toBe(404);
    h.db.order.findFirst.mockResolvedValue(row({ confirmationStatus: 'CONFIRMED' }));
    expect((await offer(post('offer', { offerId: 'o3' }), ctx())).status).toBe(409);
    expect(h.db.orderItem.update).not.toHaveBeenCalled();
  });
});

describe('follow-up', () => {
  it('«call me» moves the order to FOLLOW_UP_REQUIRED with the date and a note for the desk', async () => {
    const when = new Date(Date.now() + 86_400_000).toISOString();
    const res = await followUp(post('follow-up', { kind: 'callback', note: 'بعد العصر', when }), ctx());
    expect(res.status).toBe(200);
    expect(h.db.order.updateMany.mock.calls[0][0].data).toMatchObject({
      confirmationStatus: 'FOLLOW_UP_REQUIRED', nextFollowUpAt: new Date(when), followUpStatus: 'SCHEDULED', followUpReason: 'CUSTOMER_REQUESTED_CALLBACK',
    });
    expect(h.db.orderContactAttempt.create.mock.calls[0][0].data.result).toBe('CALLBACK_REQUESTED');
    expect(h.db.orderNote.create.mock.calls[0][0].data).toMatchObject({ kind: 'follow_up', authorId: null });
    expect(h.db.orderNote.create.mock.calls[0][0].data.body).toContain(CHAT_ACTOR_AR);
    expect(h.db.orderStatusLog.create.mock.calls[0][0].data).toMatchObject({ previousValue: 'NEW', newValue: 'FOLLOW_UP_REQUIRED' });
  });

  it('«a person, please» does the same without a date', async () => {
    const res = await followUp(post('follow-up', { kind: 'human', note: 'أريد موظفًا' }), ctx());
    expect(res.status).toBe(200);
    const data = h.db.order.updateMany.mock.calls[0][0].data;
    expect(data.confirmationStatus).toBe('FOLLOW_UP_REQUIRED');
    expect(data.nextFollowUpAt).toBeUndefined();
    expect(h.db.orderNote.create.mock.calls[0][0].data.body).toContain('أريد موظفًا');
  });

  it('a confirmed order keeps its status and gets the note', async () => {
    h.db.order.findFirst.mockResolvedValue(row({ confirmationStatus: 'CONFIRMED' }));
    const res = await followUp(post('follow-up', { kind: 'human' }), ctx());
    expect(res.status).toBe(200);
    expect(h.db.order.updateMany).not.toHaveBeenCalled();
    expect(h.db.orderNote.create).toHaveBeenCalledTimes(1);
  });

  it('a cancelled order is 409; a date in the past is 400', async () => {
    h.db.order.findFirst.mockResolvedValue(row({ confirmationStatus: 'CANCELLED' }));
    expect((await followUp(post('follow-up', { kind: 'callback' }), ctx())).status).toBe(409);
    h.db.order.findFirst.mockResolvedValue(row());
    const res = await followUp(post('follow-up', { kind: 'callback', when: '2020-01-01T00:00:00Z' }), ctx());
    expect(res.status).toBe(400);
    expect((await res.json()).fieldErrors.when).toBeTruthy();
  });
});

describe('the same key is the same answer', () => {
  it('a replay returns the stored answer and writes nothing', async () => {
    h.claimIdempotency.mockResolvedValue({ status: 200, body: { order: { orderNumber: N, confirmationStatus: 'CONFIRMED' } } });
    for (const [door, path, extra] of [
      [confirm, 'confirm', {}],
      [cancel, 'cancel', { reason: 'x' }],
      [offer, 'offer', { offerId: 'o3' }],
    ] as const) {
      const res = await door(post(path, extra), ctx());
      expect(res.status).toBe(200);
      expect((await res.json()).order.confirmationStatus).toBe('CONFIRMED');
    }
    expect(h.db.order.findFirst).not.toHaveBeenCalled();
    expect(h.db.order.updateMany).not.toHaveBeenCalled();
    expect(h.endOrder).not.toHaveBeenCalled();
    expect(h.emitAppEvent).not.toHaveBeenCalled();
  });

  it('a write without a key is refused', async () => {
    expect((await confirm(post('confirm', {}, null), ctx())).status).toBe(400);
    expect(h.db.order.updateMany).not.toHaveBeenCalled();
  });
});

describe('every decision has words on the order’s history', () => {
  it('the timeline names each of the chat’s lines', () => {
    const src = readFileSync(join(process.cwd(), 'src/lib/order-timeline.ts'), 'utf8');
    for (const action of Object.values(CHAT_ACTION)) expect(src).toContain(`${action}: '${CHAT_ACTOR_AR}`);
  });
});
