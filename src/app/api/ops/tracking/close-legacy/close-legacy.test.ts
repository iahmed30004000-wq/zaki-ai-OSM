import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * «أقفل القديمة بلا باركود» (12/11) — THE DOOR, GATE BY GATE.
 *
 *   «كل الطلبات الي بانتظار التحصيل وما الها بار كود سويها تم تحصيلها بدون ما تأثر على المالية» (the owner)
 *
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

import { GET, POST } from './route';
import { LEGACY_CLOSE_ACTION, LEGACY_CLOSE_NOTE, LEGACY_MOST } from '@/lib/legacy-closeout-words';
import { awaitingNoBarcodeWhere } from '@/lib/legacy-closeout';

const DAY = 86_400_000;
const daysAgo = (n: number) => new Date(Date.now() - n * DAY);

let seq = 0;
const order = (over: Record<string, unknown> = {}) => {
  seq += 1;
  return {
    id: `00000000-0000-4000-8000-${String(seq).padStart(12, '0')}`,
    orderNumber: `SY-${seq}`,
    merchantRef: `SY-${seq}`,
    trackingNumber: null,
    deliveryProviderId: 'p1',
    settlementStatus: 'PENDING',
    deliveredAt: daysAgo(40),
    shippedAt: daysAgo(45),
    createdAt: daysAgo(50),
    currency: 'USD',
    totalAmount: 20,
    deliveryProvider: { name: 'الباشا' },
    ...over,
  };
};

