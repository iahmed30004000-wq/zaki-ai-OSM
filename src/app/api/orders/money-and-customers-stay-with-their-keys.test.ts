import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * ORDER READS CARRIED MONEY AND CUSTOMER FILES TO WHOEVER COULD OPEN AN ORDER.
 *
 * Found by the permissions audit and checked against the code, one door at
 * a time. Every test below has two halves: the person WITHOUT the key gets
 * nothing (or a refusal), and the same person WITH it gets what the screen
 * shows — so a fix that simply broke the door would fail too.
 *
 *   · the orders list and the order window: cost, profit and other people's
 *     commission went to every reader; the customer's notes and counters to
 *     anyone, whatever their customers key;
 *   · `?queue=available` on the list handed an agent the whole unclaimed
 *     pool, names and phones;
 *   · the order's finance snapshot fell through to anyone who could open it;
 *   · the return-risk card answered for any order id in the store;
 *   · a customer's history opened for any id, scope or no scope;
 *   · «عميل جديد» with a known phone returned that person's whole file;
 *   · the shipping batches list asked nothing; a batch carried every phone.
 */

type Who = { id: string; role: string; status: 'ACTIVE'; keys: string[]; scopes?: Record<string, string> };

const { db, requireContext, applyQueueFilter, assertOrderReadable, findCustomer } = vi.hoisted(() => ({
  db: {
    order: { findMany: vi.fn(), count: vi.fn(), findFirst: vi.fn(), findUnique: vi.fn() },
    customer: { findFirst: vi.fn() },
    returnReceipt: { count: vi.fn() },
    shippingBatch: { findMany: vi.fn(), count: vi.fn(), findFirst: vi.fn() },
  },
  requireContext: vi.fn(),
  applyQueueFilter: vi.fn(),
  assertOrderReadable: vi.fn(),
  findCustomer: vi.fn(),
}));

vi.mock('@/lib/db', () => ({ db }));
vi.mock('@/lib/geo-context', () => ({ requireContext: (...a: unknown[]) => requireContext(...a) }));
vi.mock('@/lib/authorization', () => ({
  requirePermission: vi.fn(async () => ({})),
  can: (u: Who, k: string) => u.keys.includes(k),
  getPermissionScope: (u: Who, k: string) =>
    u.scopes?.[k] ? { scope: u.scopes[k] } : u.keys.includes(k) ? { scope: 'ALL_COMPANY' } : null,
  authorize: () => ({ allowed: true }),
}));
vi.mock('@/lib/rbac', () => ({
  applyQueueFilter: (...a: unknown[]) => applyQueueFilter(...a),
  assertOrderReadable: (...a: unknown[]) => assertOrderReadable(...a),
  assertOrderAccess: vi.fn(),
  ORDER_ACCESS_STATUS: { NOT_FOUND: 404, WRONG_COMPANY: 404, NOT_ASSIGNED: 404 },
}));
vi.mock('@/lib/pii-alert', () => ({ noteCustomersHandedOut: vi.fn() }));
vi.mock('@/lib/customer-risk', () => ({ customerRisk: vi.fn(async () => ({ tier: 'NEW' })) }));
vi.mock('@/lib/customer-identity', () => ({
  findCustomer: (...a: unknown[]) => findCustomer(...a),
  findOrCreateCustomer: vi.fn(),
}));
vi.mock('@/lib/audit', () => ({ logAudit: vi.fn(), redactCustomerForAudit: (c: unknown) => c }));
vi.mock('@/lib/notification', () => ({ createNotification: vi.fn() }));

import { GET as listOrders } from '@/app/api/orders/route';
import { GET as readOrder } from '@/app/api/orders/[id]/route';
import { GET as readFinance } from '@/app/api/orders/[id]/finance/route';
import { GET as readHistory } from '@/app/api/customers/[id]/history/route';
import { POST as addCustomer } from '@/app/api/customers/route';
import { GET as listBatches } from '@/app/api/shipping-batches/route';
import { GET as readBatch } from '@/app/api/shipping-batches/[id]/route';
import { ORDER_WORK_DOOR } from '@/lib/order-work-door';

const person = (keys: string[], scopes?: Record<string, string>): Who => ({ id: 'me', role: 'CUSTOM', status: 'ACTIVE', keys, scopes });
const AGENT = person(['orders.view'], { 'orders.view': 'ASSIGNED' });
const ACCOUNTANT = person(['orders.view', 'finance.view', 'customers.view']);

