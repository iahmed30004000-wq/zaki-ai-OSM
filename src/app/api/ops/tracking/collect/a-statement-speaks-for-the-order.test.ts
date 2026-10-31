import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * «استلمت منه» AND A STATEMENT MUST NOT BOOK THE SAME ORDER.
 *
 * A 20.00 order sits on an approved statement as an 18.00 line (MISMATCHED). Nothing marked it settled, so the
 * hand collection accepted it and booked another 20.00. The same happened for an order named on a statement
 * that was not approved yet — the statement would write it later. And two simultaneous presses both passed the
 * SETTLED check and both wrote the money.
 *
 * The statement lines are held by a fake that APPLIES the route's own filter (store, reference, barcode), and
 * the order claim by a fake that behaves like a conditional update — so the refusals below come from the
 * route's queries, not from a mock that was told the answer.
 */

const { db, requireContext, requirePermission, logAudit, recordMovement, markPayableForOrders, world } = vi.hoisted(() => {
  const world = {
    lines: [] as Record<string, any>[],
    settled: new Set<string>(),
  };
  const db = {
    wallet: { findFirst: vi.fn() },
    order: {
      findMany: vi.fn(),
      // A conditional update: only the ids not yet SETTLED are taken, and taking them settles them.
      updateMany: vi.fn(async ({ where }: { where: { id: { in: string[] }; settlementStatus: { not: string } }; data: unknown }) => {
        const free = where.id.in.filter((id) => !world.settled.has(id));
        free.forEach((id) => world.settled.add(id));
        return { count: free.length };
      }),
    },
    orderActivity: { create: vi.fn() },
    statementLine: {
      findMany: vi.fn(async ({ where }: { where: Record<string, any> }) => {
        const refs: string[] = where.OR.flatMap((c: any) => c.merchantRef?.in ?? []);
        const codes: string[] = where.OR.flatMap((c: any) => c.barcode?.in ?? []);
        return world.lines.filter(
          (l) =>
            l.statement.companyId === where.statement.companyId &&
            l.statement.storeId === where.statement.storeId &&
            ((l.merchantRef && refs.includes(l.merchantRef)) || (l.barcode && codes.includes(l.barcode)))
        );
      }),
    },
    // The sweep's «MISSING_IN_STATEMENT» rows live here. The door must never read them.
    settlementMatch: { findMany: vi.fn() },
    $transaction: vi.fn(async (fn: (tx: unknown) => unknown) => fn(db)),
  };
  return {
    db, world,
    requireContext: vi.fn(), requirePermission: vi.fn(), logAudit: vi.fn(),
    recordMovement: vi.fn(), markPayableForOrders: vi.fn(),
  };
});

vi.mock('@/lib/db', () => ({ db }));
vi.mock('@/lib/geo-context', () => ({ requireContext: (...a: unknown[]) => requireContext(...a) }));
vi.mock('@/lib/authorization', () => ({ requirePermission: (...a: unknown[]) => requirePermission(...a), can: () => true }));
vi.mock('@/lib/audit', () => ({ logAudit: (...a: unknown[]) => logAudit(...a) }));
vi.mock('@/lib/wallets', async (orig) => ({
  ...(await orig<typeof import('@/lib/wallets')>()),
  recordMovement: (...a: unknown[]) => recordMovement(...a),
}));
vi.mock('@/lib/commission', async (orig) => ({
  ...(await orig<typeof import('@/lib/commission')>()),
  markPayableForOrders: (...a: unknown[]) => markPayableForOrders(...a),
}));

import { POST } from './route';
import { statementNamingRefusal } from '@/lib/settlement-gates';

const ORDER_A = '11111111-1111-4111-8111-111111111111';
const ORDER_B = '22222222-2222-4222-8222-222222222222';
const WALLET = '33333333-3333-4333-8333-333333333333';

const press = (orderIds: string[] = [ORDER_A]) =>
  POST(
    new Request('http://localhost/x', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ orderIds, walletId: WALLET, note: 'استلمت منه نقداً' }),
    })
  );

const order = (over: Record<string, unknown> = {}) => ({
  id: ORDER_A, orderNumber: 'SY-2026-0001', merchantRef: 'SY-2026-0001', trackingNumber: null, deliveryProviderId: 'p1',
  currency: 'USD', shippingStatus: 'DELIVERED', settlementStatus: 'PENDING_COLLECTION',
  totalAmount: 20, deliveryFee: 3, collectedAmount: null, priceIncludesDelivery: false, returnReceipt: null,
  items: [{ quantity: 1, freeQuantity: 0, unitPrice: 20, lineTotal: 20, discountShare: 0, deliveredQty: null }],
  deliveryProvider: { id: 'p1', name: 'أبو علي', kind: 'AGENT' },
  ...over,
});

