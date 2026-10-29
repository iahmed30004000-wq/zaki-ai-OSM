import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * THE COMPANY PAID LESS THAN WE EXPECTED, AND THE APPROVAL ACCEPTED ITS FIGURE — SO SOMEBODY CARRIES THE DIFFERENCE.
 *
 * «ممكن عادي صار خصم، بس يعتمد رقم الشركة.» These tests drive the REAL approval route against a fake database, as
 * `a-decision-is-carried-out-by-the-approval` does, and look at what the approval wrote besides the settlement: a
 * PROPOSED «فرق تحصيل» for the employee who collected the parcel, in the approval's own transaction.
 *
 * The example the work was specified with, in dollars: an order of 20.00 with a courier fee of 2.50.
 *
 *     expected  17.50 net + 2.50 fee      the company's line  15.50 net + 2.50 fee
 *     approval  → ONE wallet movement IN 15.50 (the receipt), the order SETTLED, collectedAmount 18.00,
 *                 and a «فرق تحصيل» of 2.00 PROPOSED on the employee at the door
 */

type FakeOrder = {
  id: string; orderNumber: string; shippingStatus: string; settlementStatus: string;
  openRequest: boolean; collectedAmount: number | null; customerId: string;
  deliveredAt: Date | null; moderatorId: string | null; confirmedById: string | null;
};
type FakePenalty = Record<string, any>;

const { db, requireContext, requirePermission, logAudit, recordMovement, receiptGap, markPayableForOrders, notify, state } = vi.hoisted(() => {
  const state = {
    stamped: false,
    reads: [] as unknown[],
    orders: new Map<string, FakeOrder>(),
    penalties: [] as FakePenalty[],
    /** The door: orderId → who pressed «delivered». */
    door: new Map<string, string | null>(),
    users: [] as { id: string; name: string; role: string }[],
  };

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
    user: {
      findMany: vi.fn(async ({ where }: { where: { id?: { in: string[] } } }) =>
        where.id?.in ? state.users.filter((u) => where.id!.in.includes(u.id)) : state.users
      ),
    },
    deliveryAttempt: {
      findMany: vi.fn(async ({ where }: { where: { orderId: { in: string[] } } }) =>
        where.orderId.in.filter((id) => state.door.get(id)).map((orderId) => ({ orderId, deliveryAgentId: state.door.get(orderId) }))
      ),
    },
    penalty: {
      findMany: vi.fn(async ({ where }: { where: { settlementMatchId: { in: string[] } } }) =>
        state.penalties.filter((p) => where.settlementMatchId.in.includes(p.settlementMatchId) && ['PROPOSED', 'APPLIED'].includes(p.status))
      ),
      create: vi.fn(async ({ data }: { data: FakePenalty }) => {
        // The database’s own rule: one live charge per statement line.
        if (state.penalties.some((p) => p.settlementMatchId === data.settlementMatchId && ['PROPOSED', 'APPLIED'].includes(p.status))) {
          throw new Error('unique violation: penalties_one_live_per_match');
        }
        const row = { id: `pen-${state.penalties.length + 1}`, ...data };
        state.penalties.push(row);
        return row;
      }),
    },
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
        if (data.deliveredAt) o.deliveredAt = data.deliveredAt;
        return o;
      }),
    },
    orderActivity: { create: vi.fn() },
    customer: { update: vi.fn() },
    // A transaction that ROLLS BACK: the orders and the penalties are what they were before it, after a throw.
    $transaction: vi.fn(async (fn: (tx: unknown) => unknown) => {
      const orders = new Map([...state.orders].map(([k, v]) => [k, { ...v }]));
      const penalties = state.penalties.map((p) => ({ ...p }));
      try {
        return await fn(db);
      } catch (e) {
        state.orders = orders;
        state.penalties = penalties;
        throw e;
      }
    }),
  };
  return {
    db, state,
    requireContext: vi.fn(), requirePermission: vi.fn(), logAudit: vi.fn(),
    recordMovement: vi.fn(), receiptGap: vi.fn(), markPayableForOrders: vi.fn(), notify: vi.fn(),
  };
});

vi.mock('@/lib/db', () => ({ db }));
vi.mock('@/lib/geo-context', () => ({ requireContext: (...a: unknown[]) => requireContext(...a) }));
vi.mock('@/lib/authorization', () => ({ requirePermission: (...a: unknown[]) => requirePermission(...a), can: () => true }));
vi.mock('@/lib/audit', () => ({ logAudit: (...a: unknown[]) => logAudit(...a) }));
vi.mock('@/lib/notify', () => ({ notify: (...a: unknown[]) => notify(...a) }));
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
const M1 = '11111111-1111-4111-8111-111111111111';
const M2 = '22222222-2222-4222-8222-222222222222';
const U_NAMED = '33333333-3333-4333-8333-333333333333';

