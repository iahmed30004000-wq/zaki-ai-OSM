import { beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * «طلب تبديل» AT THE APPROVAL: THE MONEY IS THE COURIER'S FIGURE, AND NOBODY CARRIES A SHORTFALL (the owner, 13/11).
 *
 * The line of his screenshot — ORD-2026-3398, a piece sent to a customer whose order came short: ours 17.00 + a fee of 3, the company's
 * line −3.00 + the same fee (it collected nothing and charged only the delivery), «difference» 20.00. Answered «اعتُمد رقم الشركة» it
 * settles the order rightly — and then asks who carries the 20: a «فرق تحصيل» on the employee at the door, or the dialog «من يتحمّل
 * الفرق؟». For a replacement nobody carries anything. These tests drive the REAL approval route and the REAL close route (and with them
 * `settleStatement` and `proposeShortfalls`) against one fake database, and hold what the exchange may and may not change:
 *
 *   · THE MONEY IS UNTOUCHED — the same fixtures run with and without the kind leave the IDENTICAL writes: the receipt's wallet entry, the
 *     order SETTLED, the amount written on it, the delivery, the stock, the customer's counters, the commission, the statement's stamps.
 *     The differences are exactly the ones the exchange is FOR: no «فرق تحصيل», no notification, no «SHORTFALL» lines on the order — and
 *     its settlement line on the timeline carries the exchange's own name;
 *   · NOBODY IS ASKED — no `SHORTFALL_UNNAMED` stop (so the dialog never lists it), no `SHORTFALL_BAD_PERSON`, whatever the approver names;
 *   · BOTH DOORS THAT CLOSE A MATCHING — the approval, and «إغلاق المطابقة» — read the qualifier (the fake world returns ONLY the columns
 *     a select asks for, so a door that forgets to select it is red here);
 *   · A MIXED STATEMENT — one exchange and one plain short line: only the plain one is asked about and charged.
 *
 * The qualifier is `resolutionKind = 'EXCHANGE'` beside `resolution = 'ACCEPTED_COURIER'` — the stored answer every money path reads.
 */

type Row = Record<string, any>;
type FakeOrder = {
  id: string; orderNumber: string; shippingStatus: string; settlementStatus: string;
  openRequest: boolean; collectedAmount: number | null; customerId: string;
  deliveredAt: Date | null; moderatorId: string | null; confirmedById: string | null;
};

const { db, requireContext, requirePermission, logAudit, recordMovement, receiptGap, markPayableForOrders, consumeOrderStock, notify, state } = vi.hoisted(() => {
  const state = {
    stamped: false,
    statement: null as Record<string, any> | null,
    orders: new Map<string, any>(),
    penalties: [] as Record<string, any>[],
    /** The door: orderId → who pressed «delivered». */
    door: new Map<string, string | null>(),
    users: [] as { id: string; name: string; role: string }[],
    /** Every write, in order — what is COMMITTED: a transaction that rolls back takes its entries with it. */
    log: [] as [string, unknown][],
  };
  const rec = (kind: string, payload: unknown) => { state.log.push([kind, structuredClone(payload)]); };

  const matchesWhere = (o: any, w: Record<string, any>): boolean => {
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

  /** What the database does with a `select`: ONLY the asked columns come back — and a column the world does not hold is an error. */
  const project = (row: Record<string, any>, select: Record<string, any>): Record<string, any> => {
    const out: Record<string, any> = {};
    for (const [k, v] of Object.entries(select)) {
      if (!v) continue;
      if (!(k in row)) throw new Error(`world: the match row has no column «${k}»`);
      out[k] = row[k];
    }
    return out;
  };
  const readStatement = (a: { select?: Record<string, any>; include?: Record<string, any> }) => {
    const s = state.statement!;
    const { matches, receipts, ...own } = s;
    const matchSelect = (a.include?.matches ?? a.select?.matches)?.select as Record<string, any> | undefined;
    const projected = matchSelect ? (matches as Record<string, any>[]).map((m) => project(m, matchSelect)) : matches;
    if (a.include) return { ...own, receipts, matches: projected };
    const out: Record<string, any> = {};
    for (const [k, v] of Object.entries(a.select ?? {})) {
      if (!v) continue;
      out[k] = k === 'matches' ? projected : (own as Record<string, any>)[k];
    }
    return out;
  };

  const db = {
    courierStatement: {
      findFirst: vi.fn(async (a: any) => (state.statement ? readStatement(a) : null)),
      updateMany: vi.fn(async ({ where, data }: any) => {
        const s = state.statement!;
        // The close's own claim: approved, matching open.
        if (where.approvedAt && typeof where.approvedAt === 'object') {
          if (!s.approvedAt || s.matchingClosedAt) return { count: 0 };
          s.matchingClosedAt = data.matchingClosedAt;
          rec('statement.close-claim', data);
          return { count: 1 };
        }
        // The approval's claim.
        if (where.approvedAt === null && 'status' in where) {
          if (state.stamped) return { count: 0 };
          state.stamped = true;
          s.approvedAt = data.approvedAt;
          rec('statement.approval-claim', data);
          return { count: 1 };
        }
        // The approval closing its own matching.
        if (where.matchingClosedAt === null) {
          if (s.matchingClosedAt) return { count: 0 };
          s.matchingClosedAt = data.matchingClosedAt;
          rec('statement.close-with-approval', data);
          return { count: 1 };
        }
        throw new Error('the fake does not know this statement write');
      }),
    },
    settlementMatch: {
      findMany: vi.fn(async (a: any) => (state.statement!.matches as Record<string, any>[]).map((m) => project(m, a.select))),
    },
    walletMovement: {
      findMany: vi.fn(async () => []),
      // approvedBeforeTheSplit: the money was posted by THIS release (a movement that names its receipt), so the close is a real close.
      count: vi.fn(async ({ where }: any) => (where.statementReceiptId === null ? 0 : 1)),
    },
    user: {
      findMany: vi.fn(async ({ where }: any) => (where.id?.in ? state.users.filter((u) => where.id.in.includes(u.id)) : state.users)),
    },
    deliveryAttempt: {
      findMany: vi.fn(async ({ where }: any) =>
        where.orderId.in.filter((id: string) => state.door.get(id)).map((orderId: string) => ({ orderId, deliveryAgentId: state.door.get(orderId) }))
      ),
    },
    penalty: {
      findMany: vi.fn(async ({ where }: any) =>
        state.penalties.filter((p) => where.settlementMatchId.in.includes(p.settlementMatchId) && ['PROPOSED', 'APPLIED'].includes(p.status))
      ),
      create: vi.fn(async ({ data }: any) => {
        if (state.penalties.some((p) => p.settlementMatchId === data.settlementMatchId && ['PROPOSED', 'APPLIED'].includes(p.status))) {
          throw new Error('unique violation: penalties_one_live_per_match');
        }
        const row = { id: `pen-${state.penalties.length + 1}`, ...data };
        state.penalties.push(row);
        rec('penalty.create', data);
        return row;
      }),
    },
    order: {
      updateMany: vi.fn(async ({ where, data }: any) => {
        const hit = [...state.orders.values()].filter((o) => matchesWhere(o, where));
        for (const o of hit) if (data.settlementStatus) o.settlementStatus = data.settlementStatus;
        rec('order.updateMany', { where, data, count: hit.length });
        return { count: hit.length };
      }),
      findMany: vi.fn(async ({ where }: any) => [...state.orders.values()].filter((o) => matchesWhere(o, where))),
      update: vi.fn(async ({ where, data }: any) => {
        const o = state.orders.get(where.id)!;
        if (data.collectedAmount !== undefined) o.collectedAmount = data.collectedAmount;
        if (data.shippingStatus) o.shippingStatus = data.shippingStatus;
        if (data.deliveredAt) o.deliveredAt = data.deliveredAt;
        rec('order.update', { where, data });
        return o;
      }),
    },
    orderActivity: { create: vi.fn(async ({ data }: any) => { rec('orderActivity.create', data); }) },
    customer: { update: vi.fn(async (a: any) => { rec('customer.update', a); }) },
    // A transaction that ROLLS BACK: the orders, the penalties and the log are what they were before it, after a throw.
    $transaction: vi.fn(async (fn: (tx: unknown) => unknown) => {
      const orders = new Map([...state.orders].map(([k, v]) => [k, { ...v }]));
      const penalties = state.penalties.map((p) => ({ ...p }));
      const log = state.log.length;
      const stamped = state.stamped;
      const s = state.statement ? { approvedAt: state.statement.approvedAt, matchingClosedAt: state.statement.matchingClosedAt } : null;
      try {
        return await fn(db);
      } catch (e) {
        state.orders = orders;
        state.penalties = penalties;
        state.log.length = log;
        state.stamped = stamped;
        if (s && state.statement) Object.assign(state.statement, s);
        throw e;
      }
    }),
  };
  return {
    db, state,
    requireContext: vi.fn(), requirePermission: vi.fn(),
    logAudit: vi.fn(async (a: unknown) => { rec('audit', a); }),
    recordMovement: vi.fn(async (_tx: unknown, a: unknown) => { rec('recordMovement', a); return { id: 'mv1' }; }),
    receiptGap: vi.fn(),
    markPayableForOrders: vi.fn(async (_tx: unknown, _c: unknown, ids: unknown) => { rec('markPayable', ids); return 0; }),
    consumeOrderStock: vi.fn(async (_tx: unknown, a: unknown) => { rec('consumeOrderStock', a); }),
    notify: vi.fn((a: unknown) => { rec('notify', a); }),
  };
});

vi.mock('@/lib/db', () => ({ db }));
vi.mock('@/lib/geo-context', () => ({ requireContext: (...a: unknown[]) => requireContext(...a) }));
vi.mock('@/lib/authorization', () => ({ requirePermission: (...a: unknown[]) => requirePermission(...a), can: () => true }));
vi.mock('@/lib/audit', () => ({ logAudit: (...a: unknown[]) => logAudit(...(a as [unknown])) }));
vi.mock('@/lib/notify', () => ({ notify: (...a: unknown[]) => notify(...(a as [unknown])) }));
vi.mock('@/lib/settlement', async (orig) => ({
  ...(await orig<typeof import('@/lib/settlement')>()),
  receiptGap: (...a: unknown[]) => receiptGap(...a),
}));
vi.mock('@/lib/wallets', async (orig) => ({
  ...(await orig<typeof import('@/lib/wallets')>()),
  recordMovement: (...a: unknown[]) => recordMovement(...(a as [unknown, unknown])),
}));
vi.mock('@/lib/commission', async (orig) => ({
  ...(await orig<typeof import('@/lib/commission')>()),
  markPayableForOrders: (...a: unknown[]) => markPayableForOrders(...(a as [unknown, unknown, unknown])),
}));
vi.mock('@/lib/stock-consumption', () => ({ consumeOrderStock: (...a: unknown[]) => consumeOrderStock(...(a as [unknown, unknown])) }));

import { PATCH } from './[id]/route';
import { POST as closeMatching } from './[id]/close/route';
import { closeRowsSelect } from '@/lib/statement-close';
import { EXCHANGE_APPLIED_ACTION } from '@/lib/settlement-difference';

const ID = '88888888-8888-4888-8888-888888888888';
const M1 = '11111111-1111-4111-8111-111111111111';
const M2 = '22222222-2222-4222-8222-222222222222';
const U_NAMED = '33333333-3333-4333-8333-333333333333';
const U_OWNER = '44444444-4444-4444-8444-444444444444';

const approve = (body: Record<string, unknown> = {}) =>
  PATCH(
    new Request('http://localhost/x', { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ approve: true, ...body }) }),
    { params: Promise.resolve({ id: ID }) }
  );