function as(user: Who) {
  requireContext.mockResolvedValue({
    user,
    companyId: 'c1',
    storeId: 's1',
    countryId: 'co1',
    country: { id: 'co1', code: 'JO', currencyCode: 'JOD', minorUnit: 3, callingCode: '962' },
  });
}

const ORDER_ROW = {
  id: 'o1', orderNumber: 'JO-1', companyId: 'c1', storeId: 's1',
  confirmationStatus: 'CONFIRMED', shippingStatus: 'SHIPPED', settlementStatus: 'PENDING',
  totalAmount: 25, deliveryFee: 3, discountAmount: 0, priceIncludesDelivery: false, createdAt: new Date(),
  estimatedCostOfGoods: 9, productCost: 9, packagingCost: 1, advertisingCost: 4, otherCost: 0,
  grossProfit: 12, netProfit: 8, moderatorCommission: 1.5,
  customer: {
    id: 'cu1', fullName: 'سعاد', phone: '0790000000', address: 'عمّان', notes: 'زبونة صعبة',
    totalOrders: 4, confirmedOrders: 3, deliveredOrders: 2, cancelledOrders: 1, totalPurchaseValue: 90,
  },
  items: [{ quantity: 1, unitPrice: 25 }],
  commissions: [
    { id: 'k1', userId: 'me', role: 'MODERATOR', amount: 1, status: 'PENDING' },
    { id: 'k2', userId: 'colleague', role: 'CONFIRMATION_AGENT', amount: 0.5, status: 'PENDING' },
  ],
};

const COST = ['estimatedCostOfGoods', 'productCost', 'packagingCost', 'advertisingCost', 'otherCost', 'grossProfit', 'netProfit', 'moderatorCommission'];

beforeEach(() => {
  vi.clearAllMocks();
  applyQueueFilter.mockImplementation((_u: unknown, w: unknown) => w);
  assertOrderReadable.mockResolvedValue({ allowed: true });
  db.order.count.mockResolvedValue(1);
  db.order.findMany.mockResolvedValue([ORDER_ROW]);
  db.order.findUnique.mockResolvedValue(ORDER_ROW);
  db.order.findFirst.mockResolvedValue({ id: 'o1' });
  db.returnReceipt.count.mockResolvedValue(0);
});

const params = (id: string) => ({ params: Promise.resolve({ id }) });

describe('the orders list', () => {
  it('an agent asking for the unclaimed pool gets her own list, not the pool', async () => {
    as(AGENT);
    await listOrders(new Request('http://x/api/orders?queue=available&limit=500'));
    expect(applyQueueFilter.mock.calls[0][2]).toBeNull();
  });

  it('a supervisor still gets the pool she works from', async () => {
    as(person(['orders.view', 'confirmation.supervise'], { 'orders.view': 'ASSIGNED' }));
    await listOrders(new Request('http://x/api/orders?queue=available'));
    expect(applyQueueFilter.mock.calls[0][2]).toBe('available');
  });

  it('the narrowing queues still pass through for everyone', async () => {
    as(AGENT);
    await listOrders(new Request('http://x/api/orders?queue=my_orders'));
    expect(applyQueueFilter.mock.calls[0][2]).toBe('my_orders');
  });

  it('a row carries no cost or profit without the finance key, and does with it', async () => {
    as(AGENT);
    const without = (await (await listOrders(new Request('http://x/api/orders'))).json()).orders[0];
    for (const f of COST) expect(without, f).not.toHaveProperty(f);
    expect(without.totalAmount).toBe(25);

    as(ACCOUNTANT);
    const withKey = (await (await listOrders(new Request('http://x/api/orders'))).json()).orders[0];
    expect(withKey.netProfit).toBe(8);
    expect(withKey.estimatedCostOfGoods).toBe(9);
  });

  it('the customer keeps phone, address and the repeat counter; notes and the refusal counters need the customers key', async () => {
    as(AGENT);
    const row = (await (await listOrders(new Request('http://x/api/orders'))).json()).orders[0];
    expect(row.customer.phone).toBe('0790000000');
    expect(row.customer.address).toBe('عمّان');
    expect(row.previousOrders).toBe(3);
    for (const f of ['notes', 'cancelledOrders', 'deliveredOrders', 'totalPurchaseValue']) expect(row.customer, f).not.toHaveProperty(f);

    as(ACCOUNTANT);
    const full = (await (await listOrders(new Request('http://x/api/orders'))).json()).orders[0];
    expect(full.customer.notes).toBe('زبونة صعبة');
    expect(full.customer.cancelledOrders).toBe(1);
  });
});

