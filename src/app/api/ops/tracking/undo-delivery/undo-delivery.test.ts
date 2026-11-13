import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * «تراجع عن التسليم» (13/11) — THE DOOR, GATE BY GATE.
 *
 *   «هاد الطلب بالغلط حطيتو تم والشركة بتقول تم ارجاعها لازم يكون في زر تراجع مش محدود بمدة زمنية ويكون عليه صلاحية للمالك متاح» (the owner)
 *
 * The rules and what the undo writes are proved against a database that remembers in `src/lib/delivery-undo.test.ts`. THIS file holds the
 * door's own shape: the key is asked FIRST, before the body is read and before a single order is; the measure writes nothing and opens no
 * transaction; the press is ONE transaction and every write goes through that transaction's own client; every refusal writes nothing; and
 * what it writes is exactly the list — never a wallet, an amount, the stock, an event or a knock.
 */

const { db, requireContext, requirePermission, can, logAudit, held, apps } = vi.hoisted(() => ({
  db: {
    order: { findFirst: vi.fn(), updateMany: vi.fn(), update: vi.fn() },
    orderItem: { updateMany: vi.fn(), update: vi.fn() },
    orderActivity: { findMany: vi.fn(), create: vi.fn() },
    orderStatusLog: { findMany: vi.fn(), create: vi.fn() },
    orderNote: { create: vi.fn() },
    commissionEntry: { findMany: vi.fn(), findUnique: vi.fn(), create: vi.fn(), update: vi.fn(), updateMany: vi.fn() },
    inventoryMovement: { findMany: vi.fn(), create: vi.fn(), createMany: vi.fn(), update: vi.fn(), updateMany: vi.fn() },
    customer: { findFirst: vi.fn(), update: vi.fn(), updateMany: vi.fn() },
    statementLine: { findMany: vi.fn() },
    settlementMatch: { findMany: vi.fn() },
    // The press must never reach any of these. The tests below fail on a single call.
    deliveryAttempt: { create: vi.fn(), findFirst: vi.fn() },
    walletMovement: { create: vi.fn(), createMany: vi.fn() },
    financialTransaction: { create: vi.fn() },
    productionBatch: { create: vi.fn(), update: vi.fn(), updateMany: vi.fn() },
    $transaction: vi.fn(async (fn: (tx: unknown) => unknown) => fn(db)),
  },
  requireContext: vi.fn(),
  requirePermission: vi.fn(),
  can: vi.fn(),
  logAudit: vi.fn(),
  held: { keys: new Set<string>() },
  apps: { emitAppEvent: vi.fn(), queueConversions: vi.fn() },
}));

vi.mock('@/lib/db', () => ({ db }));
vi.mock('@/lib/geo-context', () => ({ requireContext: (...a: unknown[]) => requireContext(...a) }));
vi.mock('@/lib/authorization', () => ({
  requirePermission: (...a: unknown[]) => requirePermission(...a),
  can: (...a: unknown[]) => can(...a),
}));
vi.mock('@/lib/audit', () => ({ logAudit: (...a: unknown[]) => logAudit(...a) }));
// System 7's events and the ad platforms' conversions: the undo must never reach either (it cannot recall what a delivery sent).
vi.mock('@/lib/apps/events', () => ({ emitAppEvent: (...a: unknown[]) => apps.emitAppEvent(...a) }));
vi.mock('@/lib/conversions/emit', () => ({ queueConversions: (...a: unknown[]) => apps.queueConversions(...a) }));

import { POST } from './route';
import {
  DELIVERY_UNDO_ACTION,
  DOOR_MARK,
  UNDO_FORBIDDEN_AR,
  UNDO_NOTE_PREFIX,
  UNDO_REASON_MAX,
  type UndoMeasure,
} from '@/lib/delivery-undo-words';

const UUID = '00000000-0000-4000-8000-000000000001';
const REASON = 'انسجّل تسليمو بالغلط — الشركة بتقول تم إرجاعها';

