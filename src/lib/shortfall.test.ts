import { describe, expect, it, vi } from 'vitest';
import {
  NEVER_CHARGED_ROLES,
  ON_THE_COMPANY,
  dayOf,
  mayCarryShortfall,
  proposeShortfalls,
  shortfallNote,
  shortfallOf,
  type ShortfallCandidate,
  type ShortfallScope,
} from './shortfall';

/**
 * «فرق التحصيل» — WHAT THE COMPANY PAID LESS THAN WE EXPECTED, AND WHO CARRIES IT.
 *
 * The example the work was specified with, in dollars: an order of 20.00 with a courier fee of 2.50. We expect the
 * company to hand over 17.50 and keep 2.50 (so the customer's 20.00 is accounted for). The company's line says it
 * paid 15.50 and kept 2.50: it collected 18.00 from the customer, 2.00 short of 20.00. s = 2.00.
 */

const USD = 2;
const JOD = 3;

describe('s = (expected + expected fee) − (stated + stated fee), in the currency’s own decimals', () => {
  it('the example: 17.50 + 2.50 against 15.50 + 2.50 is 2.00 short', () => {
    expect(shortfallOf({ expectedAmount: 17.5, expectedFee: 2.5, statementAmount: 15.5, statementFee: 2.5 }, USD)).toBe(2);
  });

  it('a line that paid MORE, or exactly, is no shortfall (and never a negative number)', () => {
    expect(shortfallOf({ expectedAmount: 17.5, expectedFee: 2.5, statementAmount: 17.5, statementFee: 2.5 }, USD)).toBe(0);
    expect(shortfallOf({ expectedAmount: 17.5, expectedFee: 2.5, statementAmount: 19, statementFee: 2.5 }, USD)).toBe(0);
  });

  it('a FEE difference alone charges nobody: the courier kept 1.00 more, so it paid 1.00 less — the same gross', () => {
    expect(shortfallOf({ expectedAmount: 17.5, expectedFee: 2.5, statementAmount: 16.5, statementFee: 3.5 }, USD)).toBe(0);
  });

  it('and a fee that is only higher, with the same net, is a gross that grew — not a shortfall', () => {
    expect(shortfallOf({ expectedAmount: 17.5, expectedFee: 2.5, statementAmount: 17.5, statementFee: 4 }, USD)).toBe(0);
  });

  it('a gross that is short for a reason other than the fee still charges what is missing, and only that', () => {
    // The fee also went up by 1.00; the net fell by 3.00 → the gross fell by 2.00.
    expect(shortfallOf({ expectedAmount: 17.5, expectedFee: 2.5, statementAmount: 14.5, statementFee: 3.5 }, USD)).toBe(2);
  });

  it('a fee the company did not state is taken as ours: its silence is not a loss to an employee', () => {
    expect(shortfallOf({ expectedAmount: 17.5, expectedFee: 2.5, statementAmount: 15.5, statementFee: null }, USD)).toBe(2);
    expect(shortfallOf({ expectedAmount: 17.5, expectedFee: 2.5, statementAmount: 15.5 }, USD)).toBe(2);
  });

  it('a dinar has three places: 0.500 is half a dinar, not 0.50 rounded or 1', () => {
    expect(shortfallOf({ expectedAmount: 17.5, expectedFee: 2.5, statementAmount: 17, statementFee: 2.5 }, JOD)).toBe(0.5);
    expect(shortfallOf({ expectedAmount: 17.5, expectedFee: 2.5, statementAmount: 17.125, statementFee: 2.5 }, JOD)).toBe(0.375);
  });

  it('and rounds by the currency, not by two: 0.375 in dinars is 0.38 in dollars', () => {
    expect(shortfallOf({ expectedAmount: 17.5, expectedFee: 2.5, statementAmount: 17.125, statementFee: 2.5 }, USD)).toBe(0.38);
  });

  it('float dust is not money: 0.1 + 0.2 − 0.3 is nothing', () => {
    expect(shortfallOf({ expectedAmount: 0.1, expectedFee: 0.2, statementAmount: 0.3, statementFee: 0 }, JOD)).toBe(0);
  });

  it('a figure the line lacks is no measure at all', () => {
    expect(shortfallOf({ expectedAmount: null, statementAmount: 15.5 }, USD)).toBe(0);
    expect(shortfallOf({ expectedAmount: 20, statementAmount: null }, USD)).toBe(0);
  });

  it('a payment on an earlier claim is measured net against net — the fee was settled with the first payment', () => {
    // Expected is the remainder (2.00); the line paid 1.50 and states the order’s fee again (2.50).
    expect(shortfallOf({ expectedAmount: 2, expectedFee: 2.5, statementAmount: 1.5, statementFee: 2.5, claimPayment: true }, USD)).toBe(0.5);
    expect(shortfallOf({ expectedAmount: 2, expectedFee: 2.5, statementAmount: 2, statementFee: 2.5, claimPayment: true }, USD)).toBe(0);
  });

  it('numbers that arrive as decimals or strings (Prisma) measure the same', () => {
    expect(shortfallOf({ expectedAmount: '17.500', expectedFee: '2.500', statementAmount: '15.500', statementFee: '2.500' }, JOD)).toBe(2);
  });
});

