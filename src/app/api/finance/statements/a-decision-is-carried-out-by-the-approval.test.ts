import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * THE ANSWER A PERSON GIVES TO A DIFFERENCE IS CARRIED OUT BY THE APPROVAL — AND BY NOTHING ELSE.
 *
 * «ممكن عادي صار خصم، بس يعتمد رقم الشركة. وإذا غير معتمد أنا رح أتواصل مع الشركة وخط اعتماد رقمنا.»
 *
 * Until now an order whose difference was ACCEPTED was never settled, and one answered «رقمنا» looked the same.
 * These tests drive the REAL approval route against a fake database that APPLIES the filters it is given — a
 * conditional update takes only the orders its own WHERE lets through, and the read after a short count finds the
 * orders that failed it — so what is asserted is the route's own filter, not a mock told the answer.
 *
 * The example the work was specified with, in a currency of three places (JOD):
 *
 *     an order of 20.000, the company's line says 18.000
 *       ACCEPTED_COURIER → SETTLED, collectedAmount 18.000
 *       OURS_STANDS      → PENDING_COLLECTION, a claim of 2.000 on the company;
 *                          a later statement whose line pays 2.000 closes it (collectedAmount 20.000)
 */

type FakeOrder = {
  id: string; orderNumber: string; shippingStatus: string; settlementStatus: string;
  openRequest: boolean; collectedAmount: number | null; customerId: string;
};

const { db, requireContext, requirePermission, logAudit, recordMovement, receiptGap, markPayableForOrders, state } = vi.hoisted(() => {
  const state = {
    stamped: false,
    reads: [] as unknown[],
    orders: new Map<string, FakeOrder>(),
  };

  /** The small part of Prisma's where-language the approval uses, applied to a fake order. */
  const matchesWhere = (o: FakeOrder, w: Record<string, any>): boolean => {
    for (const [key, val] of Object.entries(w)) {
      if (key === 'companyId' || key === 'storeId') continue;
      if (key === 'id') { if (!val.in.includes(o.id)) return false; continue; }
      if (key === 'settlementStatus') { if (val.not !== undefined && o.settlementStatus === val.not) return false; continue; }
      if (key === 'shippingStatus') { if (!val.in.includes(o.shippingStatus)) return false; continue; }
      if (key === 'collectedAmount') { if (val === null && o.collectedAmount !== null) return false; continue; }
      if (key === 'changeRequests') { if (val.none && o.openRequest) return false; continue; }
      if (key === 'OR') { if (!(val as Record<string, any>[]).some((alt) => matchesWhere(o, alt))) return false; continue; }
      if (key === 'NOT') { if (matchesWhere(o, val)) return false; continue; }
      throw new Error('the fake does not know the filter: ' + key);
    }
    return true;
  };

  const db = {
    courierStatement: {
      findFirst: vi.fn(async () => (state.reads.length > 1 ? state.reads.shift() : state.reads[0])),
      updateMany: vi.fn(async ({ where }: { where: { approvedAt?: null } }) => {
        if (where.approvedAt === null && state.stamped) return { count: 0 };
        state.stamped = true;
        return { count: 1 };
      }),
    },
    walletMovement: { findMany: vi.fn(async () => []) },
    // The person at the door: every order here was delivered by the same employee, so a short line has someone to
    // name (the shortfall rule, lib/shortfall) and these tests stay about what they were written for. (Was
    // `findMany: async () => []` with no door at all.)
    user: {
      findMany: vi.fn(async ({ where }: { where: { id?: { in: string[] } } }) =>
        where.id?.in.includes('u-door') ? [{ id: 'u-door', name: 'موظف التسليم', role: 'FOLLOW_UP_AGENT' }] : []
      ),
    },
    deliveryAttempt: {
      findMany: vi.fn(async ({ where }: { where: { orderId: { in: string[] } } }) =>
        where.orderId.in.map((orderId) => ({ orderId, deliveryAgentId: 'u-door' }))
      ),
    },
    penalty: { findMany: vi.fn(async () => []), create: vi.fn(async () => ({ id: 'pen-1' })) },
    order: {
      updateMany: vi.fn(async ({ where, data }: { where: Record<string, any>; data: { settlementStatus?: string } }) => {
        const hit = [...state.orders.values()].filter((o) => matchesWhere(o, where));
        for (const o of hit) if (data.settlementStatus) o.settlementStatus = data.settlementStatus;
        return { count: hit.length };
      }),
      findMany: vi.fn(async ({ where }: { where: Record<string, any> }) =>
        [...state.orders.values()].filter((o) => matchesWhere(o, where))
      ),
      update: vi.fn(async ({ where, data }: { where: { id: string }; data: Record<string, any> }) => {
        const o = state.orders.get(where.id)!;
        if (data.collectedAmount !== undefined) o.collectedAmount = data.collectedAmount;
        if (data.shippingStatus) o.shippingStatus = data.shippingStatus;
        return o;
      }),
    },
    orderActivity: { create: vi.fn() },
    customer: { update: vi.fn() },
    // A transaction that ROLLS BACK: what the orders were before it is what they are after a throw. (The names
    // of the orders that stopped an approval are read after the rollback — the claim's own writes must not be in them.)
    $transaction: vi.fn(async (fn: (tx: unknown) => unknown) => {
      const before = new Map([...state.orders].map(([k, v]) => [k, { ...v }]));
      try {
        return await fn(db);
      } catch (e) {
        state.orders = before;
        throw e;
      }
    }),
  };
  return {
    db, state,
    requireContext: vi.fn(), requirePermission: vi.fn(), logAudit: vi.fn(),
    recordMovement: vi.fn(), receiptGap: vi.fn(), markPayableForOrders: vi.fn(),
  };
});