describe('the order window', () => {
  it('without the finance key: no cost, no commission total, and only her own commission entry', async () => {
    as(AGENT);
    const { order } = await (await readOrder(new Request('http://x/api/orders/o1'), params('o1'))).json();
    for (const f of COST) expect(order, f).not.toHaveProperty(f);
    expect(order.commission).toBeUndefined();
    expect(order.commissions.map((e: { userId: string }) => e.userId)).toEqual(['me']);
    expect(order.customer).not.toHaveProperty('notes');
  });

  it('with the finance key: the costs, the total and everybody’s entries', async () => {
    as(ACCOUNTANT);
    const { order } = await (await readOrder(new Request('http://x/api/orders/o1'), params('o1'))).json();
    expect(order.estimatedCostOfGoods).toBe(9);
    expect(order.commission).toBe(1.5);
    expect(order.commissions).toHaveLength(2);
    expect(order.customer.notes).toBe('زبونة صعبة');
  });

  it('payroll sees other people’s commission entries without the shop’s cost', async () => {
    as(person(['orders.view', 'payroll.view']));
    const { order } = await (await readOrder(new Request('http://x/api/orders/o1'), params('o1'))).json();
    expect(order.commissions).toHaveLength(2);
    expect(order).not.toHaveProperty('netProfit');
  });
});

describe('the order’s finance snapshot', () => {
  it('refuses someone who can only open orders — the fallback that let any agent read it', async () => {
    as(AGENT);
    const res = await readFinance(new Request('http://x'), params('o1'));
    expect(res.status).toBe(403);
    expect(db.order.findUnique).not.toHaveBeenCalled();
  });

  it('answers the finance key, and looks inside this store only', async () => {
    as(ACCOUNTANT);
    db.order.findUnique.mockResolvedValue({ id: 'o1', netProfit: 8 });
    const res = await readFinance(new Request('http://x'), params('o1'));
    expect(res.status).toBe(200);
    expect(db.order.findFirst.mock.calls[0][0].where).toMatchObject({ id: 'o1', companyId: 'c1', storeId: 's1' });
  });

  it('an order in another store is not found, even for the finance key', async () => {
    as(ACCOUNTANT);
    db.order.findFirst.mockResolvedValue(null);
    expect((await readFinance(new Request('http://x'), params('o1'))).status).toBe(404);
  });
});

describe('a customer’s history', () => {
  beforeEach(() => {
    db.customer.findFirst.mockResolvedValue({ id: 'cu1', fullName: 'سعاد', phone: '079', totalOrders: 4 });
    db.order.findMany.mockResolvedValue([]);
  });

  it('an agent typing a customer id with no order of hers gets nothing', async () => {
    as(AGENT);
    expect((await readHistory(new Request('http://x/api/customers/cu1/history'), params('cu1'))).status).toBe(403);
  });

  it('from an order she can open, it is that order’s customer — and only that one', async () => {
    as(AGENT);
    db.order.findFirst.mockResolvedValue({ id: 'o1' });
    const ok = await readHistory(new Request('http://x/api/customers/cu1/history?exclude=o1'), params('cu1'));
    expect(ok.status).toBe(200);

    // The order is hers, but it is somebody else's customer.
    db.order.findFirst.mockResolvedValue(null);
    const other = await readHistory(new Request('http://x/api/customers/cu9/history?exclude=o1'), params('cu9'));
    expect(other.status).toBe(403);
  });

  it('an order outside her envelope does not open its customer either', async () => {
    as(AGENT);
    assertOrderReadable.mockResolvedValue({ allowed: false, reason: 'NOT_ASSIGNED' });
    expect((await readHistory(new Request('http://x/api/customers/cu1/history?exclude=o1'), params('cu1'))).status).toBe(403);
  });

  /*
   * «عرض الطلبات» UNTICKED, «العمل على طلباتي» TICKED — the owner's case.
   *
   * The door asked `can(user, 'orders.view')` before it would even look at
   * the order, so the agent holding it got «سجلّ العميل ليس من صلاحيّاتك» on
   * her own customer. It asks the work door now: either key in, and the
   * door's own answer — her order, not a colleague's — decides.
   */
  const HOLDER = person(['confirmation.work', 'customers.view_basic']);

  it('the agent holding the order opens its customer through the work door', async () => {
    as(HOLDER);
    db.order.findFirst.mockResolvedValue({ id: 'o1' });
    const ok = await readHistory(new Request('http://x/api/customers/cu1/history?exclude=o1'), params('cu1'));
    expect(ok.status).toBe(200);
    expect(assertOrderReadable).toHaveBeenCalledWith('o1', HOLDER, { companyId: 'c1', storeId: 's1' }, ORDER_WORK_DOOR);
  });

  it('NEGATIVE: a colleague’s order does not open its customer for her — the door said no', async () => {
    as(HOLDER);
    assertOrderReadable.mockResolvedValue({ allowed: false, reason: 'NOT_FOUND' });
    expect((await readHistory(new Request('http://x/api/customers/cu1/history?exclude=o2'), params('cu1'))).status).toBe(403);
  });

  it('NEGATIVE: and with neither key the order is not even asked about', async () => {
    as(person(['customers.view_basic']));
    expect((await readHistory(new Request('http://x/api/customers/cu1/history?exclude=o1'), params('cu1'))).status).toBe(403);
    expect(assertOrderReadable).not.toHaveBeenCalled();
  });

  it('the address book: ALL opens any, OWN only customers this person brought in', async () => {
    as(person(['customers.view']));
    expect((await readHistory(new Request('http://x'), params('cu1'))).status).toBe(200);

    as(person(['customers.view'], { 'customers.view': 'OWN' }));
    db.order.findFirst.mockResolvedValue(null);
    expect((await readHistory(new Request('http://x'), params('cu1'))).status).toBe(403);
    db.order.findFirst.mockResolvedValue({ id: 'o7' });
    expect((await readHistory(new Request('http://x'), params('cu1'))).status).toBe(200);
  });
});