describe('who may carry it', () => {
  it('the owner and the managers never do', () => {
    for (const role of NEVER_CHARGED_ROLES) expect(mayCarryShortfall(role), role).toBe(false);
    expect([...NEVER_CHARGED_ROLES].sort()).toEqual(['COMPANY_ADMIN', 'DELIVERY_MANAGER', 'MANAGER', 'SUPER_ADMIN']);
  });

  it('the people who follow a parcel do', () => {
    for (const role of ['FOLLOW_UP_AGENT', 'SETTLEMENT_OFFICER', 'ACCOUNTANT', 'WAREHOUSE']) expect(mayCarryShortfall(role), role).toBe(true);
  });

  it('and no role at all is nobody', () => {
    expect(mayCarryShortfall(null)).toBe(false);
    expect(mayCarryShortfall('')).toBe(false);
  });
});

describe('the words written on the charge', () => {
  it('«طلب · كشف · التفسير»', () => {
    expect(shortfallNote({ orderNumber: 'ORD-9', reference: 'JO-ST-1', explanation: 'خصم أعطاه الموظف' })).toBe('ORD-9 · JO-ST-1 · خصم أعطاه الموظف');
  });

  it('and a dash when there is no explanation to quote', () => {
    expect(shortfallNote({ orderNumber: 'ORD-9', reference: 'JO-ST-1', explanation: null })).toBe('ORD-9 · JO-ST-1 · —');
  });

  it('the day is the UTC midnight of the moment', () => {
    expect(dayOf(new Date('2026-10-20T23:59:59Z')).toISOString()).toBe('2026-10-20T00:00:00.000Z');
  });
});

/* ───────────────────────────── the approval’s half, against a fake transaction ───────────────────────────── */

const SCOPE: ShortfallScope = {
  companyId: 'c1', storeId: 's1', approverId: 'u-approver',
  statement: { id: 'st1', reference: 'JO-ST-1', currencyCode: 'USD', importedAt: new Date('2026-10-20T10:00:00Z') },
  fallbackDeliveredAt: new Date('2026-10-19T00:00:00Z'),
  minorUnit: USD,
};

const cand = (n: string, over: Partial<ShortfallCandidate> = {}): ShortfallCandidate => ({
  matchId: `m-${n}`, orderId: `o-${n}`, orderNumber: `ORD-${n}`,
  expectedAmount: 17.5, expectedFee: 2.5, statementAmount: 15.5, statementFee: 2.5,
  explanation: 'خصم أعطاه الموظف للزبون', ...over,
});

const FOLLOWER = { id: 'u-follow', name: 'سارة', role: 'FOLLOW_UP_AGENT' };

function fakeTx(over: {
  orders?: Record<string, unknown>[];
  attempts?: { orderId: string; deliveryAgentId: string | null }[];
  users?: { id: string; name: string; role: string }[];
  live?: string[];
  candidates?: { id: string; name: string; role: string }[];
} = {}) {
  const users = over.users ?? [FOLLOWER];
  const tx = {
    order: {
      findMany: vi.fn(async ({ where }: { where: { id: { in: string[] } } }) =>
        (over.orders ?? where.id.in.map((id) => ({ id, shippingStatus: 'DELIVERED', deliveredAt: new Date('2026-10-18T09:00:00Z'), moderatorId: 'u-mod', confirmedById: 'u-conf' })))
          .filter((o) => where.id.in.includes(o.id as string))
      ),
    },
    deliveryAttempt: { findMany: vi.fn(async () => over.attempts ?? []) },
    user: {
      findMany: vi.fn(async ({ where }: { where: { id?: { in: string[] }; role?: unknown } }) =>
        where.id?.in ? users.filter((u) => where.id!.in.includes(u.id)) : over.candidates ?? []
      ),
    },
    penalty: {
      findMany: vi.fn(async () => (over.live ?? []).map((settlementMatchId) => ({ settlementMatchId }))),
      create: vi.fn(async () => ({ id: `pen-${Math.random()}` })),
    },
    orderActivity: { create: vi.fn() },
  };
  return tx;
}

