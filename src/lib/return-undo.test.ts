import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * ═══════════════════════════════════════════════════════════════════════
 * «تراجع عن المرتجع» (25/11) — THE RULES, THE PLAN AND THE PRESS, AGAINST A DATABASE THAT REMEMBERS.
 *
 * Order state and — later, through the statement — stock, so it is not tested with mocks that only count calls. The press runs against a
 * small in-memory database that (1) KEEPS STATE — the return is recorded by the REAL door recorder (`recordPartialDelivery`, nothing
 * taken), the statement is matched by the REAL `runMatching` and closed by the REAL `settleStatement` —, (2) ROLLS BACK a thrown
 * transaction, so «a refusal writes nothing» is proved by comparing the whole world before and after, and (3) records every touch of
 * anything the undo must NEVER touch (a wallet, a financial row, a batch).
 *
 * The stock: `consumeOrderStock` is replaced by a stand-in that keeps the real one's ledger key (one SALE line per order, never two), and
 * every call is counted — so «consumed ONCE, not twice, not zero» is read from the ledger AND from the calls.
 * ═══════════════════════════════════════════════════════════════════════
 */

const { current } = vi.hoisted(() => ({ current: { world: null as unknown as { onConsume: (orderId: string) => void } } }));
vi.mock('./db', () => ({ db: {}, default: {} }));
vi.mock('./stock-consumption', () => ({
  consumeOrderStock: vi.fn(async (_tx: unknown, input: { orderId: string }) => {
    current.world.onConsume(input.orderId);
    return { taken: 0, short: 0, alreadyDone: false, cost: 0 };
  }),
}));

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { stripComments } from './guard-source';
import { recordPartialDelivery } from './partial-delivery';
import { consumeOrderStock } from './stock-consumption';
import { runMatching } from './settlement';
import { settleStatement, type CloseRow } from './statement-close';
import { decisionMatrix } from './settlement-decisions';
import { ON_THE_COMPANY } from './shortfall';
import { DELIVERY_UNDO_ACTION, DOOR_MARK, SHIPPING_MARK } from './delivery-undo-words';
import {
  ReturnUndoStopped,
  beforeOf,
  claimData,
  claimWhere,
  fingerprintOf,
  judgeReturnUndo,
  measureReturnUndo,
  readReturnUndoFacts,
  recordingOf,
  undoReturn,
  type ReturnUndoFacts,
  type ReturnUndoMark,
} from './return-undo';
import {
  RETURN_UNDO_ACK_AR,
  RETURN_UNDO_ACTION,
  RETURN_UNDO_CHANGED_AR,
  RETURN_UNDO_FORBIDDEN_AR,
  RETURN_UNDO_LINE_AR,
  RETURN_UNDO_NOTE_PREFIX,
  RETURN_UNDO_NOT_FOUND_AR,
  RETURN_UNDO_ORDERS_CHANGED_AR,
  RETURN_UNDO_STAYS_AR,
  RETURN_UNDO_SUCCESS_AR,
  RETURN_UNDO_WHY_AR,
} from './return-undo-words';

/* ═════════════════════════ a database that remembers ═════════════════════════ */

type Row = Record<string, any>;
const clone = <T,>(v: T): T => structuredClone(v);

const openRequest = (r: Row) =>
  ['CANCEL', 'POSTPONE'].includes(r.intent) && (r.status === 'PENDING' || (r.status === 'APPROVED' && r.appliedAt == null));

/** Just enough of Prisma's `where`: equality, `null`, `in`, `not`, `notIn`, `lt`, `gt` — and the one relation the claims read, `changeRequests: { none }`. */
function matchesWhere(w: World, row: Row, where?: Row): boolean {
  if (!where) return true;
  for (const [k, v] of Object.entries(where)) {
    if (k === 'changeRequests') {
      if (w.state.requests.some((r) => r.orderId === row.id && openRequest(r))) return false;
      continue;
    }
    if (k === 'OR' || k === 'AND' || k === 'statement' || k === 'order') continue;
    const have = row[k];
    if (v === null) {
      if (have != null) return false;
    } else if (v && typeof v === 'object' && !(v instanceof Date) && !Array.isArray(v)) {
      if ('in' in v) {
        if (!v.in.includes(have)) return false;
      } else if ('notIn' in v) {
        if (v.notIn.includes(have)) return false;
      } else if ('not' in v) {
        if (v.not === null ? have == null : have === v.not) return false;
      } else if ('lt' in v) {
        if (!(have < v.lt)) return false;
      } else if ('gt' in v) {
        if (!(have > v.gt)) return false;
      }
    } else if (have !== v) return false;
  }
  return true;
}

function apply(row: Row, data: Row) {
  for (const [k, v] of Object.entries(data)) {
    if (v && typeof v === 'object' && !(v instanceof Date) && ('increment' in v || 'decrement' in v)) {
      row[k] = (row[k] ?? 0) + (v.increment ?? 0) - (v.decrement ?? 0);
    } else row[k] = v;
  }
}

interface State {
  order: Row;
  items: Row[];
  customer: Row;
  activities: Row[];
  logs: Row[];
  notes: Row[];
  attempts: Row[];
  requests: Row[];
  movements: Row[];
  statement: Row;
  lines: Row[];
  matches: Row[];
  seq: number;
}

class World {
  state: State;
  snap: State | null = null;
  forbidden: string[] = [];
  consumeCalls: string[] = [];
  hooks: { beforeClaim?: () => void } = {};

  constructor(over: { order?: Row; customer?: Row } = {}) {
    this.state = {
      order: {
        id: 'o1',
        companyId: 'c1',
        storeId: 's1',
        orderNumber: 'ORD-2026-0001',
        merchantRef: 'MR-1',
        trackingNumber: 'BC-1',
        deliveryProviderId: 'p1',
        customerId: 'cu1',
        currency: 'USD',
        shippingStatus: 'OUT_FOR_DELIVERY',
        settlementStatus: 'PENDING_COLLECTION',
        status: 'SHIPPED',
        version: 7,
        totalAmount: 55,
        collectedAmount: null,
        deliveredAt: null,
        returnedAt: null,
        returnReason: null,
        deliveryFee: 5,
        priceIncludesDelivery: false,
        returnReceipt: null,
        moderatorId: null,
        confirmedById: null,
        ...over.order,
      },
      items: [
        { id: 'i1', orderId: 'o1', productId: 'pr1', productName: 'كريم', quantity: 2, freeQuantity: 0, unitPrice: 10, discountShare: 0, lineTotal: 20, deliveredQty: null, returnedQty: null },
        { id: 'i2', orderId: 'o1', productId: 'pr2', productName: 'قطرة', quantity: 1, freeQuantity: 1, unitPrice: 30, discountShare: 0, lineTotal: 30, deliveredQty: null, returnedQty: null },
      ],
      customer: { id: 'cu1', companyId: 'c1', deliveredOrders: 4, cancelledOrders: 1, totalPurchaseValue: 120, ...over.customer },
      activities: [],
      logs: [],
      notes: [],
      attempts: [],
      requests: [],
      movements: [],
      statement: { id: 'st1', companyId: 'c1', storeId: 's1', reference: 'ST-1', status: 'MATCHED', approvedAt: null, matchingClosedAt: null, deliveryProviderId: 'p1', periodFrom: null, periodTo: null, createdAt: new Date(Date.UTC(2026, 10, 20)), fileHash: 'file-hash-1' },
      lines: [],
      matches: [],
      seq: 0,
    };
    current.world = this;
  }