describe('«عميل جديد» with a phone that is already here', () => {
  const add = () =>
    addCustomer(new Request('http://x/api/customers', { method: 'POST', body: JSON.stringify({ fullName: 'س', phone: '0790000000' }) }));

  beforeEach(() => {
    findCustomer.mockResolvedValue({ id: 'cu1', fullName: 'سعاد', address: 'عمّان', notes: 'زبونة صعبة' });
    db.customer.findFirst.mockResolvedValue({ id: 'cu1', fullName: 'سعاد', address: 'عمّان', orders: [{ id: 'o1', totalAmount: 25 }] });
  });

  it('says who, and nothing else, to someone who may only add customers', async () => {
    as(person(['customers.create']));
    const body = await (await add()).json();
    expect(body.isExisting).toBe(true);
    expect(body.customer).toEqual({ id: 'cu1', fullName: 'سعاد' });
  });

  it('hands the file and its orders to the address book', async () => {
    as(person(['customers.create', 'customers.view']));
    const body = await (await add()).json();
    expect(body.customer.orders).toHaveLength(1);
  });
});

describe('shipping batches', () => {
  beforeEach(() => {
    db.shippingBatch.count.mockResolvedValue(1);
    db.shippingBatch.findMany.mockResolvedValue([{ id: 'b1' }]);
    db.shippingBatch.findFirst.mockResolvedValue({
      id: 'b1',
      orders: [{ id: 'o1', orderNumber: 'JO-1', trackingNumber: 'T1', customer: { fullName: 'سعاد', phone: '079', city: 'عمّان' } }],
    });
  });

  it('the list refuses someone outside the batches screen — it asked nothing before', async () => {
    as(person(['orders.view']));
    expect((await listBatches(new Request('http://x/api/shipping-batches'))).status).toBe(403);
    // PR-8: the packing key alone no longer opens it — the page has a box of its own.
    as(person(['ops.ship']));
    expect((await listBatches(new Request('http://x/api/shipping-batches'))).status).toBe(403);
    as(person(['ops.batches']));
    expect((await listBatches(new Request('http://x/api/shipping-batches'))).status).toBe(200);
  });

  it('a batch opens on the screen’s keys, and its phones go only with the customers key', async () => {
    as(person(['orders.view']));
    expect((await readBatch(new Request('http://x'), params('b1'))).status).toBe(403);

    as(person(['ops.track']));
    expect((await readBatch(new Request('http://x'), params('b1'))).status).toBe(403);

    as(person(['ops.batches']));
    const plain = (await (await readBatch(new Request('http://x'), params('b1'))).json()).batch.orders[0];
    expect(plain.orderNumber).toBe('JO-1');
    expect(plain.customer.phone).toBeUndefined();

    as(person(['ops.batches', 'customers.view']));
    const full = (await (await readBatch(new Request('http://x'), params('b1'))).json()).batch.orders[0];
    expect(full.customer.phone).toBe('079');
  });
});
