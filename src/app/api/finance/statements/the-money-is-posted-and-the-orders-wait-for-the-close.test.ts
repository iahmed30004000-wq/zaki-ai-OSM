import { beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { stripComments } from '@/lib/guard-source';

/**
 * «افصل المطابقة عن التحصيل… لما اعتمدو ينزل التحصيل تلقائي ولما يتطابق ما يكرر التحصيل… ترحل ع المحافظ ك وارد
 * تجنبا للتكرار» (the owner, 2/11).
 *
 * The approval posts the MONEY — one IN per receipt — and never waits on a line. The ORDERS wait for every line to be
 * answered: the approval settles them in the same press when none is open (exactly as before — the golden file of
 * `a-clean-approval-writes-what-it-always-wrote` holds it to the write), and «إغلاق المطابقة» settles them later
 * otherwise, writing NO money. These tests drive both real routes against one fake database that applies the
 * conditional writes the way Postgres does: one winner per stamp, and a transaction that rolls back.
 */

type FakeOrder = {
  id: string; orderNumber: string; shippingStatus: string; settlementStatus: string;
  openRequest: boolean; collectedAmount: number | null; customerId: string;
  deliveredAt: Date | null; moderatorId: string | null; confirmedById: string | null;
};
type Stamp = Date | null;

const { db, requireContext, requirePermission, logAudit, recordMovement, receiptGap, markPayableForOrders, consumeOrderStock, notify, runMatching, state } =
  vi.hoisted(() => {
    const state = {
      identity: { id: 'st1', reference: 'ST-1', currencyCode: 'SYP' },
      statement: { approvedAt: null as Stamp, matchingClosedAt: null as Stamp, status: 'MATCHED', fileHash: 'ab'.repeat(32) },
      rows: [] as Record<string, any>[],
      receipts: [] as { id: string; walletId: string; amount: number }[],
      orders: new Map<string, FakeOrder>(),
      penalties: [] as Record<string, any>[],
      door: new Map<string, string>(),
      /** The wallet: every IN the approval wrote, with the receipt it is for. */
      movements: [] as { statementReceiptId: string | null; amount: number }[],
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
    const statementRead = () => ({
      ...state.identity, gapExplanation: null,
      createdAt: new Date('2026-10-20T10:00:00Z'), periodTo: new Date('2026-10-20T00:00:00Z'),
      ...state.statement,
      receipts: state.receipts,
      matches: state.rows,
    });

    const db = {
      courierStatement: {
        findFirst: vi.fn(async () => statementRead()),
        /** The conditional writes of both stamps, one winner each, exactly as the WHERE says. */
        updateMany: vi.fn(async ({ where, data }: { where: Record<string, any>; data: Record<string, any> }) => {
          const st = state.statement;
          if ('approvedAt' in where && where.approvedAt === null && st.approvedAt) return { count: 0 };
          if (where.approvedAt?.not === null && !st.approvedAt) return { count: 0 };
          if ('matchingClosedAt' in where && where.matchingClosedAt === null && st.matchingClosedAt) return { count: 0 };
          if (data.approvedAt) st.approvedAt = data.approvedAt;
          if (data.status) st.status = data.status;
          if (data.matchingClosedAt) st.matchingClosedAt = data.matchingClosedAt;
          return { count: 1 };
        }),
      },
      settlementMatch: { findMany: vi.fn(async () => state.rows) },
      walletMovement: {
        findMany: vi.fn(async () => []),
        count: vi.fn(async ({ where }: { where: { statementReceiptId: null | { not: null } } }) =>
          state.movements.filter((m) => (where.statementReceiptId === null ? m.statementReceiptId === null : m.statementReceiptId !== null)).length
        ),
      },
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
      orderActivity: {
        create: vi.fn(async ({ data }: { data: Record<string, any> }) => log('orderActivity.create', data)),
        findMany: vi.fn(async () => []),
      },
      orderChangeRequest: { findMany: vi.fn(async () => []) },
      customer: { update: vi.fn(async (args: unknown) => log('customer.update', args)) },
      // A transaction that ROLLS BACK: the stamps, the orders, the penalties and the wallet are what they were.
      $transaction: vi.fn(async (fn: (tx: unknown) => unknown) => {
        const before = {
          statement: { ...state.statement },
          orders: new Map([...state.orders].map(([k, v]) => [k, { ...v }])),
          penalties: state.penalties.map((p) => ({ ...p })),
          movements: [...state.movements],
          log: state.log.length,
        };
        try {
          return await fn(db);
        } catch (e) {
          state.statement = before.statement;
          state.orders = before.orders;
          state.penalties = before.penalties;
          state.movements = before.movements;
          state.log.length = before.log;
          throw e;
        }
      }),
    };
    return {
      db, state,
      requireContext: vi.fn(), requirePermission: vi.fn(),
      logAudit: vi.fn(async (a: unknown) => log('logAudit', a)),
      // The database's own rule: one movement per receipt (`wallet_movements_statementReceiptId_key`).
      recordMovement: vi.fn(async (_tx: unknown, a: { statementReceiptId?: string; amount: number }) => {
        if (a.statementReceiptId && state.movements.some((m) => m.statementReceiptId === a.statementReceiptId)) {
          throw new Error('unique violation: wallet_movements_statementReceiptId_key');
        }
        state.movements.push({ statementReceiptId: a.statementReceiptId ?? null, amount: a.amount });
        log('recordMovement', a);
        return { id: `mv-${state.movements.length}` };
      }),
      receiptGap: vi.fn(),
      markPayableForOrders: vi.fn(async (_tx: unknown, companyId: string, ids: string[]) => { log('markPayableForOrders', { companyId, ids }); return 0; }),
      consumeOrderStock: vi.fn(async (_tx: unknown, a: unknown) => log('consumeOrderStock', a)),
      notify: vi.fn((a: unknown) => log('notify', a)),
      runMatching: vi.fn(async () => ({ matched: 0 })),
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
  runMatching: () => runMatching(),
}));
vi.mock('@/lib/wallets', async (orig) => ({
  ...(await orig<typeof import('@/lib/wallets')>()),
  recordMovement: (...a: unknown[]) => recordMovement(...(a as [unknown, { statementReceiptId?: string; amount: number }])),
}));
vi.mock('@/lib/commission', async (orig) => ({
  ...(await orig<typeof import('@/lib/commission')>()),
  markPayableForOrders: (...a: unknown[]) => markPayableForOrders(...(a as [unknown, string, string[]])),
}));
vi.mock('@/lib/stock-consumption', () => ({ consumeOrderStock: (...a: unknown[]) => consumeOrderStock(...(a as [unknown, unknown])) }));

import { GET, PATCH } from './[id]/route';
import { closeRowsSelect } from '@/lib/statement-close';
import { POST as CLOSE } from './[id]/close/route';

const params = () => ({ params: Promise.resolve({ id: state.identity.id }) });
const send = (method: string, body: unknown) =>
  new Request('http://localhost/x', { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
const approve = () => PATCH(send('PATCH', { approve: true }), params());
const close = (body: unknown = {}) => CLOSE(send('POST', body), params());

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
const settled = () => [...state.orders.values()].filter((o) => o.settlementStatus === 'SETTLED').map((o) => o.id).sort();
const effects = () => state.log.filter((e) => e.op !== 'logAudit');
const ops = (op: string) => state.log.filter((e) => e.op === op);

function fresh() {
  state.identity = { id: 'st1', reference: 'ST-1', currencyCode: 'SYP' };
  state.statement = { approvedAt: null, matchingClosedAt: null, status: 'MATCHED', fileHash: 'ab'.repeat(32) };
  state.rows = [];
  state.receipts = [];
  state.orders = new Map();
  state.penalties = [];
  state.door = new Map();
  state.movements = [];
  state.log = [];
}

beforeEach(() => {
  vi.clearAllMocks();
  fresh();
  requireContext.mockResolvedValue({
    user: { id: 'u-approver', name: 'المحاسب' }, companyId: 'c1', storeId: 's1', country: { minorUnit: 2, currencyCode: 'USD' },
  });
  requirePermission.mockResolvedValue({});
});

/* ───────────────────────────── the worked example ───────────────────────────── */

describe('the owner’s example: five lines — three delivered, one returned, one postponed — and one receipt of 80,000', () => {
  beforeEach(() => {
    state.receipts = [{ id: 'r1', walletId: 'w-syp', amount: 80000 }];
    receiptGap.mockResolvedValue({ claimed: 80000, received: 80000, gap: 0, needsExplanation: false, explained: false, unconvertible: 0 });
    for (const o of [
      order('oA', { shippingStatus: 'OUT_FOR_DELIVERY', deliveredAt: null }),
      order('oB'),
      order('oC', { shippingStatus: 'SHIPPED', deliveredAt: null }),
      order('oD', { shippingStatus: 'OUT_FOR_DELIVERY', deliveredAt: null }),
      order('oE', { shippingStatus: 'FAILED_DELIVERY', deliveredAt: null }),
    ]) state.orders.set(o.id, o);
    // What the matching wrote (a-zero-line-that-came-back-is-not-money): the zero lines are EXCLUDED.
    state.rows = [
      row('mA', 'oA', { expectedAmount: 20000, statementAmount: 20000, statementFee: 5000, expectedFee: 5000 }),
      row('mB', 'oB', { expectedAmount: 25000, statementAmount: 25000, statementFee: 5000, expectedFee: 5000 }),
      row('mC', 'oC', { expectedAmount: 35000, statementAmount: 35000, statementFee: 5000, expectedFee: 5000 }),
      row('mD', 'oD', { result: 'EXCLUDED', expectedAmount: null, statementAmount: 0, statementFee: null }),
      row('mE', 'oE', { result: 'EXCLUDED', expectedAmount: null, statementAmount: 0, statementFee: null }),
    ];
  });

  it('one press: ONE wallet IN of 80,000 for the one receipt, the three delivered settled at their gross, nobody had to park a line', async () => {
    const res = await approve();
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ matchingClosed: true, openLines: 0, settledOrders: 3, deliveredByStatement: 2 });

    expect(state.movements).toEqual([{ statementReceiptId: 'r1', amount: 80000 }]);
    expect(settled()).toEqual(['oA', 'oB', 'oC']);
    expect(state.orders.get('oA')!.collectedAmount).toBe(25000);
    expect(state.orders.get('oB')!.collectedAmount).toBe(30000);
    expect(state.orders.get('oC')!.collectedAmount).toBe(40000);
    expect(state.statement.matchingClosedAt).toEqual(state.statement.approvedAt);
  });

  it('the returned and the postponed parcels are not touched by any write — the returns desk and the next statement own them', async () => {
    await approve();
    const touched = JSON.stringify(effects());
    for (const id of ['oD', 'oE']) {
      expect(state.orders.get(id)!.settlementStatus).toBe('PENDING_COLLECTION');
      expect(state.orders.get(id)!.collectedAmount).toBeNull();
      expect(touched).not.toContain(`"${id}"`);
    }
  });

  it('pressing «اعتماد» twice: the second is refused and the wallet holds the 80,000 once', async () => {
    await approve();
    const again = await approve();
    expect(again.status).toBe(409);
    expect((await again.json()).code).toBe('ALREADY_APPROVED');
    expect(state.movements).toHaveLength(1);
  });

  it('…and «إغلاق المطابقة» after it is refused — closed with the money — and writes nothing', async () => {
    await approve();
    const before = state.log.length;
    const res = await close();
    expect(res.status).toBe(409);
    expect((await res.json()).code).toBe('MATCHING_ALREADY_CLOSED');
    expect(state.log.length).toBe(before);
    expect(state.movements).toHaveLength(1);
  });
});

/* ───────────────────────────── the money first, the orders when the lines are answered ───────────────────────────── */

describe('a line still a question: the money is posted, the orders wait for «إغلاق المطابقة»', () => {
  beforeEach(() => {
    state.receipts = [{ id: 'r1', walletId: 'w-syp', amount: 79000 }];
    receiptGap.mockResolvedValue({ claimed: 79000, received: 79000, gap: 0, needsExplanation: false, explained: false, unconvertible: 0 });
    for (const o of [order('oA', { shippingStatus: 'OUT_FOR_DELIVERY', deliveredAt: null }), order('oB'), order('oC')]) state.orders.set(o.id, o);
    state.rows = [
      row('mA', 'oA', { expectedAmount: 20000, statementAmount: 20000, statementFee: 5000, expectedFee: 5000 }),
      // A price typo: ours 25,000, theirs 24,000 — a question nobody answered yet.
      row('mB', 'oB', { result: 'MISMATCHED', expectedAmount: 25000, statementAmount: 24000, statementFee: 5000, expectedFee: 5000 }),
      row('mC', 'oC', { expectedAmount: 35000, statementAmount: 35000, statementFee: 5000, expectedFee: 5000 }),
    ];
  });

  it('the approval posts the 79,000 and settles NOTHING: no order, no commission, no delivery, no stamp of the close', async () => {
    const res = await approve();
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ matchingClosed: false, openLines: 1, settledOrders: 0 });
    expect(state.movements).toEqual([{ statementReceiptId: 'r1', amount: 79000 }]);
    expect(settled()).toEqual([]);
    expect(ops('markPayableForOrders')).toHaveLength(0);
    expect(ops('order.update')).toHaveLength(0);
    expect(state.statement.approvedAt).not.toBeNull();
    expect(state.statement.matchingClosedAt).toBeNull();
  });

  it('«إغلاق المطابقة» while the line is open: refused with the number, and the claim on the close rolled back', async () => {
    await approve();
    const res = await close();
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.code).toBe('OPEN_LINES');
    expect(body.error).toContain('بقي 1 سطر');
    expect(state.statement.matchingClosedAt).toBeNull();
    expect(settled()).toEqual([]);
  });

  it('answered, then closed: the three settle — and the close writes NO money at all', async () => {
    await approve();
    state.rows[1] = { ...state.rows[1], resolution: 'ACCEPTED_COURIER', resolutionNote: 'خصم أعطاه الموظف للزبون', resolvedById: 'u-decider' };
    state.door.set('oB', 'u-door');
    const movementsBefore = recordMovement.mock.calls.length;

    const res = await close();

    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ matchingClosed: true, settledOrders: 3 });
    expect(recordMovement.mock.calls.length).toBe(movementsBefore);
    expect(state.movements).toHaveLength(1);
    expect(settled()).toEqual(['oA', 'oB', 'oC']);
    // The accepted figure is written as their gross: 24,000 + 5,000.
    expect(state.orders.get('oB')!.collectedAmount).toBe(29000);
    expect(ops('markPayableForOrders')).toHaveLength(1);
    expect(state.statement.matchingClosedAt).not.toBeNull();
    expect(logAudit).toHaveBeenCalledWith(expect.objectContaining({ action: 'STATEMENT_MATCHING_CLOSED' }));
  });

  it('two presses of «إغلاق المطابقة»: one wins, the second is refused, the orders are written once', async () => {
    await approve();
    state.rows[1] = { ...state.rows[1], resolution: 'UNDER_REVIEW', resolutionNote: 'نراجع مع الشركة' };
    const [a, b] = await Promise.all([close(), close()]);
    expect([a.status, b.status].sort()).toEqual([200, 409]);
    expect(ops('order.updateMany')).toHaveLength(1);
    expect(state.movements).toHaveLength(1);
  });

  it('NEGATIVE — «إغلاق المطابقة» before the money: refused, and nothing is claimed or written', async () => {
    const res = await close();
    expect(res.status).toBe(409);
    expect((await res.json()).code).toBe('MONEY_NOT_POSTED');
    expect(db.$transaction).not.toHaveBeenCalled();
    expect(state.log).toEqual([]);
  });

  it('NEGATIVE — the close asks the approval’s own key', async () => {
    await close();
    expect(requirePermission).toHaveBeenCalledWith('settlement.approve');
    requirePermission.mockRejectedValueOnce(Object.assign(new Error('FORBIDDEN'), { status: 403 }));
    const res = await close();
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(db.courierStatement.updateMany).not.toHaveBeenCalled();
  });

  it('an order settled by another door while the line waited: the close stops by name and rolls back its stamp', async () => {
    await approve();
    state.rows[1] = { ...state.rows[1], resolution: 'UNDER_REVIEW', resolutionNote: 'نراجع مع الشركة' };
    state.orders.get('oC')!.settlementStatus = 'SETTLED'; // collected by hand meanwhile
    const res = await close();
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ code: 'ORDERS_CHANGED', orders: ['ORD-oC'] });
    expect(state.statement.matchingClosedAt).toBeNull();
    expect(state.orders.get('oA')!.settlementStatus).toBe('PENDING_COLLECTION');
  });

  it('a short accepted line the door cannot name: the close asks «من يتحمّل الفرق؟», and goes on once answered', async () => {
    await approve();
    const MB = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
    state.rows[1] = { ...state.rows[1], id: MB, resolution: 'ACCEPTED_COURIER', resolutionNote: 'خصم أعطاه الموظف للزبون' };
    const asked = await close();
    expect(asked.status).toBe(409);
    expect((await asked.json()).code).toBe('SHORTFALL_UNNAMED');
    expect(state.statement.matchingClosedAt).toBeNull();

    const res = await close({ shortfallPeople: { [MB]: 'COMPANY' } });
    expect(res.status).toBe(200);
    expect(settled()).toEqual(['oA', 'oB', 'oC']);
  });

  it('a manual statement is matched again INSIDE the close, after its claim — as the approval did before the split', async () => {
    await approve();
    state.statement.fileHash = 'manual:ST-1';
    state.rows[1] = { ...state.rows[1], resolution: 'UNDER_REVIEW', resolutionNote: 'نراجع مع الشركة' };
    runMatching.mockClear();
    await close();
    expect(runMatching).toHaveBeenCalledTimes(1);
    const claim = db.courierStatement.updateMany.mock.invocationCallOrder.at(-1)!;
    expect(claim).toBeLessThan(runMatching.mock.invocationCallOrder[0]);
  });
});