const approve = (body: Record<string, unknown> = {}) =>
  PATCH(
    new Request('http://localhost/x', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ approve: true, ...body }),
    }),
    { params: Promise.resolve({ id: ID }) }
  );

const order = (id: string, over: Partial<FakeOrder> = {}): FakeOrder => ({
  id, orderNumber: `ORD-${id}`, shippingStatus: 'DELIVERED', settlementStatus: 'PENDING_COLLECTION',
  openRequest: false, collectedAmount: null, customerId: `cu-${id}`,
  deliveredAt: new Date('2026-10-18T09:00:00Z'), moderatorId: 'u-mod', confirmedById: 'u-conf', ...over,
});

/** The dollar example: ours 17.50 + 2.50, theirs 15.50 + 2.50. */
const row = (orderId: string, over: Record<string, unknown> = {}) => ({
  id: `m-${orderId}`, orderId, result: 'MISMATCHED', resolution: null, resolutionNote: null, resolvedById: null,
  expectedAmount: 17.5, expectedFee: 2.5, statementAmount: 15.5, statementFee: 2.5,
  order: { orderNumber: `ORD-${orderId}`, settlementMatches: [] }, ...over,
});

const accepted = (orderId: string, over: Record<string, unknown> = {}) =>
  row(orderId, { resolution: 'ACCEPTED_COURIER', resolutionNote: 'خصم أعطاه الموظف للزبون', resolvedById: 'u-decider', ...over });

const statement = (matches: unknown[], over: Record<string, unknown> = {}) => ({
  id: ID, status: 'MATCHED', reference: 'ST-1', currencyCode: 'USD', gapExplanation: null, approvedAt: null,
  createdAt: new Date('2026-10-20T10:00:00Z'), periodTo: new Date('2026-10-20T00:00:00Z'),
  fileHash: 'ab'.repeat(32),
  receipts: [{ id: 'r1', walletId: 'w-usd', amount: 15.5 }],
  matches, ...over,
});

const FOLLOWER = { id: 'u-door', name: 'سارة', role: 'FOLLOW_UP_AGENT' };
const putOrders = (...os: FakeOrder[]) => { for (const o of os) state.orders.set(o.id, o); };
const settled = () => [...state.orders.values()].filter((o) => o.settlementStatus === 'SETTLED').map((o) => o.id).sort();
const activities = (action: string) => db.orderActivity.create.mock.calls.map((c) => c[0].data).filter((d) => d.action === action);

beforeEach(() => {
  vi.clearAllMocks();
  notify.mockReset();
  state.stamped = false;
  state.orders = new Map();
  state.penalties = [];
  state.door = new Map();
  state.users = [FOLLOWER];
  requireContext.mockResolvedValue({
    user: { id: 'u-approver', name: 'المحاسب' }, companyId: 'c1', storeId: 's1', country: { minorUnit: 2, currencyCode: 'USD' },
  });
  requirePermission.mockResolvedValue({});
  receiptGap.mockResolvedValue({ claimed: 15.5, received: 15.5, gap: 0, needsExplanation: false, explained: false, unconvertible: 0 });
  markPayableForOrders.mockResolvedValue(0);
  recordMovement.mockResolvedValue({ id: 'mv1' });
});