  /** The stand-in for `consumeOrderStock`: the real one's key — one SALE line per order, never a second. Every call is counted. */
  onConsume(orderId: string) {
    this.consumeCalls.push(orderId);
    if (this.state.movements.some((m) => m.type === 'SALE' && m.referenceId === orderId)) return;
    const units = this.state.items.reduce((n, i) => n + i.quantity + i.freeQuantity, 0);
    this.state.movements.push({ id: `mv${++this.state.seq}`, companyId: 'c1', type: 'SALE', quantity: -units, referenceId: orderId });
  }

  /** A change another request committed meanwhile — kept even if THIS transaction rolls back. */
  concurrentChange(fn: (s: State) => void) {
    fn(this.state);
    if (this.snap) fn(this.snap);
  }

  async transaction<T>(fn: (tx: any) => Promise<T>): Promise<T> {
    const snap = clone(this.state);
    this.snap = snap;
    try {
      return await fn(this.tx());
    } catch (e) {
      this.state = snap;
      throw e;
    } finally {
      this.snap = null;
    }
  }

  snapshot(): State {
    return clone(this.state);
  }

  tx(): any {
    return makeTx(this);
  }
}

function makeTx(w: World): any {
  const strict = (model: string, impl: Record<string, (...a: any[]) => any>) =>
    new Proxy(impl, {
      get: (t, p: string) =>
        t[p] ??
        ((..._a: any[]) => {
          w.forbidden.push(`${model}.${p}`);
          return Promise.resolve(null);
        }),
    });
  const next = (prefix: string) => `${prefix}${++w.state.seq}`;
  const stamp = (row: Row) => ({ createdAt: new Date(Date.UTC(2026, 10, 13, 0, 0, w.state.seq)), ...row });
  const newestFirst = (rows: Row[]) => [...rows].sort((a, b) => b.createdAt - a.createdAt || String(b.id).localeCompare(String(a.id)));
  const fullOrder = () => ({
    ...clone(w.state.order),
    items: clone(w.state.items),
    addOns: [],
    deliveryProvider: { name: 'الباشا' },
    activities: [],
  });
  const stmt = () => ({ ...clone(w.state.statement) });
  const withRelations = (m: Row) => ({ ...clone(m), statement: stmt(), order: { orderNumber: w.state.order.orderNumber, settlementMatches: [] } });
  return {
    order: strict('order', {
      async findFirst({ where }: { where: Row }) {
        return matchesWhere(w, w.state.order, where) ? fullOrder() : null;
      },
      async findMany({ where }: { where: Row }) {
        return matchesWhere(w, w.state.order, where) ? [fullOrder()] : [];
      },
      async update({ where, data }: { where: Row; data: Row }) {
        if (where.id !== w.state.order.id) throw new Error('no such order');
        apply(w.state.order, data);
        return clone(w.state.order);
      },
      async updateMany({ where, data }: { where: Row; data: Row }) {
        w.hooks.beforeClaim?.();
        if (!matchesWhere(w, w.state.order, where)) return { count: 0 };
        apply(w.state.order, data);
        return { count: 1 };
      },
    }),
    orderItem: strict('orderItem', {
      async update({ where, data }: { where: Row; data: Row }) {
        for (const i of w.state.items) if (i.id === where.id) apply(i, data);
        return {};
      },
      async updateMany({ where, data }: { where: Row; data: Row }) {
        let count = 0;
        for (const i of w.state.items) {
          if (i.orderId === where.orderId && where.id.in.includes(i.id)) {
            apply(i, data);
            count += 1;
          }
        }
        return { count };
      },
    }),
    customer: strict('customer', {
      async findFirst({ where }: { where: Row }) {
        return matchesWhere(w, w.state.customer, where) ? clone(w.state.customer) : null;
      },
      async update({ where, data }: { where: Row; data: Row }) {
        if (where.id !== w.state.customer.id) throw new Error('no such customer');
        apply(w.state.customer, data);
        return clone(w.state.customer);
      },
      async updateMany({ where, data }: { where: Row; data: Row }) {
        if (!matchesWhere(w, w.state.customer, where)) return { count: 0 };
        apply(w.state.customer, data);
        return { count: 1 };
      },
    }),
    orderActivity: strict('orderActivity', {
      async create({ data }: { data: Row }) {
        const row = stamp({ id: next('a'), ...data });
        w.state.activities.push(row);
        return clone(row);
      },
      async findMany({ where }: { where: Row }) {
        return clone(newestFirst(w.state.activities.filter((r) => matchesWhere(w, r, where))));
      },
    }),
    orderStatusLog: strict('orderStatusLog', {
      async create({ data }: { data: Row }) {
        const row = stamp({ id: next('l'), ...data });
        w.state.logs.push(row);
        return clone(row);
      },
      async findMany({ where }: { where: Row }) {
        return clone(newestFirst(w.state.logs.filter((r) => matchesWhere(w, r, where))));
      },
    }),
    orderNote: strict('orderNote', {
      async create({ data }: { data: Row }) {
        const row = stamp({ id: next('n'), ...data });
        w.state.notes.push(row);
        return clone(row);
      },
    }),
    deliveryAttempt: strict('deliveryAttempt', {
      async findFirst() {
        const last = w.state.attempts[w.state.attempts.length - 1];
        return last ? { attemptNumber: last.attemptNumber } : null;
      },
      async findMany({ where }: { where: Row }) {
        return clone(w.state.attempts.filter((r) => matchesWhere(w, r, { orderId: where.orderId, result: where.result })));
      },
      async create({ data }: { data: Row }) {
        const row = stamp({ id: next('d'), ...data });
        w.state.attempts.push(row);
        return clone(row);
      },
    }),
    orderChangeRequest: strict('orderChangeRequest', {
      async findMany({ where }: { where: Row }) {
        const ids: string[] = where.orderId?.in ?? [where.orderId];
        return clone(w.state.requests.filter((r) => ids.includes(r.orderId) && openRequest(r)));
      },
    }),
    courierStatement: strict('courierStatement', {
      async findFirst() {
        return stmt();
      },
    }),
    statementLine: strict('statementLine', {
      async findMany({ where }: { where: Row }) {
        if (where.statementId) return clone(w.state.lines.filter((l) => l.statementId === where.statementId));
        const keys = new Set<string>(
          (where.OR ?? []).flatMap((o: Row) => [...(o.barcode?.in ?? []), ...(o.merchantRef?.in ?? [])])
        );
        return w.state.lines
          .filter((l) => keys.has(l.barcode) || keys.has(l.merchantRef))
          .map((l) => ({ ...clone(l), statement: stmt(), matches: w.state.matches.filter((m) => m.statementLineId === l.id).map((m) => ({ result: m.result })) }));
      },
    }),
    settlementMatch: strict('settlementMatch', {
      async findMany({ where }: { where: Row }) {
        if (where.resolution === 'OURS_STANDS' || where.matchedBy) return [];
        return w.state.matches.filter((m) => matchesWhere(w, m, where)).map(withRelations);
      },
      async deleteMany({ where }: { where: Row }) {
        const before = w.state.matches.length;
        w.state.matches = w.state.matches.filter((m) => !(m.statementId === where.statementId && m.resolution == null && m.appliedAt == null && m.matchedBy !== 'MANUAL'));
        return { count: before - w.state.matches.length };
      },
      async create({ data }: { data: Row }) {
        const row = { id: next('sm'), resolution: null, appliedAt: null, matchedBy: null, ...data };
        w.state.matches.push(row);
        return clone(row);
      },
    }),
    commissionEntry: strict('commissionEntry', {
      async updateMany() {
        return { count: 0 };
      },
      async findMany() {
        return [];
      },
    }),
    penalty: strict('penalty', {
      async findMany() {
        return [];
      },
    }),
    user: strict('user', {
      async findMany() {
        return [];
      },
    }),
    inventoryMovement: strict('inventoryMovement', {
      async findMany({ where }: { where: Row }) {
        return clone(w.state.movements.filter((r) => matchesWhere(w, r, where)));
      },
    }),
    // Anything else — a wallet, a financial row, a production batch — is `forbidden`.
    walletMovement: strict('walletMovement', {}),
    financialTransaction: strict('financialTransaction', {}),
    productionBatch: strict('productionBatch', {}),
    wallet: strict('wallet', {}),
    orderAddOn: strict('orderAddOn', {}),
  };
}