vi.mock('@/lib/db', () => ({ db }));
vi.mock('@/lib/geo-context', () => ({ requireContext: (...a: unknown[]) => requireContext(...a) }));
vi.mock('@/lib/authorization', () => ({ requirePermission: (...a: unknown[]) => requirePermission(...a), can: () => true }));
vi.mock('@/lib/audit', () => ({ logAudit: (...a: unknown[]) => logAudit(...a) }));
vi.mock('@/lib/settlement', async (orig) => ({
  ...(await orig<typeof import('@/lib/settlement')>()),
  receiptGap: (...a: unknown[]) => receiptGap(...a),
}));
vi.mock('@/lib/wallets', async (orig) => ({
  ...(await orig<typeof import('@/lib/wallets')>()),
  recordMovement: (...a: unknown[]) => recordMovement(...a),
}));
vi.mock('@/lib/commission', async (orig) => ({
  ...(await orig<typeof import('@/lib/commission')>()),
  markPayableForOrders: (...a: unknown[]) => markPayableForOrders(...a),
}));
vi.mock('@/lib/stock-consumption', () => ({ consumeOrderStock: vi.fn() }));

import { PATCH } from './[id]/route';

const ID = '88888888-8888-4888-8888-888888888888';
const approve = () =>
  PATCH(
    new Request('http://localhost/x', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ approve: true }),
    }),
    { params: Promise.resolve({ id: ID }) }
  );

const order = (id: string, over: Partial<FakeOrder> = {}): FakeOrder => ({
  id, orderNumber: `JO-${id}`, shippingStatus: 'DELIVERED', settlementStatus: 'PENDING_COLLECTION',
  openRequest: false, collectedAmount: null, customerId: `cu-${id}`, ...over,
});

const row = (orderId: string, over: Record<string, unknown> = {}) => ({
  id: `m-${orderId}`, orderId, result: 'MISMATCHED', resolution: null, resolutionNote: null, resolvedById: null,
  expectedAmount: 20, statementAmount: 18, statementFee: 0, order: { orderNumber: `JO-${orderId}`, settlementMatches: [] },
  ...over,
});

const accepted = (orderId: string, over: Record<string, unknown> = {}) =>
  row(orderId, { resolution: 'ACCEPTED_COURIER', resolutionNote: 'خصم أعطاه الموظف للزبون', resolvedById: 'u-decider', ...over });

const statement = (matches: unknown[]) => ({
  id: ID, status: 'MATCHED', reference: 'JO-ST-1', gapExplanation: null, approvedAt: null, periodTo: new Date('2026-10-20T00:00:00Z'),
  fileHash: 'ab'.repeat(32),
  receipts: [{ id: 'r1', walletId: 'w-jod', amount: 35 }],
  matches,
});