describe('the example: 20.00 with a fee of 2.50, and the company paid 15.50', () => {
  it('settles the order, moves the receipt once, and proposes 2.00 on the employee at the door', async () => {
    putOrders(order('o1'));
    state.door.set('o1', 'u-door');
    state.reads = [statement([accepted('o1')])];

    const res = await approve();

    expect(res.status).toBe(200);
    expect(settled()).toEqual(['o1']);
    expect(state.orders.get('o1')!.collectedAmount).toBe(18);
    expect(recordMovement).toHaveBeenCalledTimes(1);
    expect(recordMovement.mock.calls[0][1]).toMatchObject({ direction: 'IN', amount: 15.5, category: 'COURIER_SETTLEMENT' });

    expect(state.penalties).toHaveLength(1);
    expect(state.penalties[0]).toMatchObject({
      companyId: 'c1', storeId: 's1', userId: 'u-door', kind: 'SHORTFALL', status: 'PROPOSED',
      amount: 2, currencyCode: 'USD', settlementMatchId: 'm-o1', units: 1, chargedUnits: 1, ruleId: null,
      note: 'ORD-o1 · ST-1 · خصم أعطاه الموظف للزبون',
    });
    expect(state.penalties[0].occurredOn.toISOString()).toBe('2026-10-18T00:00:00.000Z');
    // Nothing is applied by the approval: a person decides, or payday does.
    expect(state.penalties[0].decidedById).toBeUndefined();
  });

  it('tells the employee — once, after the approval, never from inside the transaction', async () => {
    putOrders(order('o1'));
    state.door.set('o1', 'u-door');
    state.reads = [statement([accepted('o1')])];
    notify.mockImplementation(() => {
      // By now the approval has committed: the penalty is there, and the fake transaction has returned.
      expect(state.penalties).toHaveLength(1);
    });

    await approve();

    expect(notify).toHaveBeenCalledTimes(1);
    expect(notify.mock.calls[0][0]).toMatchObject({
      companyId: 'c1', storeId: 's1', audience: { userIds: ['u-door'] }, actorId: 'u-approver', type: 'SYSTEM_ALERT',
    });
    expect(notify.mock.calls[0][0].message).toContain('ORD-o1');
    expect(notify.mock.calls[0][0].message).toContain('2');
  });

  it('writes it on the order, and in the audit row', async () => {
    putOrders(order('o1'));
    state.door.set('o1', 'u-door');
    state.reads = [statement([accepted('o1')])];
    await approve();

    expect(activities('SHORTFALL_PROPOSED')).toHaveLength(1);
    expect(logAudit.mock.calls[0][0].newData.shortfalls).toEqual([
      expect.objectContaining({ employeeId: 'u-door', amount: 2, currency: 'USD' }),
    ]);
  });

  it('a dinar statement: 20.000 against 19.500 is a charge of 0.500, in JOD', async () => {
    requireContext.mockResolvedValue({
      user: { id: 'u-approver' }, companyId: 'c1', storeId: 's1', country: { minorUnit: 3, currencyCode: 'JOD' },
    });
    putOrders(order('o1'));
    state.door.set('o1', 'u-door');
    state.reads = [statement([accepted('o1', { statementAmount: 17 })], { currencyCode: 'JOD' })];

    expect((await approve()).status).toBe(200);
    expect(state.penalties[0]).toMatchObject({ amount: 0.5, currencyCode: 'JOD' });
  });
});

describe('what charges nobody', () => {
  it('a line that paid the expected figure to the fils (MATCHED) — nothing is proposed', async () => {
    putOrders(order('o1'));
    state.reads = [statement([row('o1', { result: 'MATCHED', statementAmount: 17.5 })])];
    expect((await approve()).status).toBe(200);
    expect(state.penalties).toEqual([]);
    expect(notify).not.toHaveBeenCalled();
  });

  it('a line that paid MORE than expected, accepted — nothing is proposed', async () => {
    putOrders(order('o1'));
    state.reads = [statement([accepted('o1', { statementAmount: 18.5 })])];
    expect((await approve()).status).toBe(200);
    expect(state.penalties).toEqual([]);
  });

  it('a fee difference alone — the courier kept 1.00 more and paid 1.00 less — nothing is proposed', async () => {
    putOrders(order('o1'));
    state.reads = [statement([accepted('o1', { statementAmount: 16.5, statementFee: 3.5 })])];
    expect((await approve()).status).toBe(200);
    expect(state.penalties).toEqual([]);
  });

  it('«رقمنا هو المعتمد» is a claim on the company, not on an employee', async () => {
    putOrders(order('o1'));
    state.door.set('o1', 'u-door');
    state.reads = [statement([row('o1', { resolution: 'OURS_STANDS', resolutionNote: 'الشركة مدينة بالفرق' })])];
    expect((await approve()).status).toBe(200);
    expect(state.penalties).toEqual([]);
    expect(settled()).toEqual([]);
  });

  it('«قيد المراجعة» proposes nothing', async () => {
    putOrders(order('o1'));
    state.reads = [statement([row('o1', { resolution: 'UNDER_REVIEW', resolutionNote: 'ننتظر الشركة' })])];
    expect((await approve()).status).toBe(200);
    expect(state.penalties).toEqual([]);
  });

  it('a delivered order the statement never mentioned (MISSING) is never charged', async () => {
    putOrders(order('o1'));
    state.door.set('o1', 'u-door');
    state.reads = [statement([row('o1', { result: 'MISSING_IN_STATEMENT', statementAmount: null, statementFee: null, resolution: null })])];
    expect((await approve()).status).toBe(200);
    expect(state.penalties).toEqual([]);
    expect(settled()).toEqual([]);
  });

  it('a parcel coming back, accepted at a line of zero, is a return — not a collection shortfall', async () => {
    putOrders(order('o1', { shippingStatus: 'RETURN_REQUESTED' }));
    state.door.set('o1', 'u-door');
    state.reads = [statement([accepted('o1', { expectedAmount: 0, expectedFee: 0, statementAmount: 0, statementFee: 0 })])];
    expect((await approve()).status).toBe(200);
    expect(state.penalties).toEqual([]);
  });

  it('a payment on an earlier claim is measured net against net: the fee is not charged again', async () => {
    putOrders(order('o1'));
    state.door.set('o1', 'u-door');
    state.reads = [statement([accepted('o1', {
      expectedAmount: 2, expectedFee: 2.5, statementAmount: 2, statementFee: 2.5,
      order: { orderNumber: 'ORD-o1', settlementMatches: [{ statementAmount: 15.5, statementFee: 2.5 }] },
    })])];
    expect((await approve()).status).toBe(200);
    expect(state.penalties).toEqual([]);
  });
});