const get = (age?: string) => GET(new Request(`http://localhost/api/ops/tracking/close-legacy${age === undefined ? '' : `?age=${age}`}`));
const post = (body: unknown) =>
  POST(
    new Request('http://localhost/api/ops/tracking/close-legacy', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
  );

/** The dialog's two steps: measure, then press with what it showed. */
async function measure(age = '14') {
  const res = await get(age);
  const body = await res.json();
  return { res, body };
}
const press = (m: { age: number; closeable: { fingerprint: string; count: number } }, over: Record<string, unknown> = {}) =>
  post({ age: m.age, fingerprint: m.closeable.fingerprint, count: m.closeable.count, acknowledged: true, ...over });

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

describe('the gates come first — nothing is read, nothing is written', () => {
  it('without the tracking key: refused, and the door reads nothing', async () => {
    held.keys = new Set(['ops.close_legacy']);
    expect((await get()).status).toBe(403);
    expect((await post({ age: 14, fingerprint: 'x'.repeat(24), count: 1, acknowledged: true })).status).toBe(403);
    expect(db.order.findMany).not.toHaveBeenCalled();
    nothingWritten();
  });

  it('NEGATIVE: with the tracking key and the finance keys but WITHOUT this door’s own key: refused in Arabic, nothing read', async () => {
    held.keys = new Set(['ops.track', 'ops.write_off', 'finance.cashbox', 'settlement.view', 'finance.update']);
    for (const res of [await get(), await post({ age: 14, fingerprint: 'x'.repeat(24), count: 1, acknowledged: true })]) {
      expect(res.status).toBe(403);
      const body = await res.json();
      expect(body.code).toBe('FORBIDDEN');
      expect(body.error).toContain('ops.close_legacy');
      expect(body.errorAr).toContain('مش من صلاحياتك');
    }
    expect(db.order.findMany).not.toHaveBeenCalled();
    nothingWritten();
  });

  it('a bad body is a 400 before anything is read: no body, no tick, a false tick, no count, an age that is not one of the five', async () => {
    const ok = { age: 14, fingerprint: 'f'.repeat(24), count: 3, acknowledged: true };
    for (const bad of [
      null,
      {},
      { ...ok, acknowledged: undefined },
      { ...ok, acknowledged: false },
      { ...ok, acknowledged: 'yes' },
      { ...ok, count: 0 },
      { ...ok, count: 1.5 },
      { ...ok, count: LEGACY_MOST + 1 },
      { ...ok, fingerprint: 'short' },
      { ...ok, age: 5 },
      { ...ok, age: '14' },
    ]) {
      const res = await post(bad);
      expect(res.status, JSON.stringify(bad)).toBe(400);
    }
    expect(db.order.findMany).not.toHaveBeenCalled();
    nothingWritten();
  });

  it('a bad age on the question is a 400 in Arabic; no age reads as the default (14)', async () => {
    for (const bad of ['5', 'x', '', '0', '14.5']) expect((await get(bad)).status, bad).toBe(400);
    const res = await get();
    expect(res.status).toBe(200);
    expect((await res.json()).age).toBe(14);
    expect((await (await get('1')).json()).age).toBe(1);
  });
});

describe('the question — it measures and writes NOTHING', () => {
  it('asks the database for the tracking list’s own «بانتظار التحصيل» with no barcode, in THIS store only', async () => {
    await get();
    expect(db.order.findMany).toHaveBeenCalledTimes(1);
    expect(db.order.findMany.mock.calls[0][0].where).toEqual(awaitingNoBarcodeWhere({ companyId: 'c1', storeId: 's1' }));
  });

  it('answers the count, whose they are, what they are worth, what each age closes and what is left — without a single write', async () => {
    db.order.findMany.mockResolvedValue([
      order({ deliveredAt: daysAgo(60), totalAmount: 25 }),
      order({ deliveredAt: daysAgo(30), totalAmount: 15, deliveryProvider: { name: 'الو دليفيري' } }),
      order({ deliveredAt: daysAgo(3), totalAmount: 10 }),
      order({ settlementStatus: 'COLLECTED' }),
    ]);
    const { res, body } = await measure('14');

    expect(res.status).toBe(200);
    expect(body.closeable.count).toBe(2);
    expect(body.closeable.byCourier).toEqual([
      { name: 'الباشا', count: 1 },
      { name: 'الو دليفيري', count: 1 },
    ]);
    expect(body.closeable.value).toEqual([{ currency: 'USD', amount: 40 }]);
    expect(body.options.find((o: { age: number }) => o.age === 1).count).toBe(3);
    expect(body.left).toEqual({ tooRecent: 1, moneyRecorded: 1, onAStatement: 0 });
    expect(body.closeable.fingerprint).toMatch(/^[0-9a-f]{24}$/);
    nothingWritten();
    noMoneyTouched();
  });

  it('an order whose delivery day is unknown is dated by its shipping day, then its creation day', async () => {
    db.order.findMany.mockResolvedValue([
      order({ deliveredAt: null, shippedAt: daysAgo(40), createdAt: daysAgo(2) }),
      order({ deliveredAt: null, shippedAt: null, createdAt: daysAgo(40) }),
      order({ deliveredAt: null, shippedAt: null, createdAt: daysAgo(2) }),
    ]);
    const { body } = await measure('14');
    expect(body.closeable.count).toBe(2);
    expect(body.left.tooRecent).toBe(1);
  });

  it('says nothing waiting is nothing — an empty answer, a 200', async () => {
    const { res, body } = await measure('14');
    expect(res.status).toBe(200);
    expect(body.closeable.count).toBe(0);
    expect(body.tooMany).toBe(false);
  });

  it('more than the most one press may hold: tooMany, and nothing to close at any age', async () => {
    db.order.findMany.mockResolvedValue(Array.from({ length: LEGACY_MOST + 1 }, () => order()));
    const { body } = await measure('14');
    expect(body.tooMany).toBe(true);
    expect(body.closeable.count).toBe(0);
    expect(body.options.every((o: { count: number }) => o.count === 0)).toBe(true);
    expect(db.statementLine.findMany).not.toHaveBeenCalled();
  });

  it('an order a statement names by its reference is counted as «a statement», not as closeable', async () => {
    const [a, b] = [order({ merchantRef: 'SY-NAMED' }), order()];
    db.order.findMany.mockResolvedValue([a, b]);
    db.statementLine.findMany.mockResolvedValue([
      { merchantRef: 'SY-NAMED', barcode: null, statement: { reference: 'ST-9', status: 'DRAFT', approvedAt: null, deliveryProviderId: 'p1' }, matches: [] },
    ]);
    const { body } = await measure('14');
    expect(body.closeable.count).toBe(1);
    expect(body.left.onAStatement).toBe(1);
  });
});

describe('the press — what it writes', () => {
  it('closes exactly what the dialog showed: claims them, logs them, marks them, audits the press once', async () => {
    const rows = [order({ settlementStatus: 'PENDING' }), order({ settlementStatus: 'PENDING_COLLECTION' }), order({ settlementStatus: 'NOT_APPLICABLE' })];
    db.order.findMany.mockResolvedValue(rows);
    const { body: m } = await measure('14');

    const res = await press(m);
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.closed).toBe(3);
    expect(body.message).toContain('3');
    expect(body.message).toContain('بلا أي حركة مصاري');

    // THE CLAIM: those ids, still awaiting and unbarcoded, still in a state with no money, store-scoped — and only the settlement status.
    expect(db.order.updateMany).toHaveBeenCalledTimes(1);
    const claim = db.order.updateMany.mock.calls[0][0];
    expect(claim.data).toEqual({ settlementStatus: 'SETTLED' });
    expect([...claim.where.id.in].sort()).toEqual(rows.map((r) => r.id).sort());
    expect(claim.where).toMatchObject({
      companyId: 'c1',
      storeId: 's1',
      shippingStatus: { in: ['DELIVERED', 'PARTIALLY_DELIVERED'] },
      settlementStatus: { in: ['NOT_APPLICABLE', 'PENDING', 'PENDING_COLLECTION', 'UNSETTLED'] },
      OR: [{ trackingNumber: null }, { trackingNumber: '' }],
    });

    // THE LOG: one line per order, from what it was to SETTLED, with the reason a person can read later.
    const logs = db.orderStatusLog.createMany.mock.calls[0][0].data;
    expect(logs).toHaveLength(3);
    expect(logs.map((l: { previousValue: string }) => l.previousValue).sort()).toEqual(['NOT_APPLICABLE', 'PENDING', 'PENDING_COLLECTION']);
    for (const l of logs) {
      expect(l).toMatchObject({ companyId: 'c1', statusType: 'SETTLEMENT', newValue: 'SETTLED', changedById: 'u1', changedByRole: 'SUPER_ADMIN', note: LEGACY_CLOSE_NOTE });
    }

    // THE MARK: the commission rule reads it, so these orders' commission never becomes payable.
    const marks = db.orderActivity.createMany.mock.calls[0][0].data;
    expect(marks).toHaveLength(3);
    for (const a of marks) {
      expect(a).toMatchObject({ companyId: 'c1', userId: 'u1', action: LEGACY_CLOSE_ACTION, newStatus: 'SETTLED' });
      expect(JSON.parse(a.metadata)).toMatchObject({ age: 14 });
    }

    // THE AUDIT: one line for the press.
    expect(logAudit).toHaveBeenCalledTimes(1);
    expect(logAudit.mock.calls[0][0]).toMatchObject({
      companyId: 'c1',
      userId: 'u1',
      action: LEGACY_CLOSE_ACTION,
      entity: 'Store',
      entityId: 's1',
      newData: { age: 14, closed: 3 },
    });
  });

  it('NEGATIVE: not one wallet movement, not one commission, no ledger line, no amount — nothing of the money', async () => {
    db.order.findMany.mockResolvedValue([order(), order()]);
    const { body: m } = await measure('14');
    expect((await press(m)).status).toBe(200);
    noMoneyTouched();
    // The only order write is the one claim, and it carries the settlement status and nothing else (no collectedAmount, no version).
    expect(Object.keys(db.order.updateMany.mock.calls[0][0].data)).toEqual(['settlementStatus']);
  });

  it('leaves out what it must: money recorded, an order a statement names, an order too recent — only the rest is claimed', async () => {
    const closing = order();
    const rows = [
      closing,
      order({ settlementStatus: 'PARTIALLY_SETTLED' }),
      order({ settlementStatus: 'COLLECTED' }),
      order({ merchantRef: 'SY-NAMED' }),
      order({ deliveredAt: daysAgo(2), shippedAt: daysAgo(3), createdAt: daysAgo(4) }),
    ];
    db.order.findMany.mockResolvedValue(rows);
    db.statementLine.findMany.mockResolvedValue([
      { merchantRef: 'SY-NAMED', barcode: null, statement: { reference: 'ST-1', status: 'APPROVED', approvedAt: new Date(), deliveryProviderId: 'p1' }, matches: [] },
    ]);
    const { body: m } = await measure('14');
    expect(m.closeable.count).toBe(1);
    expect(m.left).toEqual({ tooRecent: 1, moneyRecorded: 2, onAStatement: 1 });

    expect((await press(m)).status).toBe(200);
    expect(db.order.updateMany.mock.calls[0][0].where.id.in).toEqual([closing.id]);
  });

  it('a line a person tied to an order by hand keeps it out too', async () => {
    const tied = order({ merchantRef: null });
    db.order.findMany.mockResolvedValue([tied, order()]);
    db.settlementMatch.findMany.mockResolvedValue([
      { orderId: tied.id, result: 'MATCHED', statement: { reference: 'ST-2', status: 'DRAFT', approvedAt: null, deliveryProviderId: 'p1' } },
    ]);
    const { body: m } = await measure('14');
    expect(m.closeable.count).toBe(1);
    expect(m.left.onAStatement).toBe(1);
  });
});

