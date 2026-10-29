import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * A WRITE-OFF CLOSES THE ORDER, AND EVERYTHING THAT WAITED FOR IT STOPS WAITING.
 *
 * The write-off door used to leave the order RETURNED with no receipt, and every reader of «a return nobody has
 * received» kept it: the desk's list, the daily alert, «شغلك اليوم», the finance count of what is pending, and
 * the media buyer (returned, with returned_at empty). These tests run the REAL door over one in-memory order,
 * then hand the order it left to each real reader — each reader's own `where`, evaluated, not a copy of it.
 *
 * Each reader is also asked about the order as the OLD door left it (RETURNED, no receipt) as a control, so a
 * reader that stopped asking the question at all would turn this red rather than quietly agree.
 */

const { db, requireContext, requirePermission, logAudit, consumeOrderStock, createNotification, state } = vi.hoisted(() => ({
  state: { order: null as Record<string, any> | null, permissions: new Set<string>() },
  db: {
    order: { findFirst: vi.fn(), update: vi.fn(), findMany: vi.fn(), count: vi.fn() },
    returnReceipt: { create: vi.fn() },
    orderActivity: { create: vi.fn() },
    store: { findMany: vi.fn() },
    notification: { findFirst: vi.fn(), create: vi.fn() },
    orderIssue: { count: vi.fn() },
    courierStatement: { count: vi.fn() },
    orderChangeRequest: { count: vi.fn() },
    deliveryFee: { findMany: vi.fn() },
    $transaction: vi.fn(),
  },
  requireContext: vi.fn(),
  requirePermission: vi.fn(),
  logAudit: vi.fn(),
  consumeOrderStock: vi.fn(),
  createNotification: vi.fn(),
}));

vi.mock('@/lib/db', () => ({ db, default: db }));
vi.mock('@/lib/geo-context', () => ({
  requireContext: (...a: unknown[]) => requireContext(...a),
  ContextError: class extends Error {},
}));
vi.mock('@/lib/authorization', () => ({
  requirePermission: (...a: unknown[]) => requirePermission(...a),
  can: (_u: unknown, p: string) => state.permissions.has(p),
}));
vi.mock('@/lib/audit', () => ({ logAudit: (...a: unknown[]) => logAudit(...a) }));
vi.mock('@/lib/stock-consumption', () => ({ consumeOrderStock: (...a: unknown[]) => consumeOrderStock(...a) }));
vi.mock('@/lib/notification', () => ({ createNotification: (...a: unknown[]) => createNotification(...a) }));
vi.mock('@/lib/notification-audience', () => ({ resolveAudience: vi.fn(async () => [{ id: 'sup' }]) }));
vi.mock('@/lib/wallets', () => ({ blockingClosing: vi.fn(async () => null) }));
vi.mock('@/lib/confirmation-queue', () => ({
  POSTPONE_LEAD_DAYS: 2,
  waitingCount: vi.fn(async () => 0),
  awaitingConfirmationCount: vi.fn(async () => 0),
}));

import { POST as writeOff } from '@/app/api/ops/tracking/write-off/route';
import { GET as myWork } from '@/app/api/me/work/route';
import { staleReturns } from '@/lib/jobs/definitions';
import { viewScope } from '@/lib/returns-filters';
import { whereClosed, closingStages } from '@/lib/order-closing';
import { OUTCOME_LABEL_AR, orderOutcome } from '@/lib/order-outcome';
import { attributionItem } from '@/lib/v1/attribution';
import { LOSS_RECEIPT_NOTE } from '@/lib/written-off';

const ORDER = '22222222-2222-4222-8222-222222222222';
const WRITTEN_AT = new Date('2026-10-01T09:00:00.000Z');
const LATER = new Date('2026-10-12T09:00:00.000Z'); // eleven days on: the alert's three-day threshold is long past

type Any = Record<string, any>;