const SCOPE = { companyId: 'c1', storeId: 's1' };
const USER = { id: 'u1', role: 'SUPER_ADMIN' };
const REASON = 'انسجّل مرتجع بالغلط — الشركة بتقول تم توصيلها';

/** «رجعت» as the REAL door recorder writes it: nothing taken. */
async function returnAtTheDoor(w: World, note: string | null = null) {
  return w.transaction((tx) =>
    recordPartialDelivery(tx, { companyId: 'c1', storeId: 's1', orderId: 'o1', lines: w.state.items.map((i) => ({ itemId: i.id, deliveredQty: 0 })), minorUnit: 2, userId: 'u9', note })
  );
}
/** «استلم» (everything taken), as the REAL door recorder writes it. */
async function deliverAtTheDoor(w: World) {
  return w.transaction((tx) =>
    recordPartialDelivery(tx, { companyId: 'c1', storeId: 's1', orderId: 'o1', lines: w.state.items.map((i) => ({ itemId: i.id, deliveredQty: i.quantity + i.freeQuantity })), minorUnit: 2, userId: 'u9', note: null })
  );
}

async function measureOf(w: World) {
  const facts = await readReturnUndoFacts(w.tx(), SCOPE, 'o1');
  return { facts: facts!, measure: measureReturnUndo(facts!) };
}
async function press(w: World, over: { fingerprint?: string } = {}) {
  const { measure } = await measureOf(w);
  return w.transaction((tx) =>
    undoReturn(tx, { scope: SCOPE, user: USER, orderId: 'o1', reason: REASON, fingerprint: over.fingerprint ?? (measure.fingerprint as string) })
  );
}
async function refusedBy(w: World, over: { fingerprint?: string } = {}): Promise<ReturnUndoStopped> {
  try {
    await press(w, over);
  } catch (e) {
    if (e instanceof ReturnUndoStopped) return e;
    throw e;
  }
  throw new Error('the press was not refused');
}
/** A press that must be refused, and must leave the whole world as it found it. */
async function refusesAndWritesNothing(w: World, over: { fingerprint?: string } = {}) {
  const before = w.snapshot();
  const stop = await refusedBy(w, over);
  expect(w.snapshot()).toEqual(before);
  expect(w.forbidden).toEqual([]);
  return stop;
}

/** A SHIPPING timeline line, as the order's own door writes one. */
function logged(w: World, previousValue: string, newValue: string) {
  w.state.seq += 1;
  w.state.logs.push({ id: `l${w.state.seq}`, companyId: 'c1', orderId: 'o1', statusType: 'SHIPPING', previousValue, newValue, createdAt: new Date(Date.UTC(2026, 10, 13, 0, 0, w.state.seq)) });
}

const ACTIVITY_OF_RETURN = (w: World) => w.state.activities.filter((a) => a.action === RETURN_UNDO_ACTION);

beforeEach(() => {
  vi.mocked(consumeOrderStock).mockClear();
});

/* ═════════════════════════ 1 · WHAT «رجعت» WROTE, AND THE UNDO PUTS BACK EXACTLY ═════════════════════════ */