const closeIt = (body: Record<string, unknown> = {}) =>
  closeMatching(new Request('http://localhost/x', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }), {
    params: Promise.resolve({ id: ID }),
  });

const order = (id: string, over: Partial<FakeOrder> = {}): FakeOrder => ({
  id, orderNumber: `ORD-${id}`, shippingStatus: 'DELIVERED', settlementStatus: 'PENDING_COLLECTION',
  openRequest: false, collectedAmount: null, customerId: `cu-${id}`,
  deliveredAt: new Date('2026-10-18T09:00:00Z'), moderatorId: 'u-mod', confirmedById: 'u-conf', ...over,
});

/** THE LINE OF THE SCREENSHOT: ours 17.00 + fee 3, theirs −3.00 + fee 3 — the company collected nothing and charged only the delivery. */
const SCREENSHOT = { expectedAmount: 17, expectedFee: 3, statementAmount: -3, statementFee: 3 };
/** The dollar example of the shortfall work: ours 17.50 + 2.50, theirs 15.50 + 2.50 — short by 2.00. */
const DOLLARS = { expectedAmount: 17.5, expectedFee: 2.5, statementAmount: 15.5, statementFee: 2.5 };

/** A match row carries EVERY column the close may select — and the fake returns only what is asked. */
const row = (orderId: string, over: Row = {}): Row => ({
  id: `m-${orderId}`, orderId, result: 'MISMATCHED', resolution: null, resolutionKind: null, resolutionNote: null, resolvedById: null, appliedAt: null,
  ...DOLLARS, order: { orderNumber: `ORD-${orderId}`, settlementMatches: [] }, ...over,
});
const accepted = (orderId: string, over: Row = {}): Row =>
  row(orderId, { resolution: 'ACCEPTED_COURIER', resolutionNote: 'خصم أعطاه الموظف للزبون', resolvedById: 'u-decider', ...over });
