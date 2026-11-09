import { beforeEach, describe, expect, it, vi } from 'vitest';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { stripComments } from '@/lib/guard-source';

/**
 * ═══════════════════════════════════════════════════════════════════════
 * «تسوية السطور النظيفة عند الاعتماد» — THE APPROVAL SETTLES THE CLEAN LINES, A LINE STILL A QUESTION HOLDS ONLY ITS OWN ORDER.
 *
 * «طلبات بتاخد أسبوع تفسير» (the owner, 9/11). The real routes — the approval, «إغلاق المطابقة» and «سوّي الطلبات النظيفة هلّق» — run
 * here against ONE stateful world:
 *
 *   · a transaction that ROLLS BACK everything it wrote when it throws, and a SAVEPOINT that undoes only what came after it
 *     (`SAVEPOINT` / `RELEASE SAVEPOINT` / `ROLLBACK TO SAVEPOINT`, as Postgres does — measured on the development database
 *     with Prisma's interactive transaction before this was written);
 *   · conditional writes that apply their WHERE (an order the claim's filter would not take is not taken), one winner per stamp;
 *   · a filter the world does not know is an ERROR, never a silent "match everything".
 *
 * What is held here, in the owner's words: the switch OFF is the approval it always was; ON, with a line still a question, every clean
 * line is settled at the press and marked applied, the money is posted first and cannot be rolled back by the step (a changed order is
 * LEFT, any other failure is undone to a savepoint), the close then settles the rest without touching the applied rows, and the press
 * for a statement approved earlier does the same step on demand.
 * ═══════════════════════════════════════════════════════════════════════
 */

type Stamp = Date | null;
interface WOrder {
  id: string; orderNumber: string; shippingStatus: string; settlementStatus: string;
  openRequest: boolean; collectedAmount: number | null; customerId: string;
  deliveredAt: Date | null; moderatorId: string | null; confirmedById: string | null; version: number;
}
type WRow = Record<string, any>;