describe('the press — «رجعت» recorded at the door, taken back', () => {
  it('the door recorder wrote what the plan says it writes (held to the REAL code) — and consumed no stock', async () => {
    const w = new World();
    const before = w.snapshot();
    const out = await returnAtTheDoor(w);
    expect(out.status).toBe('RETURNED');
    expect(w.state.order).toMatchObject({ shippingStatus: 'RETURNED', deliveredAt: null, version: 8, returnReason: 'رفض الاستلام بالكامل' });
    expect(w.state.order.returnedAt).toBeInstanceOf(Date);
    expect(w.state.items.map((i) => [i.deliveredQty, i.returnedQty])).toEqual([[0, 2], [0, 2]]);
    expect(w.state.customer).toEqual({ ...before.customer, cancelledOrders: before.customer.cancelledOrders + 1 });
    expect(w.state.activities.map((a) => [a.action, a.newStatus])).toEqual([[DOOR_MARK, 'RETURNED']]);
    expect(w.state.attempts.map((a) => a.result)).toEqual(['FAILED']);
    expect(w.state.movements).toEqual([]);
    expect(w.consumeCalls).toEqual([]);
  });

  it('puts the order, its lines and the customer back EXACTLY — and only appends history; no stock, no money', async () => {
    const w = new World();
    const before = w.snapshot();
    await returnAtTheDoor(w, 'الزبون رفض');
    const recorded = w.snapshot();

    const done = await press(w);
    expect(done.plan.to).toBe('SHIPPED');

    // the order: everything as before the door, but the version moved forward (twice — the door, then the undo)
    expect({ ...w.state.order, version: 0 }).toEqual({ ...before.order, shippingStatus: 'SHIPPED', version: 0 });
    expect(w.state.order.version).toBe(before.order.version + 2);
    expect(w.state.items).toEqual(before.items);
    expect(w.state.customer).toEqual(before.customer);

    // history only grows: the door's rows stay, one of each kind is added
    expect(w.state.activities.slice(0, recorded.activities.length)).toEqual(recorded.activities);
    expect(w.state.attempts).toEqual(recorded.attempts);
    expect(w.state.notes.slice(0, recorded.notes.length)).toEqual(recorded.notes);
    expect(ACTIVITY_OF_RETURN(w)).toHaveLength(1);
    expect(ACTIVITY_OF_RETURN(w)[0]).toMatchObject({ previousStatus: 'RETURNED', newStatus: 'SHIPPED', userId: 'u1' });
    expect(w.state.logs).toHaveLength(1);
    expect(w.state.logs[0]).toMatchObject({ statusType: 'SHIPPING', previousValue: 'RETURNED', newValue: 'SHIPPED', changedById: 'u1' });
    expect(w.state.notes.at(-1)).toMatchObject({ kind: 'internal', body: `${RETURN_UNDO_NOTE_PREFIX}: ${REASON}` });

    expect(w.state.movements).toEqual([]);
    expect(w.consumeCalls).toEqual([]);
    expect(w.forbidden).toEqual([]);
  });

  it('after the undo the door is open again: «استلم» records the delivery and consumes the stock once', async () => {
    const w = new World();
    await returnAtTheDoor(w);
    await press(w);
    const out = await deliverAtTheDoor(w);
    expect(out.status).toBe('DELIVERED');
    expect(w.state.movements.filter((m) => m.type === 'SALE')).toHaveLength(1);
    expect(w.consumeCalls).toEqual(['o1']);
  });

  it('PRESSING TWICE IS ONE UNDO: the second press is refused «already undone» and writes nothing', async () => {
    const w = new World();
    await returnAtTheDoor(w);
    const { measure } = await measureOf(w);
    await press(w, { fingerprint: measure.fingerprint! });
    const stop = await refusesAndWritesNothing(w, { fingerprint: measure.fingerprint! });
    expect(stop.body.code).toBe('ALREADY_UNDONE');
    expect(stop.body.error).toBe(RETURN_UNDO_WHY_AR.alreadyUndone('مشحون'));
    expect(ACTIVITY_OF_RETURN(w)).toHaveLength(1);
    expect(w.state.customer.cancelledOrders).toBe(1);
  });

  it('TWO PRESSES AT ONCE: the loser’s claim is short — «ORDERS_CHANGED» — and the winner’s write is all that remains', async () => {
    const w = new World();
    await returnAtTheDoor(w);
    const { measure } = await measureOf(w);
    // the other press commits between this one's read and its claim
    w.hooks.beforeClaim = () => {
      w.hooks.beforeClaim = undefined;
      w.concurrentChange((s) => {
        s.order.shippingStatus = 'SHIPPED';
        s.order.version += 1;
      });
    };
    const stop = await refusedBy(w, { fingerprint: measure.fingerprint! });
    expect(stop.body).toEqual({ code: 'ORDERS_CHANGED', error: RETURN_UNDO_ORDERS_CHANGED_AR });
    expect(ACTIVITY_OF_RETURN(w)).toHaveLength(0);
    expect(w.state.customer.cancelledOrders).toBe(2);
    expect(w.state.items.map((i) => i.returnedQty)).toEqual([2, 2]);
  });
});

/* ═════════════════════════ 2 · WHERE IT GOES BACK TO ═════════════════════════ */

describe('the state before the record — the timeline’s, else «مشحون»', () => {
  it.each(['OUT_FOR_DELIVERY', 'FAILED_DELIVERY', 'SHIPPED'])('the timeline said %s before «رجعت»: it goes back there', async (state) => {
    const w = new World({ order: { shippingStatus: state } });
    logged(w, 'READY_FOR_PICKUP', state);
    await returnAtTheDoor(w);
    const { measure } = await measureOf(w);
    expect(measure.to).toBe(state);
    await press(w);
    expect(w.state.order.shippingStatus).toBe(state);
  });

  it('no timeline line at all: «مشحون», and the dialog says the «before» was not in the ledgers', async () => {
    const w = new World();
    await returnAtTheDoor(w);
    const { measure } = await measureOf(w);
    expect(measure.to).toBe('SHIPPED');
    expect(measure.lines[0].text).toBe(RETURN_UNDO_LINE_AR.status('مرتجع', 'مشحون', true));
  });

  it('beforeOf reads the newest line at or before the door’s row — never a state a parcel cannot be in at the door', () => {
    const at = (s: number) => new Date(Date.UTC(2026, 10, 1, 0, 0, s));
    const mark = { at: at(10) };
    expect(beforeOf(mark, [{ previousValue: 'SHIPPED', newValue: 'OUT_FOR_DELIVERY', at: at(5) }, { previousValue: null, newValue: 'SHIPPED', at: at(1) }])).toEqual({ to: 'OUT_FOR_DELIVERY', defaulted: false });
    expect(beforeOf(mark, [{ previousValue: 'X', newValue: 'READY_FOR_PICKUP', at: at(5) }])).toEqual({ to: 'SHIPPED', defaulted: true });
    expect(beforeOf(mark, [])).toEqual({ to: 'SHIPPED', defaulted: true });
  });
});

/* ═════════════════════════ 3 · WHAT IT REFUSES — EACH WRITES NOTHING ═════════════════════════ */