/** The database's own reading of a `where`, for the few shapes these readers write. A shape it does not know throws. */
function matches(where: Any, row: Any): boolean {
  return Object.entries(where).every(([key, cond]) => {
    if (key === 'AND') return (cond as Any[]).every((w) => matches(w, row));
    if (key === 'OR') return (cond as Any[]).some((w) => matches(w, row));
    if (key === 'NOT') return !matches(cond as Any, row);
    const value = row[key];
    if (cond === null) return value === null || value === undefined;
    if (cond instanceof Date || typeof cond !== 'object') return cond instanceof Date ? value?.getTime() === cond.getTime() : value === cond;
    return Object.entries(cond as Any).every(([op, arg]) => {
      if (op === 'isNot') return arg === null && value !== null && value !== undefined;
      if (op === 'is') return value != null && matches(arg as Any, value);
      if (op === 'in') return (arg as unknown[]).includes(value);
      if (op === 'notIn') return !(arg as unknown[]).includes(value);
      if (op === 'lte') return value != null && value <= arg;
      if (op === 'gte') return value != null && value >= arg;
      if (op === 'gt') return value != null && value > arg;
      throw new Error(`the evaluator does not know «${op}»`);
    });
  });
}

/** The order as it stands before anybody writes it off: pulled from a courier, waiting for the goods back. */
const awaiting = (): Any => ({
  id: ORDER,
  companyId: 'c1',
  storeId: 's1',
  orderNumber: 'ORD-2026-0099',
  confirmationStatus: 'CONFIRMED',
  shippingStatus: 'RETURN_REQUESTED',
  settlementStatus: 'PENDING',
  rejectionReason: null,
  trackingNumber: 'TRK-1',
  totalAmount: 100,
  returnedAt: null,
  returnReceipt: null,
  updatedAt: new Date('2026-10-01T08:00:00.000Z'),
  items: [
    { id: 'i1', productId: 'p1', quantity: 2, freeQuantity: 1, deliveredQty: null },
    { id: 'i2', productId: 'p2', quantity: 1, freeQuantity: 0, deliveredQty: null },
  ],
  deliveryProvider: { name: 'شركة' },
  replacedBy: null,
});

const writeOffReq = () =>
  writeOff(
    new Request('http://localhost/api/ops/tracking/write-off', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ orderId: ORDER, reason: 'الشركة لم تُرجع البضاعة بعد شهر' }),
    })
  );

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(WRITTEN_AT);
  state.order = awaiting();
  state.permissions = new Set(['ops.returns']);
  requireContext.mockResolvedValue({
    user: { id: 'u-fin', name: 'مالية' },
    companyId: 'c1',
    storeId: 's1',
    country: { allowNegativeStock: false, minorUnit: 3 },
  });
  requirePermission.mockResolvedValue({});
  consumeOrderStock.mockResolvedValue(undefined);
  db.$transaction.mockImplementation(async (fn: any) => fn(db));
  db.order.findFirst.mockImplementation(async () => state.order);
  db.returnReceipt.create.mockImplementation(async ({ data }: Any) => {
    // The unique `orderId` of the real table: a second receipt for the same order is refused.
    if (state.order!.returnReceipt) throw new Error('Unique constraint failed on orderId');
    state.order!.returnReceipt = { ...data, inspectedAt: new Date() };
    return state.order!.returnReceipt;
  });
  db.order.update.mockImplementation(async ({ data }: Any) => {
    const { version: _v, ...rest } = data;
    Object.assign(state.order!, rest, { updatedAt: new Date() });
    return { id: ORDER, orderNumber: 'ORD-2026-0099', shippingStatus: state.order!.shippingStatus, version: 2 };
  });
  db.orderActivity.create.mockResolvedValue({ id: 'a1' });
  db.store.findMany.mockResolvedValue([{ id: 's1', companyId: 'c1', countryId: 'jo', country: { id: 'jo', name: 'الأردن', code: 'JO', minorUnit: 3 } }]);
  db.notification.findFirst.mockResolvedValue(null);
  createNotification.mockResolvedValue(1);
  // Each reader's question, asked of the one order in memory.
  db.order.findMany.mockImplementation(async ({ where }: Any) => (state.order && matches(where, state.order) ? [state.order] : []));
  db.order.count.mockImplementation(async ({ where }: Any) => (state.order && matches(where, state.order) ? 1 : 0));
  db.orderIssue.count.mockResolvedValue(0);
  db.courierStatement.count.mockResolvedValue(0);
  db.orderChangeRequest.count.mockResolvedValue(0);
  db.deliveryFee.findMany.mockResolvedValue([]);
});

