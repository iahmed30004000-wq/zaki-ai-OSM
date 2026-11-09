import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * ═══════════════════════════════════════════════════════════════════════
 * PATH INDEPENDENCE — THE ONE PROPERTY THE MONEY REVIEWER READS FIRST (S6 of the brief).
 *
 * «تسوية السطور النظيفة عند الاعتماد» changes WHEN a statement's clean orders are settled, and nothing else. So for ANY statement and
 * ANY order of events — approve · answer a line · match again · close · press «سوّي الطلبات النظيفة هلّق» · something happening to an order
 * outside the statement — the state of the world once the matching is CLOSED must be the same with the switch OFF and with it ON:
 * every order (its shipping and settlement status, its delivery date, the amount written on it, its version), the stock taken, the
 * customers' counters, the commission made payable, the shortfalls charged, the wallet's movements, and the story written on each order.
 * Only the `appliedAt` marks and the moment (and the person) a thing was written may differ.
 *
 * It is an old-versus-new ORACLE, in the spirit of the settlement-decisions matrix's (#231): the OFF world is the oracle — the code
 * path every statement has taken until today — and the ON world must agree with it on thousands of seeded random statements:
 * lines of every kind and every answer, orders in every state (settled, with a cancel asked for, delivered by hand, partly delivered,
 * returned), an order two lines name, a claim paid on an earlier closed statement, a zero line, a short figure accepted, and a
 * statement approved before the switch was turned on (or turned off again after the approval).
 *
 * The routes are the REAL ones (`PATCH` approve, `close`, `settle-clean`) and the engine under them is the real `settleStatement`.
 * What is modelled, and says so: a person's answer (applied only where the real decision matrix allows it), a new matching (the clean
 * rows re-judged by the matcher's own rule, applied rows untouched — the guard of `runMatching` is held by its own test), and an
 * event outside the statement (an order collected by hand, a cancel asked for or withdrawn).
 *
 * WHAT IS DELIBERATELY NOT COMPARED, AND WHY — said here so the oracle cannot be read as claiming more than it does:
 *   · an outside event AFTER the approval on an order a clean line names. With the switch ON the order was settled at the approval,
 *     with it OFF it is still waiting, so the two worlds answer the SAME event differently BY DESIGN (OFF's close would stop on «تغيّر وضع
 *     طلب»; ON has nothing to stop on). That divergence has its own named tests below; the generator never makes it here.
 *   · a statement that never closes (a decision with no reason, an order that stays unsettlable): both worlds must STOP, but the
 *     stopped state is the early step's by design (it had already settled what it could) — only the closing code is compared.
 * ═══════════════════════════════════════════════════════════════════════
 */

type Stamp = Date | null;
interface WOrder {
  id: string; orderNumber: string; shippingStatus: string; settlementStatus: string;
  openRequest: boolean; collectedAmount: number | null; customerId: string;
  deliveredAt: Date | null; moderatorId: string | null; confirmedById: string | null; version: number;
}
type WRow = Record<string, any>;

