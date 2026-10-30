import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * WHO EACH EVENT IS ANNOUNCED TO.
 *
 * createNotification is replaced here and the routes run for real, so each
 * test reads the audience a route asks for: which permission, which named
 * people, which store, and who is left out. That the audience is then
 * resolved correctly is notification-audience.test.ts's job.
 *
 *   new order            confirmation.supervise, in the order's store
 *   confirmed/rejected   confirmation.supervise + the order's moderator, not the actor
 *   failed delivery      ops.track, in the order's store
 *   change request       the holding agent before operations, else whoever
 *                        holds control.change_requests or a supervising role
 *                        (the same rule the routing decides by); never the
 *                        requester
 */

const { db, requireContext, assertOrderAccess, can, createNotification } = vi.hoisted(() => {
  const db: any = {
    order: { findFirst: vi.fn(), findUnique: vi.fn(), updateMany: vi.fn() },
    orderChangeRequest: { findFirst: vi.fn(), create: vi.fn(), update: vi.fn(async () => ({})) },
    // The raiser may decide it themselves when the parcel has not left, so
    // the door reads the seal before it queues anything.
    shippingBatch: { findFirst: vi.fn(async () => null) },
    orderChannel: { findFirst: vi.fn(async () => null) },
    orderNote: { create: vi.fn() },
    orderStatusLog: { create: vi.fn() },
    orderActivity: { create: vi.fn() },
    orderItem: { create: vi.fn() },
    // Ending an order counts the customer's cancellation (`endOrder`, the one helper every cancel door uses).
    customer: { update: vi.fn(async () => ({})) },
    /*
     * The holder has already rung the customer. These tests are about WHO
     * gets told when a decision is made, not about the rule that a holder
     * must try to reach the customer before deciding — which is
     * `contact-first.test.ts`.
     */
    orderContactAttempt: { count: vi.fn(async () => 1) },
    // A FAILED_DELIVERY transition now writes its attempt in the same
    // transaction as the status.
    deliveryAttempt: {
      findFirst: vi.fn(async () => null),
      create: vi.fn(async () => ({ id: 'attempt-1', attemptNumber: 1 })),
    },
    user: { findUnique: vi.fn(), findMany: vi.fn() },
    region: { findMany: vi.fn() },
    offer: { findMany: vi.fn() },
    // The store's pricing policy, asked by every order door.
    store: { findFirst: vi.fn(async () => ({ priceIncludesDelivery: false })) },
    // What the goods cost. The storefront used to write a literal zero here
    // and promise that finance would fill it in; it now reads the same
    // weighted average every other order door reads. No batches on hand
    // averages to zero, which is the honest answer for an empty shelf.
    productionBatch: { findMany: vi.fn(async () => []) },
    landingPageRecommendation: { findMany: vi.fn() },
    $transaction: vi.fn(),
  };
  return {
    db,
    requireContext: vi.fn(),
    assertOrderAccess: vi.fn(),
    can: vi.fn(),
    createNotification: vi.fn(),
  };
});

vi.mock('@/lib/db', () => ({ db }));
vi.mock('@/lib/geo-context', () => ({ requireContext: (...a: unknown[]) => requireContext(...a) }));
vi.mock('@/lib/rbac', () => ({ assertOrderAccess: (...a: unknown[]) => assertOrderAccess(...a) }));
vi.mock('@/lib/audit', () => ({ logAudit: vi.fn() }));
vi.mock('@/lib/notification', () => ({ createNotification: (...a: unknown[]) => createNotification(...a) }));
vi.mock('@/lib/authorization', () => ({
  can: (...a: unknown[]) => can(...a),
  authorize: () => ({ allowed: true }),
  requirePermission: vi.fn(),
}));
vi.mock('@/lib/reservation', () => ({
  reserveOrderLines: vi.fn(),
  releaseOrderLines: vi.fn(),
  orderLinesForGuard: vi.fn(async () => []),
}));
vi.mock('@/lib/apps/events', () => ({ emitAppEvent: vi.fn() }));
vi.mock('@/lib/conversions/emit', () => ({ queueConversions: vi.fn() }));
vi.mock('@/lib/customer-identity', () => ({
  findOrCreateCustomer: vi.fn(async () => ({ id: 'cust-1', firstOrderDate: null })),
}));
vi.mock('@/lib/order-ref', () => ({ orderRefFields: vi.fn(async () => ({ orderNumber: 'ORD-77' })) }));
vi.mock('@/lib/blacklist', () => ({ isBlocked: vi.fn(async () => false), NEUTRAL_REFUSAL: 'x' }));
vi.mock('@/lib/landing-pages', () => ({ signAddonToken: vi.fn(async () => 'token') }));