/** The same answer, as an exchange. */
const exchangeRow = (orderId: string, over: Row = {}): Row =>
  accepted(orderId, { resolutionKind: 'EXCHANGE', resolutionNote: 'تبديل حبة ناقصة بعتناها للزبون', ...over });

const statementOf = (matches: Row[], over: Row = {}) => ({
  id: ID, status: 'MATCHED', reference: 'ST-1', currencyCode: 'USD', gapExplanation: null, approvedAt: null, matchingClosedAt: null,
  createdAt: new Date('2026-10-20T10:00:00Z'), periodTo: new Date('2026-10-20T00:00:00Z'),
  fileHash: 'ab'.repeat(32), receipts: [{ id: 'r1', walletId: 'w-usd', amount: 15.5 }], matches, ...over,
});

const FOLLOWER = { id: 'u-door', name: 'سارة', role: 'FOLLOW_UP_AGENT' };
const putOrders = (...os: FakeOrder[]) => { for (const o of os) state.orders.set(o.id, o); };
const settled = () => [...state.orders.values()].filter((o) => o.settlementStatus === 'SETTLED').map((o) => o.id).sort();
const logged = (kind: string) => state.log.filter(([k]) => k === kind).map(([, p]) => p as Row);
const activities = (action: string) => logged('orderActivity.create').filter((d) => d.action === action);

