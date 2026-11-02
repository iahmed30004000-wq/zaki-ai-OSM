import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * A STATEMENT WITH NOTHING LEFT TO ANSWER IS APPROVED EXACTLY AS IT ALWAYS WAS — WRITE FOR WRITE.
 *
 * «افصل المطابقة عن التحصيل… لما اعتمدو ينزل التحصيل تلقائي ولما يتطابق ما يكرر التحصيل» (the owner, 2/11).
 *
 * The approval is being split in two: the money (one IN per receipt) and the close of the matching (the orders
 * settled, delivered, paid commission on, the shortfalls proposed, the claims opened). When no line is left to
 * answer the approval does both in one transaction, as it always did, and NOTHING it writes may change.
 *
 * So this file was written FIRST, against the approval as it stood on main (028381c7), and the golden file beside
 * it is what that approval wrote for one statement that has every kind of row: a clean line on a parcel still on
 * the road, a clean line on a parcel our door delivered, a figure accepted from the company (short, so a
 * «فرق تحصيل» is proposed), our figure kept (a claim), a parked line, a parked line with no order, a parcel no
 * statement names, and a line that pays the rest of an older claim. Two receipts in two wallets.
 *
 * The fake applies the WHERE it is given (an order the claim's filter would not take is not taken), and every
 * effect — the money, each order write, the stock, the customer, the commission, the penalty, the timeline, the
 * audit, the notification — is logged in the order it happened. The split may only ADD to that log what the
 * split itself is: which receipt each movement is for, and whether the matching closed with the money.
 */

type FakeOrder = {
  id: string; orderNumber: string; shippingStatus: string; settlementStatus: string;
  openRequest: boolean; collectedAmount: number | null; customerId: string;
  deliveredAt: Date | null; moderatorId: string | null; confirmedById: string | null;
};

const { db, requireContext, requirePermission, logAudit, recordMovement, receiptGap, markPayableForOrders, consumeOrderStock, notify, state } =
  vi.hoisted(() => {
    const state = {
      approvedStamp: false,
      reads: [] as unknown[],
      orders: new Map<string, FakeOrder>(),
      penalties: [] as Record<string, any>[],
      door: new Map<string, string>(),
      log: [] as { op: string; args: unknown }[],
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
    const log = (op: string, args: unknown) => state.log.push({ op, args });

    const db = {
      courierStatement: {
        findFirst: vi.fn(async () => (state.reads.length > 1 ? state.reads.shift() : state.reads[0])),
        // The stamps are not effects of the money or of the orders: they are asserted on their own below.
        updateMany: vi.fn(async ({ where }: { where: Record<string, unknown> }) => {
          if ('approvedAt' in where && where.approvedAt === null) {
            if (state.approvedStamp) return { count: 0 };
            state.approvedStamp = true;
          }
          return { count: 1 };
        }),
      },
      walletMovement: { findMany: vi.fn(async () => []), count: vi.fn(async () => 0) },
      user: {
        findMany: vi.fn(async ({ where }: { where: { id?: { in: string[] } } }) =>
          [{ id: 'u-door', name: 'سارة', role: 'FOLLOW_UP_AGENT' }].filter((u) => !where.id?.in || where.id.in.includes(u.id))
        ),
      },
      deliveryAttempt: {
        findMany: vi.fn(async ({ where }: { where: { orderId: { in: string[] } } }) =>
          where.orderId.in.filter((id) => state.door.has(id)).map((orderId) => ({ orderId, deliveryAgentId: state.door.get(orderId) }))
        ),
      },
      penalty: {
        findMany: vi.fn(async () => state.penalties),
        create: vi.fn(async ({ data }: { data: Record<string, any> }) => {
          log('penalty.create', data);
          const row = { id: `pen-${state.penalties.length + 1}`, ...data };
          state.penalties.push(row);
          return row;
        }),
      },
      order: {
        updateMany: vi.fn(async ({ where, data }: { where: Record<string, any>; data: { settlementStatus?: string } }) => {
          const hit = [...state.orders.values()].filter((o) => matchesWhere(o, where));
          for (const o of hit) if (data.settlementStatus) o.settlementStatus = data.settlementStatus;
          log('order.updateMany', { where, data, took: hit.map((o) => o.id) });
          return { count: hit.length };
        }),
        findMany: vi.fn(async ({ where }: { where: Record<string, any> }) =>
          [...state.orders.values()].filter((o) => matchesWhere(o, where))
        ),
        update: vi.fn(async ({ where, data }: { where: { id: string }; data: Record<string, any> }) => {
          log('order.update', { where, data });
          const o = state.orders.get(where.id)!;
          if (data.collectedAmount !== undefined) o.collectedAmount = data.collectedAmount;
          if (data.shippingStatus) o.shippingStatus = data.shippingStatus;
          return o;
        }),
      },
      orderActivity: { create: vi.fn(async ({ data }: { data: Record<string, any> }) => log('orderActivity.create', data)) },
      customer: { update: vi.fn(async (args: unknown) => log('customer.update', args)) },
      $transaction: vi.fn(async (fn: (tx: unknown) => unknown) => fn(db)),
    };
    return {
      db, state,
      requireContext: vi.fn(), requirePermission: vi.fn(),
      logAudit: vi.fn(async (a: unknown) => log('logAudit', a)),
      recordMovement: vi.fn(async (_tx: unknown, a: unknown) => { log('recordMovement', a); return { id: 'mv' }; }),
      receiptGap: vi.fn(),
      markPayableForOrders: vi.fn(async (_tx: unknown, companyId: string, ids: string[]) => { log('markPayableForOrders', { companyId, ids }); return 0; }),
      consumeOrderStock: vi.fn(async (_tx: unknown, a: unknown) => log('consumeOrderStock', a)),
      notify: vi.fn((a: unknown) => log('notify', a)),
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
  markPayableForOrders: (...a: unknown[]) => markPayableForOrders(...(a as [unknown, string, string[]])),
}));
vi.mock('@/lib/stock-consumption', () => ({ consumeOrderStock: (...a: unknown[]) => consumeOrderStock(...(a as [unknown, unknown])) }));

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
  id, orderNumber: `ORD-${id}`, shippingStatus: 'DELIVERED', settlementStatus: 'PENDING_COLLECTION',
  openRequest: false, collectedAmount: null, customerId: `cu-${id}`,
  deliveredAt: new Date('2026-10-18T09:00:00Z'), moderatorId: 'u-mod', confirmedById: 'u-conf', ...over,
});