const orderRow = (over: Record<string, unknown> = {}) => ({
  id: UUID,
  orderNumber: 'ORD-2026-1696',
  merchantRef: 'MR-1696',
  trackingNumber: '100550615867',
  deliveryProviderId: 'p1',
  customerId: 'cu1',
  currency: 'USD',
  shippingStatus: 'DELIVERED',
  settlementStatus: 'PENDING_COLLECTION',
  status: 'SHIPPED',
  version: 7,
  collectedAmount: null,
  deliveryProvider: { name: 'الباشا' },
  items: [
    { id: 'i1', productName: 'كريم', deliveredQty: 2, returnedQty: 0 },
    { id: 'i2', productName: 'قطرة', deliveredQty: 2, returnedQty: 0 },
  ],
  returnReceipt: null,
  ...over,
});
const doorRow = (figure = 55) => ({ id: 'a1', action: DOOR_MARK, previousStatus: null, newStatus: 'DELIVERED', metadata: JSON.stringify({ expectedCollection: figure, deliveredValue: 50 }) });
const accrued = (over: Record<string, unknown> = {}) => ({
  id: 'ce1',
  companyId: 'c1',
  orderId: UUID,
  userId: 'ag1',
  role: 'CONFIRMATION_AGENT',
  ruleId: 'r1',
  status: 'ACCRUED',
  payoutId: null,
  amount: 2.1,
  currencyCode: 'USD',
  reversedBy: null,
  ...over,
});