const { db, world, requireContext, requirePermission, logAudit, recordMovement, receiptGap, resetWorld } = vi.hoisted(() => {
  const fresh = () => ({
    identity: { id: '88888888-8888-4888-8888-888888888888', reference: 'ST-ORACLE', currencyCode: 'SYP' },
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
    switchOn: false,
    savepoints: [] as { name: string; snap: any }[],
    lockedFirst: true,
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
  /** What a database does with `select`: only the columns asked for come back — a door that forgets one does not see it. */
  const pick = (r: WRow, select?: Record<string, unknown>) =>
    select ? Object.fromEntries(Object.keys(select).map((k) => [k, r[k]])) : r;
  const snapshot = () =>
    structuredClone({
      statement: world.statement, rows: world.rows, orders: world.orders, customers: world.customers, activities: world.activities,
      movements: world.movements, payable: world.payable, stock: world.stock, penalties: world.penalties,
    });
  const restore = (s: any) => Object.assign(world, s);
  const statementRead = (a?: { include?: { matches?: { select?: Record<string, unknown> } }; select?: { matches?: { select?: Record<string, unknown> } } }) => {
    const sel = a?.include?.matches?.select ?? a?.select?.matches?.select;
    return {
      ...world.identity, gapExplanation: null,
      createdAt: new Date('2026-10-20T10:00:00Z'), periodTo: new Date('2026-10-20T00:00:00Z'),
      ...world.statement,
      receipts: world.receipts,
      matches: world.rows.map((r) => pick(r, sel)),
    };
  };

  const db = {
    company: {
      findUnique: async () => ({
        settings: JSON.stringify(world.switchOn ? { perLineSettlement: { enabled: true, enabledAt: '2026-11-09T06:00:00.000Z' } } : {}),
      }),
    },
    courierStatement: {
      findFirst: async (a?: never) => statementRead(a),
      updateMany: async ({ where, data }: { where: Record<string, any>; data: Record<string, any> }) => {
        const st = world.statement;
        if ('approvedAt' in where && where.approvedAt === null && st.approvedAt) return { count: 0 };
        if (where.approvedAt?.not === null && !st.approvedAt) return { count: 0 };
        if ('matchingClosedAt' in where && where.matchingClosedAt === null && st.matchingClosedAt) return { count: 0 };
        if (data.approvedAt) st.approvedAt = data.approvedAt;
        if (data.status) st.status = data.status;
        if (data.matchingClosedAt) st.matchingClosedAt = data.matchingClosedAt;
        return { count: 1 };
      },
    },
    settlementMatch: {
      findMany: async ({ where, select }: { where: Record<string, any>; select?: Record<string, unknown> }) => {
        for (const key of Object.keys(where)) if (!['statementId', 'companyId'].includes(key)) throw new Error('the fake does not know: ' + key);
        return world.rows.map((r) => pick(r, select));
      },
      updateMany: async ({ where, data }: { where: Record<string, any>; data: Record<string, any> }) => {
        const hit = world.rows.filter((r) => rowMatches(r, where));
        for (const r of hit) Object.assign(r, data);
        return { count: hit.length };
      },
    },
    walletMovement: {
      findMany: async () => [],
      count: async ({ where }: { where: { statementReceiptId: null | { not: null } } }) =>
        world.movements.filter((m) => (where.statementReceiptId === null ? m.statementReceiptId === null : m.statementReceiptId !== null)).length,
    },
    user: {
      findMany: async ({ where }: { where: { id?: { in: string[] } } }) =>
        [{ id: 'u-door', name: 'سارة', role: 'FOLLOW_UP_AGENT' }].filter((u) => !where.id?.in || where.id.in.includes(u.id)),
    },
    deliveryAttempt: {
      findMany: async ({ where }: { where: { orderId: { in: string[] } } }) =>
        where.orderId.in.filter((id) => world.door.has(id)).map((orderId) => ({ orderId, deliveryAgentId: world.door.get(orderId) })),
    },
    penalty: {
      findMany: async () => world.penalties,
      create: async ({ data }: { data: Record<string, any> }) => {
        const row = { id: `pen-${world.penalties.length + 1}`, ...data };
        world.penalties.push(row);
        return row;
      },
    },
    order: {
      updateMany: async ({ where, data }: { where: Record<string, any>; data: { settlementStatus?: string } }) => {
        const hit = [...world.orders.values()].filter((o) => matchesWhere(o, where));
        for (const o of hit) if (data.settlementStatus) o.settlementStatus = data.settlementStatus;
        return { count: hit.length };
      },
      findMany: async ({ where }: { where: Record<string, any> }) =>
        [...world.orders.values()].filter((o) => matchesWhere(o, where)).map((o) => ({ ...o })),
      update: async ({ where, data }: { where: { id: string }; data: Record<string, any> }) => {
        const o = world.orders.get(where.id)!;
        if (data.collectedAmount !== undefined) o.collectedAmount = data.collectedAmount;
        if (data.shippingStatus) o.shippingStatus = data.shippingStatus;
        if (data.deliveredAt) o.deliveredAt = data.deliveredAt;
        if (data.version?.increment) o.version += data.version.increment;
        return o;
      },
    },
    orderActivity: {
      create: async ({ data }: { data: Record<string, any> }) => {
        world.activities.push({ orderId: data.orderId, action: data.action, userId: data.userId, metadata: data.metadata ?? null });
      },
    },
    customer: {
      update: async ({ where, data }: { where: { id: string }; data: Record<string, any> }) => {
        const c = world.customers.get(where.id) ?? { deliveredOrders: 0, totalPurchaseValue: 0 };
        c.deliveredOrders += data.deliveredOrders?.increment ?? 0;
        c.totalPurchaseValue += data.totalPurchaseValue?.increment ?? 0;
        world.customers.set(where.id, c);
      },
    },
    $queryRaw: async () => [],
    $executeRaw: async (strings: TemplateStringsArray) => {
      const sql = strings.join('?').trim();
      const name = sql.split(/\s+/).at(-1)!;
      if (sql.startsWith('SAVEPOINT ')) world.savepoints.push({ name, snap: snapshot() });
      else if (sql.startsWith('RELEASE SAVEPOINT ')) world.savepoints.splice(world.savepoints.map((s) => s.name).lastIndexOf(name));
      else if (sql.startsWith('ROLLBACK TO SAVEPOINT ')) {
        const at = world.savepoints.map((s) => s.name).lastIndexOf(name);
        restore(structuredClone(world.savepoints[at].snap));
        world.savepoints.splice(at + 1);
      } else throw new Error('the fake does not know this statement: ' + sql);
      return 0;
    },
    $transaction: async (fn: (tx: unknown) => unknown) => {
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
    },
  };
  return {
    db, world, resetWorld,
    requireContext: vi.fn(), requirePermission: vi.fn(),
    logAudit: vi.fn(async (a: any) => { world.audits.push({ action: a.action, newData: a.newData }); }),
    recordMovement: vi.fn(async (_tx: unknown, a: { statementReceiptId?: string; amount: number }) => {
      if (a.statementReceiptId && world.movements.some((m) => m.statementReceiptId === a.statementReceiptId)) {
        throw new Error('unique violation: wallet_movements_statementReceiptId_key');
      }
      world.movements.push({ statementReceiptId: a.statementReceiptId ?? null, amount: a.amount });
      return { id: `mv-${world.movements.length}` };
    }),
    receiptGap: vi.fn(),
  };
});

vi.mock('@/lib/db', () => ({ db }));
vi.mock('@/lib/geo-context', () => ({ requireContext: (...a: unknown[]) => requireContext(...a) }));
vi.mock('@/lib/authorization', () => ({ requirePermission: (...a: unknown[]) => requirePermission(...a), can: () => true }));
vi.mock('@/lib/audit', () => ({ logAudit: (...a: unknown[]) => logAudit(...(a as [unknown])) }));
vi.mock('@/lib/notify', () => ({ notify: () => undefined }));
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
  markPayableForOrders: async (_tx: unknown, _companyId: string, ids: string[]) => { world.payable.push(...ids); return 0; },
}));
vi.mock('@/lib/stock-consumption', () => ({
  consumeOrderStock: async (_tx: unknown, a: { orderId: string }) => { world.stock.push(a.orderId); },
}));