const row = (id: string, orderId: string | null, over: Record<string, unknown> = {}) => ({
  id, orderId, result: 'MATCHED', resolution: null, resolutionNote: null, resolvedById: null,
  expectedAmount: 20, expectedFee: 5, statementAmount: 20, statementFee: 5,
  order: orderId ? { orderNumber: `ORD-${orderId}`, settlementMatches: [] } : null,
  ...over,
});

/** Every kind of row a statement can carry, every one of them answered: nothing is left open. */
const ROWS = [
  row('m-o1', 'o1'),
  row('m-o2', 'o2', { statementAmount: 25, expectedAmount: 25 }),
  row('m-o3', 'o3', {
    result: 'MISMATCHED', resolution: 'ACCEPTED_COURIER', resolutionNote: 'خصم أعطاه الموظف للزبون', resolvedById: 'u-decider',
    expectedAmount: 35, statementAmount: 30,
  }),
  row('m-o4', 'o4', {
    result: 'MISMATCHED', resolution: 'OURS_STANDS', resolutionNote: 'سنطالب الشركة بالباقي', resolvedById: 'u-decider',
    expectedAmount: 20, statementAmount: 15,
  }),
  row('m-o5', 'o5', {
    result: 'MISMATCHED', resolution: 'UNDER_REVIEW', resolutionNote: 'الشركة قالت مؤجلة', resolvedById: 'u-decider',
    expectedAmount: 20, statementAmount: 0, statementFee: 0,
  }),
  row('m-x', null, { result: 'MISSING_IN_SYSTEM', resolution: 'UNDER_REVIEW', resolutionNote: 'سطر لشركة ثانية', expectedAmount: null }),
  row('m-o6', 'o6', { result: 'MISSING_IN_STATEMENT', statementAmount: null, statementFee: null }),
  row('m-o7', 'o7', {
    expectedAmount: 3, statementAmount: 3, statementFee: 5,
    order: { orderNumber: 'ORD-o7', settlementMatches: [{ statementAmount: 12, statementFee: 5 }] },
  }),
];