describe('a payment on an earlier claim that came in short', () => {
  it('charges the NET that is missing — the fee it states again does not hide it, and does not add to it', async () => {
    putOrders(order('o1'));
    state.door.set('o1', 'u-door');
    // Two dollars were left owing; the line pays 1.50 and states a fee of 3.50 (the fee went up by one).
    // Net against net: 0.50 short. Read as a full order it would look like a gross that GREW, and nobody pays.
    state.reads = [statement([accepted('o1', {
      expectedAmount: 2, expectedFee: 2.5, statementAmount: 1.5, statementFee: 3.5,
      order: { orderNumber: 'ORD-o1', settlementMatches: [{ statementAmount: 15.5, statementFee: 2.5 }] },
    })])];

    expect((await approve()).status).toBe(200);
    expect(state.penalties).toHaveLength(1);
    expect(state.penalties[0]).toMatchObject({ amount: 0.5, status: 'PROPOSED' });
  });
});

describe('one charge per line, however many presses', () => {
  it('two presses of «اعتماد» in the same moment: one wins, one charge', async () => {
    putOrders(order('o1'));
    state.door.set('o1', 'u-door');
    state.reads = [statement([accepted('o1')])];

    const [a, b] = await Promise.all([approve(), approve()]);

    expect([a.status, b.status].sort()).toEqual([200, 409]);
    expect(state.penalties).toHaveLength(1);
    expect(db.penalty.create).toHaveBeenCalledTimes(1);
    expect(notify).toHaveBeenCalledTimes(1);
  });

  it('two accepted rows for one order (old data) are one order: one charge', async () => {
    putOrders(order('o1'));
    state.door.set('o1', 'u-door');
    state.reads = [statement([accepted('o1', { id: 'm-a' }), accepted('o1', { id: 'm-b' })])];

    expect((await approve()).status).toBe(200);
    expect(state.penalties).toHaveLength(1);
    expect(state.penalties[0].settlementMatchId).toBe('m-a');
  });

  it('two different short orders delivered on the SAME day: two charges', async () => {
    putOrders(order('o1'), order('o2'));
    state.door.set('o1', 'u-door');
    state.door.set('o2', 'u-door');
    state.reads = [statement([accepted('o1'), accepted('o2')], { receipts: [{ id: 'r1', walletId: 'w-usd', amount: 31 }] })];

    expect((await approve()).status).toBe(200);
    expect(state.penalties.map((p) => p.settlementMatchId).sort()).toEqual(['m-o1', 'm-o2']);
  });
});