beforeEach(() => {
  vi.clearAllMocks();
  state.stamped = false;
  state.statement = null;
  state.orders = new Map();
  state.penalties = [];
  state.door = new Map();
  state.users = [FOLLOWER];
  state.log = [];
  requireContext.mockResolvedValue({ user: { id: 'u-approver', name: 'المحاسب' }, companyId: 'c1', storeId: 's1', country: { minorUnit: 2, currencyCode: 'USD' } });
  requirePermission.mockResolvedValue({});
  receiptGap.mockResolvedValue({ claimed: 15.5, received: 15.5, gap: 0, needsExplanation: false, explained: false, unconvertible: 0 });
});

describe('the line of the owner’s screenshot', () => {
  it('as an exchange: settled at the company’s figure, the receipt moves as it always does — and NOBODY is charged, asked or told', async () => {
    putOrders(order('o1'));
    state.door.set('o1', 'u-door');
    state.statement = statementOf([exchangeRow('o1', { ...SCREENSHOT })], { receipts: [{ id: 'r1', walletId: 'w-usd', amount: -3 }] });

    const res = await approve();

    expect(res.status).toBe(200);
    expect(settled()).toEqual(['o1']);
    // What the customer paid at the door: the company's net −3.00 plus the fee it kept, 3.00 — nothing.
    expect(state.orders.get('o1')!.collectedAmount).toBe(0);
    expect(recordMovement).toHaveBeenCalledTimes(1);
    expect(recordMovement.mock.calls[0][1]).toMatchObject({ direction: 'IN', category: 'COURIER_SETTLEMENT', referenceType: 'STATEMENT', statementReceiptId: 'r1' });
    expect(markPayableForOrders).toHaveBeenCalledTimes(1);
    expect(markPayableForOrders.mock.calls[0][2]).toEqual(['o1']);

    // Nobody carries the 20.
    expect(state.penalties).toEqual([]);
    expect(db.penalty.create).not.toHaveBeenCalled();
    expect(notify).not.toHaveBeenCalled();
    expect(activities('SHORTFALL_PROPOSED')).toEqual([]);
    expect(activities('SHORTFALL_ON_COMPANY')).toEqual([]);
    const audit = logged('audit').find((a) => a.action === 'STATEMENT_APPROVED')!;
    expect(audit.newData).toMatchObject({ settled: 1, acceptedByDecision: 1, shortfalls: [], shortfallsOnCompany: 0 });
  });

  it('the SAME line answered plainly charges 20 to the employee at the door — so it is the exchange that removed it (the fixture bites)', async () => {
    putOrders(order('o1'));
    state.door.set('o1', 'u-door');
    state.statement = statementOf([accepted('o1', { ...SCREENSHOT })], { receipts: [{ id: 'r1', walletId: 'w-usd', amount: -3 }] });

    expect((await approve()).status).toBe(200);
    expect(state.penalties).toHaveLength(1);
    expect(state.penalties[0]).toMatchObject({ userId: 'u-door', kind: 'SHORTFALL', status: 'PROPOSED', amount: 20, settlementMatchId: 'm-o1' });
    expect(notify).toHaveBeenCalledTimes(1);
  });

  it('with no door on the parcel the plain line stops the approval to ask — and the exchange goes straight through', async () => {
    putOrders(order('o1'));
    state.statement = statementOf([accepted('o1', { id: M1, ...SCREENSHOT })]);
    const asked = await approve();
    expect(asked.status).toBe(409);
    const body = await asked.json();
    expect(body.code).toBe('SHORTFALL_UNNAMED');
    expect(body.lines).toEqual([{ matchId: M1, orderNumber: 'ORD-o1', amount: 20, currencyCode: 'USD' }]);
    expect(settled()).toEqual([]);

    state.stamped = false;
    state.log = [];
    state.statement = statementOf([exchangeRow('o1', { id: M1, ...SCREENSHOT })]);
    const through = await approve();
    expect(through.status).toBe(200);
    expect(settled()).toEqual(['o1']);
    expect(state.penalties).toEqual([]);
  });
});

