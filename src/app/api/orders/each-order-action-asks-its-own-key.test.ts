import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * ═══════════════════════════════════════════════════════════════════════
 * EACH ORDER ACTION ASKS ITS OWN KEY (perm-plan PR-6) — the doors, one by one, with their negatives.
 *
 * The owner's rule for this change, in his words: «اي قرار بعد الان اتخذو دون الرجوع الي».
 *
 *   the price / the discount / a line's price     orders.change_price   (was orders.edit)          PATCH /api/orders/[id]
 *   the delivery fee                              orders.change_fee     (was orders.change_status) PATCH …/[id] shippingCost · POST …/[id]/shipping
 *   cancelling                                    orders.cancel         (was orders.unlock)        PATCH …/[id] · POST …/[id]/confirmation · PATCH /api/confirmation/issues/[id]
 *   a note                                        orders.note           (was the work door)        POST …/[id]/notes
 *   a change request                              orders.request_change (was the work door)        POST …/[id]/change-requests
 *   the review link                               orders.rating_link    (was orders.view)          GET …/[id]/rating-link
 *
 * The migration gave every box to exactly the people who held the old key, so on the day nobody loses a door. THIS file is
 * the other half: after the day, a person who has the OLD key and not the new one is refused — and a person who has the
 * new one is not. Each door has a case in both directions; the people are keyed, not roles.
 * ═══════════════════════════════════════════════════════════════════════
 */

const { db, requireContext, assertOrderAccess, assertOrderReadable, current, endOrder } = vi.hoisted(() => ({
  db: {
    order: { findUnique: vi.fn(), findFirst: vi.fn(), update: vi.fn(), updateMany: vi.fn() },
    orderChannel: { findFirst: vi.fn() },
    orderItem: { findMany: vi.fn() },
    product: { findMany: vi.fn() },
    shippingBatch: { findFirst: vi.fn() },
    orderChangeRequest: { findFirst: vi.fn(), create: vi.fn(), update: vi.fn() },
    orderContactAttempt: { count: vi.fn() },
    orderNote: { create: vi.fn(), findMany: vi.fn() },
    orderIssue: { findFirst: vi.fn(), update: vi.fn() },
    orderStatusLog: { create: vi.fn() },
    orderActivity: { create: vi.fn() },
    customer: { update: vi.fn(), findUnique: vi.fn() },
    user: { findUnique: vi.fn(), findMany: vi.fn() },
    $transaction: vi.fn(),
  },
  requireContext: vi.fn(),
  assertOrderAccess: vi.fn(),
  assertOrderReadable: vi.fn(),
  current: { keys: [] as string[] },
  endOrder: vi.fn(),
}));

vi.mock('@/lib/db', () => ({ db }));
vi.mock('@/lib/geo-context', () => ({ requireContext: (...a: unknown[]) => requireContext(...a) }));
vi.mock('@/lib/audit', () => ({ logAudit: vi.fn() }));
vi.mock('@/lib/notify', () => ({ notify: vi.fn(), afterResponse: vi.fn() }));
vi.mock('@/lib/notification', () => ({ createNotification: vi.fn(async () => 1) }));
vi.mock('@/lib/landing-cache', () => ({ refreshLandingPages: vi.fn() }));
vi.mock('@/lib/pii-alert', () => ({ noteCustomersHandedOut: vi.fn() }));
vi.mock('@/lib/apps/events', () => ({ emitAppEvent: vi.fn() }));
vi.mock('@/lib/conversions/emit', () => ({ queueConversions: vi.fn() }));
vi.mock('@/lib/reservation', () => ({ reserveOrderLines: vi.fn(), releaseOrderLines: vi.fn() }));
vi.mock('@/lib/stock-consumption', () => ({ consumeOrderStock: vi.fn() }));
vi.mock('@/lib/delivery-attempts', () => ({ appendDeliveryAttempt: vi.fn() }));
vi.mock('@/lib/order-cancel', () => ({
  endOrder: (...a: unknown[]) => endOrder(...a),
  releaseCourierParcel: vi.fn(),
  cancelVerdict: () => ({ allowed: true }),
}));
// THE KEYED ENGINE: a person is a list of keys, and every question is answered from it.
vi.mock('@/lib/authorization', () => ({
  can: (_u: unknown, k: string) => current.keys.includes(k),
  authorize: (_u: unknown, k: string) => (current.keys.includes(k) ? { allowed: true } : { allowed: false, reason: 'NO_PERMISSION' }),
  getPermissionScope: (_u: unknown, k: string) => (current.keys.includes(k) ? { scope: 'ALL_COMPANY' } : null),
  requirePermission: async (k: string) => {
    if (!current.keys.includes(k)) throw new Error(`Forbidden: missing required permission ${k}`);
  },
}));
vi.mock('@/lib/rbac', () => ({
  assertOrderAccess: (...a: unknown[]) => assertOrderAccess(...a),
  assertOrderReadable: (...a: unknown[]) => assertOrderReadable(...a),
  orderVisibilityWhere: () => ({}),
  applyQueueFilter: (_u: unknown, w: unknown) => w,
  ORDER_ACCESS_STATUS: { NOT_FOUND: 404, WRONG_COMPANY: 404, NOT_ASSIGNED: 404 },
}));