describe('every refusal says why in Arabic and writes NOTHING — the whole world is compared, before and after', () => {
  it('not RETURNED: a parcel on the road, a delivered one', async () => {
    const w = new World();
    let stop = await refusesAndWritesNothing(w);
    expect(stop.body).toEqual({ code: 'NOT_RETURNED', error: RETURN_UNDO_WHY_AR.notReturned('خرج للتوصيل') });
    await deliverAtTheDoor(w);
    stop = await refusesAndWritesNothing(w);
    expect(stop.body.code).toBe('NOT_RETURNED');
  });

  it('not recorded by the door: RETURNED with no «رجعت» row at all', async () => {
    const w = new World({ order: { shippingStatus: 'RETURNED' } });
    const stop = await refusesAndWritesNothing(w);
    expect(stop.body).toEqual({ code: 'NOT_BY_THE_DOOR', error: RETURN_UNDO_WHY_AR.notByTheDoor });
  });

  it('not recorded by the door: the order’s own door wrote the RETURNED (its row, not the door’s)', async () => {
    const w = new World({ order: { shippingStatus: 'RETURNED' } });
    w.state.activities.push({ id: 'a0', companyId: 'c1', orderId: 'o1', action: SHIPPING_MARK, newStatus: 'RETURNED', createdAt: new Date(Date.UTC(2026, 10, 1)) });
    const stop = await refusesAndWritesNothing(w);
    expect(stop.body.code).toBe('NOT_BY_THE_DOOR');
  });

  it('a return receipt exists — the desk counted it', async () => {
    const w = new World();
    await returnAtTheDoor(w);
    w.state.order.returnReceipt = { id: 'rr1', courierFeeAmount: 0 };
    const stop = await refusesAndWritesNothing(w);
    expect(stop.body).toEqual({ code: 'RETURN_COUNTED', error: RETURN_UNDO_WHY_AR.returnCounted });
  });

  it('the status moved after the record: a timeline line written after the door’s row', async () => {
    const w = new World();
    await returnAtTheDoor(w);
    logged(w, 'RETURNED', 'RETURNED');
    const stop = await refusesAndWritesNothing(w);
    expect(stop.body).toEqual({ code: 'CHANGED_AFTER', error: RETURN_UNDO_WHY_AR.changedAfter });
  });

  it('the status moved after the record: a newer status row to another state', async () => {
    const w = new World();
    await returnAtTheDoor(w);
    w.state.seq += 1;
    w.state.activities.push({ id: `a${w.state.seq}`, companyId: 'c1', orderId: 'o1', action: SHIPPING_MARK, newStatus: 'RETURN_REQUESTED', createdAt: new Date(Date.UTC(2026, 10, 13, 0, 0, w.state.seq)) });
    const stop = await refusesAndWritesNothing(w);
    expect(stop.body.code).toBe('CHANGED_AFTER');
  });

  it.each(['SETTLED', 'PARTIALLY_SETTLED', 'COLLECTED', 'REFUNDED', 'PARTIALLY_REFUNDED', 'CANCELLED'])('a settlement state that carries money or is closed: %s', async (state) => {
    const w = new World();
    await returnAtTheDoor(w);
    w.state.order.settlementStatus = state;
    const stop = await refusesAndWritesNothing(w);
    expect(stop.body).toEqual({ code: 'MONEY_RECORDED', error: RETURN_UNDO_WHY_AR.moneyState(state) });
  });

  it.each(['NOT_APPLICABLE', 'PENDING', 'PENDING_COLLECTION', 'UNSETTLED'])('a settlement state with no money is no reason: %s', async (state) => {
    const w = new World({ order: { settlementStatus: state } });
    await returnAtTheDoor(w);
    await press(w);
    expect(w.state.order.settlementStatus).toBe(state);
  });

  it('a collected amount written on the order is money recorded', async () => {
    const w = new World();
    await returnAtTheDoor(w);
    w.state.order.collectedAmount = 10;
    const stop = await refusesAndWritesNothing(w);
    expect(stop.body).toEqual({ code: 'MONEY_RECORDED', error: RETURN_UNDO_WHY_AR.moneyAmount });
  });

  it.each([
    ['a cancel asked for', { intent: 'CANCEL', status: 'PENDING', appliedAt: null }],
    ['a postponement asked for', { intent: 'POSTPONE', status: 'PENDING', appliedAt: null }],
    ['a postponement approved and not carried out', { intent: 'POSTPONE', status: 'APPROVED', appliedAt: null }],
  ])('an open request: %s', async (_n, r) => {
    const w = new World();
    await returnAtTheDoor(w);
    w.state.requests.push({ id: 'cr1', orderId: 'o1', ...r });
    const stop = await refusesAndWritesNothing(w);
    expect(stop.body).toEqual({ code: 'OPEN_REQUEST', error: RETURN_UNDO_WHY_AR.openRequest });
  });

  it('a request that is closed (rejected, or carried out) or of another kind is no reason', async () => {
    const w = new World();
    await returnAtTheDoor(w);
    w.state.requests.push(
      { id: 'cr1', orderId: 'o1', intent: 'CANCEL', status: 'REJECTED', appliedAt: null },
      { id: 'cr2', orderId: 'o1', intent: 'POSTPONE', status: 'APPROVED', appliedAt: new Date() },
      { id: 'cr3', orderId: 'o1', intent: 'EDIT', status: 'PENDING', appliedAt: null },
      { id: 'cr4', orderId: 'o2', intent: 'CANCEL', status: 'PENDING', appliedAt: null }
    );
    await press(w);
    expect(w.state.order.shippingStatus).toBe('SHIPPED');
  });

  it('changed since the measure — a wrong fingerprint: «changed», nothing written, though every rule is satisfied', async () => {
    const w = new World();
    await returnAtTheDoor(w);
    const stop = await refusesAndWritesNothing(w, { fingerprint: 'f'.repeat(24) });
    expect(stop.body).toEqual({ code: 'CHANGED', error: RETURN_UNDO_CHANGED_AR });
  });

  it('changed since the measure — the order was edited after the dialog opened (its version moved)', async () => {
    const w = new World();
    await returnAtTheDoor(w);
    const { measure } = await measureOf(w);
    w.state.order.version += 1;
    const stop = await refusesAndWritesNothing(w, { fingerprint: measure.fingerprint! });
    expect(stop.body.code).toBe('CHANGED');
  });

  it('a return counted, or a request opened, between the read and the claim: the claim is short, nothing is written', async () => {
    for (const change of [
      (s: State) => (s.order.returnReceipt = { id: 'rr1', courierFeeAmount: 0 }),
      (s: State) => s.requests.push({ id: 'cr9', orderId: 'o1', intent: 'CANCEL', status: 'PENDING', appliedAt: null }),
      (s: State) => (s.order.settlementStatus = 'SETTLED'),
    ]) {
      const w = new World();
      await returnAtTheDoor(w);
      const { measure } = await measureOf(w);
      w.hooks.beforeClaim = () => {
        w.hooks.beforeClaim = undefined;
        w.concurrentChange(change);
      };
      const before = w.snapshot();
      const stop = await refusedBy(w, { fingerprint: measure.fingerprint! });
      expect(stop.body.code).toBe('ORDERS_CHANGED');
      expect(w.state.activities).toEqual(before.activities);
      expect(w.state.customer).toEqual(before.customer);
      expect(w.state.items).toEqual(before.items);
    }
  });

  it('an order of another store is not found', async () => {
    const w = new World({ order: { storeId: 's2' } });
    expect(await readReturnUndoFacts(w.tx(), SCOPE, 'o1')).toBeNull();
    await expect(w.transaction((tx) => undoReturn(tx, { scope: SCOPE, user: USER, orderId: 'o1', reason: REASON, fingerprint: 'x'.repeat(24) }))).rejects.toMatchObject({
      status: 404,
      body: { code: 'NOT_FOUND', error: RETURN_UNDO_NOT_FOUND_AR },
    });
  });

  it('the order of the refusals: not returned, money, the receipt, a request, then the recording', () => {
    const base = facts();
    expect(judgeReturnUndo(base).ok).toBe(true);
    const all = facts({ order: { hasCollectedAmount: true, hasReturnReceipt: true }, openRequests: 1, marks: [] });
    expect((judgeReturnUndo(all) as { code: string }).code).toBe('MONEY_RECORDED');
    expect((judgeReturnUndo(facts({ order: { hasReturnReceipt: true }, openRequests: 1, marks: [] })) as { code: string }).code).toBe('RETURN_COUNTED');
    expect((judgeReturnUndo(facts({ openRequests: 1, marks: [] })) as { code: string }).code).toBe('OPEN_REQUEST');
    expect((judgeReturnUndo(facts({ marks: [] })) as { code: string }).code).toBe('NOT_BY_THE_DOOR');
    expect((judgeReturnUndo(facts({ order: { shippingStatus: 'SHIPPED', hasCollectedAmount: true } })) as { code: string }).code).toBe('NOT_RETURNED');
  });
});