const putOrders = (...os: FakeOrder[]) => { for (const o of os) state.orders.set(o.id, o); };
const settled = () => [...state.orders.values()].filter((o) => o.settlementStatus === 'SETTLED').map((o) => o.id).sort();
const claimsBody = () => db.order.updateMany.mock.calls.map((c) => c[0].where);

beforeEach(() => {
  vi.clearAllMocks();
  state.stamped = false;
  state.orders = new Map();
  requireContext.mockResolvedValue({
    user: { id: 'u-approver', name: 'المحاسب' }, companyId: 'c1', storeId: 's1', country: { minorUnit: 3, currencyCode: 'JOD' },
  });
  requirePermission.mockResolvedValue({});
  receiptGap.mockResolvedValue({ claimed: 35, received: 35, gap: 0, needsExplanation: false, explained: false, unconvertible: 0 });
  markPayableForOrders.mockResolvedValue(0);
  recordMovement.mockResolvedValue({ id: 'mv1' });
});

describe('the example: an order of 20.000 and a line of 18.000', () => {
  it('ACCEPTED_COURIER settles it at 18.000 — the order is SETTLED and collectedAmount is the company’s figure', async () => {
    putOrders(order('o1'));
    state.reads = [statement([accepted('o1')])];

    const res = await approve();

    expect(res.status).toBe(200);
    expect(settled()).toEqual(['o1']);
    expect(db.order.update).toHaveBeenCalledWith(expect.objectContaining({ where: { id: 'o1' }, data: expect.objectContaining({ collectedAmount: 18 }) }));
    expect(state.orders.get('o1')!.collectedAmount).toBe(18);
    expect(markPayableForOrders).toHaveBeenCalledWith(expect.anything(), 'c1', ['o1']);
  });

  it('and writes who said it, why, and in whose name it was carried out', async () => {
    putOrders(order('o1'));
    state.reads = [statement([accepted('o1')])];
    await approve();

    const act = db.orderActivity.create.mock.calls.map((c) => c[0].data).find((d) => d.action === 'SETTLEMENT_DECISION_APPLIED');
    expect(act).toMatchObject({ orderId: 'o1', userId: 'u-approver' });
    expect(JSON.parse(act.metadata)).toMatchObject({
      decision: 'ACCEPTED_COURIER', explanation: 'خصم أعطاه الموظف للزبون', decidedBy: 'u-decider', collected: 18, statement: 'JO-ST-1',
    });
  });

  it('OURS_STANDS does NOT settle it: it stays PENDING_COLLECTION as a claim of 2.000 on the company', async () => {
    putOrders(order('o1'));
    state.reads = [statement([row('o1', { resolution: 'OURS_STANDS', resolutionNote: 'الشركة مدينة بالفرق', resolvedById: 'u-decider' })])];

    const res = await approve();
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(settled()).toEqual([]);
    expect(state.orders.get('o1')!.settlementStatus).toBe('PENDING_COLLECTION');
    expect(state.orders.get('o1')!.collectedAmount).toBeNull();
    expect(db.order.updateMany).not.toHaveBeenCalled();
    expect(db.order.update).not.toHaveBeenCalled();
    expect(markPayableForOrders).toHaveBeenCalledWith(expect.anything(), 'c1', []);
    expect(body.claimsOpened).toBe(1);
    const act = db.orderActivity.create.mock.calls.map((c) => c[0].data).find((d) => d.action === 'SETTLEMENT_CLAIM_OPENED');
    expect(JSON.parse(act.metadata)).toMatchObject({ remaining: 2, decidedBy: 'u-decider' });
  });

  // (Was «…and a row nobody answered…» with an unanswered row beside it. The lock makes the approval wait for an unanswered
  // difference — it is refused now, and the test of that refusal is in a-closed-statement-is-corrected-by-a-settlement-statement.)
  it('«قيد المراجعة» settles nothing, and writes no amount', async () => {
    putOrders(order('o1'), order('o2'));
    state.reads = [statement([row('o1', { resolution: 'UNDER_REVIEW', resolutionNote: 'ننتظر الشركة' }), row('o2', { resolution: 'UNDER_REVIEW', resolutionNote: 'ننتظر ردّ الشركة' })])];

    expect((await approve()).status).toBe(200);
    expect(settled()).toEqual([]);
    expect(db.order.updateMany).not.toHaveBeenCalled();
    expect(db.order.update).not.toHaveBeenCalled();
  });

  it('a statement with all four kinds settles exactly the clean row and the accepted one', async () => {
    putOrders(order('o1'), order('o2'), order('o3'), order('o4'));
    state.reads = [
      statement([
        row('o1', { result: 'MATCHED', expectedAmount: 20, statementAmount: 20 }),
        accepted('o2'),
        row('o3', { resolution: 'OURS_STANDS', resolutionNote: 'نطالب بالفرق' }),
        // (Was an unanswered row; the approval waits for those now. Parked, it settles nothing — the same assertion.)
        row('o4', { resolution: 'UNDER_REVIEW', resolutionNote: 'ننتظر ردّ الشركة' }),
      ]),
    ];

    expect((await approve()).status).toBe(200);
    expect(settled()).toEqual(['o1', 'o2']);
    expect(markPayableForOrders.mock.calls[0][2]).toEqual(['o1', 'o2']);
    // The clean row’s gross is the company’s figure plus its fee; the accepted row’s the same arithmetic, nothing else.
    expect(state.orders.get('o1')!.collectedAmount).toBe(20);
    expect(state.orders.get('o2')!.collectedAmount).toBe(18);
    expect(state.orders.get('o3')!.collectedAmount).toBeNull();
    expect(state.orders.get('o4')!.collectedAmount).toBeNull();
  });

  it('the money in the wallet is the receipts and nothing a decision changes', async () => {
    putOrders(order('o1'), order('o2'));
    state.reads = [statement([accepted('o1'), row('o2', { resolution: 'OURS_STANDS', resolutionNote: 'نطالب بالفرق' })])];
    await approve();
    expect(recordMovement).toHaveBeenCalledTimes(1);
    expect(recordMovement.mock.calls[0][1]).toMatchObject({ direction: 'IN', amount: 35, category: 'COURIER_SETTLEMENT' });
  });
});