import { POST as confirmationPOST } from '@/app/api/orders/[id]/confirmation/route';
import { POST as shippingPOST } from '@/app/api/orders/[id]/shipping/route';
import { POST as changeRequestPOST } from '@/app/api/orders/[id]/change-requests/route';
import { createPublicOrder } from '@/lib/public-order';

const actor = { id: 'actor-1', name: 'منفّذ', role: 'CONFIRMATION_AGENT', status: 'ACTIVE' };
const ctx = {
  user: actor, companyId: 'c1', storeId: 'store-a', countryId: 'jo',
  country: {
    id: 'jo', code: 'JO', name: 'الأردن', currencyCode: 'JOD', minorUnit: 3, timezone: 'Asia/Amman',
    orderPrefix: 'ORD', allowNegativeStock: false, workHoursStart: '09:00', workHoursEnd: '17:00', weekendDays: [5],
  },
};
const order = (over: Record<string, unknown> = {}) => ({
  id: 'o1', companyId: 'c1', storeId: 'store-a', orderNumber: 'ORD-1', version: 1,
  moderatorId: 'mod-1', claimedById: null,
  confirmationStatus: 'IN_PROGRESS', shippingStatus: 'NOT_READY',
  lockedById: null, lockExpiresAt: null, shippedAt: null, nextFollowUpAt: null, followUpStatus: null,
  ...over,
});
const params = { params: Promise.resolve({ id: 'o1' }) };
const post = (body: unknown) =>
  new Request('http://localhost/x', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

beforeEach(() => {
  vi.clearAllMocks();
  requireContext.mockResolvedValue(ctx);
  /*
   * `false` for everything EXCEPT the permission that recording a call now
   * needs. This file is about WHO GETS TOLD when a confirmation ends, and
   * `orders.unlock` must stay false here — that is the override this suite
   * deliberately does not hold. `orders.contact_log` is new and is simply
   * the door into the `contact_result` action these cases drive.
   */
  // OLD → NEW (PR-6): + `orders.request_change` — raising a change request is its own key now (the `change request` cases below).
  can.mockImplementation((_u: unknown, key: string) => key === 'orders.contact_log' || key === 'orders.request_change');
  createNotification.mockResolvedValue(1);
  db.$transaction.mockImplementation(async (fn: any) => (typeof fn === 'function' ? fn(db) : fn));
  db.order.updateMany.mockResolvedValue({ count: 1 });
  db.order.findUnique.mockResolvedValue(order());
  db.orderChangeRequest.findFirst.mockResolvedValue(null);
});

describe('a confirmation outcome', () => {
  it('goes to this store\'s supervisors and the order\'s moderator, not to the agent who decided it', async () => {
    assertOrderAccess.mockResolvedValue({ allowed: true, order: order() });
    // What `endOrder` reads: the order as it is now, with its trolley (none).
    db.order.findFirst.mockResolvedValue({
      ...order(), labelPrintedAt: null, shippingBatchId: null, deliveryProviderId: null, trackingNumber: null,
      courierSendStartedAt: null, totalAmount: 10, currency: 'JOD', customerId: 'cust-1', shippingBatch: null,
    });
    const res = await confirmationPOST(
      post({ action: 'reject', rejectionReason: 'PRICE_TOO_HIGH', expectedVersion: 1 }),
      params
    );
    expect(res.status).toBe(200);
    expect(createNotification).toHaveBeenCalledTimes(1);
    expect(createNotification.mock.calls[0][0]).toMatchObject({
      companyId: 'c1',
      storeId: 'store-a',
      audience: { permission: 'confirmation.supervise', userIds: ['mod-1'] },
      actorId: 'actor-1',
      title: 'رفض طلب',
    });
  });

  it('a step that is not an outcome announces nothing', async () => {
    assertOrderAccess.mockResolvedValue({ allowed: true, order: order() });
    const res = await confirmationPOST(post({ action: 'contact_result', result: 'NO_ANSWER', expectedVersion: 1 }), params);
    expect(res.status).toBe(200);
    expect(createNotification).not.toHaveBeenCalled();
  });
});

describe('a failed delivery', () => {
  it('goes to this store\'s ops.track holders, not the person who recorded it', async () => {
    assertOrderAccess.mockResolvedValue({
      allowed: true,
      order: order({ confirmationStatus: 'CONFIRMED', shippingStatus: 'OUT_FOR_DELIVERY' }),
    });
    const res = await shippingPOST(
      post({ action: 'transition', to: 'FAILED_DELIVERY', deliveryFailureReason: 'CUSTOMER_NOT_AVAILABLE', expectedVersion: 1 }),
      params
    );
    expect(res.status).toBe(200);
    expect(createNotification.mock.calls[0][0]).toMatchObject({
      storeId: 'store-a',
      audience: { permission: 'ops.track' },
      actorId: 'actor-1',
      type: 'SYSTEM_ALERT',
    });
    expect(createNotification.mock.calls[0][0].link[0]).toBe('/ops/tracking');
  });

  it('any other shipping step announces nothing', async () => {
    assertOrderAccess.mockResolvedValue({
      allowed: true,
      order: order({ confirmationStatus: 'CONFIRMED', shippingStatus: 'SHIPPED' }),
    });
    const res = await shippingPOST(post({ action: 'transition', to: 'OUT_FOR_DELIVERY', expectedVersion: 1 }), params);
    expect(res.status).toBe(200);
    expect(createNotification).not.toHaveBeenCalled();
  });
});

describe('a change request', () => {
  const raise = () => changeRequestPOST(post({ changes: { quantity: { to: 3 } }, reason: 'الزبون طلب ثلاثة' }), params);

  beforeEach(() => {
    db.orderChangeRequest.create.mockImplementation(async ({ data }: any) => ({ id: 'cr1', ...data }));
    db.orderNote.create.mockResolvedValue({});
    db.order.findFirst.mockResolvedValue({
      quantity: 2, productId: 'p1', offerId: null, discountAmount: 0, customerNotes: null,
      customer: { fullName: 'أحمد', phone: '0791234567', altPhone: null, address: 'عمان', city: 'عمان' },
    });
  });

  it('after confirmation goes to everyone who may decide it in this store — the permission, and nothing else (PR-7)', async () => {
    assertOrderAccess.mockResolvedValue({ allowed: true, order: order({ confirmationStatus: 'CONFIRMED' }) });
    await raise();
    expect(createNotification).toHaveBeenCalledTimes(1);
    expect(createNotification.mock.calls[0][0]).toMatchObject({ storeId: 'store-a', actorId: 'actor-1' });
    // Exactly — the four role names that were told as well are the people the migration gave the key to; a name nobody can be
    // unticked from is not an audience, so the list is gone (OLD: { permission, roles: SUPERVISOR_ROLES }).
    expect(createNotification.mock.calls[0][0].audience).toEqual({ permission: 'control.change_requests' });
    expect(db.user.findMany).not.toHaveBeenCalled();
  });

  it('before operations goes to the agent holding the order, and only to her', async () => {
    assertOrderAccess.mockResolvedValue({ allowed: true, order: order({ claimedById: 'holder-1' }) });
    await raise();
    expect(createNotification).toHaveBeenCalledTimes(1);
    expect(createNotification.mock.calls[0][0]).toMatchObject({ audience: { userIds: ['holder-1'] }, actorId: 'actor-1' });
  });

  /**
   * WHEN THE HOLDER RAISES IT HERSELF, THERE IS NOBODY TO TELL.
   *
   * This used to fall through to the supervisors, because a request had to
   * be decided by somebody and she could not decide her own. She can now:
   * the raiser who may decide it, on a parcel that has not left, decides it
   * as she raises it. So there is no queue, and an announcement about a
   * decision already taken is noise addressed to people with nothing to do.
   */
  it('when the holder raised it herself, it decides itself and tells nobody', async () => {
    // She asks for a QUANTITY — a figure — so deciding it herself needs the price key too (PR-7). The agent of these tests held
    // `orders.edit` before the deploy, so the migration gave her the key: she is the person AFTER it.
    can.mockImplementation((_u: unknown, key: string) =>
      ['orders.contact_log', 'orders.request_change', 'orders.change_price'].includes(key));
    assertOrderAccess.mockResolvedValue({ allowed: true, order: order({ claimedById: 'actor-1' }) });
    await raise();
    expect(createNotification, 'أُعلن قرارٌ اتُّخذ فعلاً').not.toHaveBeenCalled();
    // And it is recorded as a decision with her name and a written reason.
    const decided = db.orderChangeRequest.update.mock.calls[0][0].data;
    expect(decided.status).toBe('APPROVED');
    expect(decided.decidedById).toBe('actor-1');
    expect(decided.decisionNote).toContain('لم يُسلَّم لشركة الشحن');
  });

  /**
   * AND SOMEBODY ELSE'S ORDER STILL WAITS. That is the rule the whole door
   * exists for, and it is untouched.
   */
  it('while a request on an order she does not hold still goes to the holder', async () => {
    assertOrderAccess.mockResolvedValue({ allowed: true, order: order({ claimedById: 'holder-1' }) });
    await raise();
    expect(createNotification).toHaveBeenCalledTimes(1);
    expect(db.orderChangeRequest.update, 'بتَّ في طلبٍ ليس له').not.toHaveBeenCalled();
  });

  /** Nor does a parcel already with the courier decide itself. */
  it('and a sealed order queues even for somebody who may decide it', async () => {
    assertOrderAccess.mockResolvedValue({
      allowed: true,
      order: order({ claimedById: 'actor-1', shippedAt: new Date(), shippingStatus: 'SHIPPED' }),
    });
    await raise();
    expect(db.orderChangeRequest.update, 'بتَّ في طلبٍ على طردٍ غادر').not.toHaveBeenCalled();
    expect(createNotification).toHaveBeenCalled();
  });

  it('offers the holder a screen she can open when the queue is closed to her', async () => {
    assertOrderAccess.mockResolvedValue({ allowed: true, order: order({ claimedById: 'holder-1' }) });
    await raise();
    expect(createNotification.mock.calls[0][0].link).toEqual(['/control/change-requests', '/confirmation/mine', '/orders']);
  });
});

describe('a new order', () => {
  it('from a public page goes to the store\'s confirmation supervisors, with no actor', async () => {
    db.region.findMany.mockResolvedValue([{ id: 'r1', name: 'عمان' }]);
    db.offer.findMany.mockResolvedValue([]);
    db.landingPageRecommendation.findMany.mockResolvedValue([]);
    // The transaction's own writes are covered elsewhere; here it only has
    // to hand back the order it made.
    db.$transaction.mockResolvedValue({ id: 'o77', orderNumber: 'ORD-77', totalAmount: 10, currency: 'JOD' });

    const result = await createPublicOrder(
      {
        companyId: 'c1',
        store: { id: 'store-b', countryId: 'jo', country: { code: 'JO', currencyCode: 'JOD', orderPrefix: 'ORD', minorUnit: 3 } },
        products: [{ id: 'p1', name: 'منتج', image: null, basePrice: 10 }],
        landingPage: null,
        source: 'STOREFRONT',
        campaignId: null,
        dedupeScope: `test-${Date.now()}`,
        notice: { title: 'طلب جديد من المتجر', message: (n) => `طلب ${n}` },
      },
      { full_name: 'أحمد علي', phone: '0791234567', address: 'شارع المدينة المنورة', city: 'عمان' }
    );

    expect(result.ok).toBe(true);
    expect(createNotification).toHaveBeenCalledTimes(1);
    const arg = createNotification.mock.calls[0][0];
    expect(arg).toMatchObject({
      companyId: 'c1',
      storeId: 'store-b',
      audience: { permission: 'confirmation.supervise' },
      type: 'ORDER_NEW',
      title: 'طلب جديد من المتجر',
    });
    expect(arg.actorId ?? null).toBeNull();
  });

  it('records the door as its channel and the kind of device — so the tables on the performance screen agree', async () => {
    db.region.findMany.mockResolvedValue([{ id: 'r1', name: 'عمان' }]);
    db.offer.findMany.mockResolvedValue([]);
    db.orderChannel.findFirst.mockResolvedValue({ id: 'ch-web' });
    let created: Record<string, unknown> | null = null;
    // Run the transaction for real this time, to read what the order row gets.
    const anyModel = () => new Proxy({}, { get: () => vi.fn(async () => ({})) });
    db.$transaction.mockImplementation(async (fn: (tx: unknown) => unknown) =>
      fn(new Proxy({}, {
        get: (_t, model) => model === 'order'
          ? { create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => { created = data; return { id: 'o78', ...data }; }) }
          : anyModel(),
      }))
    );

    const result = await createPublicOrder(
      {
        companyId: 'c1',
        store: { id: 'store-b', countryId: 'jo', country: { code: 'JO', currencyCode: 'JOD', orderPrefix: 'ORD', minorUnit: 3 } },
        products: [{ id: 'p1', name: 'منتج', image: null, basePrice: 10 }],
        landingPage: null,
        source: 'Store',
        campaignId: null,
        dedupeScope: `test-device-${Date.now()}`,
        deviceClass: 'mobile',
        notice: { title: 'طلب جديد من المتجر', message: (n) => `طلب ${n}` },
      },
      { full_name: 'أحمد علي', phone: '0791234568', address: 'شارع المدينة المنورة', city: 'عمان' }
    );

    expect(result.ok).toBe(true);
    expect(db.orderChannel.findFirst.mock.calls[0][0].where).toMatchObject({ companyId: 'c1', kind: 'WEBSITE', isActive: true });
    expect(created).toMatchObject({ channelId: 'ch-web', deviceClass: 'mobile' });
  });
});