import { PATCH as editOrder } from './[id]/route';
import { POST as shipping } from './[id]/shipping/route';
import { POST as confirmation } from './[id]/confirmation/route';
import { POST as addNote, GET as readNotes } from './[id]/notes/route';
import { GET as ratingLink } from './[id]/rating-link/route';
import { POST as raiseRequest } from './[id]/change-requests/route';
import { PATCH as issue } from '../confirmation/issues/[id]/route';

const ID = '11111111-2222-4333-8444-555555555555';
const PRODUCT = 'product-00000001';
const OTHER = 'product-00000002';

const ORDER = {
  id: ID, companyId: 'c1', storeId: 's1', customerId: 'cu1', version: 3, orderNumber: 'ORD-1',
  confirmationStatus: 'CONTACTING', shippingStatus: 'NOT_READY', status: 'NEW',
  quantity: 2, sellingPrice: 20, discountAmount: 0, shippingCost: 5, deliveryFee: 2500 as number | null,
  claimedById: null, lockedById: null, lockExpiresAt: null, trackingNumber: null,
};

const ctx = () => ({
  user: { id: 'u1', name: 'سارة', role: 'CUSTOM', status: 'ACTIVE', companyId: 'c1' },
  companyId: 'c1', storeId: 's1', country: { minorUnit: 2, currencyCode: 'USD', workHoursStart: '09:00', workHoursEnd: '17:00', weekendDays: [5], timezone: 'Asia/Amman', allowNegativeStock: false },
});

/** The person is the keys; the door reads nothing else about her. */
const as = (...keys: string[]) => { current.keys = keys; };

const call = (route: (r: Request, c: { params: Promise<{ id: string }> }) => Promise<Response>, body?: unknown, method = 'POST') =>
  route(new Request(`http://x/api/orders/${ID}`, { method, body: body === undefined ? undefined : JSON.stringify(body) }), { params: Promise.resolve({ id: ID }) });
const patch = (body: Record<string, unknown>) => call(editOrder as never, { expectedVersion: 3, ...body }, 'PATCH');

const codeOf = async (res: Response) => ((await res.clone().json().catch(() => ({}))) as { code?: string }).code;

beforeEach(() => {
  vi.clearAllMocks();
  as();
  requireContext.mockResolvedValue(ctx());
  assertOrderAccess.mockResolvedValue({ allowed: true, order: { ...ORDER } });
  assertOrderReadable.mockResolvedValue({ allowed: true, order: { ...ORDER } });
  db.order.findUnique.mockResolvedValue({ ...ORDER });
  db.order.findFirst.mockResolvedValue({ ...ORDER, store: { slug: 's' }, reviews: [] });
  db.order.updateMany.mockResolvedValue({ count: 1 });
  db.orderItem.findMany.mockResolvedValue([{ productId: PRODUCT, quantity: 2, lineTotal: 20, discountShare: 0 }]);
  db.product.findMany.mockResolvedValue([{ id: OTHER, basePrice: 12 }]);
  db.shippingBatch.findFirst.mockResolvedValue(null);
  db.orderContactAttempt.count.mockResolvedValue(1);
  db.orderNote.create.mockImplementation(async ({ data }: { data: Record<string, unknown> }) => ({ id: 'n1', ...data }));
  db.orderChangeRequest.findFirst.mockResolvedValue(null);
  db.orderChangeRequest.create.mockImplementation(async ({ data }: { data: Record<string, unknown> }) => ({ id: 'cr1', ...data }));
  db.user.findMany.mockResolvedValue([]);
  db.$transaction.mockImplementation(async (fn: unknown) => (typeof fn === 'function' ? (fn as (tx: unknown) => unknown)(db) : fn));
  endOrder.mockResolvedValue({ ok: true });
});