describe('the fee is part of what the customer handed over', () => {
  it('an accepted line of 15.500 with a fee of 2.500 writes 18.000 — the gross, as a clean row does', async () => {
    putOrders(order('o1'));
    state.reads = [statement([accepted('o1', { expectedAmount: 17.5, statementAmount: 15.5, statementFee: 2.5 })])];
    await approve();
    expect(state.orders.get('o1')!.collectedAmount).toBe(18);
  });
});

describe('every order is looked at again, as the write that settles it (RV291)', () => {
  it('an order settled by hand after the answer stops the approval and is NAMED — nothing is paid on a stale answer', async () => {
    putOrders(order('o1'), order('o2', { settlementStatus: 'SETTLED' }));
    state.reads = [statement([accepted('o1'), accepted('o2')])];

    const res = await approve();
    const body = await res.json();

    expect(res.status).toBe(409);
    expect(body.code).toBe('ORDERS_CHANGED');
    expect(body.orders).toEqual(['JO-o2']);
    expect(body.error).toContain('JO-o2');
    expect(body.error).toContain('قيد المراجعة');
    expect(markPayableForOrders).not.toHaveBeenCalled();
    expect(db.order.update).not.toHaveBeenCalled();
  });

  it('a clean row is looked at again too: two statements that name one order are both clean, and the second one stops', async () => {
    putOrders(order('o1', { settlementStatus: 'SETTLED' }));
    state.reads = [statement([row('o1', { result: 'MATCHED', expectedAmount: 20, statementAmount: 20 })])];

    const res = await approve();

    expect(res.status).toBe(409);
    expect((await res.json()).code).toBe('ORDERS_CHANGED');
    expect(markPayableForOrders).not.toHaveBeenCalled();
  });

  it('a cancel asked for since the line was matched stops it too — the parcel may not be what the line describes', async () => {
    putOrders(order('o1', { openRequest: true }));
    state.reads = [statement([accepted('o1')])];

    const res = await approve();

    expect(res.status).toBe(409);
    expect((await res.json()).orders).toEqual(['JO-o1']);
    expect(settled()).toEqual([]);
  });

  it('a decision rests on the state of the parcel: an order that went to the warehouse (not shipped) is not settled by it', async () => {
    putOrders(order('o1', { shippingStatus: 'NOT_READY' }));
    state.reads = [statement([accepted('o1')])];
    expect((await approve()).status).toBe(409);
    expect(settled()).toEqual([]);
  });

  it('the filter is the claim’s own WHERE: not settled, no open request, and — for a decision — a state the matrix allows', async () => {
    putOrders(order('o1'), order('o2'));
    state.reads = [statement([row('o1', { result: 'MATCHED', expectedAmount: 20, statementAmount: 20 }), accepted('o2')])];
    await approve();

    const [clean, decided] = claimsBody();
    expect(clean).toMatchObject({ id: { in: ['o1'] }, companyId: 'c1', settlementStatus: { not: 'SETTLED' } });
    expect(clean.changeRequests.none).toBeTruthy();
    expect(clean.OR).toBeUndefined();
    expect(decided).toMatchObject({ id: { in: ['o2'] }, settlementStatus: { not: 'SETTLED' } });
    expect(decided.OR[0].shippingStatus.in).toEqual(['DELIVERED', 'PARTIALLY_DELIVERED']);
    expect(decided.OR[1]).toMatchObject({ id: { in: ['o2'] }, shippingStatus: { in: expect.arrayContaining(['SHIPPED']) } });
  });
});