describe('DIFFERENTIAL: the same fixtures with and without the kind leave the identical writes — but for what the exchange is for', () => {
  type Scenario = {
    name: string;
    orders: FakeOrder[];
    door?: [string, string][];
    figures: Row;
    /** Extra on the match row. */
    row?: Row;
    statement?: Row;
    people?: Record<string, string>;
    minor?: number;
    /** What the PLAIN answer writes for the shortfall (so the scenario is known to be a real one), and what the exchange must not. */
    plainCharges: number;
    /** How many lines the PLAIN answer leaves «على الشركة» (a line on the order) — the exchange leaves none. */
    plainOnCompany?: number;
    plainAsks?: boolean;
  };

  const SCENARIOS: Scenario[] = [
    { name: 'a short line, an employee at the door (the screenshot)', orders: [order('o1')], door: [['o1', 'u-door']], figures: SCREENSHOT, plainCharges: 1 },
    { name: 'a short line, an employee at the door (the dollar example)', orders: [order('o1')], door: [['o1', 'u-door']], figures: DOLLARS, plainCharges: 1 },
    { name: 'a short line, nobody at the door, the approver names a person', orders: [order('o1')], figures: SCREENSHOT, row: { id: M1 }, people: { [M1]: U_NAMED }, plainCharges: 1 },
    { name: 'a short line, nobody at the door, the approver says «على الشركة»', orders: [order('o1')], figures: SCREENSHOT, row: { id: M1 }, people: { [M1]: 'COMPANY' }, plainCharges: 0, plainOnCompany: 1 },
    { name: 'a short line, nobody at the door, nobody named — the plain one asks', orders: [order('o1')], figures: SCREENSHOT, plainCharges: 0, plainAsks: true },
    { name: 'a line that paid exactly what we expected', orders: [order('o1')], door: [['o1', 'u-door']], figures: { ...DOLLARS, statementAmount: 17.5 }, plainCharges: 0 },
    { name: 'a line that paid MORE than we expected', orders: [order('o1')], door: [['o1', 'u-door']], figures: { ...DOLLARS, statementAmount: 18.5 }, plainCharges: 0 },
    { name: 'a parcel still on the road — the statement is its first proof of delivery', orders: [order('o1', { shippingStatus: 'SHIPPED', deliveredAt: null })], figures: DOLLARS, plainCharges: 0, plainAsks: true },
    { name: 'a parcel delivered by hand, with no amount yet, and a door person', orders: [order('o1')], door: [['o1', 'u-door']], figures: SCREENSHOT, plainCharges: 1 },
    {
      name: 'a dinar statement: three places',
      orders: [order('o1')], door: [['o1', 'u-door']], figures: { expectedAmount: 20, expectedFee: 0, statementAmount: 19.5, statementFee: 0 },
      statement: { currencyCode: 'JOD' }, minor: 3, plainCharges: 1,
    },
    {
      name: 'a payment on an earlier claim («رقمنا» on an older statement)',
      orders: [order('o1')], door: [['o1', 'u-door']], figures: { expectedAmount: 2, expectedFee: 2.5, statementAmount: 1.5, statementFee: 3.5 },
      row: { order: { orderNumber: 'ORD-o1', settlementMatches: [{ statementAmount: 15.5, statementFee: 2.5 }] } }, plainCharges: 1,
    },
  ];

  /** What a run COMMITTED, with the volatile parts (times, the rows' own ids in the audit) made comparable. */
  const normalised = (log: [string, unknown][]) =>
    // (`JSON.stringify` turns a Date into text BEFORE a replacer sees it, so the replacer asks the holder for the value itself.)
    JSON.parse(JSON.stringify(log, function (this: Record<string, unknown>, k: string, v: unknown) { return this[k] instanceof Date ? '<date>' : v; })) as [string, Row][];

  const SHORTFALL_ARTEFACTS = (e: [string, Row]) =>
    e[0] === 'penalty.create' || e[0] === 'notify' ||
    (e[0] === 'orderActivity.create' && ['SHORTFALL_PROPOSED', 'SHORTFALL_ON_COMPANY'].includes(e[1].action));

  const run = async (s: Scenario, makeRow: (id: string, over: Row) => Row) => {
    state.stamped = false;
    state.orders = new Map();
    state.penalties = [];
    state.door = new Map(s.door ?? []);
    state.users = [FOLLOWER, { id: U_NAMED, name: 'منى', role: 'FOLLOW_UP_AGENT' }];
    state.log = [];
    vi.clearAllMocks();
    requireContext.mockResolvedValue({
      user: { id: 'u-approver', name: 'المحاسب' }, companyId: 'c1', storeId: 's1', country: { minorUnit: s.minor ?? 2, currencyCode: 'USD' },
    });
    requirePermission.mockResolvedValue({});
    receiptGap.mockResolvedValue({ claimed: 15.5, received: 15.5, gap: 0, needsExplanation: false, explained: false, unconvertible: 0 });
    putOrders(...s.orders.map((o) => ({ ...o })));
    state.statement = statementOf([makeRow('o1', { ...s.figures, ...(s.row ?? {}) })], s.statement ?? {});
    const res = await approve(s.people ? { shortfallPeople: s.people } : {});
    return { status: res.status, body: await res.json(), log: normalised(state.log), penalties: state.penalties.length };
  };

  it.each(SCENARIOS)('$name', async (s) => {
    const plain = await run(s, (id, over) => accepted(id, over));
    const exch = await run(s, (id, over) => exchangeRow(id, { resolutionNote: accepted(id).resolutionNote, ...over }));

    // THE PLAIN RUN IS A REAL ONE: it either charges (or names the line on the company) or stops to ask — that is what the exchange removes.
    if (s.plainAsks) {
      expect(plain.status, `${s.name}: the plain line asks`).toBe(409);
      expect(plain.body.code).toBe('SHORTFALL_UNNAMED');
      // The exchange is NOT asked about: it goes through, and the approval's money is written.
      expect(exch.status).toBe(200);
      expect(exch.log.some(([k]) => k === 'recordMovement')).toBe(true);
      expect(exch.log.some(SHORTFALL_ARTEFACTS)).toBe(false);
      return;
    }
    expect(plain.status).toBe(200);
    expect(exch.status).toBe(200);
    expect(plain.penalties, s.name).toBe(s.plainCharges);

    // THE EXCHANGE writes none of the shortfall's artefacts …
    expect(exch.penalties).toBe(0);
    expect(exch.log.filter(SHORTFALL_ARTEFACTS)).toEqual([]);
    // … and the plain run wrote exactly those that the shortfall writes (a charge, its line on the order, its notification).
    const removed = plain.log.filter(SHORTFALL_ARTEFACTS);
    expect(removed.filter(([k]) => k === 'penalty.create')).toHaveLength(s.plainCharges);
    expect(removed.filter(([k, p]) => k === 'orderActivity.create' && p.action === 'SHORTFALL_ON_COMPANY')).toHaveLength(s.plainOnCompany ?? 0);
    // (A line that was NOT short has no shortfall to remove: for it the two runs differ by the timeline's sentence alone.)
    if (s.plainCharges > 0 || (s.plainOnCompany ?? 0) > 0) expect(removed.length, `${s.name}: the plain run writes something for the shortfall`).toBeGreaterThan(0);
    else expect(removed, `${s.name}: nothing was short`).toEqual([]);

    // EVERYTHING ELSE IS IDENTICAL, write for write, in the same order: the money, the order, the delivery, the stock, the customer, the stamps.
    const keep = (log: [string, Row][]) =>
      log
        .filter((e) => !SHORTFALL_ARTEFACTS(e))
        .map(([k, p]): [string, Row] => {
          // The one line that is allowed to read differently: the settlement's own sentence on the timeline.
          if (k === 'orderActivity.create' && p.action === EXCHANGE_APPLIED_ACTION) {
            const meta = JSON.parse(String(p.metadata));
            delete meta.kind;
            return [k, { ...p, action: 'SETTLEMENT_DECISION_APPLIED', metadata: JSON.stringify(meta) }];
          }
          // The approval's own audit row names the charges it proposed: the exchange proposed none.
          if (k === 'audit' && p.action === 'STATEMENT_APPROVED') {
            const rest = { ...p.newData };
            delete rest.shortfalls;
            delete rest.shortfallsOnCompany;
            return [k, { ...p, newData: rest }];
          }
          return [k, p];
        });
    expect(keep(exch.log)).toEqual(keep(plain.log));

    // And the money lines are really there to be compared (a differential over empty logs proves nothing).
    const kinds = new Set(exch.log.map(([k]) => k));
    for (const must of ['recordMovement', 'order.updateMany', 'markPayable', 'statement.approval-claim', 'statement.close-with-approval', 'audit']) {
      expect(kinds.has(must), `${s.name}: ${must}`).toBe(true);
    }
  });

  it('the settlement line on the order’s timeline carries the exchange’s own name — and the plain one keeps the name it always had', async () => {
    const s = SCENARIOS[1];
    const plain = await run(s, (id, over) => accepted(id, over));
    const exch = await run(s, (id, over) => exchangeRow(id, { resolutionNote: accepted(id).resolutionNote, ...over }));
    expect(plain.log.filter(([k, p]) => k === 'orderActivity.create' && p.action === 'SETTLEMENT_DECISION_APPLIED')).toHaveLength(1);
    expect(plain.log.some(([, p]) => p.action === EXCHANGE_APPLIED_ACTION)).toBe(false);
    const line = exch.log.filter(([k, p]) => k === 'orderActivity.create' && p.action === EXCHANGE_APPLIED_ACTION);
    expect(line).toHaveLength(1);
    expect(exch.log.some(([, p]) => p.action === 'SETTLEMENT_DECISION_APPLIED')).toBe(false);
    // Its metadata is the plain one’s, plus the kind: the money recorded on it is the same figure.
    const plainMeta = JSON.parse(String(plain.log.find(([k, p]) => k === 'orderActivity.create' && p.action === 'SETTLEMENT_DECISION_APPLIED')![1].metadata));
    expect(JSON.parse(String(line[0][1].metadata))).toEqual({ ...plainMeta, kind: 'EXCHANGE' });
    // Key order of the plain one is what it always was (a reader that parses it by position would not notice a new key).
    expect(Object.keys(plainMeta)).toEqual(['statement', 'decision', 'explanation', 'decidedBy', 'collected']);
  });
});