const door = (n: string, agent: string | null = FOLLOWER.id) => ({ orderId: `o-${n}`, deliveryAgentId: agent });

describe('an approval with no shortfall touches nothing', () => {
  it('reads and writes no table when every line paid what was expected', async () => {
    const tx = fakeTx();
    const r = await proposeShortfalls(tx as never, SCOPE, [cand('1', { statementAmount: 17.5 })]);
    expect(r).toEqual({ charges: [], onCompany: [], stop: null });
    expect(tx.order.findMany).not.toHaveBeenCalled();
    expect(tx.penalty.create).not.toHaveBeenCalled();
  });
});

describe('the door names the person', () => {
  it('a PROPOSED charge for the one on the latest delivered attempt: the amount, the currency, the day, the words', async () => {
    const tx = fakeTx({ attempts: [door('1')] });
    const r = await proposeShortfalls(tx as never, SCOPE, [cand('1')]);

    expect(r.stop).toBeNull();
    expect(tx.penalty.create).toHaveBeenCalledTimes(1);
    const data = (tx.penalty.create.mock.calls[0] as unknown as [{ data: Record<string, unknown> }])[0].data;
    expect(data).toMatchObject({
      companyId: 'c1', storeId: 's1', userId: 'u-follow', ruleId: null, kind: 'SHORTFALL',
      units: 1, chargedUnits: 1, amount: 2, currencyCode: 'USD', status: 'PROPOSED', settlementMatchId: 'm-1',
      note: 'ORD-1 · JO-ST-1 · خصم أعطاه الموظف للزبون',
    });
    expect((data.occurredOn as Date).toISOString()).toBe('2026-10-18T00:00:00.000Z');
    expect(r.charges).toEqual([expect.objectContaining({ userId: 'u-follow', matchId: 'm-1', amount: 2, currencyCode: 'USD', orderNumber: 'ORD-1' })]);
    // …and it is written on the order too, in the approver’s name.
    const act = (tx.orderActivity.create.mock.calls[0] as unknown as [{ data: Record<string, unknown> }])[0].data;
    expect(act).toMatchObject({ orderId: 'o-1', userId: 'u-approver', action: 'SHORTFALL_PROPOSED' });
  });

  it('asks the door only for a delivered or partly delivered attempt, made BEFORE the import, newest first', async () => {
    const tx = fakeTx({ attempts: [door('1')] });
    await proposeShortfalls(tx as never, SCOPE, [cand('1')]);
    const q = (tx.deliveryAttempt.findMany.mock.calls[0] as unknown as [{ where: Record<string, any>; orderBy: unknown }])[0];
    expect(q.where.result).toEqual({ in: ['DELIVERED', 'PARTIALLY_DELIVERED'] });
    expect(q.where.createdAt).toEqual({ lt: SCOPE.statement.importedAt });
    expect(q.orderBy).toEqual({ createdAt: 'desc' });
  });

  it('the NEWEST attempt wins when an order has two', async () => {
    const tx = fakeTx({
      attempts: [door('1', 'u-second'), door('1', 'u-follow')],
      users: [FOLLOWER, { id: 'u-second', name: 'منى', role: 'FOLLOW_UP_AGENT' }],
    });
    const r = await proposeShortfalls(tx as never, SCOPE, [cand('1')]);
    expect(r.charges.map((c) => c.userId)).toEqual(['u-second']);
  });

  it('two short orders delivered on ONE day are two charges — the day rule does not apply to a line', async () => {
    const tx = fakeTx({ attempts: [door('1'), door('2')] });
    const r = await proposeShortfalls(tx as never, SCOPE, [cand('1'), cand('2')]);
    expect(r.charges).toHaveLength(2);
    expect(tx.penalty.create).toHaveBeenCalledTimes(2);
  });

  it('an order with no date of its own takes the statement’s', async () => {
    const tx = fakeTx({
      attempts: [door('1')],
      orders: [{ id: 'o-1', shippingStatus: 'DELIVERED', deliveredAt: null, moderatorId: null, confirmedById: null }],
    });
    await proposeShortfalls(tx as never, SCOPE, [cand('1')]);
    const data = (tx.penalty.create.mock.calls[0] as unknown as [{ data: Record<string, any> }])[0].data;
    expect(data.occurredOn.toISOString()).toBe('2026-10-19T00:00:00.000Z');
  });

  it('a dinar statement: 0.500 short is a charge of 0.500', async () => {
    const tx = fakeTx({ attempts: [door('1')] });
    const r = await proposeShortfalls(tx as never, { ...SCOPE, minorUnit: JOD, statement: { ...SCOPE.statement, currencyCode: 'JOD' } }, [
      cand('1', { statementAmount: 17 }),
    ]);
    expect(r.charges[0]).toMatchObject({ amount: 0.5, currencyCode: 'JOD' });
  });

  it('NEGATIVE: a line that paid more than expected creates nothing', async () => {
    const tx = fakeTx({ attempts: [door('1')] });
    const r = await proposeShortfalls(tx as never, SCOPE, [cand('1', { statementAmount: 18 })]);
    expect(r.charges).toEqual([]);
    expect(tx.penalty.create).not.toHaveBeenCalled();
  });

  it('NEGATIVE: a fee-only difference creates nothing', async () => {
    const tx = fakeTx({ attempts: [door('1')] });
    const r = await proposeShortfalls(tx as never, SCOPE, [cand('1', { statementAmount: 16.5, statementFee: 3.5 })]);
    expect(r.charges).toEqual([]);
    expect(tx.penalty.create).not.toHaveBeenCalled();
  });

  it('NEGATIVE: a parcel coming back is paid nothing because it came back — not a shortfall', async () => {
    const tx = fakeTx({
      attempts: [door('1')],
      orders: [{ id: 'o-1', shippingStatus: 'RETURN_REQUESTED', deliveredAt: null, moderatorId: null, confirmedById: null }],
    });
    const r = await proposeShortfalls(tx as never, SCOPE, [cand('1', { expectedAmount: 17.5, statementAmount: 0, statementFee: 0 })]);
    expect(r).toEqual({ charges: [], onCompany: [], stop: null });
    expect(tx.penalty.create).not.toHaveBeenCalled();
    expect(tx.deliveryAttempt.findMany).not.toHaveBeenCalled();
  });

  it('NEGATIVE: a line that already carries a live charge is never charged twice', async () => {
    const tx = fakeTx({ attempts: [door('1')], live: ['m-1'] });
    const r = await proposeShortfalls(tx as never, SCOPE, [cand('1')]);
    expect(r.charges).toEqual([]);
    expect(tx.penalty.create).not.toHaveBeenCalled();
  });

  it('NEGATIVE: the owner on the door is not charged — and the attempt before it does not take his place', async () => {
    const tx = fakeTx({
      attempts: [door('1', 'u-owner'), door('1', 'u-follow')],
      users: [FOLLOWER, { id: 'u-owner', name: 'المالك', role: 'SUPER_ADMIN' }],
      candidates: [FOLLOWER],
    });
    const r = await proposeShortfalls(tx as never, SCOPE, [cand('1')]);
    expect(r.charges).toEqual([]);
    expect(r.stop).toMatchObject({ code: 'SHORTFALL_UNNAMED' });
    expect(tx.penalty.create).not.toHaveBeenCalled();
  });

  it('NEGATIVE: a suspended employee on the door is no name either', async () => {
    const tx = fakeTx({ attempts: [door('1')], users: [] });
    const r = await proposeShortfalls(tx as never, SCOPE, [cand('1')]);
    expect(r.stop).toMatchObject({ code: 'SHORTFALL_UNNAMED' });
  });
});