/* ═════════════════════════ 4 · A STATEMENT IS THE REASON, NOT A REFUSAL ═════════════════════════ */

describe('a statement that names the order does not refuse the undo — it is the reason for it', () => {
  it('an APPROVED statement line «delivered, paid» names the order by its barcode: the undo goes through, and the dialog says the statement waits for a new matching', async () => {
    const w = new World();
    await returnAtTheDoor(w);
    w.state.statement.approvedAt = new Date(Date.UTC(2026, 10, 21));
    w.state.lines.push({ id: 'ln1', statementId: 'st1', barcode: 'BC-1', merchantRef: null, amount: 50, fee: 5, collected: 55, status: 'تم توصيلها' });
    w.state.matches.push({ id: 'sm0', companyId: 'c1', statementId: 'st1', statementLineId: 'ln1', orderId: 'o1', result: 'MISMATCHED', resolution: null, appliedAt: null, matchedBy: 'BARCODE' });
    const { measure } = await measureOf(w);
    expect(measure.allowed).toBe(true);
    expect(measure.stays.map((s) => s.key)).toContain('STATEMENT');
    expect(measure.stays.find((s) => s.key === 'STATEMENT')?.text).toBe(RETURN_UNDO_STAYS_AR.statement);
    await press(w);
    expect(w.state.order.shippingStatus).toBe('SHIPPED');
  });

  it('with no statement the dialog draws no statement line', async () => {
    const w = new World();
    await returnAtTheDoor(w);
    const { measure } = await measureOf(w);
    expect(measure.stays.map((s) => s.key)).toEqual(['STOCK', 'MONEY', 'HISTORY']);
  });
});

/* ═════════════════════════ 5 · THE CUSTOMER'S COUNTERS ═════════════════════════ */

describe('the customer’s counters come back exactly, and never below zero', () => {
  it.each([0, 1, 7])('starting from %i refused orders: back to exactly that, the other counters untouched', async (n) => {
    const w = new World({ customer: { cancelledOrders: n } });
    const before = w.snapshot().customer;
    await returnAtTheDoor(w);
    expect(w.state.customer.cancelledOrders).toBe(n + 1);
    await press(w);
    expect(w.state.customer).toEqual(before);
  });

  it('a counter that fell under what the door added (somebody brought it to zero meanwhile) is held at zero, not taken under it', async () => {
    const w = new World({ customer: { cancelledOrders: 0 } });
    await returnAtTheDoor(w);
    w.state.customer.cancelledOrders = 0;
    const { measure } = await measureOf(w);
    expect(measure.lines.find((l) => l.key === 'CUSTOMER')?.text).toBe(RETURN_UNDO_LINE_AR.customer(0, 0));
    await press(w);
    expect(w.state.customer.cancelledOrders).toBe(0);
    expect(w.state.customer.deliveredOrders).toBe(4);
    expect(w.state.customer.totalPurchaseValue).toBe(120);
  });

  it('the measure says the counter it will take back, from where to where', async () => {
    const w = new World({ customer: { cancelledOrders: 2 } });
    await returnAtTheDoor(w);
    const { measure } = await measureOf(w);
    expect(measure.lines.map((l) => l.key)).toEqual(['STATUS', 'ITEMS', 'CUSTOMER']);
    expect(measure.lines[2].text).toBe(RETURN_UNDO_LINE_AR.customer(2, 3));
    expect(measure.lines[1].text).toBe(RETURN_UNDO_LINE_AR.items(2));
  });
});

/* ═════════════════════════ 6 · THEN THE STATEMENT: MATCHED, CLOSED, THE STOCK ONCE ═════════════════════════ */

const asCloseRows = (w: World): CloseRow[] =>
  w.state.matches.map((m) => ({
    id: m.id,
    orderId: m.orderId ?? null,
    result: m.result,
    resolution: m.resolution ?? null,
    resolutionNote: m.resolutionNote ?? null,
    resolvedById: m.resolvedById ?? null,
    statementAmount: m.statementAmount ?? null,
    statementFee: m.statementFee ?? null,
    expectedAmount: m.expectedAmount ?? null,
    expectedFee: m.expectedFee ?? null,
    appliedAt: m.appliedAt ?? null,
    order: { orderNumber: w.state.order.orderNumber, settlementMatches: [] },
  }));

async function match(w: World) {
  return w.transaction((tx) => runMatching(tx, { companyId: 'c1', storeId: 's1', statementId: 'st1', minorUnit: 2 }));
}
async function close(w: World, shortfallPeople?: Record<string, string>) {
  return w.transaction((tx) =>
    settleStatement(tx, {
      companyId: 'c1',
      storeId: 's1',
      userId: 'u1',
      minorUnit: 2,
      statement: { id: 'st1', reference: 'ST-1', currencyCode: 'USD', createdAt: w.state.statement.createdAt, periodTo: null },
      matches: asCloseRows(w),
      shortfallPeople,
    })
  );
}
/** The company's line: «تم توصيلها», the full price paid (net 50 + fee 5). */
const paidLine = (amount = 50) => ({ id: 'ln1', statementId: 'st1', barcode: 'BC-1', merchantRef: null, amount, fee: 5, collected: amount + 5, status: 'تم توصيلها', createdAt: new Date(Date.UTC(2026, 10, 20)) });