/* ───────────────────────────── the two presses write what the one press always wrote ───────────────────────────── */

describe('the differential: approve with a line open, answer it, close — the same writes as the one clean approval', () => {
  it('equals the golden file of main’s approval, effect for effect, in order', async () => {
    // The same statement as the golden file, with the parked line still open at the approval.
    const golden = JSON.parse(
      readFileSync(join(process.cwd(), 'src/app/api/finance/statements/a-clean-approval-writes.golden.json'), 'utf8')
    ) as { op: string; args: Record<string, any> }[];
    expect(golden.length, 'the golden file is read').toBeGreaterThan(10);

    // The golden statement's own name and id.
    state.identity = { id: '88888888-8888-4888-8888-888888888888', reference: 'ST-GOLD', currencyCode: 'USD' };
    receiptGap.mockResolvedValue({ claimed: 78, received: 78, gap: 0, needsExplanation: false, explained: false, unconvertible: 0 });
    state.receipts = [{ id: 'r1', walletId: 'w-usd', amount: 60 }, { id: 'r2', walletId: 'w-usd-2', amount: 18 }];
    for (const o of [
      order('o1', { shippingStatus: 'SHIPPED', deliveredAt: null }), order('o2'), order('o3'), order('o4'),
      order('o5', { shippingStatus: 'FAILED_DELIVERY', deliveredAt: null }), order('o6'),
      order('o7', { shippingStatus: 'OUT_FOR_DELIVERY', deliveredAt: null }),
    ]) state.orders.set(o.id, o);
    state.door.set('o3', 'u-door');
    const parked = row('m-o5', 'o5', {
      result: 'MISMATCHED', resolution: 'UNDER_REVIEW', resolutionNote: 'الشركة قالت مؤجلة', resolvedById: 'u-decider',
      expectedAmount: 20, statementAmount: 0, statementFee: 0,
    });
    state.rows = [
      row('m-o1', 'o1'),
      row('m-o2', 'o2', { statementAmount: 25, expectedAmount: 25 }),
      row('m-o3', 'o3', { result: 'MISMATCHED', resolution: 'ACCEPTED_COURIER', resolutionNote: 'خصم أعطاه الموظف للزبون', resolvedById: 'u-decider', expectedAmount: 35, statementAmount: 30 }),
      row('m-o4', 'o4', { result: 'MISMATCHED', resolution: 'OURS_STANDS', resolutionNote: 'سنطالب الشركة بالباقي', resolvedById: 'u-decider', expectedAmount: 20, statementAmount: 15 }),
      { ...parked, resolution: null, resolutionNote: null, resolvedById: null }, // still open at the approval
      row('m-x', null, { result: 'MISSING_IN_SYSTEM', resolution: 'UNDER_REVIEW', resolutionNote: 'سطر لشركة ثانية', expectedAmount: null }),
      row('m-o6', 'o6', { result: 'MISSING_IN_STATEMENT', statementAmount: null, statementFee: null }),
      row('m-o7', 'o7', { expectedAmount: 3, statementAmount: 3, statementFee: 5, order: { orderNumber: 'ORD-o7', settlementMatches: [{ statementAmount: 12, statementFee: 5 }] } }),
    ];

    expect((await (await approve()).json()).matchingClosed).toBe(false);
    state.rows[4] = parked; // answered
    expect((await close()).status).toBe(200);

    const plain = (entries: { op: string; args: unknown }[]) =>
      JSON.parse(
        JSON.stringify(entries, (_k, v) => (typeof v === 'string' && v.startsWith('{') ? (() => { try { return JSON.parse(v); } catch { return v; } })() : v))
      ).map((e: { op: string; args: Record<string, any> }) => {
        if (e.op !== 'recordMovement') return e;
        const { statementReceiptId: _r, ...rest } = e.args;
        return { op: e.op, args: rest };
      });
    expect(plain(effects())).toEqual(golden.filter((e) => e.op !== 'logAudit'));
    // …and each movement names its receipt, which the golden could not.
    expect(ops('recordMovement').map((e) => (e.args as { statementReceiptId: string }).statementReceiptId)).toEqual(['r1', 'r2']);
  });
});