const { db, world, requireContext, requirePermission, logAudit, recordMovement, receiptGap, notify, resetWorld } = vi.hoisted(() => {
  const fresh = () => ({
    identity: { id: 'st1', reference: 'ST-1', currencyCode: 'SYP' },
    statement: { approvedAt: null as Stamp, matchingClosedAt: null as Stamp, status: 'MATCHED', fileHash: 'ab'.repeat(32) },
    rows: [] as WRow[],
    receipts: [] as { id: string; walletId: string; amount: number }[],
    orders: new Map<string, WOrder>(),
    customers: new Map<string, { deliveredOrders: number; totalPurchaseValue: number }>(),
    activities: [] as { orderId: string; action: string; userId: string; metadata: string | null }[],
    movements: [] as { statementReceiptId: string | null; amount: number }[],
    payable: [] as string[],
    stock: [] as string[],
    penalties: [] as Record<string, any>[],
    door: new Map<string, string>(),
    audits: [] as { action: string; newData: any }[],
    log: [] as { op: string; args: unknown }[],
    sql: [] as string[],
    switchOn: false,
    switchBroken: false,
    /** An order whose stock draw-down throws (the early step must undo itself and let the approval go on). */
    failStockFor: null as string | null,
    /** Called once just before the claim of an order — a concurrent door flipping it between the read and the write. */
    beforeClaim: null as null | ((orderId: string) => void),
    savepoints: [] as { name: string; snap: any }[],
  });
  const world = fresh();
  const resetWorld = () => Object.assign(world, fresh());

  const matchesWhere = (o: WOrder, w: Record<string, any>): boolean => {
    for (const [key, val] of Object.entries(w)) {
      if (key === 'companyId' || key === 'storeId') continue;
      if (key === 'id') { if (!val.in.includes(o.id)) return false; continue; }
      if (key === 'settlementStatus') { if (val.not !== undefined && o.settlementStatus === val.not) return false; continue; }
      if (key === 'shippingStatus') { if (!val.in.includes(o.shippingStatus)) return false; continue; }
      if (key === 'collectedAmount') { if (val === null && o.collectedAmount !== null) return false; continue; }
      if (key === 'changeRequests') { if (val.none && o.openRequest) return false; continue; }
      if (key === 'OR') { if (!(val as Record<string, any>[]).some((alt) => matchesWhere(o, alt))) return false; continue; }
      if (key === 'NOT') { if (matchesWhere(o, val)) return false; continue; }
      throw new Error('the fake does not know the order filter: ' + key);
    }
    return true;
  };
  const rowMatches = (r: WRow, w: Record<string, any>): boolean => {
    for (const [key, val] of Object.entries(w)) {
      if (key === 'companyId') continue;
      if (key === 'statementId') { if (val !== world.identity.id) return false; continue; }
      if (key === 'result') { if (r.result !== val) return false; continue; }
      if (key === 'appliedAt') { if (val === null && r.appliedAt) return false; continue; }
      if (key === 'orderId') { if (!r.orderId || !val.in.includes(r.orderId)) return false; continue; }
      if (key === 'statement') { if (val.matchingClosedAt === null && world.statement.matchingClosedAt) return false; continue; }
      throw new Error('the fake does not know the match-row filter: ' + key);
    }
    return true;
  };
  const log = (op: string, args: unknown) => world.log.push({ op, args });
  const snapshot = () =>
    structuredClone({
      statement: world.statement, rows: world.rows, orders: world.orders, customers: world.customers, activities: world.activities,
      movements: world.movements, payable: world.payable, stock: world.stock, penalties: world.penalties, audits: world.audits,
      log: world.log,
    });
  const restore = (s: any) => {
    world.statement = s.statement; world.rows = s.rows; world.orders = s.orders; world.customers = s.customers;
    world.activities = s.activities; world.movements = s.movements; world.payable = s.payable; world.stock = s.stock;
    world.penalties = s.penalties; world.audits = s.audits; world.log = s.log;
  };
  const statementRead = () => ({
    ...world.identity, gapExplanation: null,
    createdAt: new Date('2026-10-20T10:00:00Z'), periodTo: new Date('2026-10-20T00:00:00Z'),
    ...world.statement,
    receipts: world.receipts,
    matches: world.rows,
  });

  const db = {
    company: {
      findUnique: vi.fn(async () => {
        if (world.switchBroken) throw new Error('db down');
        return { settings: JSON.stringify(world.switchOn ? { perLineSettlement: { enabled: true, enabledAt: '2026-11-09T06:00:00.000Z' } } : {}) };
      }),
    },
    courierStatement: {
      findFirst: vi.fn(async () => statementRead()),
      /** The conditional writes of both stamps, one winner each, exactly as the WHERE says. */
      updateMany: vi.fn(async ({ where, data }: { where: Record<string, any>; data: Record<string, any> }) => {
        const st = world.statement;
        if ('approvedAt' in where && where.approvedAt === null && st.approvedAt) return { count: 0 };
        if (where.approvedAt?.not === null && !st.approvedAt) return { count: 0 };
        if ('matchingClosedAt' in where && where.matchingClosedAt === null && st.matchingClosedAt) return { count: 0 };
        if (data.approvedAt) st.approvedAt = data.approvedAt;
        if (data.status) st.status = data.status;
        if (data.matchingClosedAt) st.matchingClosedAt = data.matchingClosedAt;
        return { count: 1 };
      }),
    },
    settlementMatch: {
      findMany: vi.fn(async ({ where }: { where: Record<string, any> }) => {
        for (const key of Object.keys(where)) if (!['statementId', 'companyId'].includes(key)) throw new Error('the fake does not know: ' + key);
        return world.rows;
      }),
      updateMany: vi.fn(async ({ where, data }: { where: Record<string, any>; data: Record<string, any> }) => {
        const hit = world.rows.filter((r) => rowMatches(r, where));
        for (const r of hit) Object.assign(r, data);
        log('settlementMatch.updateMany', { where, data, took: hit.map((r) => r.id) });
        return { count: hit.length };
      }),
    },
    walletMovement: {
      findMany: vi.fn(async () => []),
      count: vi.fn(async ({ where }: { where: { statementReceiptId: null | { not: null } } }) =>
        world.movements.filter((m) => (where.statementReceiptId === null ? m.statementReceiptId === null : m.statementReceiptId !== null)).length
      ),
    },
    user: {
      findMany: vi.fn(async ({ where }: { where: { id?: { in: string[] } } }) =>
        [{ id: 'u-door', name: 'سارة', role: 'FOLLOW_UP_AGENT' }].filter((u) => !where.id?.in || where.id.in.includes(u.id))
      ),
    },
    deliveryAttempt: {
      findMany: vi.fn(async ({ where }: { where: { orderId: { in: string[] } } }) =>
        where.orderId.in.filter((id) => world.door.has(id)).map((orderId) => ({ orderId, deliveryAgentId: world.door.get(orderId) }))
      ),
    },
    penalty: {
      findMany: vi.fn(async () => world.penalties),
      create: vi.fn(async ({ data }: { data: Record<string, any> }) => {
        log('penalty.create', data);
        const row = { id: `pen-${world.penalties.length + 1}`, ...data };
        world.penalties.push(row);
        return row;
      }),
    },
    order: {
      updateMany: vi.fn(async ({ where, data }: { where: Record<string, any>; data: { settlementStatus?: string } }) => {
        // A concurrent door gets in between the read and this write: it flips the order the claim names.
        if (world.beforeClaim) {
          const ids: string[] = where.id?.in ?? [];
          for (const id of ids) world.beforeClaim(id);
        }
        const hit = [...world.orders.values()].filter((o) => matchesWhere(o, where));
        for (const o of hit) if (data.settlementStatus) o.settlementStatus = data.settlementStatus;
        log('order.updateMany', { where, data, took: hit.map((o) => o.id) });
        return { count: hit.length };
      }),
      findMany: vi.fn(async ({ where }: { where: Record<string, any> }) =>
        [...world.orders.values()].filter((o) => matchesWhere(o, where)).map((o) => ({ ...o }))
      ),
      update: vi.fn(async ({ where, data }: { where: { id: string }; data: Record<string, any> }) => {
        log('order.update', { where, data });
        const o = world.orders.get(where.id)!;
        if (data.collectedAmount !== undefined) o.collectedAmount = data.collectedAmount;
        if (data.shippingStatus) o.shippingStatus = data.shippingStatus;
        if (data.deliveredAt) o.deliveredAt = data.deliveredAt;
        if (data.version?.increment) o.version += data.version.increment;
        return o;
      }),
    },
    orderActivity: {
      create: vi.fn(async ({ data }: { data: Record<string, any> }) => {
        log('orderActivity.create', data);
        world.activities.push({ orderId: data.orderId, action: data.action, userId: data.userId, metadata: data.metadata ?? null });
      }),
    },
    customer: {
      update: vi.fn(async ({ where, data }: { where: { id: string }; data: Record<string, any> }) => {
        log('customer.update', { where, data });
        const c = world.customers.get(where.id) ?? { deliveredOrders: 0, totalPurchaseValue: 0 };
        c.deliveredOrders += data.deliveredOrders?.increment ?? 0;
        c.totalPurchaseValue += data.totalPurchaseValue?.increment ?? 0;
        world.customers.set(where.id, c);
      }),
    },
    orderChangeRequest: { findMany: vi.fn(async () => []) },
    $queryRaw: vi.fn(async (strings: TemplateStringsArray) => {
      world.sql.push(strings.join('?'));
      return [];
    }),
    /** SAVEPOINT / RELEASE / ROLLBACK TO — what Postgres does, over the world's own snapshot. */
    $executeRaw: vi.fn(async (strings: TemplateStringsArray) => {
      const sql = strings.join('?').trim();
      world.sql.push(sql);
      const name = sql.split(/\s+/).at(-1)!;
      if (sql.startsWith('SAVEPOINT ')) world.savepoints.push({ name, snap: snapshot() });
      else if (sql.startsWith('RELEASE SAVEPOINT ')) {
        const at = world.savepoints.map((s) => s.name).lastIndexOf(name);
        if (at < 0) throw new Error('no such savepoint: ' + name);
        world.savepoints.splice(at);
      } else if (sql.startsWith('ROLLBACK TO SAVEPOINT ')) {
        const at = world.savepoints.map((s) => s.name).lastIndexOf(name);
        if (at < 0) throw new Error('no such savepoint: ' + name);
        restore(structuredClone(world.savepoints[at].snap));
        world.savepoints.splice(at + 1);
      } else throw new Error('the fake does not know this statement: ' + sql);
      return 0;
    }),
    // A transaction that ROLLS BACK: the stamps, the orders, the rows, the penalties and the wallet are what they were.
    $transaction: vi.fn(async (fn: (tx: unknown) => unknown) => {
      const before = snapshot();
      world.savepoints = [];
      try {
        return await fn(db);
      } catch (e) {
        restore(before);
        throw e;
      } finally {
        world.savepoints = [];
      }
    }),
  };
  return {
    db, world, resetWorld,
    requireContext: vi.fn(), requirePermission: vi.fn(),
    logAudit: vi.fn(async (a: any) => { world.audits.push({ action: a.action, newData: a.newData }); }),
    // The database's own rule: one movement per receipt (`wallet_movements_statementReceiptId_key`).
    recordMovement: vi.fn(async (_tx: unknown, a: { statementReceiptId?: string; amount: number }) => {
      if (a.statementReceiptId && world.movements.some((m) => m.statementReceiptId === a.statementReceiptId)) {
        throw new Error('unique violation: wallet_movements_statementReceiptId_key');
      }
      world.movements.push({ statementReceiptId: a.statementReceiptId ?? null, amount: a.amount });
      log('recordMovement', a);
      return { id: `mv-${world.movements.length}` };
    }),
    receiptGap: vi.fn(),
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
  runMatching: async () => ({ matched: 0 }),
}));
vi.mock('@/lib/wallets', async (orig) => ({
  ...(await orig<typeof import('@/lib/wallets')>()),
  recordMovement: (...a: unknown[]) => recordMovement(...(a as [unknown, { statementReceiptId?: string; amount: number }])),
}));
vi.mock('@/lib/commission', async (orig) => ({
  ...(await orig<typeof import('@/lib/commission')>()),
  markPayableForOrders: async (_tx: unknown, _companyId: string, ids: string[]) => {
    world.log.push({ op: 'markPayableForOrders', args: { ids } });
    world.payable.push(...ids);
    return 0;
  },
}));
vi.mock('@/lib/stock-consumption', () => ({
  consumeOrderStock: async (_tx: unknown, a: { orderId: string }) => {
    if (world.failStockFor === a.orderId) throw Object.assign(new Error('stock write refused'), { code: 'P2034' });
    world.log.push({ op: 'consumeOrderStock', args: a });
    world.stock.push(a.orderId);
  },
}));

import { PATCH } from './[id]/route';
import { POST as CLOSE } from './[id]/close/route';
import { POST as SETTLE_CLEAN } from './[id]/settle-clean/route';
import { forgetPerLineSwitch } from '@/lib/per-line-settlement-switch';
import { EARLY_STEP_CAP, cleanPendingRows, earlyAnswer, settleCleanLines, settleStatement } from '@/lib/statement-close';