describe('after the undo the company’s statement settles the order — and the stock leaves the shelf ONCE', () => {
  it('CONTROL: without the undo, the line «delivered + money» against our RETURNED order is a difference, and the close neither delivers it nor touches the stock', async () => {
    const w = new World();
    await returnAtTheDoor(w);
    w.state.lines.push(paidLine());
    await match(w);
    expect(w.state.matches.map((m) => m.result)).toEqual(['MISMATCHED']);
    const out = await close(w);
    expect(out.deliveredCount).toBe(0);
    expect(w.state.order.shippingStatus).toBe('RETURNED');
    expect(w.state.movements).toEqual([]);
    expect(w.consumeCalls).toEqual([]);
  });

  it('undo → matching: MATCHED → the close promotes it to DELIVERED and consumes the stock exactly once, with the gross the company paid', async () => {
    const w = new World();
    await returnAtTheDoor(w);
    w.state.lines.push(paidLine());
    await press(w);
    const outcome = await match(w);
    expect(outcome.matched).toBe(1);
    expect(w.state.matches.map((m) => [m.result, m.orderId])).toEqual([['MATCHED', 'o1']]);

    const out = await close(w);
    expect(out.deliveredCount).toBe(1);
    expect(w.state.order).toMatchObject({ shippingStatus: 'DELIVERED', settlementStatus: 'SETTLED', collectedAmount: 55 });
    const sales = w.state.movements.filter((m) => m.type === 'SALE');
    expect(sales).toHaveLength(1);
    expect(sales[0].quantity).toBe(-4); // every unit of the parcel: 2 + (1 + 1 free)
    expect(w.consumeCalls).toEqual(['o1']);
    // the customer: the refusal taken back by the undo, the delivery added by the close
    expect(w.state.customer).toMatchObject({ cancelledOrders: 1, deliveredOrders: 5, totalPurchaseValue: 175 });
    expect(w.forbidden).toEqual([]);
  });

  it('NOT TWICE: «استلم» after the undo consumed it; the close that follows finds a delivered order and consumes nothing more', async () => {
    const w = new World();
    await returnAtTheDoor(w);
    w.state.lines.push(paidLine());
    await press(w);
    await deliverAtTheDoor(w);
    await match(w);
    expect(w.state.matches.map((m) => m.result)).toEqual(['MATCHED']);
    const out = await close(w);
    expect(out.deliveredCount).toBe(0);
    expect(w.state.movements.filter((m) => m.type === 'SALE')).toHaveLength(1);
    expect(w.consumeCalls).toEqual(['o1']);
    expect(w.state.order.collectedAmount).toBe(55);
  });

  it('a LOWER figure (a discount at the door): an in-flight difference whose «اعتُمد رقم الشركة» is allowed — and the close then delivers it and consumes once', async () => {
    const w = new World();
    await returnAtTheDoor(w);
    w.state.lines.push(paidLine(42));
    await press(w);
    await match(w);
    const row = w.state.matches[0];
    expect(row.result).toBe('MISMATCHED');

    const asked = (shippingStatus: string) =>
      decisionMatrix({
        hasOrder: true,
        shippingStatus,
        settlementStatus: w.state.order.settlementStatus,
        openRequests: [],
        claimedElsewhere: false,
        statementApproved: false,
        expectedAmount: Number(row.expectedAmount),
        statementAmount: Number(row.statementAmount),
        courierOutcome: 'DELIVERED' as never,
        minorUnit: 2,
      });
    expect(asked(w.state.order.shippingStatus).ACCEPTED_COURIER.allowed).toBe(true);
    // the same line against the order BEFORE the undo (still RETURNED) is refused
    expect(asked('RETURNED').ACCEPTED_COURIER.allowed).toBe(false);

    Object.assign(row, { resolution: 'ACCEPTED_COURIER', resolutionNote: 'خصم عند الباب وافق عليه الزبون', resolvedById: 'u1' });
    const out = await close(w, { [row.id]: ON_THE_COMPANY });
    expect(out.acceptedCount).toBe(1);
    expect(w.state.order.shippingStatus).toBe('DELIVERED');
    expect(w.state.movements.filter((m) => m.type === 'SALE')).toHaveLength(1);
    expect(w.consumeCalls).toEqual(['o1']);
  });
});

/* ═════════════════════════ 7 · THE PIECES ═════════════════════════ */

let seq = 0;
const mk = (action: string, newStatus: string | null, s: number): ReturnUndoMark => ({ id: `m${++seq}`, action, newStatus, at: new Date(Date.UTC(2026, 10, 1, 0, 0, s)) });
function facts(over: { order?: Partial<ReturnUndoFacts['order']>; marks?: ReturnUndoMark[]; shippingLog?: ReturnUndoFacts['shippingLog']; openRequests?: number; named?: boolean } = {}): ReturnUndoFacts {
  return {
    order: {
      id: 'o1',
      orderNumber: 'ORD-1',
      merchantRef: null,
      trackingNumber: null,
      deliveryProviderId: 'p1',
      customerId: 'cu1',
      courier: 'الباشا',
      shippingStatus: 'RETURNED',
      settlementStatus: 'PENDING_COLLECTION',
      version: 3,
      hasCollectedAmount: false,
      items: [{ id: 'i1', productName: 'كريم', deliveredQty: 0, returnedQty: 1 }],
      hasReturnReceipt: false,
      ...over.order,
    },
    marks: over.marks ?? [mk(DOOR_MARK, 'RETURNED', 10)],
    shippingLog: over.shippingLog ?? [],
    openRequests: over.openRequests ?? 0,
    customer: { cancelledOrders: 1 },
    named: over.named ?? false,
  };
}

describe('which door wrote the RETURNED — from the newest row that moves a status', () => {
  it('the door’s own row decides; an older delivery row under it does not matter', () => {
    const r = recordingOf({ marks: [mk(DOOR_MARK, 'RETURNED', 10), mk(DOOR_MARK, 'DELIVERED', 5)], shippingLog: [] });
    expect(r.ok).toBe(true);
  });
  it('REFUSED: the newest row is an undo (of a return or of a delivery)', () => {
    expect(recordingOf({ marks: [mk(RETURN_UNDO_ACTION, 'SHIPPED', 11), mk(DOOR_MARK, 'RETURNED', 10)], shippingLog: [] })).toMatchObject({ ok: false, code: 'NOT_BY_THE_DOOR' });
    expect(recordingOf({ marks: [mk(DELIVERY_UNDO_ACTION, 'SHIPPED', 11)], shippingLog: [] })).toMatchObject({ ok: false, code: 'NOT_BY_THE_DOOR' });
  });
  it('a row with no status is skipped', () => {
    expect(recordingOf({ marks: [mk(SHIPPING_MARK, null, 12), mk(DOOR_MARK, 'RETURNED', 10)], shippingLog: [] }).ok).toBe(true);
  });
  it('a timeline line AT the door’s row is not «after» it; one a second later is', () => {
    const door = mk(DOOR_MARK, 'RETURNED', 10);
    expect(recordingOf({ marks: [door], shippingLog: [{ previousValue: 'SHIPPED', newValue: 'OUT_FOR_DELIVERY', at: door.at }] }).ok).toBe(true);
    expect(recordingOf({ marks: [door], shippingLog: [{ previousValue: 'RETURNED', newValue: 'RETURNED', at: new Date(door.at.getTime() + 1000) }] })).toMatchObject({ ok: false, code: 'CHANGED_AFTER' });
  });
});