describe('THE PRICE — orders.change_price', () => {
  const EDIT = ['orders.view', 'orders.edit'];

  it('NEGATIVE: who only edits is refused a new discount — and nothing is written', async () => {
    as(...EDIT);
    const res = await patch({ discountAmount: 5, reason: 'خصم للزبون' });
    expect(res.status).toBe(403);
    expect(await codeOf(res)).toBe('PRICE_FORBIDDEN');
    expect(db.order.updateMany).not.toHaveBeenCalled();
  });

  it('NEGATIVE: …and a new single-line price', async () => {
    as(...EDIT);
    const res = await patch({ sellingPrice: 5 });
    expect(await codeOf(res)).toBe('PRICE_FORBIDDEN');
    expect(res.status).toBe(403);
  });

  it('NEGATIVE: …and a line whose price moved, even though the card posts every box on every save', async () => {
    as(...EDIT);
    const res = await patch({ items: [{ productId: PRODUCT, quantity: 2, unitPrice: 5 }], discountAmount: 0 });
    expect(await codeOf(res)).toBe('PRICE_FORBIDDEN');
  });

  it('NEGATIVE: …and a new product at a price that is not its catalogue price', async () => {
    as(...EDIT);
    const res = await patch({ items: [{ productId: PRODUCT, quantity: 2, unitPrice: 20 }, { productId: OTHER, quantity: 1, unitPrice: 1 }] });
    expect(await codeOf(res)).toBe('PRICE_FORBIDDEN');
  });

  it('the people WITH the key are not asked the price question at all (no lines read, no catalogue read)', async () => {
    as(...EDIT, 'orders.change_price');
    const res = await patch({ discountAmount: 5, reason: 'خصم للزبون' });
    expect(await codeOf(res)).not.toBe('PRICE_FORBIDDEN');
    expect(db.orderItem.findMany).not.toHaveBeenCalled();
    expect(db.product.findMany).not.toHaveBeenCalled();
  });

  it('and who only edits can still save everything that is not a price: the card’s untouched boxes are not a price', async () => {
    as(...EDIT);
    // every price box posted back unchanged, with the quantity raised at the SAME piece price (20 for 2 → 30 for 3)
    for (const body of [
      { discountAmount: 0, customerName: 'محمد' },
      { sellingPrice: 20, customerName: 'محمد' },
      { items: [{ productId: PRODUCT, quantity: 2, unitPrice: 20 }], discountAmount: 0 },
      { items: [{ productId: PRODUCT, quantity: 3, unitPrice: 30 }], discountAmount: 0 },
      { items: [{ productId: PRODUCT, quantity: 2, unitPrice: 20 }, { productId: OTHER, quantity: 1, unitPrice: 12 }] },
    ]) {
      const res = await patch(body);
      expect(await codeOf(res), JSON.stringify(body)).not.toBe('PRICE_FORBIDDEN');
    }
  });

  it('NEGATIVE: keeping the saved total while raising the quantity is a NEW piece price — a discount nobody with only edit may give', async () => {
    as(...EDIT);
    const res = await patch({ items: [{ productId: PRODUCT, quantity: 3, unitPrice: 20 }], discountAmount: 0 });
    expect(await codeOf(res)).toBe('PRICE_FORBIDDEN');
  });

  it('a person with the price key and NOT the edit is stopped by the edit, as before — the price opens nothing alone', async () => {
    as('orders.view', 'orders.change_price');
    const res = await patch({ discountAmount: 5, reason: 'خصم' });
    expect(res.status).toBe(403);
    expect(await codeOf(res)).not.toBe('PRICE_FORBIDDEN');
  });
});