const post = (body: unknown) =>
  POST(
    new Request('http://localhost/api/ops/tracking/undo-delivery', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
  );

const measure = async () => {
  const res = await post({ action: 'measure', orderId: UUID });
  return { res, body: (await res.json()) as UndoMeasure };
};
const undo = (m: UndoMeasure, over: Record<string, unknown> = {}) =>
  post({ action: 'undo', orderId: UUID, reason: REASON, fingerprint: m.fingerprint, acknowledged: true, ...over });

/** Everything that writes: none of it may have been called by a door that refused. */
const WRITES: [string, { mock: { calls: unknown[] } }][] = [
  ['order.updateMany', db.order.updateMany],
  ['order.update', db.order.update],
  ['orderItem.updateMany', db.orderItem.updateMany],
  ['orderItem.update', db.orderItem.update],
  ['orderActivity.create', db.orderActivity.create],
  ['orderStatusLog.create', db.orderStatusLog.create],
  ['orderNote.create', db.orderNote.create],
  ['commissionEntry.create', db.commissionEntry.create],
  ['commissionEntry.update', db.commissionEntry.update],
  ['commissionEntry.updateMany', db.commissionEntry.updateMany],
  ['customer.update', db.customer.update],
  ['customer.updateMany', db.customer.updateMany],
];
const nothingWritten = () => {
  for (const [name, fn] of WRITES) expect(fn.mock.calls, `${name} was called by a door that refused`).toHaveLength(0);
  expect(logAudit).not.toHaveBeenCalled();
};
/** What the undo must NEVER reach, whatever it does: the money, the stock, the knock and the events. */
const neverTouched = () => {
  for (const [name, fn] of [
    ['walletMovement.create', db.walletMovement.create],
    ['walletMovement.createMany', db.walletMovement.createMany],
    ['financialTransaction.create', db.financialTransaction.create],
    ['inventoryMovement.create', db.inventoryMovement.create],
    ['inventoryMovement.createMany', db.inventoryMovement.createMany],
    ['inventoryMovement.update', db.inventoryMovement.update],
    ['inventoryMovement.updateMany', db.inventoryMovement.updateMany],
    ['productionBatch.create', db.productionBatch.create],
    ['productionBatch.update', db.productionBatch.update],
    ['productionBatch.updateMany', db.productionBatch.updateMany],
    ['deliveryAttempt.create', db.deliveryAttempt.create],
    ['emitAppEvent', apps.emitAppEvent],
    ['queueConversions', apps.queueConversions],
  ] as [string, { mock: { calls: unknown[] } }][]) {
    expect(fn.mock.calls, `${name} was reached`).toHaveLength(0);
  }
};

beforeEach(() => {
  vi.clearAllMocks();
  held.keys = new Set(['ops.track', 'ops.undo_delivery']);
  requireContext.mockResolvedValue({ user: { id: 'u1', name: 'المالك', role: 'SUPER_ADMIN' }, companyId: 'c1', storeId: 's1' });
  requirePermission.mockImplementation(async (k: string) => {
    if (!held.keys.has(k)) throw new Error(`Forbidden: missing required permission ${k}`);
  });
  can.mockImplementation((_u: unknown, k: string) => held.keys.has(k));
  // `vi.clearAllMocks` keeps implementations: a test that hands out its own transaction client must not leave it for the next.
  db.$transaction.mockImplementation(async (fn: (tx: unknown) => unknown) => fn(db));
  db.order.findFirst.mockResolvedValue(orderRow());
  db.order.updateMany.mockResolvedValue({ count: 1 });
  db.orderActivity.findMany.mockResolvedValue([doorRow()]);
  db.orderStatusLog.findMany.mockResolvedValue([]);
  db.commissionEntry.findMany.mockResolvedValue([]);
  db.commissionEntry.findUnique.mockResolvedValue(null);
  db.inventoryMovement.findMany.mockResolvedValue([{ type: 'SALE', quantity: -4 }]);
  db.customer.findFirst.mockResolvedValue({ deliveredOrders: 5, totalPurchaseValue: 140 });
  db.statementLine.findMany.mockResolvedValue([]);
  db.settlementMatch.findMany.mockResolvedValue([]);
  db.orderItem.updateMany.mockResolvedValue({ count: 2 });
  db.customer.update.mockResolvedValue({});
  db.customer.updateMany.mockResolvedValue({ count: 0 });
  db.orderStatusLog.create.mockResolvedValue({});
  db.orderActivity.create.mockResolvedValue({});
  db.orderNote.create.mockResolvedValue({});
  db.commissionEntry.create.mockResolvedValue({});
  logAudit.mockResolvedValue(undefined);
});

describe('the key comes first — before the body is read, and before a single order is', () => {
  it('without the tracking key: refused, the body is never read, and nothing is read from the database — the measure and the press alike', async () => {
    held.keys = new Set(['ops.undo_delivery']);
    for (const body of [{ action: 'measure', orderId: UUID }, { action: 'undo', orderId: UUID, reason: REASON, fingerprint: 'f'.repeat(24), acknowledged: true }]) {
      const req = new Request('http://localhost/api/ops/tracking/undo-delivery', { method: 'POST', body: JSON.stringify(body) });
      const read = vi.spyOn(req, 'json');
      expect((await POST(req)).status).toBe(403);
      expect(read, 'the body was read before the key was asked').not.toHaveBeenCalled();
    }
    expect(db.order.findFirst).not.toHaveBeenCalled();
    nothingWritten();
  });

  it('NEGATIVE — THE OWNER ONLY: with the tracking key and every near key (deliver, transfer, write-off, close-legacy, the money keys) but WITHOUT this door’s own: 403 in Arabic, the key named, nothing read, body never read', async () => {
    held.keys = new Set([
      'ops.track', 'ops.deliver', 'ops.transfer', 'ops.write_off', 'ops.close_legacy', 'ops.returns', 'ops.returns_receive_all', 'ops.returns_view',
      'finance.cashbox', 'finance.cashbox_view', 'finance.update', 'settlement.view', 'settlement.approve', 'orders.unlock', 'orders.change_status',
    ]);
    for (const body of [{ action: 'measure', orderId: UUID }, { action: 'undo', orderId: UUID, reason: REASON, fingerprint: 'f'.repeat(24), acknowledged: true }]) {
      const req = new Request('http://localhost/api/ops/tracking/undo-delivery', { method: 'POST', body: JSON.stringify(body) });
      const read = vi.spyOn(req, 'json');
      const res = await POST(req);
      expect(res.status).toBe(403);
      const answer = await res.json();
      expect(answer.code).toBe('FORBIDDEN');
      expect(answer.error).toContain('ops.undo_delivery');
      expect(answer.errorAr).toBe(UNDO_FORBIDDEN_AR);
      expect(read).not.toHaveBeenCalled();
    }
    expect(db.order.findFirst).not.toHaveBeenCalled();
    nothingWritten();
    neverTouched();
  });

  it('asks the tracking key first and this door’s key second — in that order, once each', async () => {
    await post({ action: 'measure', orderId: UUID });
    expect(requirePermission).toHaveBeenCalledTimes(1);
    expect(requirePermission).toHaveBeenCalledWith('ops.track');
    expect(can).toHaveBeenCalledTimes(1);
    expect(can.mock.calls[0][1]).toBe('ops.undo_delivery');
    expect(requirePermission.mock.invocationCallOrder[0]).toBeLessThan(can.mock.invocationCallOrder[0]);
    expect(can.mock.invocationCallOrder[0]).toBeLessThan(db.order.findFirst.mock.invocationCallOrder[0]);
  });

  it('the holder of the key gets the measure', async () => {
    expect((await post({ action: 'measure', orderId: UUID })).status).toBe(200);
  });
});

describe('a bad body is a 400 before anything is read', () => {
  const ok = { action: 'undo', orderId: UUID, reason: REASON, fingerprint: 'f'.repeat(24), acknowledged: true };

  it('no body, no action, another action, a bad id, no reason, a short or blank reason, a reason over the limit, no tick, a false tick, no fingerprint', async () => {
    for (const bad of [
      null,
      {},
      { action: 'close', orderId: UUID },
      { action: 'measure' },
      { action: 'measure', orderId: 'not-a-uuid' },
      { action: 'measure', orderId: '' },
      { ...ok, orderId: 'nope' },
      { ...ok, reason: undefined },
      { ...ok, reason: 'غلط' }, // three characters: under the door's own minimum of five
      { ...ok, reason: '        ' },
      { ...ok, reason: 'x'.repeat(UNDO_REASON_MAX + 1) },
      { ...ok, acknowledged: undefined },
      { ...ok, acknowledged: false },
      { ...ok, acknowledged: 'yes' },
      { ...ok, fingerprint: undefined },
      { ...ok, fingerprint: 'short' },
    ]) {
      const res = await post(bad);
      expect(res.status, JSON.stringify(bad)).toBe(400);
    }
    expect(db.order.findFirst).not.toHaveBeenCalled();
    nothingWritten();
  });

  it('the reason’s own sentence names the field and the length, in Arabic — and exactly five characters is welcome', async () => {
    const short = await post({ ...ok, reason: 'غلط' });
    const body = await short.json();
    expect(body.error).toContain('السبب');
    expect(body.error).toContain('5 أحرف على الأقل');
    expect(body.errorAr).toBe(body.error);
    const { body: m } = await measure();
    expect((await post({ ...ok, fingerprint: m.fingerprint, reason: 'غلطان' })).status).toBe(200);
  });

  it('the reason is saved trimmed', async () => {
    const { body: m } = await measure();
    await post({ ...ok, fingerprint: m.fingerprint, reason: `   ${REASON}   ` });
    expect(db.orderNote.create.mock.calls[0][0].data.body).toBe(`${UNDO_NOTE_PREFIX}: ${REASON}`);
  });
});

describe('the measure — it writes NOTHING and opens no transaction', () => {
  it('answers whether it can be done, what it would reverse and what it would leave — without a single write, and without a transaction', async () => {
    const { res, body } = await measure();
    expect(res.status).toBe(200);
    expect(body).toMatchObject({ allowed: true, refusal: null, orderNumber: 'ORD-2026-1696', courier: 'الباشا', from: 'DELIVERED', to: 'SHIPPED' });
    expect(body.fingerprint).toMatch(/^[0-9a-f]{24}$/);
    expect(body.lines.map((l) => l.key)).toEqual(['STATUS', 'ITEMS', 'CUSTOMER']);
    expect(body.lines[2].amount).toEqual({ value: 55, currency: 'USD' });
    expect(body.stays.map((l) => l.key)).toEqual(['STOCK', 'MONEY', 'HISTORY', 'COMMISSION']);
    expect(db.$transaction, 'the measure opened a transaction').not.toHaveBeenCalled();
    nothingWritten();
    neverTouched();
  });

  it('reads THIS store’s order only: the company and the store are in the question', async () => {
    await measure();
    expect(db.order.findFirst.mock.calls[0][0].where).toEqual({ id: UUID, companyId: 'c1', storeId: 's1' });
  });

  it('an order that is not this store’s (or no order): 404, in Arabic, nothing else read', async () => {
    db.order.findFirst.mockResolvedValue(null);
    const res = await post({ action: 'measure', orderId: UUID });
    const body = await res.json();
    expect(res.status).toBe(404);
    expect(body).toMatchObject({ code: 'NOT_FOUND', errorAr: 'الطلب ما انلقى بهالمتجر.' });
    expect(db.orderActivity.findMany).not.toHaveBeenCalled();
  });

  it('a refusal is a 200 with the reason in words and no fingerprint — and still writes nothing', async () => {
    db.order.findFirst.mockResolvedValue(orderRow({ settlementStatus: 'SETTLED' }));
    const { res, body } = await measure();
    expect(res.status).toBe(200);
    expect(body).toMatchObject({ allowed: false, fingerprint: null, refusal: { code: 'MONEY_RECORDED' } });
    expect(body.refusal?.text).toContain('«مسوّى»');
    nothingWritten();
  });

  it('commission that is accrued is said as a line; a statement line is read for the reference AND the barcode', async () => {
    db.commissionEntry.findMany.mockResolvedValue([accrued()]);
    const { body } = await measure();
    expect(body.lines.map((l) => l.key)).toContain('COMMISSION');
    const where = db.statementLine.findMany.mock.calls[0][0].where;
    expect(where.statement).toEqual({ companyId: 'c1', storeId: 's1' });
    expect(where.OR).toEqual([{ merchantRef: { in: ['MR-1696'] } }, { barcode: { in: ['100550615867'] } }]);
  });
});

describe('the press — what it writes', () => {
  it('writes exactly the list, in order: the claim, the lines, the counters, the history — and answers in the door’s own sentence', async () => {
    const { body: m } = await measure();
    vi.clearAllMocks(); // the calls of the measure are not the press's (the mocks' answers stay)

    const res = await undo(m);
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body).toEqual({ undone: true, orderNumber: 'ORD-2026-1696', from: 'DELIVERED', to: 'SHIPPED', message: 'اتراجع عن تسليم الطلب ORD-2026-1696 — رجع «مشحون»' });

    // THE CLAIM: this order, this store, this version, this delivery, this settlement, no money and no counted return — and the status, no date, the next version
    expect(db.order.updateMany).toHaveBeenCalledTimes(1);
    expect(db.order.updateMany.mock.calls[0][0]).toEqual({
      where: { id: UUID, companyId: 'c1', storeId: 's1', version: 7, shippingStatus: 'DELIVERED', settlementStatus: 'PENDING_COLLECTION', collectedAmount: null, returnReceipt: null },
      data: { shippingStatus: 'SHIPPED', deliveredAt: null, version: { increment: 1 } },
    });
    // THE LINES the door spoke about
    expect(db.orderItem.updateMany.mock.calls[0][0]).toEqual({ where: { orderId: UUID, id: { in: ['i1', 'i2'] } }, data: { deliveredQty: null, returnedQty: null } });
    // THE CUSTOMER: exactly what the door added (one, and its expected collection), then the clamps that keep it from going below zero
    expect(db.customer.update.mock.calls[0][0]).toEqual({ where: { id: 'cu1' }, data: { deliveredOrders: { decrement: 1 }, totalPurchaseValue: { decrement: 55 } } });
    expect(db.customer.updateMany.mock.calls.map((c) => c[0])).toEqual([
      { where: { id: 'cu1', deliveredOrders: { lt: 0 } }, data: { deliveredOrders: 0 } },
      { where: { id: 'cu1', totalPurchaseValue: { lt: 0 } }, data: { totalPurchaseValue: 0 } },
    ]);
    // THE HISTORY: a timeline line, the activity, the note
    expect(db.orderStatusLog.create).toHaveBeenCalledTimes(1);
    expect(db.orderStatusLog.create.mock.calls[0][0].data).toEqual({
      companyId: 'c1',
      orderId: UUID,
      statusType: 'SHIPPING',
      previousValue: 'DELIVERED',
      newValue: 'SHIPPED',
      changedById: 'u1',
      changedByRole: 'SUPER_ADMIN',
      note: `${UNDO_NOTE_PREFIX}: ${REASON}`,
    });
    expect(db.orderActivity.create).toHaveBeenCalledTimes(1);
    const activity = db.orderActivity.create.mock.calls[0][0].data;
    expect(activity).toMatchObject({ companyId: 'c1', orderId: UUID, userId: 'u1', action: DELIVERY_UNDO_ACTION, previousStatus: 'DELIVERED', newStatus: 'SHIPPED' });
    expect(JSON.parse(activity.metadata)).toMatchObject({ reason: REASON, path: 'DOOR', items: 2, stock: 'KEPT', commissionVoided: 0 });
    expect(db.orderNote.create.mock.calls[0][0].data).toEqual({ companyId: 'c1', orderId: UUID, authorId: 'u1', kind: 'internal', body: `${UNDO_NOTE_PREFIX}: ${REASON}` });
    // no commission, so no reversing entry
    expect(db.commissionEntry.create).not.toHaveBeenCalled();
    neverTouched();

    // THE AUDIT: one line for the press
    expect(logAudit).toHaveBeenCalledTimes(1);
    expect(logAudit.mock.calls[0][0]).toMatchObject({
      companyId: 'c1',
      userId: 'u1',
      action: DELIVERY_UNDO_ACTION,
      entity: 'Order',
      entityId: UUID,
      previousData: { shippingStatus: 'DELIVERED', settlementStatus: 'PENDING_COLLECTION' },
      newData: { shippingStatus: 'SHIPPED', settlementStatus: 'PENDING_COLLECTION', path: 'DOOR', reason: REASON, items: 2, customer: { delivered: -1, value: -55 }, commissionVoided: 0, orderNumber: 'ORD-2026-1696' },
    });
  });

  it('an accrued commission is voided by ONE reversing entry through the existing helper — the original is not edited, and nothing is promoted or paid', async () => {
    db.commissionEntry.findMany.mockResolvedValue([accrued()]);
    const { body: m } = await measure();
    const res = await undo(m);
    expect(res.status).toBe(200);
    expect(db.commissionEntry.create).toHaveBeenCalledTimes(1);
    expect(db.commissionEntry.create.mock.calls[0][0].data).toMatchObject({
      companyId: 'c1',
      orderId: UUID,
      userId: 'ag1',
      amount: -2.1,
      currencyCode: 'USD',
      status: 'REVERSED',
      reversalOfId: 'ce1',
    });
    expect(db.commissionEntry.create.mock.calls[0][0].data.reversalReason).toContain(UNDO_NOTE_PREFIX);
    expect(db.commissionEntry.update).not.toHaveBeenCalled();
    expect(db.commissionEntry.updateMany).not.toHaveBeenCalled();
    neverTouched();
    expect(JSON.parse(db.orderActivity.create.mock.calls[0][0].data.metadata).commissionVoided).toBe(1);
  });

  it('THE PRESS IS ONE TRANSACTION, AND EVERY WRITE GOES THROUGH ITS CLIENT — the claim is undone with the rest when a refusal comes after it', async () => {
    db.commissionEntry.findMany.mockResolvedValue([accrued()]);
    const { body: m } = await measure();
    const touched = new Set<string>();
    const tx = new Proxy(db, {
      get(target, prop: string) {
        touched.add(prop);
        return (target as unknown as Record<string, unknown>)[prop];
      },
    });
    db.$transaction.mockClear();
    db.$transaction.mockImplementation(async (fn: (c: unknown) => unknown) => fn(tx));
    const res = await undo(m);
    expect(res.status).toBe(200);
    expect(db.$transaction, 'the press ran without a transaction (or in several): a refusal after the claim could not take it back').toHaveBeenCalledTimes(1);
    expect((db.$transaction.mock.calls[0] as unknown[])[1]).toEqual({ timeout: 30_000, maxWait: 10_000 });
    for (const part of ['order', 'orderItem', 'customer', 'commissionEntry', 'orderStatusLog', 'orderActivity', 'orderNote', 'statementLine', 'settlementMatch', 'inventoryMovement']) {
      expect(touched.has(part), `${part} was not reached through the transaction's client`).toBe(true);
    }
  });

  it('the measure, on the other hand, opens no transaction at all', async () => {
    await measure();
    expect(db.$transaction).not.toHaveBeenCalled();
  });

  it('claims first: nothing is written before the claim, and the statements and the commission are read AGAIN after it, before the first write', async () => {
    db.commissionEntry.findMany.mockResolvedValue([accrued()]);
    const { body: m } = await measure();
    vi.clearAllMocks(); // the calls of the measure are not the press's (the mocks' answers stay)
    expect((await undo(m)).status).toBe(200);

    const claim = db.order.updateMany.mock.invocationCallOrder[0];
    const firstWrite = Math.min(
      ...[db.orderItem.updateMany, db.customer.update, db.commissionEntry.create, db.orderStatusLog.create, db.orderActivity.create, db.orderNote.create].flatMap((f) => f.mock.invocationCallOrder)
    );
    expect(claim).toBeLessThan(firstWrite);
    const lines = db.statementLine.findMany.mock.invocationCallOrder;
    const entries = db.commissionEntry.findMany.mock.invocationCallOrder;
    expect(lines.some((n) => n < claim), 'a statement read before the claim').toBe(true);
    expect(lines.some((n) => n > claim && n < firstWrite), 'a statement read AFTER the claim').toBe(true);
    expect(entries.some((n) => n > claim && n < firstWrite), 'a commission read AFTER the claim').toBe(true);
    expect(db.settlementMatch.findMany.mock.invocationCallOrder.some((n) => n > claim && n < firstWrite)).toBe(true);
  });

  it('a delivery recorded through the order’s own door: the settlement line and the timeline’s «before» are written; the customer is not touched', async () => {
    db.order.findFirst.mockResolvedValue(orderRow({ settlementStatus: 'COLLECTED', status: 'DELIVERED', items: [{ id: 'i1', productName: 'كريم', deliveredQty: null, returnedQty: null }] }));
    db.orderActivity.findMany.mockResolvedValue([{ id: 'a2', action: 'SHIPPING_STATUS_CHANGED', previousStatus: 'OUT_FOR_DELIVERY', newStatus: 'DELIVERED', metadata: '{}' }]);
    db.orderStatusLog.findMany.mockResolvedValue([{ previousValue: 'OUT_FOR_DELIVERY', newValue: 'DELIVERED' }]);
    const { body: m } = await measure();
    expect(m).toMatchObject({ allowed: true, to: 'OUT_FOR_DELIVERY' });
    expect((await undo(m)).status).toBe(200);
    expect(db.order.updateMany.mock.calls[0][0].data).toEqual({ shippingStatus: 'OUT_FOR_DELIVERY', deliveredAt: null, version: { increment: 1 }, status: 'SHIPPED', settlementStatus: 'PENDING_COLLECTION' });
    expect(db.order.updateMany.mock.calls[0][0].where.settlementStatus).toBe('COLLECTED');
    expect(db.orderStatusLog.create.mock.calls.map((c) => [c[0].data.statusType, c[0].data.previousValue, c[0].data.newValue])).toEqual([
      ['SHIPPING', 'DELIVERED', 'OUT_FOR_DELIVERY'],
      ['SETTLEMENT', 'COLLECTED', 'PENDING_COLLECTION'],
    ]);
    expect(db.customer.update).not.toHaveBeenCalled();
    expect(db.orderItem.updateMany).not.toHaveBeenCalled();
    neverTouched();
  });
});