const params = () => ({ params: Promise.resolve({ id: world.identity.id }) });
const send = (method: string, body?: unknown) =>
  new Request('http://localhost/x', { method, headers: { 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
const approve = () => PATCH(send('PATCH', { approve: true }), params());
const close = (body: unknown = {}) => CLOSE(send('POST', body), params());
const press = () => SETTLE_CLEAN(send('POST'), params());

const order = (id: string, over: Partial<WOrder> = {}): WOrder => ({
  id, orderNumber: `ORD-${id}`, shippingStatus: 'DELIVERED', settlementStatus: 'PENDING_COLLECTION',
  openRequest: false, collectedAmount: null, customerId: `cu-${id}`,
  deliveredAt: new Date('2026-10-18T09:00:00Z'), moderatorId: 'u-mod', confirmedById: 'u-conf', version: 1, ...over,
});
const row = (id: string, orderId: string | null, over: WRow = {}): WRow => ({
  id, orderId, result: 'MATCHED', resolution: null, resolutionNote: null, resolvedById: null,
  expectedAmount: 20, expectedFee: 5, statementAmount: 20, statementFee: 5, appliedAt: null,
  order: orderId ? { orderNumber: `ORD-${orderId}`, settlementMatches: [] } : null,
  ...over,
});
/** A difference nobody answered — the line that holds the matching open. */
const question = (id: string, orderId: string) =>
  row(id, orderId, { result: 'MISMATCHED', expectedAmount: 25, statementAmount: 24 });
/** A difference answered «اعتُمد رقم الشركة», with a real reason. */
const accepted = (id: string, orderId: string, over: WRow = {}) =>
  row(id, orderId, {
    result: 'MISMATCHED', resolution: 'ACCEPTED_COURIER', resolutionNote: 'خصم أعطاه الموظف للزبون', resolvedById: 'u-decider',
    expectedAmount: 25, statementAmount: 24, expectedFee: 5, statementFee: 5, ...over,
  });

/** The statement approved with the switch OFF, as every statement was before it existed — then the switch is turned ON. */
async function approvedBeforeTheSwitch() {
  world.switchOn = false;
  forgetPerLineSwitch();
  await approve();
  world.switchOn = true;
  forgetPerLineSwitch();
}

const settledIds = () => [...world.orders.values()].filter((o) => o.settlementStatus === 'SETTLED').map((o) => o.id).sort();
const marked = () => world.rows.filter((r) => r.appliedAt).map((r) => r.id).sort();
const effects = () => world.log.filter((e) => e.op !== 'logAudit');
const ops = (op: string) => world.log.filter((e) => e.op === op);
const activitiesOf = (action: string) => world.activities.filter((a) => a.action === action).map((a) => a.orderId).sort();
const audit = (action: string) => world.audits.filter((a) => a.action === action);

beforeEach(() => {
  vi.clearAllMocks();
  resetWorld();
  forgetPerLineSwitch();
  // The step reports an undone failure with one line in the log; the tests below read it from the answer instead.
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
  requireContext.mockResolvedValue({
    user: { id: 'u-approver', name: 'المحاسب' }, companyId: 'c1', storeId: 's1', country: { minorUnit: 2, currencyCode: 'USD' },
  });
  requirePermission.mockResolvedValue({});
  receiptGap.mockResolvedValue({ claimed: 80000, received: 80000, gap: 0, needsExplanation: false, explained: false, unconvertible: 0 });
  world.receipts = [{ id: 'r1', walletId: 'w-syp', amount: 80000 }];
});

/**
 * The statement of the owner’s complaint: three clean lines (two parcels still on the road, one our door already delivered), one
 * line that is a question nobody answered, and one more clean line on a parcel somebody else already collected by hand.
 */
function oneQuestionAmongClean() {
  for (const o of [
    order('oA', { shippingStatus: 'OUT_FOR_DELIVERY', deliveredAt: null }),
    order('oB'),
    order('oC', { shippingStatus: 'SHIPPED', deliveredAt: null }),
    order('oQ'),
  ]) world.orders.set(o.id, o);
  world.rows = [
    row('mA', 'oA', { expectedAmount: 20, statementAmount: 20 }),
    row('mB', 'oB', { expectedAmount: 25, statementAmount: 25 }),
    row('mC', 'oC', { expectedAmount: 35, statementAmount: 35 }),
    question('mQ', 'oQ'),
  ];
}

/* ───────────────────────────── 1 · THE SWITCH OFF: the approval is what it was ───────────────────────────── */

describe('the switch OFF — a line still a question holds every order, as it always did', () => {
  it('posts the money, settles NOTHING, and writes nothing the early step would: no savepoint, no mark, no new field in the answer', async () => {
    oneQuestionAmongClean();
    const res = await approve();
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({ matchingClosed: false, openLines: 1, settledOrders: 0, deliveredByStatement: 0, claimsOpened: 0 });
    expect(body).not.toHaveProperty('earlySettlement');
    expect(world.movements).toEqual([{ statementReceiptId: 'r1', amount: 80000 }]);
    expect(settledIds()).toEqual([]);
    expect(marked()).toEqual([]);
    expect(world.sql.filter((s) => /SAVEPOINT/.test(s))).toEqual([]);
    expect(ops('settlementMatch.updateMany')).toEqual([]);
    expect(audit('STATEMENT_APPROVED')[0].newData).not.toHaveProperty('perLineSettlement');
  });

  it('and a switch that cannot be read is OFF too — an error never turns an experiment on', async () => {
    oneQuestionAmongClean();
    world.switchOn = true;
    world.switchBroken = true;
    const res = await approve();
    expect(res.status).toBe(200);
    expect(settledIds()).toEqual([]);
    expect(world.sql.filter((s) => /SAVEPOINT/.test(s))).toEqual([]);
  });

  it('the close after it settles every order in one press, exactly as before', async () => {
    oneQuestionAmongClean();
    await approve();
    world.rows[3] = { ...world.rows[3], resolution: 'UNDER_REVIEW', resolutionNote: 'نراجع مع الشركة', resolvedById: 'u-decider' };
    const res = await close();
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({ matchingClosed: true, settledOrders: 3, deliveredByStatement: 2 });
    expect(body).not.toHaveProperty('settledEarlier');
    expect(settledIds()).toEqual(['oA', 'oB', 'oC']);
    expect(marked()).toEqual([]);
  });
});

/* ───────────────────────────── 2 · THE SWITCH ON: the clean lines settle at the press ───────────────────────────── */

describe('the switch ON — the approval settles the clean lines and leaves the question with its own order', () => {
  beforeEach(() => {
    world.switchOn = true;
  });

  it('the three clean orders are settled at the press — the two on the road delivered, stock out once, commission payable — and the question’s order waits', async () => {
    oneQuestionAmongClean();
    const res = await approve();
    expect(res.status).toBe(200);
    expect(settledIds()).toEqual(['oA', 'oB', 'oC']);
    // The parcels on the road are delivered BY THE STATEMENT (dated its period’s end); the one our door delivered keeps its own date.
    expect(world.orders.get('oA')!.shippingStatus).toBe('DELIVERED');
    expect(world.orders.get('oC')!.shippingStatus).toBe('DELIVERED');
    expect(world.orders.get('oA')!.deliveredAt).toEqual(new Date('2026-10-20T00:00:00Z'));
    expect(world.orders.get('oB')!.deliveredAt).toEqual(new Date('2026-10-18T09:00:00Z'));
    // The money written on the order is the gross: the net plus the fee the courier kept.
    expect(world.orders.get('oA')!.collectedAmount).toBe(25);
    expect(world.orders.get('oB')!.collectedAmount).toBe(30);
    expect(world.orders.get('oC')!.collectedAmount).toBe(40);
    expect(world.stock.sort()).toEqual(['oA', 'oC']);
    expect(world.payable.sort()).toEqual(['oA', 'oB', 'oC']);
    expect(activitiesOf('DELIVERED_BY_STATEMENT')).toEqual(['oA', 'oC']);
    expect(world.customers.get('cu-oA')).toEqual({ deliveredOrders: 1, totalPurchaseValue: 25 });
    // …and the question’s order is untouched in every way.
    expect(world.orders.get('oQ')).toEqual(order('oQ'));
    expect(world.payable).not.toContain('oQ');
    expect(world.stock).not.toContain('oQ');
  });

  it('every settled row is marked applied with the moment of the approval; the question’s row is not', async () => {
    oneQuestionAmongClean();
    await approve();
    expect(marked()).toEqual(['mA', 'mB', 'mC']);
    expect(world.rows.find((r) => r.id === 'mA')!.appliedAt).toEqual(world.statement.approvedAt);
    expect(world.rows.find((r) => r.id === 'mQ')!.appliedAt).toBeNull();
  });

  it('the money is posted FIRST and is exactly what it is with the switch off: one IN per receipt', async () => {
    oneQuestionAmongClean();
    await approve();
    expect(world.movements).toEqual([{ statementReceiptId: 'r1', amount: 80000 }]);
    const order_ = world.log.map((e) => e.op);
    expect(order_.indexOf('recordMovement')).toBeGreaterThan(-1);
    expect(order_.indexOf('recordMovement')).toBeLessThan(order_.indexOf('order.updateMany'));
    expect(order_.indexOf('recordMovement')).toBeLessThan(order_.indexOf('markPayableForOrders'));
  });

  it('the answer keeps every field it had — and ADDS one: what was settled early', async () => {
    oneQuestionAmongClean();
    const body = await (await approve()).json();
    // The fields of the answer are what the same press says with the switch off (the matching is still open).
    expect(body).toMatchObject({ matchingClosed: false, openLines: 1, settledOrders: 0, deliveredByStatement: 0, claimsOpened: 0 });
    expect(body.earlySettlement).toEqual({
      ran: true, settled: 3, delivered: 2, heldBack: [], failed: false, message: 'تسوّى 3 طلب نظيف مع الاعتماد',
    });
  });

  it('writes the early step on the approval’s audit row — and only there', async () => {
    oneQuestionAmongClean();
    await approve();
    expect(audit('STATEMENT_APPROVED')[0].newData).toMatchObject({
      matchingClosed: false, openLines: 1, settled: 0,
      perLineSettlement: { ran: true, settled: 3, delivered: 2, heldBack: [], failed: false },
    });
  });

  it('rows that are NOT clean are not touched by the press: an accepted figure, a claim kept, a parked line, an excluded one, a line with no order', async () => {
    for (const o of [order('oA'), order('oAcc'), order('oOurs'), order('oPark'), order('oEx', { shippingStatus: 'RETURN_REQUESTED' }), order('oQ')]) world.orders.set(o.id, o);
    world.rows = [
      row('mA', 'oA'),
      accepted('mAcc', 'oAcc'),
      row('mOurs', 'oOurs', { result: 'MISMATCHED', resolution: 'OURS_STANDS', resolutionNote: 'نطالب الشركة بالباقي', expectedAmount: 25, statementAmount: 20 }),
      row('mPark', 'oPark', { result: 'MISMATCHED', resolution: 'UNDER_REVIEW', resolutionNote: 'نراجع مع الشركة', expectedAmount: 25, statementAmount: 0 }),
      row('mEx', 'oEx', { result: 'EXCLUDED', statementAmount: 0, expectedAmount: null }),
      row('mX', null, { result: 'MISSING_IN_SYSTEM', expectedAmount: null }),
      question('mQ', 'oQ'),
    ];
    const body = await (await approve()).json();
    expect(body.earlySettlement).toMatchObject({ ran: true, settled: 1, delivered: 0 });
    expect(settledIds()).toEqual(['oA']);
    expect(marked()).toEqual(['mA']);
    // None of the close’s own writes happened: no decision sentence, no claim opened, no shortfall, no commission for them.
    expect(activitiesOf('SETTLEMENT_DECISION_APPLIED')).toEqual([]);
    expect(activitiesOf('SETTLEMENT_CLAIM_OPENED')).toEqual([]);
    expect(world.penalties).toEqual([]);
    expect(world.payable).toEqual(['oA']);
  });

  it('with NO line left to answer the approval closes the matching at once — the early step has nothing to add and does not run', async () => {
    for (const o of [order('oA', { shippingStatus: 'SHIPPED', deliveredAt: null }), order('oB')]) world.orders.set(o.id, o);
    world.rows = [row('mA', 'oA'), row('mB', 'oB')];
    const res = await approve();
    const body = await res.json();
    expect(body).toMatchObject({ matchingClosed: true, openLines: 0, settledOrders: 2, deliveredByStatement: 1 });
    expect(body).not.toHaveProperty('earlySettlement');
    expect(world.sql.filter((s) => /SAVEPOINT/.test(s))).toEqual([]);
    expect(marked()).toEqual([]);
    expect(audit('STATEMENT_APPROVED')[0].newData.perLineSettlement).toEqual({ ran: false });
  });

  it('…and writes, effect for effect, what the switch off writes for the same statement', async () => {
    const build = () => {
      resetWorld();
      world.receipts = [{ id: 'r1', walletId: 'w-syp', amount: 80000 }];
      for (const o of [order('oA', { shippingStatus: 'SHIPPED', deliveredAt: null }), order('oB'), order('oC')]) world.orders.set(o.id, o);
      world.door.set('oC', 'u-door');
      world.rows = [
        row('mA', 'oA'), row('mB', 'oB'),
        accepted('mC', 'oC', { expectedAmount: 35, statementAmount: 30 }),
        row('mX', null, { result: 'MISSING_IN_SYSTEM', resolution: 'UNDER_REVIEW', resolutionNote: 'سطر لشركة ثانية', expectedAmount: null }),
      ];
    };
    build();
    world.switchOn = false;
    forgetPerLineSwitch();
    await approve();
    const off = JSON.stringify(effects());
    build();
    world.switchOn = true;
    forgetPerLineSwitch();
    await approve();
    expect(JSON.stringify(effects())).toBe(off);
  });
});

/* ───────────────────────────── 3 · S3: A ROW THAT CANNOT BE SETTLED NOW IS LEFT — THE APPROVAL AND ITS MONEY STAND ───────────────────────────── */

describe('a clean line whose order cannot be settled now is LEFT for the close — the approval never fails and the money is never rolled back', () => {
  beforeEach(() => {
    world.switchOn = true;
    oneQuestionAmongClean();
  });

  it('an order collected by hand meanwhile: left, named with the reason, unmarked — the others settle and the approval answers 200', async () => {
    world.orders.get('oB')!.settlementStatus = 'SETTLED';
    const res = await approve();
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.earlySettlement).toMatchObject({
      settled: 2, heldBack: [{ orderNumber: 'ORD-oB', why: 'سُوِّي بباب آخر (تحصيل يدوي أو كشف ثاني)' }],
    });
    expect(marked()).toEqual(['mA', 'mC']);
    expect(world.payable.sort()).toEqual(['oA', 'oC']);
    expect(world.movements).toHaveLength(1);
    expect(world.statement.approvedAt).not.toBeNull();
  });

  it('an order with a cancel asked for: left, with its own reason', async () => {
    world.orders.get('oC')!.openRequest = true;
    const body = await (await approve()).json();
    expect(body.earlySettlement).toMatchObject({ settled: 2, heldBack: [{ orderNumber: 'ORD-oC', why: 'عليه طلب إلغاء أو تأجيل مفتوح' }] });
    expect(settledIds()).toEqual(['oA', 'oB']);
    expect(world.orders.get('oC')!.shippingStatus).toBe('SHIPPED');
    expect(world.stock).toEqual(['oA']);
  });

  it('an order that changes BETWEEN the read and the claim (a door that gets in): the claim takes nothing, the order is left, the approval stands', async () => {
    world.beforeClaim = (id) => {
      if (id === 'oA') world.orders.get('oA')!.settlementStatus = 'SETTLED';
    };
    const res = await approve();
    expect(res.status).toBe(200);
    expect((await res.json()).earlySettlement).toMatchObject({ settled: 2, heldBack: [{ orderNumber: 'ORD-oA' }] });
    expect(world.orders.get('oA')!.shippingStatus).toBe('OUT_FOR_DELIVERY');
    expect(marked()).toEqual(['mB', 'mC']);
    expect(world.movements).toHaveLength(1);
  });

  it('EVERY clean order unsettlable: nothing is settled, nothing is marked, the money is still posted and the approval answers 200', async () => {
    for (const o of world.orders.values()) if (o.id !== 'oQ') o.settlementStatus = 'SETTLED';
    const res = await approve();
    expect(res.status).toBe(200);
    expect((await res.json()).earlySettlement).toMatchObject({ ran: true, settled: 0, delivered: 0, failed: false });
    expect(marked()).toEqual([]);
    expect(world.movements).toEqual([{ statementReceiptId: 'r1', amount: 80000 }]);
    expect(world.stock).toEqual([]);
  });

  it('an order two clean lines name that is left is left once, by both rows', async () => {
    world.rows.push(row('mB2', 'oB'));
    world.orders.get('oB')!.settlementStatus = 'SETTLED';
    const body = await (await approve()).json();
    expect(body.earlySettlement.heldBack).toEqual([{ orderNumber: 'ORD-oB', why: 'سُوِّي بباب آخر (تحصيل يدوي أو كشف ثاني)' }]);
    expect(marked()).toEqual(['mA', 'mC']);
  });

  it('an error nobody expected inside the step (the stock write is refused): everything the step wrote is undone to its savepoint, the approval and its money go on', async () => {
    world.failStockFor = 'oC';
    const res = await approve();
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.earlySettlement).toMatchObject({ ran: true, settled: 0, failed: true, failure: 'Error' });
    expect(body.earlySettlement.message).toBe('تعذّرت تسوية الطلبات النظيفة مع الاعتماد — بتتسوّى كلها عند «إغلاق المطابقة»');
    // Nothing of the step remains — not the claims taken before the failure, not a mark, not a commission, not a counter.
    expect(settledIds()).toEqual([]);
    expect(marked()).toEqual([]);
    expect(world.payable).toEqual([]);
    expect(world.stock).toEqual([]);
    expect(world.customers.size).toBe(0);
    expect(activitiesOf('DELIVERED_BY_STATEMENT')).toEqual([]);
    expect(world.orders.get('oA')!.shippingStatus).toBe('OUT_FOR_DELIVERY');
    // The approval is whole: the money, the stamp, the answer, the audit row that says what happened.
    expect(world.movements).toEqual([{ statementReceiptId: 'r1', amount: 80000 }]);
    expect(world.statement.approvedAt).not.toBeNull();
    expect(audit('STATEMENT_APPROVED')[0].newData.perLineSettlement).toMatchObject({ ran: true, failed: true });
  });

  it('the savepoint is taken BEFORE the first write of the step and released after its last — and rolled back to on a failure', async () => {
    await approve();
    const kinds = world.sql.filter((s) => /SAVEPOINT/.test(s));
    expect(kinds).toEqual(['SAVEPOINT per_line_settlement', 'RELEASE SAVEPOINT per_line_settlement']);
    world.sql = [];
    resetWorld();
    forgetPerLineSwitch();
    world.switchOn = true;
    world.receipts = [{ id: 'r1', walletId: 'w-syp', amount: 80000 }];
    oneQuestionAmongClean();
    world.failStockFor = 'oC';
    await approve();
    expect(world.sql.filter((s) => /SAVEPOINT/.test(s))).toEqual(['SAVEPOINT per_line_settlement', 'ROLLBACK TO SAVEPOINT per_line_settlement']);
  });

  it('the rows the step could not settle are settled by the close — or the close reports them as it always did', async () => {
    world.orders.get('oB')!.settlementStatus = 'SETTLED'; // collected by hand before the approval
    await approve();
    world.rows[3] = { ...world.rows[3], resolution: 'UNDER_REVIEW', resolutionNote: 'نراجع', resolvedById: 'u-decider' };
    const res = await close();
    // The clean row of oB is still a clean row with a settled order: the close stops on it, by name, exactly as the old close did.
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ code: 'ORDERS_CHANGED', orders: ['ORD-oB'] });
    expect(world.statement.matchingClosedAt).toBeNull();
    // …and the two applied rows are untouched by the failed close (it rolled back what it wrote, nothing of the early step).
    expect(marked()).toEqual(['mA', 'mC']);
    expect(settledIds()).toEqual(['oA', 'oB', 'oC']);
  });
});

