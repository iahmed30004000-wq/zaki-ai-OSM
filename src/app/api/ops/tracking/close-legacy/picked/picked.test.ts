import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * «أقفل المحدّد بلا حركة مال» (13/11) — THE DOOR, GATE BY GATE.
 *
 *   «اقدر اعمل هالحركة هاي لاي طلب حتى لو عليه باركود، بس بدي الزر هاد متاح للمالك فقط» (the owner)
 *
 * The owner ticks orders on the follow-up list; the door closes THOSE — any barcode, any age — as collected, with no money moved.
 * Each refusal asserts that NOTHING was written — the order, the settlement log, the mark and the audit — because a refusal that
 * wrote half of it is the defect again. And every test that writes asserts what it does NOT touch: the money.
 */

const { db, requireContext, requirePermission, can, logAudit, held } = vi.hoisted(() => ({
  db: {
    order: { findMany: vi.fn(), updateMany: vi.fn() },
    statementLine: { findMany: vi.fn() },
    settlementMatch: { findMany: vi.fn() },
    orderStatusLog: { createMany: vi.fn() },
    orderActivity: { createMany: vi.fn() },
    // The press must never reach any of these. The tests below fail on a single call.
    walletMovement: { create: vi.fn(), createMany: vi.fn() },
    commissionEntry: { updateMany: vi.fn(), create: vi.fn() },
    financialTransaction: { create: vi.fn() },
    $transaction: vi.fn(async (fn: (tx: unknown) => unknown) => fn(db)),
  },
  requireContext: vi.fn(),
  requirePermission: vi.fn(),
  can: vi.fn(),
  logAudit: vi.fn(),
  held: { keys: new Set<string>() },
}));

vi.mock('@/lib/db', () => ({ db }));
vi.mock('@/lib/geo-context', () => ({ requireContext: (...a: unknown[]) => requireContext(...a) }));
vi.mock('@/lib/authorization', () => ({
  requirePermission: (...a: unknown[]) => requirePermission(...a),
  can: (...a: unknown[]) => can(...a),
}));
vi.mock('@/lib/audit', () => ({ logAudit: (...a: unknown[]) => logAudit(...a) }));

import { POST } from './route';
import { LEGACY_CLOSE_ACTION, PICKED_CLOSE_AUDIT, PICKED_CLOSE_NOTE, PICKED_MOST } from '@/lib/legacy-closeout-words';
import { stillClosablePickedWhere } from '@/lib/legacy-closeout-picked';

const DAY = 86_400_000;
const daysAgo = (n: number) => new Date(Date.now() - n * DAY);

let seq = 0;
const order = (over: Record<string, unknown> = {}) => {
  seq += 1;
  return {
    id: `00000000-0000-4000-8000-${String(seq).padStart(12, '0')}`,
    orderNumber: `ORD-${seq}`,
    merchantRef: `ORD-${seq}`,
    trackingNumber: null,
    deliveryProviderId: 'p1',
    settlementStatus: 'PENDING',
    shippingStatus: 'DELIVERED',
    deliveredAt: daysAgo(40),
    shippedAt: daysAgo(45),
    createdAt: daysAgo(50),
    currency: 'USD',
    totalAmount: 20,
    deliveryProvider: { name: 'الباشا' },
    ...over,
  };
};
const idsOf = (rows: { id: string }[]) => rows.map((r) => r.id);