describe('a parcel coming back takes the company’s figure only as a line of zero', () => {
  it('a zero line against a RETURN_REQUESTED order is settled at 0', async () => {
    putOrders(order('o1', { shippingStatus: 'RETURN_REQUESTED' }));
    state.reads = [statement([accepted('o1', { expectedAmount: -1.5, statementAmount: 0 })])];

    expect((await approve()).status).toBe(200);
    expect(settled()).toEqual(['o1']);
    expect(state.orders.get('o1')!.collectedAmount).toBe(0);
  });

  it('a line with a MONEY figure against a returned order is refused at approval', async () => {
    putOrders(order('o1', { shippingStatus: 'RETURNED' }));
    state.reads = [statement([accepted('o1', { expectedAmount: 0, statementAmount: 5 })])];

    expect((await approve()).status).toBe(409);
    expect(settled()).toEqual([]);
  });
});

describe('a zero line does not deliver a parcel that is still on the road', () => {
  it('«مؤجلة» with nothing against it, accepted, stops the approval — the parcel is not delivered for nothing', async () => {
    putOrders(order('o1', { shippingStatus: 'SHIPPED' }));
    state.reads = [statement([accepted('o1', { expectedAmount: 20, statementAmount: 0 })])];

    const res = await approve();

    expect(res.status).toBe(409);
    expect((await res.json()).orders).toEqual(['JO-o1']);
    expect(state.orders.get('o1')).toMatchObject({ shippingStatus: 'SHIPPED', settlementStatus: 'PENDING_COLLECTION', collectedAmount: null });
  });

  it('but a zero line against a parcel our own door recorded as delivered may be accepted — a loss a person accepts in words', async () => {
    putOrders(order('o1'));
    state.reads = [statement([accepted('o1', { expectedAmount: 20, statementAmount: 0 })])];
    expect((await approve()).status).toBe(200);
    expect(state.orders.get('o1')).toMatchObject({ settlementStatus: 'SETTLED', collectedAmount: 0 });
  });
});

describe('a parcel still on the road is DELIVERED by the statement that is accepted for it', () => {
  it('SHIPPED becomes DELIVERED, dated, and gets the company’s figure', async () => {
    putOrders(order('o1', { shippingStatus: 'SHIPPED' }));
    state.reads = [statement([accepted('o1')])];

    expect((await approve()).status).toBe(200);
    expect(state.orders.get('o1')).toMatchObject({ shippingStatus: 'DELIVERED', settlementStatus: 'SETTLED', collectedAmount: 18 });
  });
});