/* ───────────────────────────── 4 · S4: THE MARK, AND THE CLOSE THAT SKIPS WHAT IS APPLIED ───────────────────────────── */

describe('the close settles the rest and leaves the applied rows alone — nothing is settled, delivered or counted twice', () => {
  beforeEach(() => {
    world.switchOn = true;
    oneQuestionAmongClean();
  });

  it('after the line is answered the close settles the question’s order and ONLY it: the applied orders are not claimed again', async () => {
    await approve();
    const claimsBefore = ops('order.updateMany').length;
    world.rows[3] = { ...world.rows[3], resolution: 'ACCEPTED_COURIER', resolutionNote: 'خصم أعطاه الموظف للزبون', resolvedById: 'u-decider' };
    world.door.set('oQ', 'u-door');
    const res = await close({});
    expect(res.status).toBe(200);
    expect(settledIds()).toEqual(['oA', 'oB', 'oC', 'oQ']);
    const closeClaims = ops('order.updateMany').slice(claimsBefore);
    expect(closeClaims).toHaveLength(1);
    expect((closeClaims[0].args as any).where.id.in).toEqual(['oQ']);
    expect(world.stock.sort()).toEqual(['oA', 'oC']); // oQ was delivered by our own door already; nothing is counted out twice
  });

  it('the answer counts every settled order of the statement — the number the same statement gives with the switch off — and says how many were settled earlier', async () => {
    await approve();
    world.rows[3] = { ...world.rows[3], resolution: 'UNDER_REVIEW', resolutionNote: 'نراجع', resolvedById: 'u-decider' };
    const body = await (await close()).json();
    expect(body).toMatchObject({ matchingClosed: true, settledOrders: 3, settledEarlier: 3, deliveredByStatement: 0, claimsOpened: 0 });
    expect(audit('STATEMENT_MATCHING_CLOSED')[0].newData).toMatchObject({ settled: 3, settledEarlier: 3 });
  });

  it('the close writes no money, and no second delivery, no second counter, no second commission for the applied orders', async () => {
    await approve();
    const moneyBefore = recordMovement.mock.calls.length;
    const activitiesBefore = world.activities.length;
    world.rows[3] = { ...world.rows[3], resolution: 'UNDER_REVIEW', resolutionNote: 'نراجع', resolvedById: 'u-decider' };
    await close();
    expect(recordMovement.mock.calls.length).toBe(moneyBefore);
    expect(world.activities.length).toBe(activitiesBefore);
    expect(world.payable.sort()).toEqual(['oA', 'oB', 'oC']);
    expect(world.customers.get('cu-oA')).toEqual({ deliveredOrders: 1, totalPurchaseValue: 25 });
  });

  it('an order named by an applied clean row AND by a decision on another line is settled once: the decision is not carried out on top of it', async () => {
    world.rows.push(accepted('mA2', 'oA', { expectedAmount: 20, statementAmount: 20 }));
    await approve();
    world.rows[3] = { ...world.rows[3], resolution: 'UNDER_REVIEW', resolutionNote: 'نراجع', resolvedById: 'u-decider' };
    const res = await close();
    expect(res.status).toBe(200);
    expect(activitiesOf('SETTLEMENT_DECISION_APPLIED')).toEqual([]);
    expect(world.penalties).toEqual([]);
  });

  it('an order two CLEAN lines name is settled once, and both rows are marked — so the close skips the order, not just one row', async () => {
    world.rows.push(row('mA2', 'oA'));
    await approve();
    expect(marked()).toEqual(['mA', 'mA2', 'mB', 'mC']);
    expect(world.stock.filter((id) => id === 'oA')).toHaveLength(1);
    world.rows[3] = { ...world.rows[3], resolution: 'UNDER_REVIEW', resolutionNote: 'نراجع', resolvedById: 'u-decider' };
    expect((await close()).status).toBe(200);
  });

  it('only one of two rows for an order is applied (a row added later): the close still skips the ORDER — it is settled', async () => {
    await approve();
    world.rows.push(row('mA3', 'oA')); // a clean row that appeared after the press, for an order already settled
    world.rows[3] = { ...world.rows[3], resolution: 'UNDER_REVIEW', resolutionNote: 'نراجع', resolvedById: 'u-decider' };
    const res = await close();
    expect(res.status).toBe(200);
    expect(world.stock.filter((id) => id === 'oA')).toHaveLength(1);
  });

  it('a claim paid by an earlier statement: the early step writes the same amount the close would (the earlier gross plus this net)', async () => {
    world.rows[0] = row('mA', 'oA', {
      expectedAmount: 8, statementAmount: 8, statementFee: 0,
      order: { orderNumber: 'ORD-oA', settlementMatches: [{ statementAmount: 12, statementFee: 5 }] },
    });
    await approve();
    expect(world.orders.get('oA')!.collectedAmount).toBe(25); // 12 + 5 earlier, + 8 now
  });

  it('an order our own door delivered by hand keeps its status and date and is given its amount — in the early step, as at the close', async () => {
    await approve();
    const b = world.orders.get('oB')!;
    expect(b.shippingStatus).toBe('DELIVERED');
    expect(b.deliveredAt).toEqual(new Date('2026-10-18T09:00:00Z'));
    expect(b.collectedAmount).toBe(30);
    expect(b.version).toBe(2);
    expect(world.stock).not.toContain('oB');
  });

  it('a zero line on a delivered order is clean and is settled at its zero', async () => {
    world.orders.set('oZ', order('oZ'));
    world.rows.push(row('mZ', 'oZ', { expectedAmount: 0, expectedFee: 0, statementAmount: 0, statementFee: 0 }));
    await approve();
    expect(world.orders.get('oZ')!.settlementStatus).toBe('SETTLED');
    expect(world.orders.get('oZ')!.collectedAmount).toBe(0);
    expect(marked()).toContain('mZ');
  });

  it('a partly delivered order is settled and given its amount without being promoted to a full delivery', async () => {
    world.orders.set('oP', order('oP', { shippingStatus: 'PARTIALLY_DELIVERED' }));
    world.rows.push(row('mP', 'oP', { expectedAmount: 12, statementAmount: 12, statementFee: 0 }));
    await approve();
    expect(world.orders.get('oP')!.shippingStatus).toBe('PARTIALLY_DELIVERED');
    expect(world.orders.get('oP')!.collectedAmount).toBe(12);
    expect(world.stock).not.toContain('oP');
  });
});