/* ───────────────────────────── a statement the old approval already settled ───────────────────────────── */

describe('a statement approved by the old code during the Redeploy — money posted, orders settled, no close stamped', () => {
  beforeEach(() => {
    state.statement = { approvedAt: new Date('2026-11-02T08:00:00Z'), matchingClosedAt: null, status: 'APPROVED', fileHash: 'ab'.repeat(32) };
    state.rows = [row('m-o1', 'o1')];
    state.orders.set('o1', order('o1'));
    state.orders.set('o1', order('o1', { settlementStatus: 'SETTLED' }));
    state.rows = [row('m-o1', 'o1')];
  });

  it('is recognised by its movements, which name no receipt, and «إغلاق المطابقة» only stamps it — no second settling, no money', async () => {
    state.movements = [{ statementReceiptId: null, amount: 20 }];
    const res = await close();
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ matchingClosed: true, approvedBeforeTheSplit: true, settledOrders: 0 });
    expect(effects()).toEqual([]);
    expect(recordMovement).not.toHaveBeenCalled();
    expect(state.statement.matchingClosedAt).not.toBeNull();
    expect(logAudit).toHaveBeenCalledWith(expect.objectContaining({ action: 'STATEMENT_MATCHING_CLOSED', newData: expect.objectContaining({ approvedBeforeTheSplit: true }) }));
  });

  it('NEGATIVE — one movement that names its receipt is enough: the new approval wrote it, so it is settled, not stamped', async () => {
    state.movements = [{ statementReceiptId: null, amount: 5 }, { statementReceiptId: 'r1', amount: 20 }];
    state.orders.get('o1')!.settlementStatus = 'PENDING_COLLECTION';
    const res = await close();
    expect(await res.json()).toMatchObject({ approvedBeforeTheSplit: false, settledOrders: 1 });
  });

  it('NEGATIVE — a statement whose movements name their receipts is the new approval’s: it is settled, not stamped', async () => {
    state.movements = [{ statementReceiptId: 'r1', amount: 20 }];
    state.orders.get('o1')!.settlementStatus = 'PENDING_COLLECTION';
    const res = await close();
    expect(await res.json()).toMatchObject({ approvedBeforeTheSplit: false, settledOrders: 1 });
    expect(settled()).toEqual(['o1']);
  });
});