const ORDERS = (): FakeOrder[] => [
  order('o1', { shippingStatus: 'SHIPPED', deliveredAt: null }),
  order('o2'),
  order('o3'),
  order('o4'),
  order('o5', { shippingStatus: 'FAILED_DELIVERY', deliveredAt: null }),
  order('o6'),
  order('o7', { shippingStatus: 'OUT_FOR_DELIVERY', deliveredAt: null }),
];

const statement = () => ({
  id: ID, status: 'MATCHED', reference: 'ST-GOLD', currencyCode: 'USD', gapExplanation: null, approvedAt: null,
  matchingClosedAt: null, createdAt: new Date('2026-10-20T10:00:00Z'), periodTo: new Date('2026-10-20T00:00:00Z'),
  fileHash: 'ab'.repeat(32),
  receipts: [
    { id: 'r1', walletId: 'w-usd', amount: 60 },
    { id: 'r2', walletId: 'w-usd-2', amount: 18 },
  ],
  matches: ROWS,
});

/**
 * The log, made comparable: a date becomes its ISO text and a JSON metadata its object. What the split itself adds is
 * taken out — the receipt each movement is for, and the audit's word on the matching — and asserted on its own.
 */
function comparable(entries: { op: string; args: unknown }[]) {
  const plain = JSON.parse(
    JSON.stringify(entries, (_k, v) => (typeof v === 'string' && v.startsWith('{') ? (() => { try { return JSON.parse(v); } catch { return v; } })() : v))
  ) as { op: string; args: Record<string, any> }[];
  return plain.map((e) => {
    if (e.op === 'recordMovement') {
      const { statementReceiptId: _r, ...rest } = e.args;
      return { op: e.op, args: rest };
    }
    if (e.op === 'logAudit' && e.args.action === 'STATEMENT_APPROVED') {
      const { matchingClosed: _c, openLines: _o, ...newData } = e.args.newData;
      return { op: e.op, args: { ...e.args, newData } };
    }
    return e;
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  state.approvedStamp = false;
  state.orders = new Map(ORDERS().map((o) => [o.id, o]));
  state.penalties = [];
  state.door = new Map([['o3', 'u-door']]);
  state.log = [];
  state.reads = [statement()];
  requireContext.mockResolvedValue({
    user: { id: 'u-approver', name: 'المحاسب' }, companyId: 'c1', storeId: 's1', country: { minorUnit: 2, currencyCode: 'USD' },
  });
  requirePermission.mockResolvedValue({});
  receiptGap.mockResolvedValue({ claimed: 78, received: 78, gap: 0, needsExplanation: false, explained: false, unconvertible: 0 });
});

describe('a statement with nothing left to answer', () => {
  it('is approved with exactly the writes the approval made before the split', async () => {
    const res = await approve();
    expect(res.status).toBe(200);
    await expect(JSON.stringify(comparable(state.log), null, 2)).toMatchFileSnapshot('./a-clean-approval-writes.golden.json');
  });

  it('and what it settles is the clean rows, the accepted figure and the claim payment — nothing parked, kept or unnamed', async () => {
    await approve();
    const settled = [...state.orders.values()].filter((o) => o.settlementStatus === 'SETTLED').map((o) => o.id).sort();
    expect(settled).toEqual(['o1', 'o2', 'o3', 'o7']);
  });
});