describe('nobody is asked — the dialog «من يتحمّل الفرق؟» never lists an exchange', () => {
  it('one exchange and one plain short line, nobody at the door: the stop names ONLY the plain one', async () => {
    putOrders(order('o1'), order('o2'));
    state.statement = statementOf(
      [exchangeRow('o1', { id: M1, ...SCREENSHOT }), accepted('o2', { id: M2, ...DOLLARS })],
      { receipts: [{ id: 'r1', walletId: 'w-usd', amount: 12.5 }] }
    );

    const res = await approve();
    const body = await res.json();

    expect(res.status).toBe(409);
    expect(body.code).toBe('SHORTFALL_UNNAMED');
    expect(body.lines).toEqual([{ matchId: M2, orderNumber: 'ORD-o2', amount: 2, currencyCode: 'USD' }]);
    expect(body.error).toContain('ORD-o2');
    expect(body.error).not.toContain('ORD-o1');
    // The stop rolled everything back — the exchange's order too.
    expect(settled()).toEqual([]);
    expect(state.log.filter(([k]) => k === 'recordMovement')).toEqual([]);
  });

  it('…and once the approver names the plain one, the exchange is settled with it and only the plain one is charged', async () => {
    putOrders(order('o1'), order('o2'));
    state.statement = statementOf(
      [exchangeRow('o1', { id: M1, ...SCREENSHOT }), accepted('o2', { id: M2, ...DOLLARS })],
      { receipts: [{ id: 'r1', walletId: 'w-usd', amount: 12.5 }] }
    );
    state.users = [FOLLOWER, { id: U_NAMED, name: 'منى', role: 'FOLLOW_UP_AGENT' }];

    const res = await approve({ shortfallPeople: { [M2]: U_NAMED } });

    expect(res.status).toBe(200);
    expect(settled()).toEqual(['o1', 'o2']);
    expect(state.penalties).toHaveLength(1);
    expect(state.penalties[0]).toMatchObject({ settlementMatchId: M2, userId: U_NAMED, amount: 2 });
    expect(state.penalties.some((p) => p.settlementMatchId === M1)).toBe(false);
  });

  it('naming a person for the exchange (a stale screen, a hand-made request) charges nobody — it is not a candidate, so the name is never read', async () => {
    putOrders(order('o1'));
    state.statement = statementOf([exchangeRow('o1', { id: M1, ...SCREENSHOT })]);
    state.users = [FOLLOWER, { id: U_NAMED, name: 'منى', role: 'FOLLOW_UP_AGENT' }];
    const res = await approve({ shortfallPeople: { [M1]: U_NAMED } });
    expect(res.status).toBe(200);
    expect(state.penalties).toEqual([]);
    expect(notify).not.toHaveBeenCalled();
  });

  it('naming the OWNER for it (which would be refused for a plain line) is not a stop either — and «على الشركة» writes no line', async () => {
    putOrders(order('o1'));
    state.users = [{ id: U_OWNER, name: 'المالك', role: 'SUPER_ADMIN' }];
    state.statement = statementOf([exchangeRow('o1', { id: M1, ...SCREENSHOT })]);
    expect((await approve({ shortfallPeople: { [M1]: U_OWNER } })).status).toBe(200);

    state.stamped = false;
    state.orders = new Map();
    state.log = [];
    putOrders(order('o1'));
    state.statement = statementOf([exchangeRow('o1', { id: M1, ...SCREENSHOT })]);
    expect((await approve({ shortfallPeople: { [M1]: 'COMPANY' } })).status).toBe(200);
    expect(activities('SHORTFALL_ON_COMPANY')).toEqual([]);
    expect(logged('audit').find((a) => a.action === 'STATEMENT_APPROVED')!.newData.shortfallsOnCompany).toBe(0);
  });

  it('a kind standing beside ANY OTHER answer is read as nothing: «رقمنا» and «قيد المراجعة» never settle, and an unanswered row is not settled either', async () => {
    putOrders(order('o1'), order('o2'));
    state.door.set('o1', 'u-door');
    state.statement = statementOf(
      [
        row('o1', { resolution: 'OURS_STANDS', resolutionKind: 'EXCHANGE', resolutionNote: 'نطالب بالفرق' }),
        row('o2', { resolution: 'UNDER_REVIEW', resolutionKind: 'EXCHANGE', resolutionNote: 'ننتظر الشركة' }),
      ],
      { receipts: [{ id: 'r1', walletId: 'w-usd', amount: 12.5 }] }
    );
    expect((await approve()).status).toBe(200);
    expect(settled()).toEqual([]);
    expect(state.penalties).toEqual([]);
    // The claim is opened exactly as for any «رقمنا».
    expect(activities('SETTLEMENT_CLAIM_OPENED')).toHaveLength(1);
    expect(activities(EXCHANGE_APPLIED_ACTION)).toEqual([]);
  });

  it('a row that CARRIES the kind but whose order the statement never proved (not an accepted row at all) writes no exchange line', async () => {
    putOrders(order('o1'));
    state.statement = statementOf([row('o1', { result: 'MATCHED', ...{ expectedAmount: 17.5, statementAmount: 17.5 }, resolutionKind: 'EXCHANGE' })]);
    expect((await approve()).status).toBe(200);
    expect(settled()).toEqual(['o1']);
    expect(activities(EXCHANGE_APPLIED_ACTION)).toEqual([]);
    expect(activities('SETTLEMENT_DECISION_APPLIED')).toEqual([]);
  });
});