/* ───────────────────────────── 5 · TWO PRESSES, A STATEMENT APPROVED BEFORE THE SWITCH ───────────────────────────── */

describe('a statement approved BEFORE the switch was turned on — nothing happens by itself; the press does the same step', () => {
  beforeEach(() => {
    oneQuestionAmongClean();
  });

  it('approved with the switch off: nothing is settled, nothing is marked; turning the switch on later changes nothing by itself', async () => {
    await approve();
    world.switchOn = true;
    forgetPerLineSwitch();
    expect(settledIds()).toEqual([]);
    expect(marked()).toEqual([]);
  });

  it('the close of such a statement behaves exactly as today — it has no applied row to skip', async () => {
    await approve();
    world.switchOn = true;
    forgetPerLineSwitch();
    world.rows[3] = { ...world.rows[3], resolution: 'UNDER_REVIEW', resolutionNote: 'نراجع', resolvedById: 'u-decider' };
    const body = await (await close()).json();
    expect(body).toMatchObject({ settledOrders: 3, deliveredByStatement: 2 });
    expect(body).not.toHaveProperty('settledEarlier');
  });

  it('the press settles its clean lines now; the close then settles the rest — and the end is the same as the one-shot close', async () => {
    await approve();
    world.switchOn = true;
    forgetPerLineSwitch();
    const pressed = await press();
    expect(pressed.status).toBe(200);
    expect(await pressed.json()).toMatchObject({ settled: 3, delivered: 2, heldBack: 0, message: 'تسوّى 3 طلب نظيف' });
    expect(marked()).toEqual(['mA', 'mB', 'mC']);
    world.rows[3] = { ...world.rows[3], resolution: 'UNDER_REVIEW', resolutionNote: 'نراجع', resolvedById: 'u-decider' };
    await close();
    expect(settledIds()).toEqual(['oA', 'oB', 'oC']);
    expect(world.stock.sort()).toEqual(['oA', 'oC']);
  });

  it('moves no money: the wallet holds what the approval wrote, once', async () => {
    await approve();
    world.switchOn = true;
    forgetPerLineSwitch();
    const before = recordMovement.mock.calls.length;
    await press();
    expect(recordMovement.mock.calls.length).toBe(before);
    expect(world.movements).toHaveLength(1);
  });

  it('pressed twice: the second finds nothing left to settle and writes nothing', async () => {
    await approve();
    world.switchOn = true;
    forgetPerLineSwitch();
    await press();
    const logged = world.log.length;
    const again = await press();
    expect(again.status).toBe(200);
    expect(await again.json()).toMatchObject({ settled: 0, heldBack: 0, rows: [], message: 'ما في طلبات نظيفة بتنتظر التسوية' });
    expect(world.log.length).toBe(logged);
  });

  it('a per-row report: the settled and the left, each with the order number and the reason', async () => {
    await approve();
    world.switchOn = true;
    forgetPerLineSwitch();
    world.orders.get('oB')!.settlementStatus = 'SETTLED';
    world.orders.get('oC')!.openRequest = true;
    const body = await (await press()).json();
    expect(body.rows).toEqual([
      { matchId: 'mA', orderNumber: 'ORD-oA', outcome: 'SETTLED', why: null },
      { matchId: 'mB', orderNumber: 'ORD-oB', outcome: 'HELD_BACK', why: 'سُوِّي بباب آخر (تحصيل يدوي أو كشف ثاني)' },
      { matchId: 'mC', orderNumber: 'ORD-oC', outcome: 'HELD_BACK', why: 'عليه طلب إلغاء أو تأجيل مفتوح' },
    ]);
    expect(body).toMatchObject({ settled: 1, heldBack: 2, message: 'تسوّى 1 طلب نظيف، و2 بقوا للإغلاق (تغيّر وضعهم)' });
  });

  it('writes its own audit row, with who and what', async () => {
    await approve();
    world.switchOn = true;
    forgetPerLineSwitch();
    await press();
    expect(audit('STATEMENT_CLEAN_LINES_SETTLED')[0].newData).toMatchObject({ reference: 'ST-1', ran: true, settled: 3, delivered: 2, failed: false });
  });

  it('a step that fails undoes itself and the press says so: a plain refusal, nothing written, no audit row', async () => {
    await approve();
    world.switchOn = true;
    forgetPerLineSwitch();
    world.failStockFor = 'oC';
    const res = await press();
    expect(res.status).toBe(409);
    expect((await res.json()).code).toBe('CLEAN_SETTLE_FAILED');
    expect(settledIds()).toEqual([]);
    expect(marked()).toEqual([]);
    expect(audit('STATEMENT_CLEAN_LINES_SETTLED')).toEqual([]);
  });
});