import { PATCH } from './[id]/route';
import { POST as CLOSE } from './[id]/close/route';
import { POST as SETTLE_CLEAN } from './[id]/settle-clean/route';
import { forgetPerLineSwitch } from '@/lib/per-line-settlement-switch';
import { decisionMatrix, type DecisionFacts } from '@/lib/settlement-decisions';

/* ───────────────────────────── a seeded random number generator, and what it draws ───────────────────────────── */

function rng(seed: number) {
  let a = seed >>> 0;
  const next = () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const int = (lo: number, hi: number) => lo + Math.floor(next() * (hi - lo + 1));
  const chance = (p: number) => next() < p;
  const pick = <T,>(xs: readonly T[]) => xs[Math.floor(next() * xs.length)];
  const weighted = <T,>(xs: readonly (readonly [T, number])[]) => {
    const total = xs.reduce((s, [, w]) => s + w, 0);
    let r = next() * total;
    for (const [x, w] of xs) { r -= w; if (r < 0) return x; }
    return xs[xs.length - 1][0];
  };
  return { next, int, chance, pick, weighted };
}
type Rng = ReturnType<typeof rng>;

const rowId = (k: number) => `00000000-0000-4000-8000-${String(k).padStart(12, '0')}`;
const SHIPPING = [
  ['SHIPPED', 14], ['OUT_FOR_DELIVERY', 14], ['READY_FOR_PICKUP', 5], ['FAILED_DELIVERY', 8], ['DELIVERED', 30],
  ['PARTIALLY_DELIVERED', 6], ['RETURN_REQUESTED', 6], ['RETURNED', 3],
] as const;
const KINDS = [
  ['MATCHED', 46], ['MISMATCHED_OPEN', 14], ['ACCEPTED', 10], ['OURS', 6], ['PARKED', 6], ['EXCLUDED', 5], ['ZERO_MATCHED', 3], ['SHORT_ACCEPTED', 6],
] as const;

interface Scenario {
  orders: WOrder[];
  rows: WRow[];
  receipts: { id: string; walletId: string; amount: number }[];
  door: [string, string][];
  /** The orders that can NEVER be named by a clean line (no row of theirs has equal figures). */
  neverClean: Set<string>;
  history: 'ON_ALWAYS' | 'ON_AFTER_APPROVAL' | 'ON_THEN_OFF';
  script: Event[];
}
type Event =
  | { t: 'approve' }
  | { t: 'answer'; row: number; resolution: 'ACCEPTED_COURIER' | 'OURS_STANDS' | 'UNDER_REVIEW'; reasoned: boolean }
  | { t: 'rematch' }
  | { t: 'outside'; order: number; kind: 'collect' | 'request' | 'withdraw' }
  | { t: 'press' }
  | { t: 'close' };