describe('the order may not be what it was — an exchange stops the approval exactly as the plain answer does', () => {
  it('an order settled meanwhile (by hand, or by another statement): «تغيّر وضع طلب», and nothing is written — penalty included', async () => {
    putOrders(order('o1', { settlementStatus: 'SETTLED' }));
    state.door.set('o1', 'u-door');
    for (const make of [accepted, exchangeRow]) {
      state.stamped = false;
      state.log = [];
      state.statement = statementOf([make('o1', { ...SCREENSHOT })]);
      const res = await approve();
      expect(res.status).toBe(409);
      expect((await res.json()).code).toBe('ORDERS_CHANGED');
      expect(state.penalties).toEqual([]);
      expect(state.log).toEqual([]);
    }
  });

  it('a cancel asked for since the answer, and a parcel recorded as not sent: the same stop', async () => {
    for (const over of [{ openRequest: true }, { shippingStatus: 'CANCELLED' }, { shippingStatus: 'PACKING' }]) {
      putOrders(order('o1', over));
      for (const make of [accepted, exchangeRow]) {
        state.stamped = false;
        state.log = [];
        state.statement = statementOf([make('o1', { ...SCREENSHOT })]);
        const res = await approve();
        expect(res.status, JSON.stringify(over)).toBe(409);
        expect((await res.json()).code).toBe('ORDERS_CHANGED');
        expect(state.log).toEqual([]);
      }
    }
  });

  it('a decision with no reason stops it too — the exchange needs its explanation like any other answer', async () => {
    putOrders(order('o1'));
    state.statement = statementOf([exchangeRow('o1', { ...SCREENSHOT, resolutionNote: 'خصم' })]);
    const res = await approve();
    expect(res.status).toBe(409);
    expect((await res.json()).code).toBe('DECISION_WITHOUT_REASON');
    expect(state.log).toEqual([]);
  });

  it('the second statement for the same order: it is settled already, so its line is refused at the approval, as for any accepted line', async () => {
    // Statement 1 settled the order as an exchange; statement 2 names it again and answers it «اعتُمد رقم الشركة» (an old row), or as an exchange.
    putOrders(order('o1'));
    state.statement = statementOf([exchangeRow('o1', { ...SCREENSHOT })]);
    expect((await approve()).status).toBe(200);
    expect(settled()).toEqual(['o1']);

    for (const make of [accepted, exchangeRow]) {
      state.stamped = false;
      state.log = [];
      state.statement = statementOf([make('o1', { id: 'm-second', ...SCREENSHOT })]);
      const res = await approve();
      expect(res.status).toBe(409);
      expect((await res.json()).code).toBe('ORDERS_CHANGED');
      expect(state.penalties).toEqual([]);
    }
  });
});