describe('the claim is closed by a later statement that pays what remains', () => {
  const earlier = (statementAmount: number, statementFee = 0) => ({ statementAmount, statementFee });
  const payment = (orderId: string, over: Record<string, unknown> = {}) =>
    row(orderId, {
      result: 'MATCHED', expectedAmount: 2, statementAmount: 2,
      order: { orderNumber: `JO-${orderId}`, settlementMatches: [earlier(18)] }, ...over,
    });

  it('18.000 paid first and 2.000 paid now: SETTLED, and the order was paid 20.000 in all', async () => {
    putOrders(order('o1'));
    state.reads = [statement([payment('o1')])];

    expect((await approve()).status).toBe(200);
    expect(settled()).toEqual(['o1']);
    expect(state.orders.get('o1')!.collectedAmount).toBe(20);
  });

  it('LESS than the remainder, answered «اعتُمد رقم الشركة»: closed at what was paid — 18.000 + 1.500', async () => {
    putOrders(order('o1'));
    state.reads = [statement([accepted('o1', {
      expectedAmount: 2, statementAmount: 1.5, order: { orderNumber: 'JO-o1', settlementMatches: [earlier(18)] },
    })])];

    expect((await approve()).status).toBe(200);
    expect(settled()).toEqual(['o1']);
    expect(state.orders.get('o1')!.collectedAmount).toBe(19.5);
  });

  it('MORE than the remainder, answered the same: 18.000 + 5.000', async () => {
    putOrders(order('o1'));
    state.reads = [statement([accepted('o1', {
      expectedAmount: 2, statementAmount: 5, order: { orderNumber: 'JO-o1', settlementMatches: [earlier(18)] },
    })])];

    await approve();
    expect(state.orders.get('o1')!.collectedAmount).toBe(23);
  });

  it('less than the remainder and left as «رقمنا» is still a claim, of what is still missing', async () => {
    putOrders(order('o1'));
    state.reads = [statement([row('o1', {
      expectedAmount: 2, statementAmount: 1.5, resolution: 'OURS_STANDS', resolutionNote: 'ما زال ناقصاً',
      order: { orderNumber: 'JO-o1', settlementMatches: [earlier(18)] },
    })])];

    await approve();
    expect(settled()).toEqual([]);
    const act = db.orderActivity.create.mock.calls.map((c) => c[0].data).find((d) => d.action === 'SETTLEMENT_CLAIM_OPENED');
    expect(JSON.parse(act.metadata).remaining).toBe(0.5);
  });

  it('the places of a dinar are kept: 10.100 paid first, 10.200 now = 20.300, not 20.299999999999997', async () => {
    putOrders(order('o1'));
    state.reads = [statement([payment('o1', {
      expectedAmount: 10.2, statementAmount: 10.2, order: { orderNumber: 'JO-o1', settlementMatches: [earlier(10.1)] },
    })])];

    await approve();
    expect(state.orders.get('o1')!.collectedAmount).toBe(20.3);
  });

  it('the fee the first statement kept is part of what was paid: 15.500 + 2.500 fee, then 2.000 → 20.000', async () => {
    putOrders(order('o1'));
    state.reads = [statement([payment('o1', { order: { orderNumber: 'JO-o1', settlementMatches: [earlier(15.5, 2.5)] } })])];

    await approve();
    expect(state.orders.get('o1')!.collectedAmount).toBe(20);
  });

  it('a closing line that states a fee of its own (a manual statement does) does not add the fee a second time', async () => {
    putOrders(order('o1'));
    state.reads = [statement([payment('o1', { statementFee: 2.5, order: { orderNumber: 'JO-o1', settlementMatches: [earlier(15.5, 2.5)] } })])];

    await approve();
    expect(state.orders.get('o1')!.collectedAmount).toBe(20);
  });

  it('an order with no earlier claim is written exactly as before — nothing is added', async () => {
    putOrders(order('o1'));
    state.reads = [statement([row('o1', { result: 'MATCHED', expectedAmount: 17.5, statementAmount: 15.5, statementFee: 2.5 })])];
    await approve();
    expect(state.orders.get('o1')!.collectedAmount).toBe(18);
  });
});