describe('the press — every refusal writes NOTHING', () => {
  it('another age than the one the dialog showed is another set: refused as «changed»', async () => {
    db.order.findMany.mockResolvedValue([order({ deliveredAt: daysAgo(60) }), order({ deliveredAt: daysAgo(10) })]);
    const { body: m } = await measure('14');
    expect(m.closeable.count).toBe(1);

    const res = await press(m, { age: 7 });
    expect(res.status).toBe(409);
    expect((await res.json()).code).toBe('CHANGED');
    nothingWritten();
  });

  it('the orders changed after the dialog opened (another one qualifies): refused as «changed», with the sentence that says what to do', async () => {
    db.order.findMany.mockResolvedValue([order()]);
    const { body: m } = await measure('14');
    db.order.findMany.mockResolvedValue([order(), order()]);

    const res = await press(m);
    const body = await res.json();
    expect(res.status).toBe(409);
    expect(body.code).toBe('CHANGED');
    expect(body.errorAr).toContain('افتحها من جديد');
    nothingWritten();
  });

  it('the same count but other orders: refused too (the fingerprint, not only the count)', async () => {
    db.order.findMany.mockResolvedValue([order()]);
    const { body: m } = await measure('14');
    db.order.findMany.mockResolvedValue([order()]); // one order, a different one
    const res = await press(m);
    expect(res.status).toBe(409);
    expect((await res.json()).code).toBe('CHANGED');
    nothingWritten();
  });

  it('nothing to close at that age: a 409, not a silent 200', async () => {
    db.order.findMany.mockResolvedValue([order({ deliveredAt: daysAgo(2) })]);
    const res = await post({ age: 14, fingerprint: 'f'.repeat(24), count: 1, acknowledged: true });
    expect(res.status).toBe(409);
    expect((await res.json()).code).toBe('NOTHING_TO_CLOSE');
    nothingWritten();
  });

  it('a second press after the first closed them finds nothing left', async () => {
    db.order.findMany.mockResolvedValue([order()]);
    const { body: m } = await measure('14');
    expect((await press(m)).status).toBe(200);
    vi.clearAllMocks();
    db.order.findMany.mockResolvedValue([]);
    db.statementLine.findMany.mockResolvedValue([]);
    db.settlementMatch.findMany.mockResolvedValue([]);
    const again = await press(m);
    expect(again.status).toBe(409);
    expect((await again.json()).code).toBe('NOTHING_TO_CLOSE');
    nothingWritten();
  });

  it('more than the most a press may hold: refused, nothing claimed', async () => {
    db.order.findMany.mockResolvedValue(Array.from({ length: LEGACY_MOST + 1 }, () => order()));
    const res = await post({ age: 14, fingerprint: 'f'.repeat(24), count: 5, acknowledged: true });
    expect(res.status).toBe(409);
    expect((await res.json()).code).toBe('TOO_MANY');
    nothingWritten();
  });

  it('another press, a collection or a statement took one of them a moment ago (the claim is SHORT): all or nothing — no log, no mark, no audit', async () => {
    db.order.findMany.mockResolvedValue([order(), order(), order()]);
    const { body: m } = await measure('14');
    db.order.updateMany.mockResolvedValue({ count: 2 });

    const res = await press(m);
    expect(res.status).toBe(409);
    expect((await res.json()).code).toBe('ORDERS_CHANGED');
    expect(db.orderStatusLog.createMany).not.toHaveBeenCalled();
    expect(db.orderActivity.createMany).not.toHaveBeenCalled();
    expect(logAudit).not.toHaveBeenCalled();
    noMoneyTouched();
  });

  it('a statement was uploaded while the press waited for the rows (the second read names an order): nothing is logged or marked', async () => {
    const rows = [order({ merchantRef: 'SY-LATE' }), order()];
    db.order.findMany.mockResolvedValue(rows);
    const { body: m } = await measure('14');

    // The measure read no statement; the press reads once before the claim (still none) and once after it (now one names SY-LATE).
    db.statementLine.findMany.mockReset();
    db.statementLine.findMany
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([
        { merchantRef: 'SY-LATE', barcode: null, statement: { reference: 'ST-LATE', status: 'DRAFT', approvedAt: null, deliveryProviderId: 'p1' }, matches: [] },
      ]);

    const res = await press(m);
    const body = await res.json();
    expect(res.status).toBe(409);
    expect(body.code).toBe('ON_A_STATEMENT');
    expect(body.orders).toEqual([rows[0].orderNumber]);
    expect(db.orderStatusLog.createMany).not.toHaveBeenCalled();
    expect(db.orderActivity.createMany).not.toHaveBeenCalled();
    expect(logAudit).not.toHaveBeenCalled();
  });
});

describe('a big press is claimed in parts, in ONE transaction', () => {
  it('2300 orders: three claims of at most a thousand each, one transaction, and every order logged and marked', async () => {
    const rows = Array.from({ length: 2300 }, () => order());
    db.order.findMany.mockResolvedValue(rows);
    const { body: m } = await measure('14');
    expect(m.closeable.count).toBe(2300);

    const res = await press(m);
    expect(res.status).toBe(200);
    expect(db.$transaction).toHaveBeenCalledTimes(1);
    expect(db.order.updateMany.mock.calls.map((c) => c[0].where.id.in.length)).toEqual([1000, 1000, 300]);
    const logged = db.orderStatusLog.createMany.mock.calls.reduce((n, c) => n + c[0].data.length, 0);
    const marked = db.orderActivity.createMany.mock.calls.reduce((n, c) => n + c[0].data.length, 0);
    expect([logged, marked]).toEqual([2300, 2300]);
    expect(logAudit).toHaveBeenCalledTimes(1);
    // The audit line carries the first twenty names, not 2300.
    expect(logAudit.mock.calls[0][0].newData.first).toHaveLength(20);
  });
});