describe('no door on the parcel: the approver names a person for the line, or says «على الشركة»', () => {
  it('without an answer the approval stops — nothing is settled, nothing is charged — and the lines come back with the people', async () => {
    putOrders(order('o1'));
    state.reads = [statement([accepted('o1', { id: M1 })])];

    const res = await approve();
    const body = await res.json();

    expect(res.status).toBe(409);
    expect(body.code).toBe('SHORTFALL_UNNAMED');
    expect(body.lines).toEqual([{ matchId: M1, orderNumber: 'ORD-o1', amount: 2, currencyCode: 'USD' }]);
    expect(body.error).toContain('ORD-o1');
    expect(settled()).toEqual([]);
    expect(state.penalties).toEqual([]);
    expect(notify).not.toHaveBeenCalled();
    expect(logAudit).not.toHaveBeenCalled();
  });

  it('the approver names an employee: the approval goes through and the charge is theirs', async () => {
    state.users = [FOLLOWER, { id: U_NAMED, name: 'منى', role: 'FOLLOW_UP_AGENT' }];
    putOrders(order('o1'));
    state.reads = [statement([accepted('o1', { id: M1 })])];

    const res = await approve({ shortfallPeople: { [M1]: U_NAMED } });

    expect(res.status).toBe(200);
    expect(settled()).toEqual(['o1']);
    expect(state.penalties).toHaveLength(1);
    expect(state.penalties[0]).toMatchObject({ userId: U_NAMED, status: 'PROPOSED', settlementMatchId: M1 });
    expect(notify.mock.calls[0][0].audience).toEqual({ userIds: [U_NAMED] });
  });

  it('the approver says «على الشركة»: the order is settled, nobody is charged, and the order says so', async () => {
    putOrders(order('o1'));
    state.reads = [statement([accepted('o1', { id: M1 })])];

    const res = await approve({ shortfallPeople: { [M1]: 'COMPANY' } });

    expect(res.status).toBe(200);
    expect(settled()).toEqual(['o1']);
    expect(state.penalties).toEqual([]);
    expect(notify).not.toHaveBeenCalled();
    expect(activities('SHORTFALL_ON_COMPANY')).toHaveLength(1);
    expect(logAudit.mock.calls[0][0].newData.shortfallsOnCompany).toBe(1);
  });

  it('one line named and one left blank: the approval stops and asks only about the blank one', async () => {
    state.users = [FOLLOWER, { id: U_NAMED, name: 'منى', role: 'FOLLOW_UP_AGENT' }];
    putOrders(order('o1'), order('o2'));
    state.reads = [statement([accepted('o1', { id: M1 }), accepted('o2', { id: M2 })])];

    const res = await approve({ shortfallPeople: { [M1]: U_NAMED } });
    const body = await res.json();

    expect(res.status).toBe(409);
    expect(body.lines.map((l: { matchId: string }) => l.matchId)).toEqual([M2]);
    expect(state.penalties).toEqual([]);
    expect(settled()).toEqual([]);
  });

  it('NEGATIVE: the owner cannot be named — the approval stops with the reason', async () => {
    state.users = [{ id: U_NAMED, name: 'المالك', role: 'SUPER_ADMIN' }];
    putOrders(order('o1'));
    state.reads = [statement([accepted('o1', { id: M1 })])];

    const res = await approve({ shortfallPeople: { [M1]: U_NAMED } });
    const body = await res.json();

    expect(res.status).toBe(409);
    expect(body.code).toBe('SHORTFALL_BAD_PERSON');
    expect(state.penalties).toEqual([]);
    expect(settled()).toEqual([]);
  });

  it('NEGATIVE: the order’s confirmer and moderator are never the ones named', async () => {
    state.users = [{ id: U_NAMED, name: 'مؤكد', role: 'CONFIRMATION_AGENT' }];
    putOrders(order('o1', { confirmedById: U_NAMED }));
    state.reads = [statement([accepted('o1', { id: M1 })])];
    expect((await (await approve({ shortfallPeople: { [M1]: U_NAMED } })).json()).code).toBe('SHORTFALL_BAD_PERSON');

    state.stamped = false;
    putOrders(order('o1', { moderatorId: U_NAMED }));
    state.reads = [statement([accepted('o1', { id: M1 })])];
    expect((await (await approve({ shortfallPeople: { [M1]: U_NAMED } })).json()).code).toBe('SHORTFALL_BAD_PERSON');
    expect(state.penalties).toEqual([]);
  });

  it('a parcel a statement is the first proof of (still on the road) has no door yet: it asks too', async () => {
    putOrders(order('o1', { shippingStatus: 'SHIPPED', deliveredAt: null }));
    state.reads = [statement([accepted('o1', { id: M1 })])];
    expect((await (await approve()).json()).code).toBe('SHORTFALL_UNNAMED');
  });

  it('a body that names a thing which is not a person is refused before anything runs', async () => {
    putOrders(order('o1'));
    state.reads = [statement([accepted('o1', { id: M1 })])];
    expect((await approve({ shortfallPeople: { [M1]: 'whoever' } })).status).toBe(400);
    expect(db.$transaction).not.toHaveBeenCalled();
  });
});

describe('an approval that stops leaves nothing behind', () => {
  it('a stop for a missing name rolls back the settled orders as well', async () => {
    putOrders(order('o1'), order('o2'));
    state.door.set('o1', 'u-door');
    state.reads = [statement([accepted('o1'), accepted('o2', { id: M2 })])];

    expect((await approve()).status).toBe(409);
    expect(settled()).toEqual([]);
    expect(state.penalties).toEqual([]);
  });
});