const line = (over: Record<string, unknown> = {}, statement: Record<string, unknown> = {}) => ({
  merchantRef: 'SY-2026-0001', barcode: null,
  statement: {
    companyId: 'c1', storeId: 's1', reference: 'ST-2026-10', status: 'MATCHED', approvedAt: null, deliveryProviderId: 'p1',
    ...statement,
  },
  ...over,
});

beforeEach(() => {
  vi.clearAllMocks();
  world.lines = [];
  world.settled = new Set();
  requireContext.mockResolvedValue({ user: { id: 'u1' }, companyId: 'c1', storeId: 's1', country: { minorUnit: 2, currencyCode: 'USD' } });
  requirePermission.mockResolvedValue({});
  db.wallet.findFirst.mockResolvedValue({ id: WALLET, name: 'صندوق سوريا', currencyCode: 'USD' });
  db.order.findMany.mockResolvedValue([order()]);
  db.orderActivity.create.mockResolvedValue({});
  recordMovement.mockResolvedValue({ id: 'm1' });
  markPayableForOrders.mockResolvedValue(0);
});

const nothingBooked = () => {
  expect(recordMovement).not.toHaveBeenCalled();
  expect(db.orderActivity.create).not.toHaveBeenCalled();
  expect(markPayableForOrders).not.toHaveBeenCalled();
  expect(logAudit).not.toHaveBeenCalled();
};

describe('an order a statement speaks for is not collected by hand', () => {
  it('on a statement that is NOT approved yet — its money will be written at approval', async () => {
    world.lines = [line()];
    const res = await press();
    const body = await res.json();

    expect(res.status).toBe(409);
    expect(body.code).toBe('ON_UNAPPROVED_STATEMENT');
    expect(body.error).toBe('الطلب SY-2026-0001 بكشف ما انعتمد بعد — مصاريه بتنسجّل لما ينعتمد الكشف');
    nothingBooked();
    expect(db.order.updateMany).not.toHaveBeenCalled();
  });

  it('on an APPROVED statement — even as a MISMATCHED line, its money already entered', async () => {
    // 20.00 on our side, 18.00 on the courier's: the order is not SETTLED, but the statement paid for it.
    world.lines = [line({}, { status: 'APPROVED', approvedAt: new Date('2026-10-28T09:00:00Z'), reference: '7446102700052' })];
    const res = await press();
    const body = await res.json();

    expect(res.status).toBe(409);
    expect(body.code).toBe('IN_APPROVED_STATEMENT');
    expect(body.error).toBe('مصاري الطلب SY-2026-0001 دخلت مع كشف 7446102700052');
    nothingBooked();
  });

  it('an approval stamped only by the status word (an old row) counts as approved', async () => {
    world.lines = [line({}, { status: 'APPROVED', approvedAt: null })];
    expect((await (await press()).json()).code).toBe('IN_APPROVED_STATEMENT');
  });

  it('by the courier’s barcode, within that courier', async () => {
    db.order.findMany.mockResolvedValue([order({ merchantRef: null, trackingNumber: 'B-100' })]);
    world.lines = [line({ merchantRef: null, barcode: 'B-100' })];
    const res = await press();
    expect(res.status).toBe(409);
    expect((await res.json()).code).toBe('ON_UNAPPROVED_STATEMENT');
    nothingBooked();
  });

  it('…but the same barcode on ANOTHER courier’s statement is another parcel', async () => {
    db.order.findMany.mockResolvedValue([order({ merchantRef: null, trackingNumber: 'B-100' })]);
    world.lines = [line({ merchantRef: null, barcode: 'B-100' }, { deliveryProviderId: 'p2' })];
    const res = await press();
    expect(res.status).toBe(200);
    expect(recordMovement).toHaveBeenCalledTimes(1);
  });

  it('an order named by NO statement is collected as before', async () => {
    world.lines = [line({ merchantRef: 'SY-2026-9999' })];
    const res = await press();
    expect(res.status).toBe(200);
    expect(recordMovement).toHaveBeenCalledTimes(1);
    expect(recordMovement.mock.calls[0][1]).toMatchObject({ category: 'COURIER_SETTLEMENT', amount: 17, direction: 'IN' });
  });

  it('a line on another STORE’s statement is not this order’s statement', async () => {
    world.lines = [line({}, { storeId: 's2' })];
    expect((await press()).status).toBe(200);
  });

  it('a sweep row «MISSING_IN_STATEMENT» is not a line: the door never reads the matches', async () => {
    db.settlementMatch.findMany.mockResolvedValue([{ orderId: ORDER_A, result: 'MISSING_IN_STATEMENT' }]);
    const res = await press();
    expect(res.status).toBe(200);
    expect(db.settlementMatch.findMany).not.toHaveBeenCalled();
  });

  it('one order of a batch is enough to refuse the batch — and the sentence names that order', async () => {
    db.order.findMany.mockResolvedValue([order(), order({ id: ORDER_B, orderNumber: 'SY-2026-0002', merchantRef: 'SY-2026-0002' })]);
    world.lines = [line({ merchantRef: 'SY-2026-0002' })];
    const res = await press([ORDER_A, ORDER_B]);
    const body = await res.json();
    expect(res.status).toBe(409);
    expect(body.error).toContain('SY-2026-0002');
    expect(body.error).not.toContain('SY-2026-0001 بكشف');
    nothingBooked();
  });
});