function scenario(seed: number): Scenario {
  const r = rng(seed);
  const n = r.int(3, 9);
  const orders: WOrder[] = [];
  for (let i = 0; i < n; i++) {
    const shipping = r.weighted(SHIPPING);
    orders.push({
      id: `o${i}`, orderNumber: `ORD-${i}`, shippingStatus: shipping,
      settlementStatus: r.chance(0.08) ? 'SETTLED' : 'PENDING_COLLECTION',
      openRequest: r.chance(0.08),
      collectedAmount: shipping === 'DELIVERED' && r.chance(0.3) ? r.int(10, 60) : null,
      customerId: `cu-${i % 4}`,
      deliveredAt: ['DELIVERED', 'PARTIALLY_DELIVERED'].includes(shipping) ? new Date('2026-10-18T09:00:00Z') : null,
      moderatorId: 'u-mod', confirmedById: 'u-conf', version: 1,
    });
  }
  const rows: WRow[] = [];
  let k = 1;
  const base = (id: string, orderId: string | null, over: WRow): WRow => ({
    id, orderId, result: 'MATCHED', resolution: null, resolutionNote: null, resolvedById: null, appliedAt: null,
    expectedAmount: 20, expectedFee: 5, statementAmount: 20, statementFee: 5,
    order: orderId ? { orderNumber: `ORD-${orderId.slice(1)}`, settlementMatches: [] as { statementAmount: number; statementFee: number }[] } : null,
    ...over,
  });
  const neverClean = new Set<string>();
  for (const o of orders) {
    const amount = r.int(5, 60) * 5;
    const kind = r.weighted(KINDS);
    const earlier = r.chance(0.1) ? [{ statementAmount: r.int(3, 20), statementFee: 5 }] : [];
    let row: WRow;
    switch (kind) {
      case 'MATCHED':
        row = base(rowId(k++), o.id, { expectedAmount: amount, statementAmount: amount });
        break;
      case 'ZERO_MATCHED':
        row = base(rowId(k++), o.id, { expectedAmount: 0, expectedFee: 0, statementAmount: 0, statementFee: 0 });
        break;
      case 'MISMATCHED_OPEN':
        row = base(rowId(k++), o.id, { result: 'MISMATCHED', expectedAmount: amount, statementAmount: amount - r.int(1, 4) });
        break;
      case 'ACCEPTED':
        row = base(rowId(k++), o.id, {
          result: 'MISMATCHED', expectedAmount: amount, statementAmount: amount + r.pick([-3, 0, 2]),
          resolution: 'ACCEPTED_COURIER', resolutionNote: 'خصم أعطاه الموظف للزبون', resolvedById: 'u-decider',
        });
        break;
      case 'SHORT_ACCEPTED':
        row = base(rowId(k++), o.id, {
          result: 'MISMATCHED', expectedAmount: amount, statementAmount: amount - r.int(1, 4),
          resolution: 'ACCEPTED_COURIER', resolutionNote: 'خصم أعطاه الموظف للزبون', resolvedById: 'u-decider',
        });
        break;
      case 'OURS':
        row = base(rowId(k++), o.id, {
          result: 'MISMATCHED', expectedAmount: amount, statementAmount: amount - r.int(1, 4),
          resolution: 'OURS_STANDS', resolutionNote: 'نطالب الشركة بالباقي', resolvedById: 'u-decider',
        });
        break;
      case 'PARKED':
        row = base(rowId(k++), o.id, {
          result: 'MISMATCHED', expectedAmount: amount, statementAmount: r.pick([0, amount - 2]),
          resolution: 'UNDER_REVIEW', resolutionNote: 'نراجع مع الشركة', resolvedById: 'u-decider',
        });
        break;
      default:
        row = base(rowId(k++), o.id, { result: 'EXCLUDED', expectedAmount: null, statementAmount: 0, statementFee: null });
    }
    if (earlier.length > 0 && row.order) row.order.settlementMatches = earlier;
    rows.push(row);
    // An order two lines name (the file names a parcel twice), as the matcher and the doors leave it: only ONE row holds an order —
    // clean, or answered «اعتُمد رقم الشركة». When the first holds it the second is a flagged difference (open, or parked); when the
    // first holds nothing, the courier's later, right line may be the clean one.
    if (r.chance(0.12)) {
      const holds = row.result === 'MATCHED' || row.resolution === 'ACCEPTED_COURIER';
      const second = holds
        ? base(rowId(k++), o.id, {
            result: 'MISMATCHED', expectedAmount: amount, statementAmount: amount,
            ...(r.chance(0.5) ? { resolution: 'UNDER_REVIEW', resolutionNote: 'نفس الطرد مذكور مرتين', resolvedById: 'u-decider' } : {}),
          })
        : row.result === 'EXCLUDED' || row.resolution === 'OURS_STANDS'
          ? base(rowId(k++), o.id, { result: 'MISMATCHED', expectedAmount: amount, statementAmount: amount - 1 })
          : base(rowId(k++), o.id, { expectedAmount: amount, statementAmount: amount });
      rows.push(second);
    }
  }
  // Lines no order of ours carries, and a parcel no statement names.
  for (let i = r.int(0, 2); i > 0; i--) {
    rows.push(base(rowId(k++), null, {
      result: 'MISSING_IN_SYSTEM', expectedAmount: null, statementAmount: r.int(3, 30), expectedFee: null,
      ...(r.chance(0.4) ? { resolution: 'UNDER_REVIEW', resolutionNote: 'سطر لشركة ثانية' } : {}),
    }));
  }
  if (r.chance(0.2)) rows.push(base(rowId(k++), orders[0].id, { result: 'MISSING_IN_STATEMENT', statementAmount: null, statementFee: null }));

  for (const o of orders) {
    const mine = rows.filter((x) => x.orderId === o.id && x.result !== 'MISSING_IN_STATEMENT');
    if (mine.every((x) => Number(x.expectedAmount) !== Number(x.statementAmount))) neverClean.add(o.id);
  }
  const door: [string, string][] = orders.filter(() => r.chance(0.5)).map((o) => [o.id, 'u-door']);
  const receipts = Array.from({ length: r.int(1, 2) }, (_, i) => ({ id: `r${i + 1}`, walletId: `w${i + 1}`, amount: r.int(100, 900) }));

  // The script: a few things before the approval, the approval, a few things after. The event after the approval that would make
  // the two worlds answer differently BY DESIGN (an outside event on an order a clean line names) is never drawn.
  const history = r.pick(['ON_ALWAYS', 'ON_ALWAYS', 'ON_AFTER_APPROVAL', 'ON_THEN_OFF'] as const);
  const script: Event[] = [];
  const draw = (afterApproval: boolean): Event => {
    const t = r.weighted([['answer', 36], ['rematch', 14], ['outside', 16], ['press', afterApproval ? 10 : 0], ['close', afterApproval ? 6 : 0]] as const);
    if (t === 'answer') {
      return { t, row: r.int(0, rows.length - 1), resolution: r.pick(['ACCEPTED_COURIER', 'OURS_STANDS', 'UNDER_REVIEW', 'UNDER_REVIEW'] as const), reasoned: !r.chance(0.08) };
    }
    if (t === 'outside') {
      const pool = orders.map((_, i) => i).filter((i) => !afterApproval || neverClean.has(orders[i].id));
      if (pool.length === 0) return { t: 'rematch' };
      return { t, order: r.pick(pool), kind: r.pick(['collect', 'request', 'request', 'withdraw'] as const) };
    }
    return { t } as Event;
  };
  for (let i = r.int(0, 5); i > 0; i--) script.push(draw(false));
  script.push({ t: 'approve' });
  for (let i = r.int(0, 6); i > 0; i--) script.push(draw(true));

  return { orders, rows, receipts, door, neverClean, history, script };
}