const post = (body: unknown) =>
  POST(
    new Request('http://localhost/api/ops/tracking/close-legacy/picked', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
  );

type Measure = {
  asked: number;
  closeable: { count: number; fingerprint: string; withBarcode: number; recent: number; byCourier: { name: string; count: number }[]; value: { currency: string; amount: number }[] };
  left: { orderNumber: string | null; why: string; text: string }[];
  leftTotal: number;
};

/** The dialog's two steps: measure, then press with what it showed. */
async function measure(orders: { id: string }[]) {
  const res = await post({ action: 'measure', orderIds: idsOf(orders) });
  return { res, body: (await res.json()) as Measure };
}
const press = (orders: { id: string }[], m: Measure, over: Record<string, unknown> = {}) =>
  post({ action: 'close', orderIds: idsOf(orders), fingerprint: m.closeable.fingerprint, count: m.closeable.count, acknowledged: true, ...over });

const nothingWritten = () => {
  expect(db.order.updateMany).not.toHaveBeenCalled();
  expect(db.orderStatusLog.createMany).not.toHaveBeenCalled();
  expect(db.orderActivity.createMany).not.toHaveBeenCalled();
  expect(logAudit).not.toHaveBeenCalled();
};
const noMoneyTouched = () => {
  expect(db.walletMovement.create).not.toHaveBeenCalled();
  expect(db.walletMovement.createMany).not.toHaveBeenCalled();
  expect(db.commissionEntry.updateMany).not.toHaveBeenCalled();
  expect(db.commissionEntry.create).not.toHaveBeenCalled();
  expect(db.financialTransaction.create).not.toHaveBeenCalled();
};

beforeEach(() => {
  vi.clearAllMocks();
  seq = 0;
  held.keys = new Set(['ops.track', 'ops.close_legacy']);
  requireContext.mockResolvedValue({ user: { id: 'u1', name: 'المالك', role: 'SUPER_ADMIN' }, companyId: 'c1', storeId: 's1' });
  requirePermission.mockImplementation(async (k: string) => {
    if (!held.keys.has(k)) throw new Error(`Forbidden: missing required permission ${k}`);
  });
  can.mockImplementation((_u: unknown, k: string) => held.keys.has(k));
  db.order.findMany.mockResolvedValue([]);
  db.order.updateMany.mockImplementation(async (a: { where: { id: { in: string[] } } }) => ({ count: a.where.id.in.length }));
  db.statementLine.findMany.mockResolvedValue([]);
  db.settlementMatch.findMany.mockResolvedValue([]);
  db.orderStatusLog.createMany.mockResolvedValue({ count: 0 });
  db.orderActivity.createMany.mockResolvedValue({ count: 0 });
  logAudit.mockResolvedValue(undefined);
});

const UUID = '00000000-0000-4000-8000-0000000000aa';
const okClose = { action: 'close', orderIds: [UUID], fingerprint: 'f'.repeat(24), count: 1, acknowledged: true };

describe('the gates come first — nothing is read, nothing is written', () => {
  it('without the tracking key: refused, and the door reads nothing — the measure and the press alike', async () => {
    held.keys = new Set(['ops.close_legacy']);
    expect((await post({ action: 'measure', orderIds: [UUID] })).status).toBe(403);
    expect((await post(okClose)).status).toBe(403);
    expect(db.order.findMany).not.toHaveBeenCalled();
    nothingWritten();
  });

  it('NEGATIVE — THE OWNER ONLY: with the tracking key and every finance key but WITHOUT this door’s own key: refused in Arabic, nothing read', async () => {
    held.keys = new Set(['ops.track', 'ops.write_off', 'ops.deliver', 'ops.transfer', 'finance.cashbox', 'settlement.view', 'settlement.approve', 'finance.update']);
    for (const body of [{ action: 'measure', orderIds: [UUID] }, okClose]) {
      const res = await post(body);
      expect(res.status).toBe(403);
      const answer = await res.json();
      expect(answer.code).toBe('FORBIDDEN');
      expect(answer.error).toContain('ops.close_legacy');
      expect(answer.errorAr).toContain('مش من صلاحياتك');
    }
    expect(db.order.findMany).not.toHaveBeenCalled();
    expect(db.statementLine.findMany).not.toHaveBeenCalled();
    nothingWritten();
    noMoneyTouched();
  });

  it('the key is asked BEFORE the body is read: a person without it gets «403», never «400», whatever they send', async () => {
    held.keys = new Set(['ops.track']);
    for (const body of [null, {}, { action: 'nope' }, { action: 'close' }]) {
      expect((await post(body)).status, JSON.stringify(body)).toBe(403);
    }
  });

  it('a bad body is a 400 before anything is read: no body, an unknown action, no ids, too many ids, a non-id, no tick, a false tick, no count, a short fingerprint', async () => {
    const tooMany = Array.from({ length: PICKED_MOST + 1 }, (_, i) => `00000000-0000-4000-8000-${String(i + 1).padStart(12, '0')}`);
    for (const bad of [
      null,
      {},
      { action: 'nope', orderIds: [UUID] },
      { action: 'measure' },
      { action: 'measure', orderIds: [] },
      { action: 'measure', orderIds: tooMany },
      { action: 'measure', orderIds: ['not-an-id'] },
      { ...okClose, orderIds: [] },
      { ...okClose, acknowledged: undefined },
      { ...okClose, acknowledged: false },
      { ...okClose, acknowledged: 'yes' },
      { ...okClose, count: 0 },
      { ...okClose, count: 1.5 },
      { ...okClose, count: PICKED_MOST + 1 },
      { ...okClose, fingerprint: 'short' },
      { action: 'close', orderIds: [UUID], count: 1, acknowledged: true },
    ]) {
      const res = await post(bad);
      expect(res.status, JSON.stringify(bad).slice(0, 80)).toBe(400);
    }
    expect(db.order.findMany).not.toHaveBeenCalled();
    nothingWritten();
  });
});

describe('the question — it measures and writes NOTHING', () => {
  it('asks the database for the ticked ids of THIS store only — each once, however often they were sent', async () => {
    const a = order();
    await post({ action: 'measure', orderIds: [a.id, a.id] });
    expect(db.order.findMany).toHaveBeenCalledTimes(1);
    expect(db.order.findMany.mock.calls[0][0].where).toEqual({ companyId: 'c1', storeId: 's1', id: { in: [a.id] } });
  });

  it('answers the count, whose they are, what they are worth, the barcodes and the recent ones, and what is left — without a single write', async () => {
    const rows = [
      order({ totalAmount: 25 }),
      order({ totalAmount: 15, deliveryProvider: { name: 'الو دليفيري' }, trackingNumber: 'BP-1', deliveredAt: daysAgo(2) }),
      order({ settlementStatus: 'COLLECTED' }),
    ];
    db.order.findMany.mockResolvedValue(rows);
    const { res, body } = await measure(rows);

    expect(res.status).toBe(200);
    expect(body.asked).toBe(3);
    expect(body.closeable.count).toBe(2);
    expect(body.closeable.byCourier).toEqual([
      { name: 'الباشا', count: 1 },
      { name: 'الو دليفيري', count: 1 },
    ]);
    expect(body.closeable.value).toEqual([{ currency: 'USD', amount: 40 }]);
    expect(body.closeable.withBarcode).toBe(1);
    expect(body.closeable.recent).toBe(1);
    expect(body.leftTotal).toBe(1);
    expect(body.left).toEqual([{ orderNumber: 'ORD-3', why: 'MONEY_RECORDED', text: expect.stringContaining('ORD-3') }]);
    expect(body.closeable.fingerprint).toMatch(/^[0-9a-f]{24}$/);
    nothingWritten();
    noMoneyTouched();
    expect(db.$transaction).not.toHaveBeenCalled();
  });

  it('a BARCODED order is closeable and so is one of yesterday — the owner: «لاي طلب حتى لو عليه باركود»', async () => {
    const withBarcode = order({ trackingNumber: 'BP-55', deliveredAt: daysAgo(1) });
    db.order.findMany.mockResolvedValue([withBarcode]);
    const { body } = await measure([withBarcode]);
    expect(body.closeable.count).toBe(1);
    expect(body.closeable.withBarcode).toBe(1);
    expect(body.closeable.recent).toBe(1);
    expect(body.leftTotal).toBe(0);
  });

  it('every reason is said by the order’s number: not delivered · already settled · money recorded (three kinds) · a statement · not found', async () => {
    const shipped = order({ shippingStatus: 'SHIPPED' });
    const settled = order({ settlementStatus: 'SETTLED' });
    const collected = order({ settlementStatus: 'COLLECTED' });
    const part = order({ settlementStatus: 'PARTIALLY_SETTLED' });
    const refunded = order({ settlementStatus: 'REFUNDED' });
    const named = order({ merchantRef: 'ORD-STMT' });
    db.order.findMany.mockResolvedValue([shipped, settled, collected, part, refunded, named]);
    db.statementLine.findMany.mockResolvedValue([
      { merchantRef: 'ORD-STMT', barcode: null, statement: { reference: 'ST-7', status: 'DRAFT', approvedAt: null, deliveryProviderId: 'p1' }, matches: [] },
    ]);
    const ghost = { id: '00000000-0000-4000-8000-0000000000ff' };
    const { body } = await measure([shipped, settled, collected, part, refunded, named, ghost]);

    expect(body.closeable.count).toBe(0);
    expect(body.leftTotal).toBe(7);
    // The stale id comes first, then each order in the order it was ticked.
    expect(body.left.map((l) => l.why)).toEqual(['NOT_FOUND', 'NOT_DELIVERED', 'ALREADY_SETTLED', 'MONEY_RECORDED', 'MONEY_RECORDED', 'MONEY_RECORDED', 'ON_A_STATEMENT']);
    // The sentence is the collect door's own, and it carries the order's NUMBER (the statement named its reference).
    expect(body.left[6].text).toContain(named.orderNumber);
    expect(body.left[6].text).toContain('ما انعتمد');
    nothingWritten();
  });

  it('a BARCODED order that a statement names — by the courier’s barcode, within that courier — is left to the statement', async () => {
    const mine = order({ merchantRef: null, trackingNumber: 'BP-77', deliveryProviderId: 'p1' });
    db.order.findMany.mockResolvedValue([mine]);
    db.statementLine.findMany.mockResolvedValue([
      { merchantRef: null, barcode: 'BP-77', statement: { reference: 'ST-8', status: 'APPROVED', approvedAt: new Date(), deliveryProviderId: 'p1' }, matches: [] },
    ]);
    const { body } = await measure([mine]);
    expect(body.closeable.count).toBe(0);
    expect(body.left[0]).toMatchObject({ why: 'ON_A_STATEMENT' });
    expect(body.left[0].text).toContain('ST-8');
  });

  it('the same barcode on ANOTHER courier’s statement does not name it', async () => {
    const mine = order({ merchantRef: null, trackingNumber: 'BP-77', deliveryProviderId: 'p1' });
    db.order.findMany.mockResolvedValue([mine]);
    db.statementLine.findMany.mockResolvedValue([
      { merchantRef: null, barcode: 'BP-77', statement: { reference: 'ST-9', status: 'DRAFT', approvedAt: null, deliveryProviderId: 'p2' }, matches: [] },
    ]);
    expect((await measure([mine])).body.closeable.count).toBe(1);
  });

  it('a line a person tied to the order by hand names it, whatever it carries', async () => {
    const a = order({ merchantRef: null });
    db.order.findMany.mockResolvedValue([a]);
    db.settlementMatch.findMany.mockResolvedValue([
      { orderId: a.id, result: 'MATCHED', statement: { reference: 'ST-2', status: 'DRAFT', approvedAt: null, deliveryProviderId: 'p1' } },
    ]);
    expect((await measure([a])).body.left[0].why).toBe('ON_A_STATEMENT');
  });
});

describe('the press — closes exactly what the measure showed, and only that', () => {
  it('claims the ticked orders that qualify, writes the log and the mark, and one audit line — and NOTHING that is money', async () => {
    const barcoded = order({ trackingNumber: 'BP-1', settlementStatus: 'PENDING_COLLECTION', deliveredAt: daysAgo(3) });
    const plain = order({ settlementStatus: 'PENDING' });
    const settled = order({ settlementStatus: 'SETTLED' });
    const rows = [barcoded, plain, settled];
    db.order.findMany.mockResolvedValue(rows);
    const { body: m } = await measure(rows);
    expect(m.closeable.count).toBe(2);
    vi.clearAllMocks();
    db.order.findMany.mockResolvedValue(rows);
    db.order.updateMany.mockImplementation(async (a: { where: { id: { in: string[] } } }) => ({ count: a.where.id.in.length }));
    db.statementLine.findMany.mockResolvedValue([]);
    db.settlementMatch.findMany.mockResolvedValue([]);

    const res = await press(rows, m);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ closed: 2, message: 'اتقفل 2 طلب كمحصَّل — بلا أي حركة مصاري' });

    // The claim: the two that qualify (not the settled one), with the claim's own WHERE.
    expect(db.order.updateMany).toHaveBeenCalledTimes(1);
    const claim = db.order.updateMany.mock.calls[0][0];
    expect(claim.where).toEqual(stillClosablePickedWhere({ companyId: 'c1', storeId: 's1' }, [barcoded.id, plain.id]));
    expect(claim.data).toEqual({ settlementStatus: 'SETTLED' });

    // One line on each order's settlement log, in the owner's own words, with the state it was in.
    const log = db.orderStatusLog.createMany.mock.calls[0][0].data;
    expect(log).toHaveLength(2);
    expect(log[0]).toMatchObject({ companyId: 'c1', orderId: barcoded.id, statusType: 'SETTLEMENT', previousValue: 'PENDING_COLLECTION', newValue: 'SETTLED', changedById: 'u1', changedByRole: 'SUPER_ADMIN', note: PICKED_CLOSE_NOTE });
    expect(log[1]).toMatchObject({ orderId: plain.id, previousValue: 'PENDING', newValue: 'SETTLED' });

    // The MARK the commission rule reads — the same one the old-ones press writes — with the state it was in, for the rollback.
    const marks = db.orderActivity.createMany.mock.calls[0][0].data;
    expect(marks).toHaveLength(2);
    expect(marks[0]).toMatchObject({ companyId: 'c1', orderId: barcoded.id, userId: 'u1', action: LEGACY_CLOSE_ACTION, previousStatus: 'PENDING_COLLECTION', newStatus: 'SETTLED' });
    expect(JSON.parse(marks[0].metadata)).toEqual({ picked: true, note: PICKED_CLOSE_NOTE });

    // One audit line for the press.
    expect(logAudit).toHaveBeenCalledTimes(1);
    expect(logAudit.mock.calls[0][0]).toMatchObject({ companyId: 'c1', userId: 'u1', action: PICKED_CLOSE_AUDIT, entity: 'Store', entityId: 's1' });
    expect(logAudit.mock.calls[0][0].newData).toMatchObject({ closed: 2, withBarcode: 1, recent: 1, first: ['ORD-1', 'ORD-2'] });
    noMoneyTouched();
  });

  it('claims, then looks at the statements AGAIN, and only then writes the log and the mark — in that order, by the calls actually made', async () => {
    const a = order();
    db.order.findMany.mockResolvedValue([a]);
    const { body: m } = await measure([a]);
    vi.clearAllMocks();
    db.order.findMany.mockResolvedValue([a]);
    db.order.updateMany.mockImplementation(async (x: { where: { id: { in: string[] } } }) => ({ count: x.where.id.in.length }));
    db.statementLine.findMany.mockResolvedValue([]);
    db.settlementMatch.findMany.mockResolvedValue([]);
    await press([a], m);

    const at = (f: { mock: { invocationCallOrder: number[] } }, i = 0) => f.mock.invocationCallOrder[i];
    // The first look is the read inside `readPicked` (its hand-link question); the second one is the one after the claim.
    expect(db.settlementMatch.findMany).toHaveBeenCalledTimes(2);
    expect(at(db.settlementMatch.findMany, 0)).toBeLessThan(at(db.order.updateMany));
    expect(at(db.settlementMatch.findMany, 1)).toBeGreaterThan(at(db.order.updateMany));
    expect(at(db.orderStatusLog.createMany)).toBeGreaterThan(at(db.settlementMatch.findMany, 1));
    expect(at(db.orderActivity.createMany)).toBeGreaterThan(at(db.settlementMatch.findMany, 1));
  });

  it('closes a barcoded order of YESTERDAY end to end — the two things the old press never did', async () => {
    const a = order({ trackingNumber: 'BP-9', deliveredAt: daysAgo(1) });
    db.order.findMany.mockResolvedValue([a]);
    const { body: m } = await measure([a]);
    const res = await press([a], m);
    expect(res.status).toBe(200);
    expect(db.order.updateMany.mock.calls[0][0].where.id).toEqual({ in: [a.id] });
    noMoneyTouched();
  });

  it('a press after a success finds the order settled and closes NOTHING — the second tap cannot write twice', async () => {
    const a = order();
    db.order.findMany.mockResolvedValue([a]);
    const { body: m } = await measure([a]);
    expect((await press([a], m)).status).toBe(200);
    vi.clearAllMocks();
    db.order.findMany.mockResolvedValue([{ ...a, settlementStatus: 'SETTLED' }]);
    const again = await press([a], m);
    expect(again.status).toBe(409);
    expect((await again.json()).code).toBe('NOTHING_TO_CLOSE');
    nothingWritten();
  });

  it('NEGATIVE: nothing the owner ticked qualifies → 409 NOTHING_TO_CLOSE, nothing written', async () => {
    const shipped = order({ shippingStatus: 'SHIPPED' });
    db.order.findMany.mockResolvedValue([shipped]);
    const res = await post({ action: 'close', orderIds: [shipped.id], fingerprint: 'f'.repeat(24), count: 1, acknowledged: true });
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.code).toBe('NOTHING_TO_CLOSE');
    expect(body.errorAr).toContain('ما في ولا طلب');
    nothingWritten();
    noMoneyTouched();
  });

  it('NEGATIVE: the orders are no longer the ones the dialog showed (one was collected meanwhile) → 409 CHANGED, nothing written', async () => {
    const [a, b] = [order(), order()];
    db.order.findMany.mockResolvedValue([a, b]);
    const { body: m } = await measure([a, b]);
    vi.clearAllMocks();
    db.order.findMany.mockResolvedValue([a, { ...b, settlementStatus: 'SETTLED' }]);
    db.statementLine.findMany.mockResolvedValue([]);
    db.settlementMatch.findMany.mockResolvedValue([]);
    const res = await press([a, b], m);
    expect(res.status).toBe(409);
    expect((await res.json()).code).toBe('CHANGED');
    nothingWritten();
  });

  it('NEGATIVE: the right orders but a wrong count, or a wrong fingerprint, are refused the same way', async () => {
    const a = order();
    db.order.findMany.mockResolvedValue([a]);
    const { body: m } = await measure([a]);
    for (const over of [{ count: 2 }, { fingerprint: '0'.repeat(24) }]) {
      const res = await press([a], m, over);
      expect(res.status, JSON.stringify(over)).toBe(409);
      expect((await res.json()).code).toBe('CHANGED');
    }
    nothingWritten();
  });

  it('NEGATIVE: a collection took an order between the look and the claim → the claim is short → 409 ORDERS_CHANGED, no log, no mark, no audit', async () => {
    const [a, b] = [order(), order()];
    db.order.findMany.mockResolvedValue([a, b]);
    const { body: m } = await measure([a, b]);
    db.order.updateMany.mockResolvedValue({ count: 1 });
    const res = await press([a, b], m);
    expect(res.status).toBe(409);
    expect((await res.json()).code).toBe('ORDERS_CHANGED');
    expect(db.orderStatusLog.createMany).not.toHaveBeenCalled();
    expect(db.orderActivity.createMany).not.toHaveBeenCalled();
    expect(logAudit).not.toHaveBeenCalled();
    noMoneyTouched();
  });

  it('NEGATIVE: a statement that landed while the press waited for the rows is seen AFTER the claim → 409 ON_A_STATEMENT with the number, nothing logged', async () => {
    const a = order({ merchantRef: 'ORD-LATE' });
    db.order.findMany.mockResolvedValue([a]);
    const { body: m } = await measure([a]);
    // The first read (before the claim) finds nothing; the one after the claim finds a line.
    db.statementLine.findMany.mockReset();
    db.statementLine.findMany.mockResolvedValueOnce([]).mockResolvedValue([
      { merchantRef: 'ORD-LATE', barcode: null, statement: { reference: 'ST-3', status: 'DRAFT', approvedAt: null, deliveryProviderId: 'p1' }, matches: [] },
    ]);
    const res = await press([a], m);
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.code).toBe('ON_A_STATEMENT');
    expect(body.orders).toEqual([a.orderNumber]);
    expect(db.orderStatusLog.createMany).not.toHaveBeenCalled();
    expect(db.orderActivity.createMany).not.toHaveBeenCalled();
    expect(logAudit).not.toHaveBeenCalled();
    noMoneyTouched();
  });

  it('the press never claims an order the measure left out: the ids in the claim are the closeable ones only', async () => {
    const good = order();
    const money = order({ settlementStatus: 'PARTIALLY_SETTLED' });
    const shipped = order({ shippingStatus: 'SHIPPED' });
    db.order.findMany.mockResolvedValue([good, money, shipped]);
    const { body: m } = await measure([good, money, shipped]);
    await press([good, money, shipped], m);
    expect(db.order.updateMany.mock.calls[0][0].where.id).toEqual({ in: [good.id] });
    expect(db.orderStatusLog.createMany.mock.calls[0][0].data.map((d: { orderId: string }) => d.orderId)).toEqual([good.id]);
  });

  it('a failure outside the door’s own refusals is not swallowed (it reaches the shared error handler)', async () => {
    const a = order();
    db.order.findMany.mockResolvedValue([a]);
    const { body: m } = await measure([a]);
    db.order.updateMany.mockRejectedValue(new Error('connection reset'));
    const res = await press([a], m);
    expect(res.status).toBeGreaterThanOrEqual(500);
    expect(db.orderStatusLog.createMany).not.toHaveBeenCalled();
  });
});