/** The order as the OLD door left it, for the controls: RETURNED, and no receipt. */
const leftTheOldWay = (): Any => ({ ...awaiting(), shippingStatus: 'RETURNED', updatedAt: WRITTEN_AT });

async function writtenOff(): Promise<Any> {
  const res = await writeOffReq();
  expect(res.status, JSON.stringify(await res.clone().json())).toBe(200);
  return state.order!;
}

describe('the door writes the receipt the desk writes for a count of nothing', () => {
  it('received 0, damaged 0, missing = the whole expected, with the loss note and the person', async () => {
    const o = await writtenOff();
    // two lines: 2 + 1 gift, and 1 — four units were to come back
    expect(o.returnReceipt).toMatchObject({
      companyId: 'c1',
      orderId: ORDER,
      expectedQty: 4,
      receivedQty: 0,
      damagedQty: 0,
      missingQty: 4,
      courierFeeCharged: false,
      courierFeeAmount: 0,
      inspectedById: 'u-fin',
      note: LOSS_RECEIPT_NOTE,
      stockRestored: false,
    });
    expect(LOSS_RECEIPT_NOTE).toBe('أُغلق كخسارة — لم يصل');
  });

  it('and stamps returnedAt, and owes no settlement on goods that never came back', async () => {
    const o = await writtenOff();
    expect(o.shippingStatus).toBe('RETURNED');
    expect(o.returnedAt).toEqual(WRITTEN_AT);
    expect(o.settlementStatus).toBe('NOT_APPLICABLE');
  });

  it('and takes the units off the shelf once, as consumed — the goods left and are not coming back', async () => {
    await writtenOff();
    expect(consumeOrderStock).toHaveBeenCalledTimes(1);
  });

  it('NEGATIVE: money already recorded against the order is NOT rewritten', async () => {
    for (const settlementStatus of ['SETTLED', 'COLLECTED', 'PARTIALLY_SETTLED', 'REFUNDED', 'PARTIALLY_REFUNDED']) {
      state.order = { ...awaiting(), settlementStatus };
      await writtenOff();
      expect(state.order!.settlementStatus, settlementStatus).toBe(settlementStatus);
      expect(state.order!.returnReceipt, 'but it is closed all the same').not.toBeNull();
    }
  });

  it('NEGATIVE: an order the desk already counted is refused, and nothing is consumed', async () => {
    state.order = { ...awaiting(), returnReceipt: { id: 'rr' } };
    const res = await writeOffReq();
    expect(res.status).toBe(409);
    expect((await res.json()).code).toBe('ALREADY_RECEIVED');
    expect(consumeOrderStock).not.toHaveBeenCalled();
    expect(db.returnReceipt.create).not.toHaveBeenCalled();
  });

  it('NEGATIVE: an order that is not waiting for its goods is still refused, as before', async () => {
    state.order = { ...awaiting(), shippingStatus: 'DELIVERED' };
    const res = await writeOffReq();
    expect(res.status).toBe(409);
    expect((await res.json()).code).toBe('NOT_AWAITING_RETURN');
    expect(db.returnReceipt.create).not.toHaveBeenCalled();
  });

  it('NEGATIVE: a second write-off in a race fails on the receipt, so the shelf is not drawn twice', async () => {
    state.order = awaiting();
    await writtenOff();
    // the second request read the order BEFORE the first landed: still waiting, no receipt
    state.order = { ...state.order!, shippingStatus: 'RETURN_REQUESTED' };
    db.order.findFirst.mockResolvedValueOnce({ ...awaiting() });
    const res = await writeOffReq();
    expect(res.status).toBeGreaterThanOrEqual(400);
  });

  it('the outcome word is READ from the receipt: «مفقود بعد الشحن — خسارة = مغلق», and it is closed', async () => {
    const o = await writtenOff();
    const outcome = orderOutcome(o as never);
    expect(outcome).toBe('LOST_AFTER_SHIPPING_CLOSED');
    expect(OUTCOME_LABEL_AR[outcome]).toBe('مفقود بعد الشحن — خسارة = مغلق');
    expect(closingStages({ shippingStatus: o.shippingStatus, settlementStatus: o.settlementStatus, returnReceived: true, confirmationStatus: o.confirmationStatus }).closed).toBe(true);
  });
});