describe('one approval, however many presses — the decisions are carried out once', () => {
  it('two presses settle the order and write the amount ONCE', async () => {
    putOrders(order('o1'));
    state.reads = [statement([accepted('o1')])];

    const [a, b] = await Promise.all([approve(), approve()]);

    expect([a.status, b.status].sort()).toEqual([200, 409]);
    expect(recordMovement).toHaveBeenCalledTimes(1);
    expect(db.order.updateMany).toHaveBeenCalledTimes(1);
    expect(db.order.update).toHaveBeenCalledTimes(1);
    expect(db.orderActivity.create.mock.calls.filter((c) => c[0].data.action === 'SETTLEMENT_DECISION_APPLIED')).toHaveLength(1);
  });

  it('an order two rows name is settled once, by the first', async () => {
    putOrders(order('o1'));
    state.reads = [statement([
      row('o1', { id: 'm-a', result: 'MATCHED', expectedAmount: 20, statementAmount: 20 }),
      accepted('o1', { id: 'm-b' }),
    ])];

    expect((await approve()).status).toBe(200);
    expect(db.order.updateMany).toHaveBeenCalledTimes(1);
    expect(markPayableForOrders.mock.calls[0][2]).toEqual(['o1']);
    expect(state.orders.get('o1')!.collectedAmount).toBe(20);
  });
});

describe('two accepted rows for one order (old data, answered before the door refused it)', () => {
  it('do not hang the approval: the order is settled ONCE, with one activity, and no empty list of names', async () => {
    putOrders(order('o1'));
    state.reads = [statement([accepted('o1', { id: 'm-a' }), accepted('o1', { id: 'm-b' })])];

    const res = await approve();

    expect(res.status).toBe(200);
    expect(settled()).toEqual(['o1']);
    expect(db.order.updateMany).toHaveBeenCalledTimes(1);
    expect(db.order.updateMany.mock.calls[0][0].where.id).toEqual({ in: ['o1'] });
    expect(db.orderActivity.create.mock.calls.filter((c) => c[0].data.action === 'SETTLEMENT_DECISION_APPLIED')).toHaveLength(1);
    expect(state.orders.get('o1')!.collectedAmount).toBe(18);
  });

  it('and when an order really did change, the 409 still names it (never an empty list)', async () => {
    putOrders(order('o1', { settlementStatus: 'SETTLED' }));
    state.reads = [statement([accepted('o1', { id: 'm-a' }), accepted('o1', { id: 'm-b' })])];

    const res = await approve();
    const body = await res.json();

    expect(res.status).toBe(409);
    expect(body.code).toBe('ORDERS_CHANGED');
    expect(body.orders).toEqual(['JO-o1']);
  });
});

describe('a decision carried out must carry a real reason', () => {
  it.each([null, '', 'خصم', '.....', '\u0640\u0640\u0640\u0640\u0640', '\u200B\u200B\u200B\u200B\u200B'])(
    'a row answered with %j stops the approval, names the order, and settles nothing',
    async (resolutionNote) => {
      putOrders(order('o1'), order('o2'));
      state.reads = [statement([accepted('o1', { resolutionNote }), accepted('o2')])];

      const res = await approve();
      const body = await res.json();

      expect(res.status).toBe(409);
      expect(body.code).toBe('DECISION_WITHOUT_REASON');
      expect(body.orders).toEqual(['JO-o1']);
      expect(settled()).toEqual([]);
      expect(db.order.updateMany).not.toHaveBeenCalled();
      expect(markPayableForOrders).not.toHaveBeenCalled();
    }
  );

  it('a short real reason is enough', async () => {
    putOrders(order('o1'));
    state.reads = [statement([accepted('o1', { resolutionNote: 'خطأ بالرقم' })])];
    expect((await approve()).status).toBe(200);
  });

  it('«رقمنا» is not carried out, so its reason is not asked at approval', async () => {
    putOrders(order('o1'));
    state.reads = [statement([row('o1', { resolution: 'OURS_STANDS', resolutionNote: null })])];
    expect((await approve()).status).toBe(200);
  });
});

describe('the audit row says what the approval settled', () => {
  it('the clean rows plus the answered ones, and the claims it left open', async () => {
    putOrders(order('o1'), order('o2'), order('o3'));
    state.reads = [statement([
      row('o1', { result: 'MATCHED', expectedAmount: 20, statementAmount: 20 }),
      accepted('o2'),
      row('o3', { resolution: 'OURS_STANDS', resolutionNote: 'نطالب بالفرق' }),
    ])];
    await approve();
    expect(logAudit.mock.calls[0][0].newData).toMatchObject({ settled: 2, acceptedByDecision: 1, claimsOpened: 1 });
  });
});