describe('the fingerprint and the claim', () => {
  it('the same order and plan give the same print; any part of it moves it', () => {
    const f = facts();
    const j = judgeReturnUndo(f);
    if (!j.ok) throw new Error('refused');
    const p = fingerprintOf(f.order, j.plan);
    expect(fingerprintOf(f.order, j.plan)).toBe(p);
    expect(fingerprintOf({ ...f.order, version: 4 }, j.plan)).not.toBe(p);
    expect(fingerprintOf(f.order, { ...j.plan, to: 'OUT_FOR_DELIVERY' })).not.toBe(p);
    expect(fingerprintOf(f.order, { ...j.plan, markId: 'other' })).not.toBe(p);
    expect(fingerprintOf(f.order, { ...j.plan, settlementFrom: 'PENDING' })).not.toBe(p);
    expect(fingerprintOf(f.order, { ...j.plan, items: [] })).not.toBe(p);
  });

  it('holds the order to this store, version, RETURNED, this settlement, no money, no receipt, no open request — and writes only four columns', () => {
    const f = facts();
    const j = judgeReturnUndo(f);
    if (!j.ok) throw new Error('refused');
    expect(claimWhere(SCOPE, f.order, j.plan)).toEqual({
      id: 'o1',
      companyId: 'c1',
      storeId: 's1',
      version: 3,
      shippingStatus: 'RETURNED',
      settlementStatus: 'PENDING_COLLECTION',
      collectedAmount: null,
      returnReceipt: null,
      changeRequests: { none: { intent: { in: ['CANCEL', 'POSTPONE'] }, OR: [{ status: 'PENDING' }, { status: 'APPROVED', appliedAt: null }] } },
    });
    expect(claimData(j.plan)).toEqual({ shippingStatus: 'SHIPPED', returnedAt: null, returnReason: null, version: { increment: 1 } });
  });

  it('a refusal carries the reason and NO fingerprint, no lines — there is nothing to press', () => {
    const m = measureReturnUndo(facts({ order: { hasReturnReceipt: true } }));
    expect(m).toMatchObject({ allowed: false, fingerprint: null, to: null, lines: [], stays: [], refusal: { code: 'RETURN_COUNTED' } });
  });
});

/* ═════════════════════════ 8 · THE WORDS AND THE SOURCES ═════════════════════════ */

describe('the words — Arabic, all of them, and the history says them too', () => {
  it('every sentence the door and the dialog can say has no English word in it', () => {
    const sentences: string[] = [
      RETURN_UNDO_FORBIDDEN_AR,
      RETURN_UNDO_ACK_AR,
      RETURN_UNDO_NOT_FOUND_AR,
      RETURN_UNDO_CHANGED_AR,
      RETURN_UNDO_ORDERS_CHANGED_AR,
      RETURN_UNDO_WHY_AR.notReturned('مشحون'),
      RETURN_UNDO_WHY_AR.alreadyUndone('مشحون'),
      RETURN_UNDO_WHY_AR.notByTheDoor,
      RETURN_UNDO_WHY_AR.changedAfter,
      RETURN_UNDO_WHY_AR.returnCounted,
      RETURN_UNDO_WHY_AR.moneyAmount,
      RETURN_UNDO_WHY_AR.openRequest,
      ...['SETTLED', 'COLLECTED', 'REFUNDED', 'SOMETHING_NEW'].map((s) => RETURN_UNDO_WHY_AR.moneyState(s)),
      RETURN_UNDO_LINE_AR.status('مرتجع', 'مشحون', true),
      RETURN_UNDO_LINE_AR.status('مرتجع', 'مشحون', false),
      RETURN_UNDO_LINE_AR.items(2),
      RETURN_UNDO_LINE_AR.customer(1, 2),
      RETURN_UNDO_LINE_AR.customer(0, 0),
      ...Object.values(RETURN_UNDO_STAYS_AR),
      RETURN_UNDO_SUCCESS_AR('٠', 'مشحون'),
    ];
    for (const s of sentences) expect(s, s).not.toMatch(/[A-Za-z]/);
  });

  it('the order’s timeline and the audit view each carry an Arabic word for the activity', () => {
    const read = (p: string) => readFileSync(join(process.cwd(), p), 'utf8');
    for (const f of ['src/lib/order-timeline.ts', 'src/lib/audit-view.ts']) {
      const word = new RegExp(`${RETURN_UNDO_ACTION}: '([^']+)'`).exec(read(f))?.[1];
      expect(word, `${f} has no word for ${RETURN_UNDO_ACTION}`).toBeTruthy();
      expect(word, f).not.toMatch(/[A-Za-z]/);
    }
  });
});

describe('the sources — no clock, no money writer, no stock writer, nothing deleted', () => {
  const read = (p: string) => stripComments(readFileSync(join(process.cwd(), p), 'utf8'));
  const FILES = ['src/lib/return-undo.ts', 'src/lib/return-undo-words.ts', 'src/app/api/ops/tracking/undo-return/route.ts'];

  it('not one of them reads a clock — a return is never «too old» or «too new» to be taken back', () => {
    for (const f of FILES) expect(read(f), f).not.toMatch(/Date\.now|new Date\(|\.getTime\(|setTimeout|setInterval|differenceIn/);
  });

  it('writes no wallet, no financial row, no stock line or batch, no collected amount, no commission, no event', () => {
    for (const f of ['src/lib/return-undo.ts', 'src/app/api/ops/tracking/undo-return/route.ts']) {
      const src = read(f);
      expect(src, f).not.toMatch(/recordMovement|walletMovement|financialTransaction|inventoryMovement|productionBatch|consumeOrderStock|restoreOrderStock|commission|emitAppEvent|queueConversions/i);
      for (const line of src.split('\n').filter((l) => /collectedAmount:/.test(l))) expect(line, f).toMatch(/collectedAmount:\s*(true|null)\b/);
      expect(src, f).not.toMatch(/settlementStatus:\s*'/);
    }
  });

  it('deletes nothing: history is only appended to', () => {
    for (const f of FILES) expect(read(f), f).not.toMatch(/\.delete\(|\.deleteMany\(|\.upsert\(/);
  });
});