describe('«إغلاق المطابقة» — the other door that closes a matching — reads the qualifier too', () => {
  /** A statement whose money was posted and whose matching is open: only the close is left to do. */
  const approvedOpen = (matches: Row[], over: Row = {}) =>
    statementOf(matches, { status: 'APPROVED', approvedAt: new Date('2026-11-12T10:00:00Z'), matchingClosedAt: null, ...over });

  it('an exchange line: the orders are settled, nobody is charged, no question — and the money is not written a second time', async () => {
    putOrders(order('o1'));
    state.door.set('o1', 'u-door');
    state.statement = approvedOpen([exchangeRow('o1', { ...SCREENSHOT })]);

    const res = await closeIt();

    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ matchingClosed: true, settledOrders: 1 });
    expect(settled()).toEqual(['o1']);
    expect(state.orders.get('o1')!.collectedAmount).toBe(0);
    expect(state.penalties).toEqual([]);
    expect(notify).not.toHaveBeenCalled();
    expect(recordMovement).not.toHaveBeenCalled();
    expect(activities(EXCHANGE_APPLIED_ACTION)).toHaveLength(1);
  });

  it('the plain line at the same door DOES charge (so the door is a real one), and a line nobody can name stops it with the question', async () => {
    putOrders(order('o1'));
    state.door.set('o1', 'u-door');
    state.statement = approvedOpen([accepted('o1', { ...SCREENSHOT })]);
    expect((await closeIt()).status).toBe(200);
    expect(state.penalties).toHaveLength(1);
    expect(state.penalties[0]).toMatchObject({ amount: 20, settlementMatchId: 'm-o1' });

    state.orders = new Map();
    state.penalties = [];
    putOrders(order('o2'));
    state.statement = approvedOpen([accepted('o2', { id: M2, ...SCREENSHOT })]);
    const res = await closeIt();
    expect(res.status).toBe(409);
    expect((await res.json()).code).toBe('SHORTFALL_UNNAMED');
  });

  it('a mixed statement at this door: only the plain line is asked about', async () => {
    putOrders(order('o1'), order('o2'));
    state.statement = approvedOpen([exchangeRow('o1', { id: M1, ...SCREENSHOT }), accepted('o2', { id: M2, ...DOLLARS })]);
    const res = await closeIt();
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.lines.map((l: { matchId: string }) => l.matchId)).toEqual([M2]);
    expect(settled()).toEqual([]);
  });
});

describe('the close reads the qualifier from the database — the fake world returns only what a select asks for', () => {
  it('`closeRowsSelect` asks for it, and the rows the world hands back carry it', () => {
    expect(closeRowsSelect('st').resolutionKind).toBe(true);
    // The qualifier travels beside the answer, not instead of it.
    expect(closeRowsSelect('st').resolution).toBe(true);
  });

  it('both doors that close a matching read the rows through that select — so a door that forgot the column would charge the exchange, and the first tests above would be red', () => {
    for (const door of ['src/app/api/finance/statements/[id]/route.ts', 'src/app/api/finance/statements/[id]/close/route.ts']) {
      expect(readFileSync(join(process.cwd(), door), 'utf8'), door).toMatch(/closeRowsSelect\(id\)/);
    }
  });
});