describe('two presses book the money once', () => {
  it('the claim is conditional — only orders not yet SETTLED are taken', async () => {
    await press();
    const call = db.order.updateMany.mock.calls[0][0];
    expect(call.where.settlementStatus).toEqual({ not: 'SETTLED' });
    expect(call.where.id.in).toEqual([ORDER_A]);
    expect(call.data).toEqual({ settlementStatus: 'SETTLED' });
    // The claim comes before the money.
    expect(db.order.updateMany.mock.invocationCallOrder[0]).toBeLessThan(recordMovement.mock.invocationCallOrder[0]);
  });

  it('two simultaneous presses on the same order write ONE movement', async () => {
    // Both read the order as not settled (the outer check passes for both).
    const [a, b] = await Promise.all([press(), press()]);

    expect([a.status, b.status].sort()).toEqual([200, 409]);
    expect(recordMovement).toHaveBeenCalledTimes(1);
    expect(db.orderActivity.create).toHaveBeenCalledTimes(1);
    expect(markPayableForOrders).toHaveBeenCalledTimes(1);
    const loser = a.status === 409 ? a : b;
    expect(await loser.json()).toEqual({ code: 'ALREADY_SETTLED', error: 'انحصّل من قبل — حدّث الصفحة' });
  });

  it('a claim that takes fewer orders than were pressed rolls everything back', async () => {
    db.order.findMany.mockResolvedValue([order(), order({ id: ORDER_B, orderNumber: 'SY-2026-0002', merchantRef: 'SY-2026-0002' })]);
    world.settled.add(ORDER_B); // another press got B a moment ago
    const res = await press([ORDER_A, ORDER_B]);

    expect(res.status).toBe(409);
    expect((await res.json()).error).toBe('انحصّل من قبل — حدّث الصفحة');
    nothingBooked();
  });
});

describe('the sentence, on its own', () => {
  const o = (n: string) => ({ orderNumber: n, merchantRef: n, trackingNumber: null, deliveryProviderId: 'p1' });
  const st = { reference: 'ST-1', status: 'MATCHED', approvedAt: null, deliveryProviderId: 'p1' };

  it('says nothing when no line names any order', () => {
    expect(statementNamingRefusal([o('A')], [{ merchantRef: 'Z', barcode: null, statement: st }])).toBeNull();
  });

  it('gives one sentence per order and the graver code when any statement is approved', () => {
    const lines = [
      { merchantRef: 'A', barcode: null, statement: st },
      { merchantRef: 'B', barcode: null, statement: { ...st, reference: 'ST-0', approvedAt: new Date() } },
    ];
    const r = statementNamingRefusal([o('A'), o('B')], lines)!;
    expect(r.code).toBe('IN_APPROVED_STATEMENT');
    expect(r.orders).toEqual(['A', 'B']);
    expect(r.error).toBe('الطلب A بكشف ما انعتمد بعد — مصاريه بتنسجّل لما ينعتمد الكشف · مصاري الطلب B دخلت مع كشف ST-0');
  });

  it('prefers the approved statement when an order is named by two', () => {
    const lines = [
      { merchantRef: 'A', barcode: null, statement: st },
      { merchantRef: 'A', barcode: null, statement: { ...st, reference: 'ST-0', status: 'APPROVED' } },
    ];
    expect(statementNamingRefusal([o('A')], lines)!.error).toBe('مصاري الطلب A دخلت مع كشف ST-0');
  });
});