describe('THE DELIVERY FEE — orders.change_fee', () => {
  it('PATCH shippingCost: NEGATIVE — the old key (change_status) no longer opens it', async () => {
    as('orders.view', 'orders.edit', 'orders.change_status');
    const res = await patch({ shippingCost: 99 });
    expect(res.status).toBe(403);
    expect(await codeOf(res)).toBe('SHIPPING_FORBIDDEN');
  });

  it('PATCH shippingCost: the new key opens it', async () => {
    as('orders.view', 'orders.edit', 'orders.change_status', 'orders.change_fee');
    expect(await codeOf(await patch({ shippingCost: 99, reason: 'اتفاق' }))).not.toBe('SHIPPING_FORBIDDEN');
  });

  const fee = (deliveryFee: number | null) => call(shipping as never, { action: 'update_tracking', expectedVersion: 3, deliveryFee });

  it('POST shipping: NEGATIVE — a CHANGED fee needs the key; the shipping key alone is refused and nothing is saved', async () => {
    as('orders.view', 'orders.change_status');
    const res = await fee(0);
    expect(res.status).toBe(403);
    expect(await codeOf(res)).toBe('FEE_FORBIDDEN');
    expect(db.order.updateMany).not.toHaveBeenCalled();
  });

  it('POST shipping: the key opens it — and the fee is really saved', async () => {
    as('orders.view', 'orders.change_status', 'orders.change_fee');
    const res = await fee(0);
    expect(res.status, JSON.stringify(await res.clone().json())).toBe(200);
    expect(db.order.updateMany.mock.calls[0][0].data.deliveryFee).toBe(0);
  });

  it('POST shipping: the form posts the fee box back on every save — the SAME fee is not a change, so the number can still be saved', async () => {
    as('orders.view', 'orders.change_status');
    const res = await fee(2500);
    expect(res.status, JSON.stringify(await res.clone().json())).toBe(200);
  });
});

describe('CANCELLING — orders.cancel', () => {
  it('PATCH: NEGATIVE — the OLD key (orders.unlock) no longer opens an ending, and nothing is ended', async () => {
    as('orders.view', 'orders.edit', 'orders.change_status', 'orders.unlock');
    const res = await patch({ shippingStatus: 'CANCELLED', reason: 'الزبون ألغى' });
    expect(res.status).toBe(403);
    expect(await codeOf(res)).toBe('CANCEL_REQUIRED');
    expect(endOrder).not.toHaveBeenCalled();
  });

  it('PATCH: the new key opens it', async () => {
    as('orders.view', 'orders.edit', 'orders.change_status', 'orders.cancel');
    const res = await patch({ shippingStatus: 'CANCELLED', reason: 'الزبون ألغى' });
    expect(await codeOf(res)).not.toBe('CANCEL_REQUIRED');
    expect(endOrder).toHaveBeenCalledTimes(1);
  });

  const cancelNow = () => call(confirmation as never, { action: 'cancel', note: 'الزبون ألغى بالتلفون', expectedVersion: 3 });

  it('POST confirmation «cancel»: NEGATIVE — confirm + the OLD key is refused', async () => {
    as('orders.view', 'orders.confirm', 'orders.unlock');
    // from CONTACTING a cancel is an override, which the old key would also have allowed — it must not get this far
    const res = await cancelNow();
    expect(res.status).toBe(403);
    expect(endOrder).not.toHaveBeenCalled();
  });

  it('POST confirmation «cancel»: the new key (with the confirm it always needed) opens it', async () => {
    as('orders.view', 'orders.confirm', 'orders.cancel', 'orders.unlock');
    const res = await cancelNow();
    expect(res.status).not.toBe(403);
  });

  it('POST confirmation «cancel»: the new key alone, without the confirm it also needs, is refused', async () => {
    as('orders.view', 'orders.cancel');
    expect((await cancelNow()).status).toBe(403);
  });

  const voidIt = () =>
    issue(new Request('http://x', { method: 'PATCH', body: JSON.stringify({ action: 'void', note: 'خطأ إدخال' }) }), { params: Promise.resolve({ id: 'issue-0000001' }) });

  it('PATCH issue «void»: NEGATIVE — the OLD key is refused, the issue stays open', async () => {
    as('confirmation.issues', 'orders.unlock');
    db.orderIssue.findFirst.mockResolvedValue({ id: 'issue-0000001', status: 'OPEN', orderId: ID, order: { id: ID, confirmationStatus: 'NEW', shippingStatus: 'NOT_READY', shippedAt: null, labelPrintedAt: null } });
    const res = await voidIt();
    expect(res.status).toBe(403);
    expect(db.$transaction).not.toHaveBeenCalled();
  });

  it('PATCH issue «void»: the new key opens it', async () => {
    as('confirmation.issues', 'orders.cancel');
    db.orderIssue.findFirst.mockResolvedValue({ id: 'issue-0000001', status: 'OPEN', orderId: ID, order: { id: ID, confirmationStatus: 'NEW', shippingStatus: 'NOT_READY', shippedAt: null, labelPrintedAt: null } });
    db.orderIssue.update.mockResolvedValue({ id: 'issue-0000001' });
    expect((await voidIt()).status).not.toBe(403);
  });
});