/* ───────────────────────────── 6 · THE PRESS'S GATES ───────────────────────────── */

describe('«سوّي الطلبات النظيفة هلّق» — its gates, in the order a person meets them', () => {
  beforeEach(() => {
    oneQuestionAmongClean();
  });

  it('asks the close’s own key — and a refusal of the key writes nothing', async () => {
    await approvedBeforeTheSwitch();
    requirePermission.mockClear();
    requirePermission.mockRejectedValueOnce(Object.assign(new Error('FORBIDDEN'), { status: 403 }));
    const res = await press();
    expect(requirePermission).toHaveBeenCalledWith('settlement.approve');
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(marked()).toEqual([]);
    expect(settledIds()).toEqual([]);
  });

  it('the switch OFF: refused with its own sentence, and not even a transaction is opened', async () => {
    await approve();
    db.$transaction.mockClear();
    const res = await press();
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ code: 'PER_LINE_OFF', error: 'مفتاح «تسوية السطور النظيفة عند الاعتماد» مطفي — شغّله من الإعدادات أول' });
    expect(db.$transaction).not.toHaveBeenCalled();
  });

  it('a statement whose money is not posted: refused — the orders are never settled on cash that has not arrived', async () => {
    world.switchOn = true;
    const res = await press();
    expect(res.status).toBe(409);
    expect((await res.json()).code).toBe('MONEY_NOT_POSTED');
    expect(db.$transaction).not.toHaveBeenCalled();
    expect(settledIds()).toEqual([]);
  });

  it('a statement whose matching is closed: refused, and nothing is written', async () => {
    world.switchOn = true;
    await approve();
    world.rows[3] = { ...world.rows[3], resolution: 'UNDER_REVIEW', resolutionNote: 'نراجع', resolvedById: 'u-decider' };
    await close();
    const logged = world.log.length;
    const res = await press();
    expect(res.status).toBe(409);
    expect((await res.json()).code).toBe('MATCHING_ALREADY_CLOSED');
    expect(world.log.length).toBe(logged);
  });

  it('a statement the matching closed between the read and the lock: refused after the lock, which is taken before anything is read', async () => {
    await approvedBeforeTheSwitch();
    const real = db.courierStatement.findFirst.getMockImplementation()! as (a?: unknown) => Promise<Record<string, unknown>>;
    world.sql = [];
    let reads = 0;
    db.courierStatement.findFirst.mockImplementation((async (a: unknown) => {
      reads += 1;
      // The read before the act sees it open; the read after the lock sees it closed.
      return reads === 1 ? await real(a) : { ...(await real(a)), matchingClosedAt: new Date() };
    }) as never);
    try {
      const res = await press();
      expect(res.status).toBe(409);
      expect((await res.json()).code).toBe('MATCHING_ALREADY_CLOSED');
      expect(world.sql[0]).toContain('FOR UPDATE');
      expect(marked()).toEqual([]);
    } finally {
      db.courierStatement.findFirst.mockImplementation(real as never);
    }
  });

  it('a statement the old approval settled during a Redeploy (movements that name no receipt): refused — its orders are settled already', async () => {
    world.switchOn = true;
    world.statement = { approvedAt: new Date('2026-11-02T08:00:00Z'), matchingClosedAt: null, status: 'APPROVED', fileHash: 'ab'.repeat(32) };
    world.movements = [{ statementReceiptId: null, amount: 20 }];
    const res = await press();
    expect(res.status).toBe(409);
    expect((await res.json()).code).toBe('APPROVED_BEFORE_THE_SPLIT');
    expect(marked()).toEqual([]);
  });

  it('a statement of another store or company: 404', async () => {
    world.switchOn = true;
    db.courierStatement.findFirst.mockResolvedValueOnce(null as never);
    expect((await press()).status).toBe(404);
  });
});