describe('no door: the approver names a person per line, or says «على الشركة»', () => {
  it('without an answer the approval STOPS with the lines and the people who can be named — and writes nothing', async () => {
    const tx = fakeTx({ candidates: [FOLLOWER] });
    const r = await proposeShortfalls(tx as never, SCOPE, [cand('1'), cand('2')]);
    expect(r.stop).toEqual({
      code: 'SHORTFALL_UNNAMED',
      lines: [
        { matchId: 'm-1', orderNumber: 'ORD-1', amount: 2, currencyCode: 'USD' },
        { matchId: 'm-2', orderNumber: 'ORD-2', amount: 2, currencyCode: 'USD' },
      ],
      candidates: [FOLLOWER],
    });
    expect(tx.penalty.create).not.toHaveBeenCalled();
    expect(tx.orderActivity.create).not.toHaveBeenCalled();
  });

  it('the people offered never include the owner, the managers or the approver', async () => {
    const tx = fakeTx({ candidates: [] });
    await proposeShortfalls(tx as never, SCOPE, [cand('1')]);
    const q = (tx.user.findMany.mock.calls.at(-1) as unknown as [{ where: Record<string, any> }])[0].where;
    expect(q.role).toEqual({ notIn: ['SUPER_ADMIN', 'COMPANY_ADMIN', 'MANAGER', 'DELIVERY_MANAGER'] });
    expect(q.id).toEqual({ not: 'u-approver' });
    expect(q.status).toBe('ACTIVE');
  });

  it('a named employee is charged', async () => {
    const tx = fakeTx({});
    const r = await proposeShortfalls(tx as never, { ...SCOPE, naming: { 'm-1': 'u-follow' } }, [cand('1')]);
    expect(r.stop).toBeNull();
    expect(r.charges).toEqual([expect.objectContaining({ userId: 'u-follow', matchId: 'm-1' })]);
  });

  it('«على الشركة» charges nobody, and the order says so', async () => {
    const tx = fakeTx({});
    const r = await proposeShortfalls(tx as never, { ...SCOPE, naming: { 'm-1': ON_THE_COMPANY } }, [cand('1')]);
    expect(r.stop).toBeNull();
    expect(r.charges).toEqual([]);
    expect(r.onCompany).toEqual([{ matchId: 'm-1', orderNumber: 'ORD-1', amount: 2 }]);
    expect(tx.penalty.create).not.toHaveBeenCalled();
    expect((tx.orderActivity.create.mock.calls[0] as unknown as [{ data: Record<string, unknown> }])[0].data).toMatchObject({ action: 'SHORTFALL_ON_COMPANY', orderId: 'o-1' });
  });

  it('a line the door DID name ignores what the approver wrote for it', async () => {
    const tx = fakeTx({ attempts: [door('1')], users: [FOLLOWER, { id: 'u-other', name: 'منى', role: 'FOLLOW_UP_AGENT' }] });
    const r = await proposeShortfalls(tx as never, { ...SCOPE, naming: { 'm-1': 'u-other' } }, [cand('1')]);
    expect(r.charges.map((c) => c.userId)).toEqual(['u-follow']);
  });

  it.each([
    ['the owner', { id: 'u-owner', name: 'المالك', role: 'SUPER_ADMIN' }],
    ['a manager', { id: 'u-mgr', name: 'مدير', role: 'MANAGER' }],
    ['the approver’s own name', { id: 'u-approver', name: 'المحاسب', role: 'ACCOUNTANT' }],
    ['the order’s confirmer', { id: 'u-conf', name: 'مؤكد', role: 'CONFIRMATION_AGENT' }],
    ['the order’s moderator', { id: 'u-mod', name: 'مودريتر', role: 'MODERATOR' }],
  ])('NEGATIVE: %s cannot be named — the approval stops and nothing is written', async (_who, person) => {
    const tx = fakeTx({ users: [person] });
    const r = await proposeShortfalls(tx as never, { ...SCOPE, naming: { 'm-1': person.id } }, [cand('1')]);
    expect(r.stop).toMatchObject({ code: 'SHORTFALL_BAD_PERSON', lines: [expect.objectContaining({ matchId: 'm-1' })] });
    expect(r.charges).toEqual([]);
    expect(tx.penalty.create).not.toHaveBeenCalled();
  });

  it('NEGATIVE: someone who is not in this company (or not active) cannot be named', async () => {
    const tx = fakeTx({ users: [] });
    const r = await proposeShortfalls(tx as never, { ...SCOPE, naming: { 'm-1': 'u-ghost' } }, [cand('1')]);
    expect(r.stop).toMatchObject({ code: 'SHORTFALL_BAD_PERSON' });
    // …and the people are looked up in THIS company, active ones only.
    const where = (tx.user.findMany.mock.calls[0] as unknown as [{ where: Record<string, unknown> }])[0].where;
    expect(where).toMatchObject({ companyId: 'c1', status: 'ACTIVE' });
  });
});