describe('the press — every refusal writes NOTHING', () => {
  const refused = async (code: string, over: Record<string, unknown> = {}, status = 409) => {
    const { body: m } = await measure();
    const res = await undo(m, over);
    const body = await res.json();
    expect(res.status).toBe(status);
    expect(body.code).toBe(code);
    expect(body.errorAr, 'a refusal with no sentence').toEqual(expect.any(String));
    expect(body.errorAr.length).toBeGreaterThan(10);
    return body;
  };

  it('the numbers changed after the dialog opened (another fingerprint): «changed», with the sentence that says what to do', async () => {
    const body = await refused('CHANGED', { fingerprint: 'a'.repeat(24) });
    expect(body.errorAr).toContain('افتحها من جديد');
    nothingWritten();
    neverTouched();
  });

  it('money recorded on the order: refused, in words', async () => {
    const { body: m } = await measure();
    db.order.findFirst.mockResolvedValue(orderRow({ settlementStatus: 'SETTLED' }));
    const res = await undo(m);
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.code).toBe('MONEY_RECORDED');
    expect(body.errorAr).toContain('«مسوّى»');
    nothingWritten();
  });

  it('a statement names the order — the collect door’s own sentence, nothing written', async () => {
    const { body: m } = await measure();
    db.statementLine.findMany.mockResolvedValue([{ merchantRef: 'MR-1696', barcode: null, statement: { reference: 'ST-9', status: 'APPROVED', approvedAt: new Date(), deliveryProviderId: 'p1' }, matches: [] }]);
    const res = await undo(m);
    const body = await res.json();
    expect(res.status).toBe(409);
    expect(body.code).toBe('ON_A_STATEMENT');
    expect(body.errorAr).toContain('ST-9');
    nothingWritten();
  });

  it('a counted return', async () => {
    const { body: m } = await measure();
    db.order.findFirst.mockResolvedValue(orderRow({ returnReceipt: { id: 'rr1' } }));
    expect((await (await undo(m)).json()).code).toBe('RETURN_COUNTED');
    nothingWritten();
  });

  it('a commission that is payable', async () => {
    const { body: m } = await measure();
    db.commissionEntry.findMany.mockResolvedValue([accrued({ status: 'PAYABLE' })]);
    const body = await (await undo(m)).json();
    expect(body.code).toBe('COMMISSION_MOVED');
    nothingWritten();
  });

  it('a delivery whose recording the ledgers cannot prove', async () => {
    const { body: m } = await measure();
    db.orderActivity.findMany.mockResolvedValue([]);
    expect((await (await undo(m)).json()).code).toBe('PATH_UNKNOWN');
    nothingWritten();
  });

  it('an order that is not delivered any more', async () => {
    const { body: m } = await measure();
    db.order.findFirst.mockResolvedValue(orderRow({ shippingStatus: 'SHIPPED' }));
    expect((await (await undo(m)).json()).code).toBe('NOT_DELIVERED');
    nothingWritten();
  });

  it('an order that is not this store’s: 404, nothing written', async () => {
    const { body: m } = await measure();
    db.order.findFirst.mockResolvedValue(null);
    const res = await undo(m);
    expect(res.status).toBe(404);
    expect((await res.json()).code).toBe('NOT_FOUND');
    nothingWritten();
  });

  it('TWO PRESSES AT ONCE / the order changed between the read and the claim (the claim is SHORT): all or nothing — no line, no counter, no entry, no note, no audit', async () => {
    db.commissionEntry.findMany.mockResolvedValue([accrued()]);
    const { body: m } = await measure();
    db.order.updateMany.mockResolvedValue({ count: 0 });
    const res = await undo(m);
    const body = await res.json();
    expect(res.status).toBe(409);
    expect(body.code).toBe('ORDERS_CHANGED');
    expect(db.order.updateMany).toHaveBeenCalledTimes(1);
    for (const [name, fn] of WRITES.filter(([n]) => n !== 'order.updateMany')) expect(fn.mock.calls, `${name} wrote after a short claim`).toHaveLength(0);
    expect(logAudit).not.toHaveBeenCalled();
    neverTouched();
  });

  it('a statement uploaded while the press waited for the row (the second read names the order): nothing after the claim is written', async () => {
    const { body: m } = await measure();
    db.statementLine.findMany.mockReset();
    db.statementLine.findMany
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{ merchantRef: 'MR-1696', barcode: null, statement: { reference: 'ST-LATE', status: 'DRAFT', approvedAt: null, deliveryProviderId: 'p1' }, matches: [] }]);
    const res = await undo(m);
    const body = await res.json();
    expect(res.status).toBe(409);
    expect(body.code).toBe('ON_A_STATEMENT');
    expect(body.errorAr).toContain('وقت التراجع');
    for (const [name, fn] of WRITES.filter(([n]) => n !== 'order.updateMany')) expect(fn.mock.calls, `${name} wrote after a late statement`).toHaveLength(0);
    expect(logAudit).not.toHaveBeenCalled();
  });

  it('a commission made payable while the press waited: nothing after the claim is written', async () => {
    db.commissionEntry.findMany.mockResolvedValueOnce([accrued()]);
    const { body: m } = await measure();
    db.commissionEntry.findMany.mockReset();
    db.commissionEntry.findMany.mockResolvedValueOnce([accrued()]).mockResolvedValueOnce([accrued({ status: 'PAYABLE' })]);
    const res = await undo(m);
    expect(res.status).toBe(409);
    expect((await res.json()).code).toBe('COMMISSION_MOVED');
    for (const [name, fn] of WRITES.filter(([n]) => n !== 'order.updateMany')) expect(fn.mock.calls, `${name} wrote after a late payable commission`).toHaveLength(0);
    expect(logAudit).not.toHaveBeenCalled();
  });

  it('a second press after the first succeeded is refused as «already undone» and writes nothing', async () => {
    const { body: m } = await measure();
    expect((await undo(m)).status).toBe(200);
    vi.clearAllMocks();
    db.order.findFirst.mockResolvedValue(orderRow({ shippingStatus: 'SHIPPED' }));
    db.orderActivity.findMany.mockResolvedValue([{ id: 'a9', action: DELIVERY_UNDO_ACTION, previousStatus: 'DELIVERED', newStatus: 'SHIPPED', metadata: '{}' }, doorRow()]);
    db.orderStatusLog.findMany.mockResolvedValue([]);
    db.commissionEntry.findMany.mockResolvedValue([]);
    db.inventoryMovement.findMany.mockResolvedValue([]);
    db.customer.findFirst.mockResolvedValue({ deliveredOrders: 4, totalPurchaseValue: 85 });
    db.statementLine.findMany.mockResolvedValue([]);
    db.settlementMatch.findMany.mockResolvedValue([]);
    const again = await undo(m);
    expect(again.status).toBe(409);
    expect((await again.json()).code).toBe('ALREADY_UNDONE');
    nothingWritten();
  });

  it('a failure that is not one of the door’s own refusals is not swallowed (it reaches the shared error handler), and writes nothing after it', async () => {
    const { body: m } = await measure();
    db.order.updateMany.mockRejectedValue(new Error('connection reset'));
    const res = await undo(m);
    expect(res.status).toBeGreaterThanOrEqual(500);
    expect(db.orderStatusLog.create).not.toHaveBeenCalled();
    expect(db.orderActivity.create).not.toHaveBeenCalled();
    expect(db.orderNote.create).not.toHaveBeenCalled();
    expect(logAudit).not.toHaveBeenCalled();
  });
});

describe('NO TIME WINDOW — an order delivered a minute ago and one delivered years ago are judged by the same facts', () => {
  it('the door never reads a date from the order, so there is no age to refuse on', async () => {
    await measure();
    const select = db.order.findFirst.mock.calls[0][0].select;
    for (const key of ['deliveredAt', 'shippedAt', 'createdAt', 'updatedAt', 'returnedAt']) expect(select, key).not.toHaveProperty(key);
    // the activity rows are asked for by their action and never by a time
    const where = db.orderActivity.findMany.mock.calls[0][0].where;
    expect(Object.keys(where).sort()).toEqual(['action', 'companyId', 'orderId']);
  });
});