/* ───────────────────────────── 7 · TWO PRESSES OF THE APPROVAL ───────────────────────────── */

describe('one approval, however many presses', () => {
  it('the second press is refused and the early step ran once: the wallet holds the money once and each order is delivered once', async () => {
    world.switchOn = true;
    oneQuestionAmongClean();
    await approve();
    const again = await approve();
    expect(again.status).toBe(409);
    expect((await again.json()).code).toBe('ALREADY_APPROVED');
    expect(world.movements).toHaveLength(1);
    expect(world.stock.sort()).toEqual(['oA', 'oC']);
    expect(ops('markPayableForOrders')).toHaveLength(1);
  });

  it('NEGATIVE — with no line left to answer the switch ON closes in the same transaction exactly as OFF does: a changed order stops the whole approval (409) and rolls the money back', async () => {
    world.switchOn = true;
    for (const o of [order('oA', { shippingStatus: 'SHIPPED', deliveredAt: null }), order('oB')]) world.orders.set(o.id, o);
    world.rows = [row('mA', 'oA'), row('mB', 'oB')]; // no question: the matching closes in the same transaction
    world.orders.get('oB')!.settlementStatus = 'SETTLED';
    const res = await approve();
    expect(res.status).toBe(409);
    expect((await res.json()).code).toBe('ORDERS_CHANGED');
    expect(world.movements).toEqual([]);
    expect(world.statement.approvedAt).toBeNull();
    expect(settledIds()).toEqual(['oB']);
    expect(marked()).toEqual([]);
  });
});

/* ───────────────────────────── 8 · NOTHING ELSE MOVES (S9) — read from the source ───────────────────────────── */