/* ───────────────────────────── the database holds one movement per receipt ───────────────────────────── */

describe('one movement per receipt', () => {
  it('the approval writes the receipt on every movement it posts', async () => {
    state.receipts = [{ id: 'r1', walletId: 'w1', amount: 10 }, { id: 'r2', walletId: 'w2', amount: 10 }];
    receiptGap.mockResolvedValue({ claimed: 20, received: 20, gap: 0, needsExplanation: false, explained: false, unconvertible: 0 });
    state.orders.set('o1', order('o1'));
    state.rows = [row('m-o1', 'o1')];
    await approve();
    expect(state.movements.map((m) => m.statementReceiptId)).toEqual(['r1', 'r2']);
  });

  it('NEGATIVE — a second movement for the same receipt is refused by the index, and the approval rolls back whole', async () => {
    state.receipts = [{ id: 'r1', walletId: 'w1', amount: 10 }, { id: 'r1', walletId: 'w1', amount: 10 }];
    receiptGap.mockResolvedValue({ claimed: 20, received: 20, gap: 0, needsExplanation: false, explained: false, unconvertible: 0 });
    state.orders.set('o1', order('o1'));
    state.rows = [row('m-o1', 'o1')];
    const res = await approve();
    expect(res.status).toBe(500);
    expect(state.movements).toEqual([]);
    expect(state.statement.approvedAt).toBeNull();
  });
});