describe('A NOTE — orders.note', () => {
  it('NEGATIVE: a person who only READS the order can read the thread but cannot write to it', async () => {
    as('orders.view');
    db.orderNote.findMany.mockResolvedValue([]);
    expect((await call(readNotes as never, undefined, 'GET')).status).toBe(200);
    const res = await call(addNote as never, { body: 'ملاحظة طويلة كفاية' });
    expect(res.status).toBe(403);
    expect(await codeOf(res)).toBe('NOTE_FORBIDDEN');
    expect(db.orderNote.create).not.toHaveBeenCalled();
  });

  it('the key writes it', async () => {
    as('orders.view', 'orders.note');
    const res = await call(addNote as never, { body: 'ملاحظة طويلة كفاية' });
    expect(res.status).toBe(201);
    expect(db.orderNote.create).toHaveBeenCalledTimes(1);
  });

  it('NEGATIVE: the key does not skip the order’s own visibility — an order she cannot reach is still not found', async () => {
    as('orders.view', 'orders.note');
    assertOrderAccess.mockResolvedValue({ allowed: false, reason: 'NOT_ASSIGNED' });
    expect((await call(addNote as never, { body: 'ملاحظة طويلة كفاية' })).status).toBe(404);
    expect(db.orderNote.create).not.toHaveBeenCalled();
  });
});

describe('A CHANGE REQUEST — orders.request_change', () => {
  const ask = () => call(raiseRequest as never, { changes: { quantity: { to: 3 } }, reason: 'الزبون طلب ثلاثة' });
  beforeEach(() => {
    db.order.findFirst.mockResolvedValue({
      quantity: 2, productId: 'p1', offerId: null, discountAmount: 0, customerNotes: null,
      customer: { fullName: 'أحمد', phone: '0791234567', altPhone: null, address: 'عمان', city: 'عمان' },
    });
    assertOrderAccess.mockResolvedValue({ allowed: true, order: { ...ORDER, confirmationStatus: 'CONFIRMED' } });
  });

  it('NEGATIVE: a person who only reads the order cannot raise a request on it', async () => {
    as('orders.view');
    const res = await ask();
    expect(res.status).toBe(403);
    expect(await codeOf(res)).toBe('REQUEST_CHANGE_FORBIDDEN');
    expect(db.orderChangeRequest.create).not.toHaveBeenCalled();
  });

  it('the key raises it', async () => {
    as('orders.view', 'orders.request_change');
    const res = await ask();
    expect(res.status, JSON.stringify(await res.clone().json())).toBeLessThan(300);
    expect(db.orderChangeRequest.create).toHaveBeenCalledTimes(1);
  });
});

describe('THE REVIEW LINK — orders.rating_link', () => {
  it('NEGATIVE: orders.view alone no longer hands out the customer’s review link', async () => {
    as('orders.view');
    const res = await call(ratingLink as never, undefined, 'GET');
    expect(res.status).toBe(403);
    expect(await codeOf(res)).toBe('RATING_LINK_FORBIDDEN');
    expect(assertOrderReadable).not.toHaveBeenCalled();
  });

  it('the key (with the view it sits behind) reaches the order check and past the gate', async () => {
    as('orders.view', 'orders.rating_link');
    const res = await call(ratingLink as never, undefined, 'GET');
    expect(await codeOf(res)).not.toBe('RATING_LINK_FORBIDDEN');
    expect(assertOrderReadable).toHaveBeenCalledTimes(1);
  });
});