/* ───────────────────────────── what a person, the matcher and the world do — modelled, identically in both worlds ───────────────────────────── */

const params = () => ({ params: Promise.resolve({ id: world.identity.id }) });
const send = (method: string, body?: unknown) =>
  new Request('http://localhost/x', { method, headers: { 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });

const isOpenRow = (r: WRow) => !r.resolution && (r.result === 'MISMATCHED' || (r.result === 'MISSING_IN_SYSTEM' && !r.orderId));

/** The decision matrix of the real code, asked of the world as it is now. */
function mayAnswer(row: WRow, resolution: string): boolean {
  if (row.appliedAt || world.statement.matchingClosedAt) return false;
  if (row.result === 'MISSING_IN_SYSTEM') return !row.orderId && resolution === 'UNDER_REVIEW';
  if (row.result !== 'MISMATCHED' || !row.orderId) return false;
  const o = world.orders.get(row.orderId)!;
  const facts: DecisionFacts = {
    hasOrder: true, shippingStatus: o.shippingStatus, settlementStatus: o.settlementStatus,
    openRequests: o.openRequest ? ['CANCEL'] : [],
    claimedElsewhere: world.rows.some((x) => x.id !== row.id && x.orderId === row.orderId && (x.result === 'MATCHED' || x.resolution === 'ACCEPTED_COURIER')),
    statementApproved: false, expectedAmount: Number(row.expectedAmount), statementAmount: Number(row.statementAmount),
    courierOutcome: null, minorUnit: 2,
  };
  return decisionMatrix(facts)[resolution as 'ACCEPTED_COURIER'].allowed;
}

function answer(e: Extract<Event, { t: 'answer' }>) {
  const row = world.rows[e.row];
  if (!row || row.resolution || !mayAnswer(row, e.resolution)) return;
  Object.assign(row, {
    resolution: e.resolution, resolvedById: 'u-decider',
    resolutionNote: e.reasoned ? 'اتفقنا مع الزبون على هالمبلغ' : 'x',
  });
}

/** A new matching, in the matcher's own words: an unanswered machine row is judged afresh; an applied or answered row is kept. */
function rematch() {
  if (world.statement.matchingClosedAt) return;
  for (const row of world.rows) {
    if (row.appliedAt || row.resolution || !row.orderId) continue;
    if (row.result !== 'MATCHED' && row.result !== 'MISMATCHED') continue;
    const o = world.orders.get(row.orderId)!;
    // Who already holds the order when this line is judged: a KEPT row (a decision «اعتُمد رقم الشركة», or a row already applied) from
    // anywhere in the file, or a line before this one that the same pass has just found clean.
    const heldByKept = world.rows.some((x) => x !== row && x.orderId === row.orderId && (x.resolution === 'ACCEPTED_COURIER' || (x.appliedAt && x.result === 'MATCHED')));
    const heldByEarlier = world.rows.slice(0, world.rows.indexOf(row)).some((x) => x.orderId === row.orderId && !x.appliedAt && !x.resolution && x.result === 'MATCHED');
    const clean = Number(row.expectedAmount) === Number(row.statementAmount) && o.settlementStatus !== 'SETTLED' && !o.openRequest && !heldByKept && !heldByEarlier;
    row.result = clean ? 'MATCHED' : 'MISMATCHED';
  }
}

function outside(e: Extract<Event, { t: 'outside' }>, orders: WOrder[]) {
  const o = world.orders.get(orders[e.order].id)!;
  if (e.kind === 'collect') o.settlementStatus = 'SETTLED';
  else o.openRequest = e.kind === 'request';
}

function parkTheQuestions() {
  for (const row of world.rows) {
    if (row.appliedAt || !isOpenRow(row)) continue;
    Object.assign(row, { resolution: 'UNDER_REVIEW', resolvedById: 'u-decider', resolutionNote: 'نراجع مع الشركة' });
  }
}
/** «غيّر بتّه إلى قيد المراجعة» — what the close tells a person to do with a decision whose order can no longer take it. */
function repark() {
  for (const row of world.rows) {
    if (row.appliedAt || row.resolution !== 'ACCEPTED_COURIER' || mayAnswer(row, 'ACCEPTED_COURIER')) continue;
    Object.assign(row, { resolution: 'UNDER_REVIEW', resolutionNote: 'نراجع مع الشركة' });
  }
}
function giveReasons() {
  for (const row of world.rows) if (!row.appliedAt && row.resolution === 'ACCEPTED_COURIER') row.resolutionNote = 'اتفقنا مع الزبون على هالمبلغ';
}

const codeOf = async (res: Response) => ((await res.clone().json().catch(() => ({}))) as { code?: string }).code ?? String(res.status);

/* ───────────────────────────── one world, one script ───────────────────────────── */

interface Run {
  statuses: string[];
  closed: boolean;
  /** Why it did not close, when it did not. */
  stuck: string | null;
  earlySettled: number;
  earlyHeldBack: number;
  applied: number;
  afterApproval: { movements: string; approved: boolean; closed: boolean; open: number } | null;
}

async function run(sc: Scenario, on: boolean): Promise<Run> {
  resetWorld();
  forgetPerLineSwitch();
  world.orders = new Map(structuredClone(sc.orders).map((o) => [o.id, o]));
  world.rows = structuredClone(sc.rows);
  world.receipts = structuredClone(sc.receipts);
  world.door = new Map(sc.door);
  const out: Run = { statuses: [], closed: false, stuck: null, earlySettled: 0, earlyHeldBack: 0, applied: 0, afterApproval: null };
  const setSwitch = (v: boolean) => { world.switchOn = v; forgetPerLineSwitch(); };
  setSwitch(on && sc.history !== 'ON_AFTER_APPROVAL');

  /** «من يتحمّل الفرق؟» — the person says «على الشركة» for every short line the door could not name. */
  const people = () => {
    const out: Record<string, string> = {};
    for (const row of world.rows) if (row.resolution === 'ACCEPTED_COURIER') out[row.id] = 'COMPANY';
    return out;
  };
  const approve = async () => {
    const res = await PATCH(send('PATCH', { approve: true, shortfallPeople: people() }), params());
    out.statuses.push(`approve:${res.status}:${await codeOf(res)}`);
    if (res.status === 200) {
      const body = await res.clone().json();
      out.earlySettled += body.earlySettlement?.settled ?? 0;
      out.earlyHeldBack += body.earlySettlement?.heldBack?.length ?? 0;
      out.afterApproval = {
        movements: JSON.stringify(world.movements), approved: !!world.statement.approvedAt, closed: !!world.statement.matchingClosedAt,
        open: world.rows.filter(isOpenRow).length,
      };
      if (on && sc.history === 'ON_AFTER_APPROVAL') setSwitch(true);
      if (on && sc.history === 'ON_THEN_OFF') setSwitch(false);
    }
    return res;
  };
  const close = async () => {
    const res = await CLOSE(send('POST', { shortfallPeople: people() }), params());
    out.statuses.push(`close:${res.status}:${await codeOf(res)}`);
    return res;
  };

  for (const e of sc.script) {
    if (e.t === 'approve') await approve();
    else if (e.t === 'answer') answer(e);
    else if (e.t === 'rematch') rematch();
    else if (e.t === 'outside') outside(e, sc.orders);
    else if (e.t === 'close') await close();
    else if (e.t === 'press') {
      if (!on) continue; // the press exists only with the switch; the OFF world has no such event
      const res = await SETTLE_CLEAN(send('POST'), params());
      out.statuses.push(`press:${res.status}:${await codeOf(res)}`);
    }
  }

  // The person finishes the job: approves if it is not approved yet (matching again when an order changed), parks what is still a
  // question, and closes — matching again and giving a decision its reason when the close says so.
  for (let attempt = 0; attempt < 6 && !world.statement.matchingClosedAt; attempt++) {
    if (!world.statement.approvedAt) {
      const res = await approve();
      if (res.status !== 200) {
        const code = await codeOf(res);
        if (code === 'ORDERS_CHANGED') { rematch(); repark(); continue; }
        if (code === 'DECISION_WITHOUT_REASON') { giveReasons(); continue; }
        out.stuck = `approve:${code}`;
        break;
      }
    }
    parkTheQuestions();
    const res = await close();
    if (res.status === 200) break;
    const code = await codeOf(res);
    if (code === 'ORDERS_CHANGED') { rematch(); repark(); }
    else if (code === 'DECISION_WITHOUT_REASON') giveReasons();
    else if (code === 'MATCHING_ALREADY_CLOSED') break;
    else { out.stuck = `close:${code}`; break; }
  }
  out.closed = !!world.statement.matchingClosedAt;
  if (!out.closed && !out.stuck) out.stuck = 'attempts';
  out.applied = world.rows.filter((r) => r.appliedAt).length;
  return out;
}

/** Everything the brief lists, as the world holds it — with the moment and the person left out. */
function finalState() {
  const norm = (s: string | null) => (s == null ? null : s);
  return {
    orders: [...world.orders.values()]
      .map((o) => ({
        id: o.id, shippingStatus: o.shippingStatus, settlementStatus: o.settlementStatus,
        deliveredAt: o.deliveredAt ? o.deliveredAt.getTime() : null, collectedAmount: o.collectedAmount, version: o.version,
      }))
      .sort((a, b) => a.id.localeCompare(b.id)),
    customers: [...world.customers.entries()].sort(([a], [b]) => a.localeCompare(b)),
    stock: [...world.stock].sort(),
    payable: [...world.payable].sort(),
    penalties: world.penalties.map((p) => ({ user: p.userId, amount: p.amount, note: p.note, match: p.settlementMatchId, on: String(p.occurredOn) })).sort((a, b) => String(a.match).localeCompare(String(b.match))),
    movements: world.movements,
    activities: world.activities.map((a) => `${a.orderId}|${a.action}|${norm(a.metadata)}`).sort(),
    rows: world.rows.map((r) => ({ id: r.id, result: r.result, resolution: r.resolution })),
    statement: { approved: !!world.statement.approvedAt, closed: !!world.statement.matchingClosedAt },
    closeAudit: world.audits.filter((a) => a.action === 'STATEMENT_MATCHING_CLOSED').map((a) => ({
      settled: a.newData.settled, accepted: a.newData.acceptedByDecision, claims: a.newData.claimsOpened, shortfalls: a.newData.shortfalls?.length,
    })),
    // How many parcels the statement delivered in all: the approval’s early step (or the press), plus the close.
    delivered: [
      ...world.audits.filter((a) => a.action === 'STATEMENT_APPROVED').map((a) => a.newData.perLineSettlement?.delivered ?? 0),
      ...world.audits.filter((a) => a.action === 'STATEMENT_CLEAN_LINES_SETTLED').map((a) => a.newData.delivered ?? 0),
      ...world.audits.filter((a) => a.action === 'STATEMENT_MATCHING_CLOSED').map((a) => a.newData.deliveredByStatement ?? 0),
    ].reduce((s, n) => s + n, 0),
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
  requireContext.mockResolvedValue({
    user: { id: 'u-approver', name: 'المحاسب' }, companyId: 'c1', storeId: 's1', country: { minorUnit: 2, currencyCode: 'USD' },
  });
  requirePermission.mockResolvedValue({});
  receiptGap.mockResolvedValue({ claimed: 0, received: 0, gap: 0, needsExplanation: false, explained: false, unconvertible: 0 });
});

/* ───────────────────────────── THE ORACLE ───────────────────────────── */

const CASES = 4000;

describe(`the same statement, the same events: with the switch ON the world ends where it ends with the switch OFF (${CASES} seeded statements)`, () => {
  const stats = { cases: 0, bothClosed: 0, earlyRan: 0, applied: 0, heldBack: 0, stuckBoth: 0, withClaim: 0, withTwoLines: 0, afterBeforeSwitch: 0 };

  it('every closed statement ends identically — orders, stock, counters, commission, shortfalls, money and timeline', { timeout: 120_000 }, async () => {
    const failures: string[] = [];
    for (let seed = 1; seed <= CASES; seed++) {
      const sc = scenario(seed);
      const off = await run(sc, false);
      const offState = finalState();
      const on = await run(sc, true);
      const onState = finalState();
      stats.cases++;
      if (sc.rows.some((r) => r.order?.settlementMatches?.length)) stats.withClaim++;
      if (sc.rows.filter((r) => r.orderId).some((r, i, all) => all.findIndex((o) => o.orderId === r.orderId) !== i)) stats.withTwoLines++;
      if (sc.history === 'ON_AFTER_APPROVAL') stats.afterBeforeSwitch++;
      if (on.earlySettled > 0) stats.earlyRan++;
      stats.applied += on.applied;
      stats.heldBack += on.earlyHeldBack;

      // S3, at scale: the approval itself answers the same in both worlds, and its money is the same.
      const approvals = (r: Run) => r.statuses.filter((s) => s.startsWith('approve:'));
      if (JSON.stringify(approvals(on)) !== JSON.stringify(approvals(off))) failures.push(`seed ${seed}: the approval answered ${approvals(on)} with the switch on, ${approvals(off)} off`);
      if (on.afterApproval && off.afterApproval) {
        if (on.afterApproval.movements !== off.afterApproval.movements) failures.push(`seed ${seed}: the money differs at the approval`);
        if (on.afterApproval.open !== off.afterApproval.open) failures.push(`seed ${seed}: the lines still a question differ at the approval`);
        if (on.afterApproval.approved !== off.afterApproval.approved || on.afterApproval.closed !== off.afterApproval.closed) failures.push(`seed ${seed}: the stamps differ at the approval`);
      }
      // No order is ever taken off the shelf twice, and no commission made payable twice.
      if (new Set(onState.stock).size !== onState.stock.length) failures.push(`seed ${seed}: an order left the shelf twice with the switch on`);
      if (new Set(onState.payable).size !== onState.payable.length) failures.push(`seed ${seed}: commission made payable twice with the switch on`);

      if (on.closed !== off.closed) {
        failures.push(`seed ${seed}: closed=${on.closed} on, ${off.closed} off (${on.stuck} / ${off.stuck})`);
        continue;
      }
      if (!on.closed) {
        stats.stuckBoth++;
        // Both stopped: they must have stopped for the same reason.
        if (on.stuck !== off.stuck) failures.push(`seed ${seed}: stopped on ${on.stuck} with the switch on, ${off.stuck} off`);
        continue;
      }
      stats.bothClosed++;
      const a = JSON.stringify(onState);
      const b = JSON.stringify(offState);
      if (a !== b) {
        const keys = (Object.keys(onState) as (keyof typeof onState)[]).filter((k) => JSON.stringify(onState[k]) !== JSON.stringify(offState[k]));
        failures.push(`seed ${seed}: the final state differs in ${keys.join(', ')}`);
      }
      // …and every row the early step marked is a clean row whose order is settled.
      if (on.applied > 0 && world.rows.some((r) => r.appliedAt && (r.result !== 'MATCHED' || world.orders.get(r.orderId)!.settlementStatus !== 'SETTLED'))) {
        failures.push(`seed ${seed}: an applied row that is not a clean row of a settled order`);
      }
      if (failures.length >= 12) break;
    }
    console.info(`[per-line oracle] ${JSON.stringify(stats)}`);
    expect(failures.slice(0, 12), failures.slice(0, 12).join('\n')).toEqual([]);
  });

  it('and the oracle is not vacuous: it saw statements closed both ways, early steps that ran, rows held back, two-line orders, earlier claims and a statement approved before the switch', () => {
    expect(stats.cases).toBe(CASES);
    expect(stats.bothClosed).toBeGreaterThan(CASES * 0.6);
    expect(stats.earlyRan).toBeGreaterThan(CASES * 0.2);
    expect(stats.applied).toBeGreaterThan(CASES * 0.5);
    expect(stats.heldBack).toBeGreaterThan(20);
    expect(stats.withTwoLines).toBeGreaterThan(CASES * 0.1);
    expect(stats.withClaim).toBeGreaterThan(CASES * 0.2);
    expect(stats.afterBeforeSwitch).toBeGreaterThan(CASES * 0.15);
  });
});

/* ───────────────────────────── WHAT DIFFERS BY DESIGN — named, so that it is a decision and not a surprise ───────────────────────────── */

describe('the one thing the two worlds answer differently ON PURPOSE: an outside event after the approval on an order a clean line names', () => {
  const build = (on: boolean) => {
    resetWorld();
    forgetPerLineSwitch();
    world.switchOn = on;
    world.receipts = [{ id: 'r1', walletId: 'w1', amount: 100 }];
    for (const id of ['oA', 'oQ']) {
      world.orders.set(id, {
        id, orderNumber: `ORD-${id}`, shippingStatus: 'DELIVERED', settlementStatus: 'PENDING_COLLECTION', openRequest: false,
        collectedAmount: null, customerId: `cu-${id}`, deliveredAt: new Date('2026-10-18T09:00:00Z'), moderatorId: 'u-mod', confirmedById: 'u-conf', version: 1,
      });
    }
    const row = (id: string, orderId: string, over: WRow = {}): WRow => ({
      id, orderId, result: 'MATCHED', resolution: null, resolutionNote: null, resolvedById: null, appliedAt: null,
      expectedAmount: 20, expectedFee: 5, statementAmount: 20, statementFee: 5, order: { orderNumber: `ORD-${orderId}`, settlementMatches: [] }, ...over,
    });
    world.rows = [row(rowId(1), 'oA'), row(rowId(2), 'oQ', { result: 'MISMATCHED', expectedAmount: 25, statementAmount: 24 })];
  };

  it('OFF: the order was still waiting, a cancel asked for after the approval makes the close stop on it; ON: it was settled at the approval, so nothing is left to stop', async () => {
    build(false);
    await PATCH(send('PATCH', { approve: true }), params());
    world.orders.get('oA')!.openRequest = true;
    world.rows[1] = { ...world.rows[1], resolution: 'UNDER_REVIEW', resolutionNote: 'نراجع', resolvedById: 'u-decider' };
    const off = await CLOSE(send('POST', {}), params());
    expect(off.status).toBe(409);
    expect(await codeOf(off)).toBe('ORDERS_CHANGED');

    build(true);
    await PATCH(send('PATCH', { approve: true }), params());
    expect(world.orders.get('oA')!.settlementStatus).toBe('SETTLED');
    world.orders.get('oA')!.openRequest = true;
    world.rows[1] = { ...world.rows[1], resolution: 'UNDER_REVIEW', resolutionNote: 'نراجع', resolvedById: 'u-decider' };
    const on = await CLOSE(send('POST', {}), params());
    expect(on.status).toBe(200);
    expect(world.orders.get('oA')!.settlementStatus).toBe('SETTLED');
  });

  it('two statements that both name one order cleanly: the first APPROVED wins it with the switch on (the first CLOSED wins it with it off) — the loser stops on the order by name', async () => {
    // The statement under test is the second to be approved: another one settled the order first.
    build(true);
    world.orders.get('oA')!.settlementStatus = 'SETTLED';
    const res = await PATCH(send('PATCH', { approve: true }), params());
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.earlySettlement.heldBack).toEqual([{ orderNumber: 'ORD-oA', why: 'سُوِّي بباب آخر (تحصيل يدوي أو كشف ثاني)' }]);
    world.rows[1] = { ...world.rows[1], resolution: 'UNDER_REVIEW', resolutionNote: 'نراجع', resolvedById: 'u-decider' };
    const close = await CLOSE(send('POST', {}), params());
    expect(close.status).toBe(409);
    expect(await close.json()).toMatchObject({ code: 'ORDERS_CHANGED', orders: ['ORD-oA'] });
  });
});