/* ───────────────────────────── the close cannot write money — read from the source ───────────────────────────── */

describe('the close cannot write a wallet movement', () => {
  const src = (p: string) => stripComments(readFileSync(join(process.cwd(), p), 'utf8'));

  it.each(['src/lib/statement-close.ts', 'src/app/api/finance/statements/[id]/close/route.ts'])('%s imports no wallet writer and touches no movement', (file) => {
    const s = src(file);
    expect(s).not.toMatch(/from ['"](@\/lib|\.)\/wallets['"]/);
    expect(s).not.toMatch(/recordMovement|reverseMovement|reverseHandRows|payFromWallet/);
    expect(s).not.toMatch(/walletMovement\.(create|createMany|update|updateMany|upsert|delete|deleteMany)\(/);
  });

  it('the statement route writes money in exactly one place, inside the approval, after the claim on the money', () => {
    const s = src('src/app/api/finance/statements/[id]/route.ts');
    const at = [...s.matchAll(/recordMovement\(/g)].map((m) => m.index ?? 0);
    expect(at).toHaveLength(1);
    expect(s.indexOf("data: {\n          status: 'APPROVED'")).toBeLessThan(at[0]);
    // …and the settling, which writes no money, comes after it.
    expect(at[0]).toBeLessThan(s.indexOf('await settleStatement('));
  });
});

/* ───────────────────────────── pinned by the adversarial review (RV809–RV811) ───────────────────────────── */

describe('RV809 — «إغلاق المطابقة» reads the statement of THIS store only, at both of its reads', () => {
  const reads = () => (db.courierStatement.findFirst.mock.calls as unknown as [{ where: Record<string, unknown> }][]).map((c) => c[0].where);

  it('the read before the act asks for this store', async () => {
    state.statement = { approvedAt: new Date('2026-11-02T08:00:00Z'), matchingClosedAt: null, status: 'APPROVED', fileHash: 'ab'.repeat(32) };
    state.rows = [row('m-o1', 'o1')];
    state.orders.set('o1', order('o1'));
    await close();
    expect(reads()[0]).toEqual({ id: 'st1', companyId: 'c1', storeId: 's1' });
    // …and so does the claim that follows it.
    expect(db.courierStatement.updateMany.mock.calls[0][0].where).toMatchObject({ id: 'st1', companyId: 'c1', storeId: 's1' });
  });

  it('the read after a lost claim — the one that names why — asks for this store too', async () => {
    state.statement = { approvedAt: new Date('2026-11-02T08:00:00Z'), matchingClosedAt: null, status: 'APPROVED', fileHash: 'ab'.repeat(32) };
    state.rows = [row('m-o1', 'o1')];
    state.orders.set('o1', order('o1'));
    // The read before sees it open; the claim finds it closed by a press a moment earlier.
    db.courierStatement.updateMany.mockImplementationOnce(async () => ({ count: 0 }));
    const res = await close();
    expect(res.status).toBe(409);
    expect(reads()).toHaveLength(2);
    expect(reads()[1]).toEqual({ id: 'st1', companyId: 'c1', storeId: 's1' });
  });
});

describe('RV810 — what an earlier claim paid is read from CLOSED statements, at the close', () => {
  it('the close’s own select asks for the close, not the money', () => {
    const where = (closeRowsSelect('st1').order.select.settlementMatches as { where: Record<string, unknown> }).where;
    expect(where.statement).toEqual({ matchingClosedAt: { not: null } });
    expect(where).toMatchObject({ resolution: 'OURS_STANDS', statementId: { not: 'st1' } });
  });
});

describe('RV811 — the statement’s page offers answers until the MATCHING closes, not until the money', () => {
  const statementRead = (over: Record<string, unknown>) => ({
    id: 'st1', reference: 'ST-1', currencyCode: 'SYP', gapExplanation: null, status: 'APPROVED',
    approvedAt: new Date('2026-11-02T08:00:00Z'), createdAt: new Date('2026-10-20T10:00:00Z'), periodTo: null, fileHash: 'ab'.repeat(32),
    lines: [], receipts: [],
    matches: [{
      id: 'm-o2', orderId: 'o2', result: 'MISMATCHED', resolution: null, expectedAmount: 25000, statementAmount: 24000,
      order: { id: 'o2', orderNumber: 'ORD-o2', merchantRef: 'REF-o2', shippingStatus: 'DELIVERED', confirmationStatus: 'CONFIRMED', settlementStatus: 'PENDING_COLLECTION', rejectionReason: null, returnReceipt: null },
      statementLine: { merchantRef: 'REF-o2', barcode: null, amount: 24000, collected: null, fee: null, status: null, rawRow: null },
    }],
    ...over,
  });
  const open = async (over: Record<string, unknown>) => {
    state.orders.set('o2', order('o2'));
    receiptGap.mockResolvedValue({ claimed: 0, received: 0, gap: 0, needsExplanation: false, explained: false, unconvertible: 0 });
    db.courierStatement.findFirst.mockImplementationOnce(async () => statementRead(over) as never);
    const res = await GET(new Request('http://localhost/x'), params());
    expect(res.status).toBe(200);
    const body = await res.json();
    return body.statement.matches[0].decisions as Record<string, { allowed: boolean; why: string | null }>;
  };

  it('the money posted, the matching open: «قيد المراجعة» is still offered', async () => {
    const d = await open({ matchingClosedAt: null });
    expect(d.UNDER_REVIEW.allowed).toBe(true);
  });

  it('NEGATIVE — the matching closed: every saying carries the closed sentence', async () => {
    const d = await open({ matchingClosedAt: new Date('2026-11-03T00:00:00Z') });
    for (const v of Object.values(d)) expect(v).toEqual({ allowed: false, why: 'الكشف مغلق نهائياً — التصحيح بكشف تسوية' });
  });
});