describe('and every reader of «a return nobody has received» lets it go', () => {
  it('CONTROL: the order as the old door left it IS found by each of them', async () => {
    state.order = leftTheOldWay();
    expect(matches(viewScope('pending', { companyId: 'c1', storeId: 's1' }), state.order)).toBe(true);
    expect(matches(whereClosed() as Any, state.order)).toBe(false);

    await staleReturns.run({ now: LATER } as never);
    expect(createNotification).toHaveBeenCalledTimes(1);

    const items = ((await (await myWork()).json()) as { items: { key: string; count: number }[] }).items;
    expect(items.find((i) => i.key === 'RETURNS_WAITING')?.count).toBe(1);

    const v1 = attributionItem({ ...v1Row(), shippingStatus: 'RETURNED', returnedAt: null } as never, null);
    expect(v1.returned_at).toBeNull(); // the leak, in the media buyer's words
  });

  it('the desk\'s list of parcels waiting to be counted does not hold it', async () => {
    const o = await writtenOff();
    expect(matches(viewScope('pending', { companyId: 'c1', storeId: 's1' }), o)).toBe(false);
    // it is on the other list — the record of what was counted
    expect(matches(viewScope('received', { companyId: 'c1', storeId: 's1' }), o)).toBe(true);
  });

  it('the daily alert about returns that never arrived stays silent', async () => {
    await writtenOff();
    await staleReturns.run({ now: LATER } as never);
    expect(createNotification).not.toHaveBeenCalled();
  });

  it('«شغلك اليوم» counts no return waiting', async () => {
    await writtenOff();
    const items = ((await (await myWork()).json()) as { items: { key: string; count: number }[] }).items;
    expect(items.find((i) => i.key === 'RETURNS_WAITING')?.count ?? 0).toBe(0);
  });

  it('finance reads it as closed, not pending', async () => {
    const o = await writtenOff();
    expect(matches(whereClosed() as Any, o)).toBe(true);
  });

  it('the media buyer receives it as returned WITH its moment', async () => {
    const o = await writtenOff();
    const item = attributionItem({ ...v1Row(), shippingStatus: o.shippingStatus, returnedAt: o.returnedAt } as never, null);
    expect(item.status).toBe('returned');
    expect(item.returned_at).not.toBeNull();
    expect(item.returned_at).toContain('2026-10-01');
  });
});

/** The row the media buyer's select returns, around the two columns that matter here. */
function v1Row(): Any {
  return {
    id: ORDER,
    orderNumber: 'SY-0001',
    confirmationStatus: 'CONFIRMED',
    shippingStatus: 'RETURNED',
    claimedById: null,
    shippedAt: new Date('2026-09-20T05:00:00Z'),
    labelPrintedAt: null,
    confirmedAt: new Date('2026-09-19T05:00:00Z'),
    deliveredAt: null,
    returnedAt: null,
    createdAt: new Date('2026-09-18T04:00:00Z'),
    updatedAt: new Date('2026-10-01T05:00:00Z'),
    totalAmount: 20,
    collectedAmount: null,
    currency: 'USD',
    rejectionReason: null,
    source: 'Landing Page',
    externalChannel: null,
    adId: null,
    landingPageId: null,
    product: { sku: 'TRF01' },
    channel: null,
    campaign: null,
    landingPage: null,
    store: { country: { code: 'SY', timezone: 'Asia/Damascus', minorUnit: 2 } },
    statusLogs: [],
    contactAttempts: [],
  };
}