describe('the early step writes no money and changes no rule — read from the source', () => {
  const src = (p: string) => stripComments(readFileSync(join(process.cwd(), p), 'utf8'));

  it.each([
    'src/lib/statement-close.ts',
    'src/app/api/finance/statements/[id]/settle-clean/route.ts',
    'src/lib/per-line-settlement-switch.ts',
  ])('%s imports no wallet writer and touches no movement', (file) => {
    const s = src(file);
    expect(s).not.toMatch(/from ['"](@\/lib|\.)\/wallets['"]/);
    expect(s).not.toMatch(/recordMovement|reverseMovement|reverseHandRows|payFromWallet/);
    expect(s).not.toMatch(/walletMovement\.(create|createMany|update|updateMany|upsert|delete|deleteMany)\(/);
  });

  it('in the approval the money is written first, then the early step, then the close — and the early step runs only while a line is a question', () => {
    const s = src('src/app/api/finance/statements/[id]/route.ts');
    const money = s.indexOf('recordMovement(');
    const early = s.indexOf('await settleCleanLines(');
    const closing = s.indexOf('await settleStatement(');
    expect(money).toBeGreaterThan(-1);
    expect(money).toBeLessThan(early);
    expect(early).toBeLessThan(closing);
    expect(s).toMatch(/if \(openLines > 0 && perLine\) \{\s*early = await settleCleanLines\(/);
  });

  it('the rule that decides which line is a question is untouched: the early step reads no open-line function', () => {
    expect(src('src/lib/statement-close.ts')).not.toMatch(/isOpenLine|countOpenLines|openLineWhere/);
    expect(src('src/lib/statement-open-lines.ts')).not.toMatch(/appliedAt/);
  });

  it('the sentences of the new words live on the server alone — no component imports them', () => {
    const found = spawnSync('git', ['grep', '-lE', "from ['\"].*per-line-settlement-words", '--', 'src/components'], { cwd: process.cwd(), encoding: 'utf8' });
    expect(found.stdout.trim()).toBe('');
  });
});

/* ───────────────────────────── 9 · THE ENGINE, CALLED DIRECTLY ───────────────────────────── */

describe('the engine called directly — the early step takes the clean rows and nothing else', () => {
  const input = (matches: WRow[], minorUnit = 2) => ({
    companyId: 'c1', storeId: 's1', userId: 'u1', minorUnit,
    statement: { id: 'st1', reference: 'ST-1', currencyCode: 'SYP', createdAt: new Date('2026-10-20T10:00:00Z'), periodTo: new Date('2026-10-20T00:00:00Z') },
    matches: matches as never,
  });

  it('the rows it is for: clean, with an order, not settled early yet — a difference, an excluded line, a line with no order and an applied row are not', () => {
    const rows = [
      row('a', 'oA'),
      row('b', 'oB', { appliedAt: new Date() }),
      row('c', 'oC', { result: 'MISMATCHED' }),
      row('d', 'oD', { result: 'EXCLUDED' }),
      row('e', null, { result: 'MISSING_IN_SYSTEM' }),
      row('f', 'oF'),
    ];
    expect(cleanPendingRows(rows as never).map((r) => r.id)).toEqual(['a', 'f']);
  });

  it('with no clean row waiting it does nothing at all: no savepoint, no read, no write', async () => {
    const out = await settleCleanLines(db as never, { ...input([question('q', 'oQ'), row('b', 'oB', { appliedAt: new Date() })]), at: new Date() });
    expect(out).toEqual({ ran: false, settled: 0, delivered: 0, heldBack: 0, remaining: 0, failed: false, failure: null, rows: [] });
    expect(world.sql).toEqual([]);
    expect(world.log).toEqual([]);
  });

  it('handed the rows of a decision or a claim by mistake, the early mode settles NONE of them — it has no accepted rows and opens no claim', async () => {
    for (const o of [order('oAcc'), order('oOurs')]) world.orders.set(o.id, o);
    const rows = [
      accepted('acc', 'oAcc'),
      row('ours', 'oOurs', { result: 'MISMATCHED', resolution: 'OURS_STANDS', resolutionNote: 'نطالب بالباقي', expectedAmount: 25, statementAmount: 20 }),
    ];
    const out = await settleStatement(db as never, { ...input(rows), early: { at: new Date() } });
    expect(out).toMatchObject({ settledCount: 0, acceptedCount: 0, claimCount: 0, deliveredCount: 0, heldBack: [] });
    expect(settledIds()).toEqual([]);
    expect(world.activities).toEqual([]);
    expect(world.penalties).toEqual([]);
  });

  it('an order whose claim takes nothing is reported as left, and never counted, marked or promoted', async () => {
    for (const o of [order('oA', { shippingStatus: 'SHIPPED', deliveredAt: null }), order('oB', { settlementStatus: 'SETTLED' })]) world.orders.set(o.id, o);
    world.rows = [row('mA', 'oA'), row('mB', 'oB')];
    const out = await settleStatement(db as never, { ...input(world.rows), early: { at: new Date('2026-11-09T10:00:00Z') } });
    expect(out).toMatchObject({ settledCount: 1, deliveredCount: 1, heldBack: ['oB'] });
    expect(marked()).toEqual(['mA']);
    expect(world.orders.get('oB')!.version).toBe(1);
  });

  it('a mark that comes up short (the row is gone) is a stop, not a shrug: the step throws and the savepoint undoes the claims it took', async () => {
    world.orders.set('oA', order('oA', { shippingStatus: 'SHIPPED', deliveredAt: null }));
    world.rows = [row('mA', 'oA'), question('mQ', 'oQ')];
    db.settlementMatch.updateMany.mockResolvedValueOnce({ count: 0 } as never);
    const out = await settleCleanLines(db as never, { ...input(world.rows), at: new Date() });
    expect(out).toMatchObject({ ran: true, failed: true, failure: 'Error', settled: 0 });
    expect(settledIds()).toEqual([]);
    expect(world.orders.get('oA')!.shippingStatus).toBe('SHIPPED');
    expect(world.sql).toEqual(['SAVEPOINT per_line_settlement', 'ROLLBACK TO SAVEPOINT per_line_settlement']);
  });

  it('the close called directly with only applied rows makes no claim at all and settles nothing', async () => {
    world.orders.set('oA', order('oA', { settlementStatus: 'SETTLED' }));
    const out = await settleStatement(db as never, input([row('mA', 'oA', { appliedAt: new Date() })]));
    expect(out).toMatchObject({ settledCount: 0, settledEarlier: 1, deliveredCount: 0 });
    expect(ops('order.updateMany')).toEqual([]);
  });

  it('the report says each order once, however many lines name it', () => {
    const answer = earlyAnswer({
      ran: true, settled: 0, delivered: 0, heldBack: 1, remaining: 0, failed: false, failure: null,
      rows: [
        { matchId: 'a', orderId: 'o1', orderNumber: 'ORD-1', outcome: 'HELD_BACK', why: 'x' },
        { matchId: 'b', orderId: 'o1', orderNumber: 'ORD-1', outcome: 'HELD_BACK', why: 'x' },
        { matchId: 'c', orderId: 'o2', orderNumber: 'ORD-2', outcome: 'SETTLED', why: null },
      ],
    });
    expect(answer.heldBack).toEqual([{ orderNumber: 'ORD-1', why: 'x' }]);
  });

  it.each([0, 2, 3])('the early step writes the same figure the close writes, in a currency of %i decimals', async (minorUnit) => {
    const build = () => {
      resetWorld();
      world.receipts = [{ id: 'r1', walletId: 'w1', amount: 100 }];
      world.orders.set('oA', order('oA', { shippingStatus: 'SHIPPED', deliveredAt: null }));
      world.orders.set('oQ', order('oQ'));
      world.rows = [
        row('mA', 'oA', {
          expectedAmount: 7.123, statementAmount: 7.123, statementFee: 1.5,
          order: { orderNumber: 'ORD-oA', settlementMatches: [{ statementAmount: 3.337, statementFee: 0.5 }] },
        }),
        question('mQ', 'oQ'),
      ];
      requireContext.mockResolvedValue({ user: { id: 'u-approver' }, companyId: 'c1', storeId: 's1', country: { minorUnit, currencyCode: 'USD' } });
    };
    build();
    world.switchOn = false;
    forgetPerLineSwitch();
    await approve();
    world.rows[1] = { ...world.rows[1], resolution: 'UNDER_REVIEW', resolutionNote: 'نراجع', resolvedById: 'u-decider' };
    await close();
    const off = world.orders.get('oA')!.collectedAmount;
    const offCustomer = world.customers.get('cu-oA');

    build();
    world.switchOn = true;
    forgetPerLineSwitch();
    await approve();
    expect(world.orders.get('oA')!.settlementStatus).toBe('SETTLED');
    expect(world.orders.get('oA')!.collectedAmount).toBe(off);
    expect(world.customers.get('cu-oA')).toEqual(offCustomer);
    expect(off).not.toBeNull();
  });
});

/* ───────────────────────────── 10 · A BIG STATEMENT DOES NOT SPEND THE APPROVAL'S WHOLE TRANSACTION ───────────────────────────── */

describe('a statement of more clean lines than one transaction should carry', () => {
  const big = (n: number) => {
    world.switchOn = true;
    world.receipts = [{ id: 'r1', walletId: 'w1', amount: 1000 }];
    for (let i = 0; i < n; i++) world.orders.set(`b${i}`, order(`b${i}`, { shippingStatus: 'SHIPPED', deliveredAt: null }));
    world.orders.set('oQ', order('oQ'));
    world.rows = [...Array.from({ length: n }, (_, i) => row(`m${i}`, `b${i}`)), question('mQ', 'oQ')];
  };

  it(`the approval settles the first ${EARLY_STEP_CAP} in the order of the file and says how many wait — the money is posted whole`, async () => {
    big(EARLY_STEP_CAP + 5);
    const res = await approve();
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.earlySettlement).toMatchObject({ ran: true, settled: EARLY_STEP_CAP, remaining: 5, failed: false });
    expect(body.earlySettlement.message).toBe(`تسوّى ${EARLY_STEP_CAP} طلب نظيف مع الاعتماد. بقي 5 نظيف — زر «سوّي الطلبات النظيفة»`);
    expect(marked()).toHaveLength(EARLY_STEP_CAP);
    expect(world.orders.get(`b${EARLY_STEP_CAP}`)!.settlementStatus).toBe('PENDING_COLLECTION');
    expect(world.movements).toEqual([{ statementReceiptId: 'r1', amount: 1000 }]);
  });

  it('the press takes the rest in its own transaction; then the close settles nothing twice and the end is the one-shot close’s', async () => {
    big(EARLY_STEP_CAP + 5);
    await approve();
    const pressed = await (await press()).json();
    expect(pressed).toMatchObject({ settled: 5, remaining: 0, message: 'تسوّى 5 طلب نظيف' });
    expect(marked()).toHaveLength(EARLY_STEP_CAP + 5);
    world.rows[world.rows.length - 1] = { ...world.rows[world.rows.length - 1], resolution: 'UNDER_REVIEW', resolutionNote: 'نراجع', resolvedById: 'u-decider' };
    const closed = await (await close()).json();
    expect(closed).toMatchObject({ settledOrders: EARLY_STEP_CAP + 5, settledEarlier: EARLY_STEP_CAP + 5 });
    expect(world.stock).toHaveLength(EARLY_STEP_CAP + 5);
  });

  it('a close that comes before the press settles the ones the approval left, and only those', async () => {
    big(EARLY_STEP_CAP + 5);
    await approve();
    world.rows[world.rows.length - 1] = { ...world.rows[world.rows.length - 1], resolution: 'UNDER_REVIEW', resolutionNote: 'نراجع', resolvedById: 'u-decider' };
    const claimsBefore = ops('order.updateMany').length;
    const closed = await (await close()).json();
    expect(closed).toMatchObject({ settledOrders: EARLY_STEP_CAP + 5, settledEarlier: EARLY_STEP_CAP });
    const closeClaims = ops('order.updateMany').slice(claimsBefore);
    expect(closeClaims).toHaveLength(1);
    expect((closeClaims[0].args as any).where.id.in).toHaveLength(5);
  });

  it('and the list’s number is every clean line waiting, not the part one press takes', () => {
    // The count on the screen is asked of the database without the cap, so the press shows what is really left.
    const src = stripComments(readFileSync(join(process.cwd(), 'src/app/api/finance/statements/route.ts'), 'utf8'));
    expect(src).not.toMatch(/EARLY_STEP_CAP/);
  });
});
