import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * ═══════════════════════════════════════════════════════════════════════
 * «تراجع عن التسليم» (13/11) — THE RULES, THE PLAN AND THE PRESS, AGAINST A DATABASE THAT REMEMBERS.
 *
 *   «هاد الطلب بالغلط حطيتو تم والشركة بتقول تم ارجاعها لازم يكون في زر تراجع مش محدود بمدة زمنية ويكون عليه صلاحية للمالك متاح» (the owner)
 *
 * Money- and stock-adjacent, so it is not tested with mocks that only count calls. The press runs against a small in-memory database that
 * (1) KEEPS STATE — a delivery is recorded by the REAL door recorder (`recordPartialDelivery`) or by the order's own door's real helpers
 * (`shippingMoveColumns`, `recordShippingMove`, `appendDeliveryAttempt`), and the undo is then asked to take back exactly that —,
 * (2) ROLLS BACK a thrown transaction, so «a refusal writes nothing» is proved by comparing the whole world before and after, not by
 * counting calls, and (3) records every touch of anything the undo must NEVER touch (a wallet, the stock, a financial row).
 *
 * What is held here, in the owner's words:
 *   · the undo reverses EXACTLY what the recording wrote — compared against the real recorders, so a recorder that starts writing one
 *     more column fails here and says the undo must be revisited;
 *   · it has NO time window: the facts it reads carry no date at all, and the sources name no clock;
 *   · it refuses, with the reason in words, and writes nothing, on money · a statement · a counted return · a payable commission · a
 *     recording the ledgers cannot prove · stale numbers · two presses at once;
 *   · it never writes a wallet, an amount, the stock or an event; history is appended to, never edited.
 * ═══════════════════════════════════════════════════════════════════════
 */

const { current } = vi.hoisted(() => ({ current: { world: null as unknown as { onConsume: (orderId: string) => void } } }));
vi.mock('./db', () => ({ db: {}, default: {} }));
// The stock is NOT what the undo reverses — it is mocked only so the recorders can run; the stand-in writes the SALE line the real one writes.
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
import { recordShippingMove, shippingMoveColumns } from './shipping-move';
import { appendDeliveryAttempt } from './delivery-attempts';
import { proposeShortfalls } from './shortfall';
import { consumeOrderStock } from './stock-consumption';
import { EXCLUDED_RESULT } from './statement-open-lines';
import {
  BACK_TO_AWAITING,
  UndoStopped,
  beforeOf,
  claimData,
  claimWhere,
  commissionMoved,
  commissionVoidable,
  figureOf,
  fingerprintOf,
  judgeUndo,
  measureUndo,
  readUndoFacts,
  recordingOf,
  undoDelivery,
  type UndoCommission,
  type UndoFacts,
  type UndoMark,
  type UndoOrder,
  type UndoPlan,
} from './delivery-undo';
import {
  DELIVERY_UNDO_ACTION,
  DOOR_MARK,
  OVERRIDE_MARK,
  SHIPPING_MARK,
  UNDO_ACK_AR,
  UNDO_CHANGED_AR,
  UNDO_FORBIDDEN_AR,
  UNDO_LATE_COMMISSION_AR,
  UNDO_LATE_STATEMENT_AR,
  UNDO_LINE_AR,
  UNDO_NOT_FOUND_AR,
  UNDO_NOTE_PREFIX,
  UNDO_ORDERS_CHANGED_AR,
  UNDO_REASON_MAX,
  UNDO_REASON_MIN,
  UNDO_STAYS_AR,
  UNDO_SUCCESS_AR,
  UNDO_WHY_AR,
} from './delivery-undo-words';

/* ═════════════════════════ a database that remembers ═════════════════════════ */

type Row = Record<string, any>;
const clone = <T,>(v: T): T => structuredClone(v);

/** Just enough of Prisma's `where`: equality, `null`, `in`, `not`, `lt`, `gt`. Anything else (a relation filter) is ignored, as the fake reads no relations. */
function matches(row: Row, where?: Row): boolean {
  if (!where) return true;
  for (const [k, v] of Object.entries(where)) {
    const have = row[k];
    if (v === null) {
      if (have != null) return false;
    } else if (v && typeof v === 'object' && !(v instanceof Date) && !Array.isArray(v)) {
      if ('in' in v) {
        if (!v.in.includes(have)) return false;
      } else if ('not' in v) {
        if (have === v.not) return false;
      } else if ('notIn' in v) {
        if (v.notIn.includes(have)) return false;
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
  commission: Row[];
  movements: Row[];
  lines: Row[];
  links: Row[];
  seq: number;
}

class World {
  state: State;
  snap: State | null = null;
  /** Every call to something the undo must never touch — and to any write the fake was not told about. */
  forbidden: string[] = [];
  /** The order in which the fake's models were touched. */
  trace: string[] = [];
  hooks: { beforeClaim?: () => void; afterClaim?: () => void } = {};
  txCount = 0;
  /** The client the transaction handed out is a DIFFERENT object from the module's: a write that skips it is visible. */
  readonly db = {};

  constructor(over: { order?: Row; items?: Row[]; customer?: Row } = {}) {
    this.state = {
      order: {
        id: 'o1',
        companyId: 'c1',
        storeId: 's1',
        orderNumber: 'ORD-2026-1696',
        merchantRef: 'MR-1696',
        trackingNumber: '100550615867',
        deliveryProviderId: 'p1',
        customerId: 'cu1',
        currency: 'USD',
        shippingStatus: 'OUT_FOR_DELIVERY',
        settlementStatus: 'PENDING_COLLECTION',
        status: 'SHIPPED',
        version: 7,
        collectedAmount: null,
        deliveredAt: null,
        returnedAt: null,
        returnReason: null,
        deliveryFee: 5,
        priceIncludesDelivery: false,
        returnReceipt: null,
        ...over.order,
      },
      items: over.items ?? [
        { id: 'i1', orderId: 'o1', productId: 'p1', productName: 'كريم', quantity: 2, freeQuantity: 0, unitPrice: 10, discountShare: 0, lineTotal: 20, deliveredQty: null, returnedQty: null },
        { id: 'i2', orderId: 'o1', productId: 'p2', productName: 'قطرة', quantity: 1, freeQuantity: 1, unitPrice: 30, discountShare: 0, lineTotal: 30, deliveredQty: null, returnedQty: null },
      ],
      customer: { id: 'cu1', companyId: 'c1', deliveredOrders: 4, cancelledOrders: 1, totalPurchaseValue: 120, ...over.customer },
      activities: [],
      logs: [],
      notes: [],
      attempts: [],
      commission: [],
      movements: [],
      lines: [],
      links: [],
      seq: 0,
    };
    current.world = this;
  }

  /** The stand-in for `consumeOrderStock`: the SALE line the real one writes for a delivered order. */
  onConsume(orderId: string) {
    // the real one asks the ledger first and does nothing twice (`alreadyMoved`)
    if (this.state.movements.some((m) => m.type === 'SALE' && m.referenceId === orderId)) return;
    const units = this.state.items.reduce((n, i) => n + i.quantity + i.freeQuantity, 0);
    this.state.movements.push({ id: `mv${++this.state.seq}`, companyId: 'c1', type: 'SALE', quantity: -units, referenceId: orderId });
  }

  /** A change another request committed meanwhile — kept even if THIS transaction rolls back, as a real commit would be. */
  concurrentChange(fn: (s: State) => void) {
    fn(this.state);
    if (this.snap) fn(this.snap);
  }

  async transaction<T>(fn: (tx: any) => Promise<T>): Promise<T> {
    this.txCount += 1;
    const snap = clone(this.state);
    this.snap = snap;
    try {
      return await fn(this.tx());
    } catch (e) {
      this.state = snap; // the whole transaction is taken back
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

/** The client a transaction hands out: it reads and writes the world, and anything it was not told about is recorded as forbidden. */
function makeTx(w: World): any {
    const touch = (n: string) => w.trace.push(n);
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
    const newestFirst = (rows: Row[]) => [...rows].reverse();
    return {
      order: strict('order', {
        async findFirst({ where }: { where: Row }) {
          touch('order.findFirst');
          const o = w.state.order;
          if (!matches(o, where)) return null;
          return { ...clone(o), items: clone(w.state.items), addOns: [], deliveryProvider: { name: 'الباشا' } };
        },
        async update({ data }: { data: Row }) {
          touch('order.update');
          apply(w.state.order, data);
          return clone(w.state.order);
        },
        async updateMany({ where, data }: { where: Row; data: Row }) {
          touch('order.updateMany');
          w.hooks.beforeClaim?.();
          if (!matches(w.state.order, where)) return { count: 0 };
          apply(w.state.order, data);
          w.hooks.afterClaim?.();
          return { count: 1 };
        },
      }),
      orderItem: strict('orderItem', {
        async update({ where, data }: { where: Row; data: Row }) {
          touch('orderItem.update');
          for (const i of w.state.items) if (i.id === where.id) apply(i, data);
          return {};
        },
        async updateMany({ where, data }: { where: Row; data: Row }) {
          touch('orderItem.updateMany');
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
          touch('customer.findFirst');
          return matches(w.state.customer, where) ? clone(w.state.customer) : null;
        },
        async update({ where, data }: { where: Row; data: Row }) {
          touch('customer.update');
          if (where.id !== w.state.customer.id) throw new Error('no such customer');
          apply(w.state.customer, data);
          return clone(w.state.customer);
        },
        async updateMany({ where, data }: { where: Row; data: Row }) {
          touch('customer.updateMany');
          if (!matches(w.state.customer, where)) return { count: 0 };
          apply(w.state.customer, data);
          return { count: 1 };
        },
      }),
      orderActivity: strict('orderActivity', {
        async create({ data }: { data: Row }) {
          touch('orderActivity.create');
          const row = stamp({ id: next('a'), ...data });
          w.state.activities.push(row);
          return clone(row);
        },
        async findMany({ where }: { where: Row }) {
          touch('orderActivity.findMany');
          return clone(newestFirst(w.state.activities.filter((r) => matches(r, where))));
        },
      }),
      orderStatusLog: strict('orderStatusLog', {
        async create({ data }: { data: Row }) {
          touch('orderStatusLog.create');
          const row = stamp({ id: next('l'), ...data });
          w.state.logs.push(row);
          return clone(row);
        },
        async findMany({ where }: { where: Row }) {
          touch('orderStatusLog.findMany');
          return clone(newestFirst(w.state.logs.filter((r) => matches(r, where))));
        },
      }),
      orderNote: strict('orderNote', {
        async create({ data }: { data: Row }) {
          touch('orderNote.create');
          const row = stamp({ id: next('n'), ...data });
          w.state.notes.push(row);
          return clone(row);
        },
      }),
      deliveryAttempt: strict('deliveryAttempt', {
        async findFirst() {
          touch('deliveryAttempt.findFirst');
          const last = w.state.attempts[w.state.attempts.length - 1];
          return last ? { attemptNumber: last.attemptNumber } : null;
        },
        async create({ data }: { data: Row }) {
          touch('deliveryAttempt.create');
          const row = stamp({ id: next('d'), ...data });
          w.state.attempts.push(row);
          return clone(row);
        },
      }),
      commissionEntry: strict('commissionEntry', {
        async findMany({ where }: { where: Row }) {
          touch('commissionEntry.findMany');
          return clone(
            w.state.commission
              .filter((r) => matches(r, where))
              .map((r) => ({ ...r, reversedBy: w.state.commission.some((x) => x.reversalOfId === r.id) ? { id: 'rev' } : null }))
          );
        },
        async findUnique({ where }: { where: Row }) {
          touch('commissionEntry.findUnique');
          return clone(w.state.commission.find((r) => r.reversalOfId === where.reversalOfId) ?? null);
        },
        async create({ data }: { data: Row }) {
          touch('commissionEntry.create');
          const row = stamp({ id: next('ce'), payoutId: null, ...data });
          w.state.commission.push(row);
          return clone(row);
        },
      }),
      inventoryMovement: strict('inventoryMovement', {
        async findMany({ where }: { where: Row }) {
          touch('inventoryMovement.findMany');
          return clone(w.state.movements.filter((r) => matches(r, where)));
        },
      }),
      statementLine: strict('statementLine', {
        async findMany() {
          touch('statementLine.findMany');
          return clone(w.state.lines);
        },
      }),
      settlementMatch: strict('settlementMatch', {
        async findMany() {
          touch('settlementMatch.findMany');
          return clone(w.state.links);
        },
      }),
      // Anything else — a wallet, a financial row, a production batch, an app event's table — is `forbidden`.
      walletMovement: strict('walletMovement', {}),
      financialTransaction: strict('financialTransaction', {}),
      productionBatch: strict('productionBatch', {}),
      wallet: strict('wallet', {}),
      orderAddOn: strict('orderAddOn', {}),
    };
}

const SCOPE = { companyId: 'c1', storeId: 's1' };
const USER = { id: 'u1', role: 'SUPER_ADMIN' };
const REASON = 'انسجّل تسليمو بالغلط — الشركة بتقول تم إرجاعها';

/** The delivery as the REAL door recorder writes it (the «استلم» button, «استلم جزءاً», «استلم المحدد»). */
async function recordAtTheDoor(w: World, lines: { itemId: string; deliveredQty: number }[], note: string | null = null, userId = 'u1') {
  return w.transaction((tx) => recordPartialDelivery(tx, { companyId: 'c1', storeId: 's1', orderId: 'o1', lines, minorUnit: 2, userId, note }));
}

/** The delivery as the order's own door writes it: the helpers it calls, in the order it calls them (`/api/orders/[id]/shipping`). */
async function recordThroughTheShippingRoute(w: World, to: 'DELIVERED' | 'PARTIALLY_DELIVERED', from = 'OUT_FOR_DELIVERY') {
  return w.transaction(async (tx) => {
    const moved = await tx.order.updateMany({
      where: { id: 'o1', companyId: 'c1', version: w.state.order.version },
      data: { ...shippingMoveColumns(to, new Date()), version: { increment: 1 } },
    });
    expect(moved.count).toBe(1);
    await consumeOrderStock(tx, { orderId: 'o1', companyId: 'c1', userId: 'u1' });
    await appendDeliveryAttempt(tx, { orderId: 'o1', companyId: 'c1', result: to, note: null, deliveryProviderId: 'p1', userId: 'u1' });
    await recordShippingMove(tx, {
      companyId: 'c1',
      orderId: 'o1',
      from,
      to,
      user: { id: 'u1', name: 'المالك', role: 'SUPER_ADMIN' },
      logNote: null,
      typedNote: null,
      provider: 'p1',
    });
  });
}

const allTaken = (w: World) => w.state.items.map((i) => ({ itemId: i.id, deliveredQty: i.quantity + i.freeQuantity }));

/** The dialog's two steps against the world: measure (reads, writes nothing), then press with what it showed. */
async function measureOf(w: World) {
  const facts = await readUndoFacts(w.tx(), SCOPE, 'o1');
  return { facts: facts!, measure: measureUndo(facts!) };
}
async function press(w: World, over: { fingerprint?: string; reason?: string } = {}) {
  const { measure } = await measureOf(w);
  return w.transaction((tx) =>
    undoDelivery(tx, { scope: SCOPE, user: USER, orderId: 'o1', reason: over.reason ?? REASON, fingerprint: over.fingerprint ?? (measure.fingerprint as string) })
  );
}
async function refusedBy(w: World, over: { fingerprint?: string } = {}): Promise<UndoStopped> {
  try {
    await press(w, over);
  } catch (e) {
    if (e instanceof UndoStopped) return e;
    throw e;
  }
  throw new Error('the press was not refused');
}

const accrued = (over: Row = {}): Row => ({
  id: 'ce1',
  companyId: 'c1',
  orderId: 'o1',
  userId: 'ag1',
  role: 'CONFIRMATION_AGENT',
  ruleId: 'r1',
  amount: 2.1,
  currencyCode: 'USD',
  status: 'ACCRUED',
  periodMonth: '2026-11',
  payoutId: null,
  reversalOfId: null,
  ...over,
});

/* ═════════════════════════ the facts, built by hand ═════════════════════════ */

let seq = 0;
const mark = (action: string, newStatus: string | null, over: Partial<UndoMark> = {}): UndoMark => ({
  id: `m${++seq}`,
  action,
  previousStatus: null,
  newStatus,
  metadata: null,
  ...over,
});
const doorMark = (status = 'DELIVERED', figure: number | null = 25) =>
  mark(DOOR_MARK, status, { metadata: figure === null ? null : JSON.stringify({ expectedCollection: figure, deliveredValue: 20 }) });
const routeMark = (status = 'DELIVERED', previousStatus: string | null = 'OUT_FOR_DELIVERY') => mark(SHIPPING_MARK, status, { previousStatus });
const item = (id: string, deliveredQty: number | null, returnedQty: number | null) => ({ id, productName: `بند ${id}`, deliveredQty, returnedQty });
const entry = (over: Partial<UndoCommission> = {}): UndoCommission => ({
  id: 'ce1',
  userId: 'ag1',
  status: 'ACCRUED',
  payoutId: null,
  amount: 2.1,
  currency: 'USD',
  reversed: false,
  ...over,
});

const facts = (over: { order?: Partial<UndoOrder>; marks?: UndoMark[]; shippingLog?: UndoFacts['shippingLog']; commission?: UndoCommission[]; shelf?: UndoFacts['shelf']; customer?: UndoFacts['customer']; named?: UndoFacts['named'] } = {}): UndoFacts => ({
  order: {
    id: 'o1',
    orderNumber: 'ORD-2026-1696',
    merchantRef: 'MR-1696',
    trackingNumber: '100550615867',
    deliveryProviderId: 'p1',
    customerId: 'cu1',
    currency: 'JOD',
    courier: 'الباشا',
    shippingStatus: 'DELIVERED',
    settlementStatus: 'PENDING_COLLECTION',
    status: 'SHIPPED',
    version: 9,
    hasCollectedAmount: false,
    items: [],
    hasReturnReceipt: false,
    ...over.order,
  },
  marks: over.marks ?? [doorMark()],
  shippingLog: over.shippingLog ?? [],
  commission: over.commission ?? [],
  shelf: over.shelf ?? { out: 3, back: 0 },
  customer: over.customer === undefined ? { deliveredOrders: 5, totalPurchaseValue: 140 } : over.customer,
  named: over.named ?? null,
});

const planOf = (f: UndoFacts): UndoPlan => {
  const j = judgeUndo(f);
  if (!j.ok) throw new Error(`refused: ${j.code} — ${j.text}`);
  return j.plan;
};

beforeEach(() => {
  seq = 0;
});

/* ═════════════════════════ 1 · THE PLAN, FROM WHAT THE LEDGERS PROVE ═════════════════════════ */

describe('the plan — what a delivery recorded at the door is taken back to', () => {
  it('back to «مشحون», the door-written lines reset, the customer’s counters, and nothing else', () => {
    const plan = planOf(facts({ order: { items: [item('i1', 2, 0), item('i2', 0, 2), item('i3', null, null)] } }));
    expect(plan).toMatchObject({
      path: 'DOOR',
      from: 'DELIVERED',
      to: 'SHIPPED',
      toDefaulted: true,
      settlementFrom: 'PENDING_COLLECTION',
      settlement: null,
      legacyStatus: false,
      customer: { value: 25 },
      commission: [],
    });
    // only the lines the door spoke about; a line it never touched is left exactly as it is
    expect(plan.items.map((i) => i.id)).toEqual(['i1', 'i2']);
  });

  it('a partial delivery is taken back the same way', () => {
    const plan = planOf(facts({ order: { shippingStatus: 'PARTIALLY_DELIVERED' }, marks: [doorMark('PARTIALLY_DELIVERED', 18.5)] }));
    expect(plan).toMatchObject({ path: 'DOOR', from: 'PARTIALLY_DELIVERED', to: 'SHIPPED', customer: { value: 18.5 } });
  });

  it('a delivery whose door figure is zero (gift units only) takes back the count and no money', () => {
    expect(planOf(facts({ marks: [doorMark('DELIVERED', 0)] })).customer).toEqual({ value: 0 });
  });

  it('the legacy combined status is put back only when it says DELIVERED', () => {
    expect(planOf(facts({ order: { status: 'DELIVERED' } })).legacyStatus).toBe(true);
    for (const status of ['SHIPPED', 'CONFIRMED', 'NEW']) expect(planOf(facts({ order: { status } })).legacyStatus, status).toBe(false);
  });

  it('a settlement state with no money is left exactly as it is — the door never wrote it, so nothing is put back', () => {
    for (const s of ['NOT_APPLICABLE', 'PENDING', 'PENDING_COLLECTION', 'UNSETTLED']) {
      const plan = planOf(facts({ order: { settlementStatus: s } }));
      expect(plan.settlement, s).toBeNull();
      expect(plan.settlementFrom, s).toBe(s);
    }
  });

  it('the commission that is still only ACCRUED is to be voided — and only that', () => {
    const plan = planOf(
      facts({
        commission: [
          entry({ id: 'a' }),
          entry({ id: 'b', userId: 'ag2' }),
          entry({ id: 'neg', status: 'REVERSED', amount: -2.1 }), // a reversal is not an entry to void
          entry({ id: 'done', reversed: true }), // already voided
        ],
      })
    );
    expect(plan.commission.map((e) => e.id)).toEqual(['a', 'b']);
  });
});

describe('the plan — a delivery recorded through the order’s own door', () => {
  it('goes back to the state the timeline says it had — «خرج للتوصيل» — and COLLECTED (which the delivery wrote) goes back to «لم يُحصَّل»', () => {
    const plan = planOf(
      facts({
        order: { settlementStatus: 'COLLECTED', status: 'DELIVERED' },
        marks: [routeMark('DELIVERED', 'OUT_FOR_DELIVERY')],
        shippingLog: [{ previousValue: 'OUT_FOR_DELIVERY', newValue: 'DELIVERED' }],
      })
    );
    expect(plan).toMatchObject({
      path: 'SHIPPING_ROUTE',
      from: 'DELIVERED',
      to: 'OUT_FOR_DELIVERY',
      toDefaulted: false,
      settlementFrom: 'COLLECTED',
      settlement: { to: BACK_TO_AWAITING },
      legacyStatus: true,
      customer: null, // this door never touched the customer's counters, so none is taken off
      items: [],
    });
  });

  it('each state a parcel can have been in is restored; a state it cannot have been in (or none) is «مشحون»', () => {
    const to = (previous: string | null, log = true) =>
      planOf(
        facts({
          order: { settlementStatus: 'COLLECTED' },
          marks: [routeMark('DELIVERED', previous)],
          shippingLog: log ? [{ previousValue: previous, newValue: 'DELIVERED' }] : [],
        })
      ).to;
    expect(to('OUT_FOR_DELIVERY')).toBe('OUT_FOR_DELIVERY');
    expect(to('SHIPPED')).toBe('SHIPPED');
    expect(to('FAILED_DELIVERY')).toBe('FAILED_DELIVERY');
    for (const odd of ['READY_FOR_PICKUP', 'RETURNED', 'CANCELLED', 'NOT_READY', null]) expect(to(odd), String(odd)).toBe('SHIPPED');
  });

  it('with no timeline line the activity’s own «before» is read; the timeline wins when both exist', () => {
    const base = { order: { settlementStatus: 'COLLECTED' } };
    expect(planOf(facts({ ...base, marks: [routeMark('DELIVERED', 'FAILED_DELIVERY')], shippingLog: [] })).to).toBe('FAILED_DELIVERY');
    expect(
      planOf(facts({ ...base, marks: [routeMark('DELIVERED', 'FAILED_DELIVERY')], shippingLog: [{ previousValue: 'SHIPPED', newValue: 'DELIVERED' }] })).to
    ).toBe('SHIPPED');
  });

  it('the line read is the one that moved it to the status it HAS — an older line about another status is not mistaken for it', () => {
    const plan = planOf(
      facts({
        order: { settlementStatus: 'COLLECTED' },
        marks: [routeMark('DELIVERED', 'OUT_FOR_DELIVERY')],
        // newest first: the delivery line, then the older ones
        shippingLog: [
          { previousValue: 'OUT_FOR_DELIVERY', newValue: 'DELIVERED' },
          { previousValue: 'SHIPPED', newValue: 'OUT_FOR_DELIVERY' },
        ],
      })
    );
    expect(plan.to).toBe('OUT_FOR_DELIVERY');
  });

  it('a partial delivery through this door writes no COLLECTED, so COLLECTED on it is unexplained and refused', () => {
    const j = judgeUndo(facts({ order: { shippingStatus: 'PARTIALLY_DELIVERED', settlementStatus: 'COLLECTED' }, marks: [routeMark('PARTIALLY_DELIVERED')] }));
    expect(j).toMatchObject({ ok: false, code: 'PATH_UNKNOWN', text: UNDO_WHY_AR.collectedUnexplained });
    // …and without COLLECTED it is taken back as any other
    expect(planOf(facts({ order: { shippingStatus: 'PARTIALLY_DELIVERED' }, marks: [routeMark('PARTIALLY_DELIVERED', 'SHIPPED')] }))).toMatchObject({ path: 'SHIPPING_ROUTE', from: 'PARTIALLY_DELIVERED', to: 'SHIPPED', settlement: null });
  });

  it('COLLECTED on a delivery the DOOR recorded is unexplained — the door never writes it — and refused', () => {
    expect(judgeUndo(facts({ order: { settlementStatus: 'COLLECTED' } }))).toMatchObject({ ok: false, code: 'PATH_UNKNOWN', text: UNDO_WHY_AR.collectedUnexplained });
  });
});

describe('which door recorded the delivery — from the newest row that says so', () => {
  const order = { shippingStatus: 'DELIVERED' };

  it('the newest row decides: a delivery recorded again after an undo is judged by its own row', () => {
    const marks = [doorMark('DELIVERED', 11), mark(DELIVERY_UNDO_ACTION, 'SHIPPED'), doorMark('DELIVERED', 99)];
    const rec = recordingOf(order, marks);
    expect(rec.ok && rec.path).toBe('DOOR');
    expect(planOf(facts({ marks })).customer).toEqual({ value: 11 });
  });

  it('a row about another status (OUT_FOR_DELIVERY) is skipped, and the delivery row under it is read', () => {
    const marks = [mark(SHIPPING_MARK, 'OUT_FOR_DELIVERY'), routeMark('DELIVERED')];
    expect(recordingOf(order, marks)).toMatchObject({ ok: true, path: 'SHIPPING_ROUTE' });
  });

  it('REFUSED: no row at all — the ledgers do not say who recorded it', () => {
    expect(judgeUndo(facts({ marks: [] }))).toMatchObject({ ok: false, code: 'PATH_UNKNOWN', text: UNDO_WHY_AR.noRecord });
  });

  it('REFUSED: the newest row is an undo — it was undone, and what made it delivered again left no row', () => {
    expect(judgeUndo(facts({ marks: [mark(DELIVERY_UNDO_ACTION, 'SHIPPED'), doorMark()] }))).toMatchObject({ ok: false, code: 'PATH_UNKNOWN', text: UNDO_WHY_AR.noRecord });
  });

  it('REFUSED: the row says PARTIALLY_DELIVERED but the order says DELIVERED — the status moved after the recording', () => {
    expect(judgeUndo(facts({ marks: [doorMark('PARTIALLY_DELIVERED')] }))).toMatchObject({ ok: false, code: 'PATH_UNKNOWN', text: UNDO_WHY_AR.changedAfter });
  });

  it('REFUSED: the combined-status override (the generic PATCH) — its counters and its figure cannot be proved', () => {
    expect(judgeUndo(facts({ marks: [mark(OVERRIDE_MARK, 'DELIVERED')] }))).toMatchObject({ ok: false, code: 'PATH_UNKNOWN', text: UNDO_WHY_AR.override });
  });

  it('the override row about another legacy status (SHIPPED) is not a delivery row', () => {
    expect(recordingOf(order, [mark(OVERRIDE_MARK, 'SHIPPED'), doorMark()])).toMatchObject({ ok: true, path: 'DOOR' });
  });

  it('REFUSED: a door row with no readable figure — what the customer’s record was given cannot be proved', () => {
    for (const metadata of [null, '', 'not json', '{}', '{"expectedCollection":"25"}', '{"expectedCollection":-1}', '{"expectedCollection":null}', '[]']) {
      expect(judgeUndo(facts({ marks: [mark(DOOR_MARK, 'DELIVERED', { metadata })] })), String(metadata)).toMatchObject({
        ok: false,
        code: 'PATH_UNKNOWN',
        text: UNDO_WHY_AR.noFigure,
      });
    }
    expect(figureOf('{"expectedCollection":0}')).toBe(0);
    expect(figureOf('{"expectedCollection":12.5}')).toBe(12.5);
  });

  it('beforeOf: only the order’s own door keeps a «before»; the door recorder never does', () => {
    expect(beforeOf('DOOR', { previousStatus: 'OUT_FOR_DELIVERY' }, 'DELIVERED', [{ previousValue: 'OUT_FOR_DELIVERY', newValue: 'DELIVERED' }])).toEqual({ to: 'SHIPPED', defaulted: true });
  });
});

/* ═════════════════════════ 2 · WHAT IT REFUSES, WITH THE REASON IN WORDS ═════════════════════════ */

describe('what it refuses — one reason, in words', () => {
  it('an order that is not delivered: a plain «not delivered», for every state a parcel can be in', () => {
    for (const s of ['NOT_READY', 'READY_FOR_PICKUP', 'SHIPPED', 'OUT_FOR_DELIVERY', 'FAILED_DELIVERY', 'RETURN_REQUESTED', 'RETURNED', 'CANCELLED']) {
      const j = judgeUndo(facts({ order: { shippingStatus: s } }));
      expect(j, s).toMatchObject({ ok: false, code: 'NOT_DELIVERED' });
      expect((j as { text: string }).text, s).toContain('مش مسجَّل مسلَّم');
    }
  });

  it('an order already undone says so — «ALREADY_UNDONE», with where it is now', () => {
    const j = judgeUndo(facts({ order: { shippingStatus: 'SHIPPED' }, marks: [mark(DELIVERY_UNDO_ACTION, 'SHIPPED'), doorMark()] }));
    expect(j).toMatchObject({ ok: false, code: 'ALREADY_UNDONE' });
    expect((j as { text: string }).text).toContain('مشحون');
  });

  it('settlement that carries money or is closed: every one refused, each named in words — and nothing is left to the clock', () => {
    const words: Record<string, string> = {
      SETTLED: 'مسوّى',
      PARTIALLY_SETTLED: 'مسوّى جزئياً',
      REFUNDED: 'مُسترد',
      PARTIALLY_REFUNDED: 'مُسترد جزئياً',
      CANCELLED: 'ملغى',
    };
    for (const [s, word] of Object.entries(words)) {
      const j = judgeUndo(facts({ order: { settlementStatus: s } }));
      expect(j, s).toMatchObject({ ok: false, code: 'MONEY_RECORDED' });
      expect((j as { text: string }).text, s).toContain(`«${word}»`);
    }
  });

  it('a collected amount written on the order is money recorded — whatever the settlement word says', () => {
    expect(judgeUndo(facts({ order: { hasCollectedAmount: true } }))).toMatchObject({ ok: false, code: 'MONEY_RECORDED', text: UNDO_WHY_AR.moneyAmount });
    expect(judgeUndo(facts({ order: { hasCollectedAmount: true, settlementStatus: 'SETTLED' } }))).toMatchObject({ code: 'MONEY_RECORDED', text: UNDO_WHY_AR.moneyAmount });
  });

  it('a statement that names the order — the gate’s own sentence is what is said', () => {
    const named = { code: 'ON_UNAPPROVED_STATEMENT', error: 'الطلب ORD-2026-1696 بكشف ما انعتمد بعد — مصاريه بتنسجّل لما ينعتمد الكشف' };
    expect(judgeUndo(facts({ named }))).toEqual({ ok: false, code: 'ON_A_STATEMENT', text: named.error });
  });

  it('a counted return', () => {
    expect(judgeUndo(facts({ order: { hasReturnReceipt: true } }))).toMatchObject({ ok: false, code: 'RETURN_COUNTED', text: UNDO_WHY_AR.returnCounted });
  });

  it('a commission that moved: payable, paid, or inside a payout — counted in the sentence', () => {
    for (const e of [entry({ status: 'PAYABLE' }), entry({ status: 'PAID' }), entry({ status: 'ACCRUED', payoutId: 'po1' })]) {
      const j = judgeUndo(facts({ commission: [entry({ id: 'fine' }), e] }));
      expect(j, e.status).toMatchObject({ ok: false, code: 'COMMISSION_MOVED', text: UNDO_WHY_AR.commissionMoved(1) });
      expect(commissionMoved(e)).toBe(true);
    }
    expect(judgeUndo(facts({ commission: [entry({ status: 'PAYABLE', id: 'x' }), entry({ status: 'PAID', id: 'y' })] }))).toMatchObject({ text: UNDO_WHY_AR.commissionMoved(2) });
  });

  it('only an entry that is still ACCRUED, unreversed and unpaid is voidable — a payable, paid, paid-out, reversed or reversing one never is', () => {
    expect(commissionVoidable(entry())).toBe(true);
    for (const e of [
      entry({ status: 'PAYABLE' }),
      entry({ status: 'PAID' }),
      entry({ payoutId: 'po1' }),
      entry({ reversed: true }),
      entry({ status: 'REVERSED', amount: -2.1 }),
    ]) {
      expect(commissionVoidable(e), JSON.stringify(e)).toBe(false);
    }
  });

  it('a commission that was already voided (a reversing entry points at it) or is itself a reversal is not «moved», whatever its status', () => {
    expect(commissionMoved(entry({ status: 'PAID', reversed: true }))).toBe(false);
    expect(commissionMoved(entry({ status: 'REVERSED', payoutId: 'po1' }))).toBe(false);
    expect(judgeUndo(facts({ commission: [entry({ status: 'PAYABLE', reversed: true })] })).ok).toBe(true);
  });

  it('the order of the sentences: money first, then the statement, the return, the commission, the recording', () => {
    const everything = facts({
      order: { settlementStatus: 'SETTLED', hasReturnReceipt: true },
      named: { code: 'IN_APPROVED_STATEMENT', error: 'x' },
      commission: [entry({ status: 'PAID' })],
      marks: [],
    });
    const codes: string[] = [];
    let f = everything;
    for (const step of [
      (x: UndoFacts) => x,
      (x: UndoFacts) => ({ ...x, order: { ...x.order, settlementStatus: 'PENDING' } }),
      (x: UndoFacts) => ({ ...x, named: null }),
      (x: UndoFacts) => ({ ...x, order: { ...x.order, hasReturnReceipt: false } }),
      (x: UndoFacts) => ({ ...x, commission: [] }),
    ]) {
      f = step(f);
      const j = judgeUndo(f);
      codes.push(j.ok ? 'ok' : j.code);
    }
    expect(codes).toEqual(['MONEY_RECORDED', 'ON_A_STATEMENT', 'RETURN_COUNTED', 'COMMISSION_MOVED', 'PATH_UNKNOWN']);
  });

  it('THERE IS NO CLOCK: the facts carry no date at all, so no delivery is too old — or too new — to be taken back', () => {
    const f = facts();
    const keys = (o: object): string[] => Object.entries(o).flatMap(([k, v]) => [k, ...(v && typeof v === 'object' ? keys(v) : [])]);
    expect(keys(f).filter((k) => /At$|Date|time|age/i.test(k))).toEqual([]);
    expect(judgeUndo(f).ok).toBe(true);
  });
});

/* ═════════════════════════ 3 · WHAT THE DIALOG DRAWS ═════════════════════════ */

describe('the measure — every line the press would write, and every line it would leave', () => {
  it('a door delivery: status, lines, customer (with the figure as money) and commission — and the stock, money and history it leaves', () => {
    const m = measureUndo(
      facts({
        order: { items: [item('i1', 2, 0), item('i2', 1, 1)] },
        commission: [entry()],
        shelf: { out: 4, back: 0 },
        customer: { deliveredOrders: 5, totalPurchaseValue: 140 },
      })
    );
    expect(m).toMatchObject({ allowed: true, refusal: null, to: 'SHIPPED', from: 'DELIVERED', orderNumber: 'ORD-2026-1696', courier: 'الباشا' });
    expect(m.fingerprint).toMatch(/^[0-9a-f]{24}$/);
    expect(m.lines.map((l) => l.key)).toEqual(['STATUS', 'ITEMS', 'CUSTOMER', 'COMMISSION']);
    expect(m.lines[0].text).toContain('«مسلَّم»');
    expect(m.lines[0].text).toContain('«مشحون»');
    expect(m.lines[1].text).toContain('2 بند');
    expect(m.lines[2].text).toContain('من 5 لـ4');
    expect(m.lines[2].amount).toEqual({ value: 25, currency: 'JOD' });
    expect(m.lines[3].text).toContain('1 قيد');
    expect(m.stays.map((l) => l.key)).toEqual(['STOCK', 'MONEY', 'HISTORY']);
    expect(m.stays[0].text).toBe(UNDO_STAYS_AR.stock(4, 0));
    expect(m.stays[0].text).toContain('4 قطعة');
    expect(m.stays[0].text).toContain('بقسم المرتجعات');
  });

  it('says the stock is NOT touched, in the owner’s own terms — it comes back when the desk counts it, not from here', () => {
    const text = measureUndo(facts()).stays[0].text;
    expect(text).toContain('المخزون ما بيتغيّر');
    expect(text).toContain('لما تنعدّ بقسم المرتجعات');
  });

  it('with no commission it says so (a line in «what stays»), and draws no commission line', () => {
    const m = measureUndo(facts());
    expect(m.lines.map((l) => l.key)).toEqual(['STATUS', 'CUSTOMER']);
    expect(m.stays.map((l) => l.key)).toEqual(['STOCK', 'MONEY', 'HISTORY', 'COMMISSION']);
  });

  it('a customer counter that is already zero is said as staying at zero — the screen never promises «−1» it cannot do', () => {
    const m = measureUndo(facts({ customer: { deliveredOrders: 0, totalPurchaseValue: 0 } }));
    expect(m.lines.find((l) => l.key === 'CUSTOMER')?.text).toContain('أصلاً صفر');
  });

  it('a delivery through the order’s own door: the settlement line, no customer line, and the one thing it cannot recall — the event it sent', () => {
    const m = measureUndo(
      facts({
        order: { settlementStatus: 'COLLECTED', status: 'DELIVERED' },
        marks: [routeMark()],
        shippingLog: [{ previousValue: 'OUT_FOR_DELIVERY', newValue: 'DELIVERED' }],
      })
    );
    expect(m.lines.map((l) => l.key)).toEqual(['STATUS', 'SETTLEMENT']);
    expect(m.lines[1].text).toContain('«محصَّل»');
    expect(m.lines[1].text).toContain('«لم يُحصَّل»');
    expect(m.stays.map((l) => l.key)).toContain('EVENTS');
    expect(m.stays.find((l) => l.key === 'EVENTS')?.text).toBe(UNDO_STAYS_AR.events);
  });

  it('what stays says the announcement is not recalled ONLY for a FULL delivery through the order’s own door — a partial one through it sent nothing, and the door never sends one', () => {
    const eventsFor = (f: UndoFacts) => measureUndo(f).stays.some((l) => l.key === 'EVENTS');
    const viaTheOrdersDoor = (status: 'DELIVERED' | 'PARTIALLY_DELIVERED') =>
      facts({
        order: { shippingStatus: status, ...(status === 'DELIVERED' ? { settlementStatus: 'COLLECTED', status: 'DELIVERED' } : {}) },
        marks: [routeMark(status, status === 'DELIVERED' ? 'OUT_FOR_DELIVERY' : 'SHIPPED')],
        shippingLog: [{ previousValue: status === 'DELIVERED' ? 'OUT_FOR_DELIVERY' : 'SHIPPED', newValue: status }],
      });
    const viaTheDoor = (status: 'DELIVERED' | 'PARTIALLY_DELIVERED') => facts({ order: { shippingStatus: status }, marks: [doorMark(status)] });

    expect(eventsFor(viaTheOrdersDoor('DELIVERED'))).toBe(true);
    expect(eventsFor(viaTheOrdersDoor('PARTIALLY_DELIVERED'))).toBe(false);
    expect(eventsFor(viaTheDoor('DELIVERED'))).toBe(false);
    expect(eventsFor(viaTheDoor('PARTIALLY_DELIVERED'))).toBe(false);
    // …and when it is said, it is said in the one sentence, last among the things that stay
    const said = measureUndo(viaTheOrdersDoor('DELIVERED')).stays;
    expect(said[said.length - 1]).toEqual({ key: 'EVENTS', text: UNDO_STAYS_AR.events });
  });

  it('the status line says when the «before» is not in the ledgers', () => {
    expect(measureUndo(facts()).lines[0].text).toContain('مش محفوظة بالسجل');
    const known = measureUndo(
      facts({ order: { settlementStatus: 'COLLECTED' }, marks: [routeMark('DELIVERED', 'OUT_FOR_DELIVERY')], shippingLog: [{ previousValue: 'OUT_FOR_DELIVERY', newValue: 'DELIVERED' }] })
    );
    expect(known.lines[0].text).not.toContain('مش محفوظة بالسجل');
    expect(known.lines[0].text).toContain('«خرج للتوصيل»');
  });

  it('a refusal carries the reason in words and NO fingerprint, no lines — there is nothing to press', () => {
    const m = measureUndo(facts({ order: { settlementStatus: 'SETTLED' } }));
    expect(m).toMatchObject({ allowed: false, fingerprint: null, to: null, lines: [], stays: [] });
    expect(m.refusal).toEqual({ code: 'MONEY_RECORDED', text: UNDO_WHY_AR.moneyState('SETTLED') });
  });

  it('the fingerprint is the same for the same order and the same plan, and moves with any part of it', () => {
    const base = facts({ order: { items: [item('i1', 2, 0)] }, commission: [entry()] });
    const fp = (f: UndoFacts) => fingerprintOf(f.order, planOf(f));
    expect(fp(base)).toBe(fp(JSON.parse(JSON.stringify(base)) as UndoFacts));
    const moved: [string, UndoFacts][] = [
      ['the version', facts({ order: { version: 10, items: [item('i1', 2, 0)] }, commission: [entry()] })],
      ['a line’s quantities', facts({ order: { items: [item('i1', 1, 1)] }, commission: [entry()] })],
      ['an extra line', facts({ order: { items: [item('i1', 2, 0), item('i2', 1, 0)] }, commission: [entry()] })],
      ['the commission', facts({ order: { items: [item('i1', 2, 0)] }, commission: [entry({ id: 'other' })] })],
      ['no commission', facts({ order: { items: [item('i1', 2, 0)] } })],
      ['the door figure', facts({ order: { items: [item('i1', 2, 0)] }, commission: [entry()], marks: [doorMark('DELIVERED', 26)] })],
      ['the status', facts({ order: { shippingStatus: 'PARTIALLY_DELIVERED', items: [item('i1', 2, 0)] }, commission: [entry()], marks: [doorMark('PARTIALLY_DELIVERED', 25)] })],
      ['the settlement', facts({ order: { settlementStatus: 'PENDING', items: [item('i1', 2, 0)] }, commission: [entry()] })],
      ['the legacy status', facts({ order: { status: 'DELIVERED', items: [item('i1', 2, 0)] }, commission: [entry()] })],
    ];
    for (const [what, f] of moved) expect(fp(f), what).not.toBe(fp(base));
    // …and the order in which the lines and the entries came is not part of it
    expect(fp(facts({ order: { items: [item('i2', 1, 0), item('i1', 2, 0)] }, commission: [entry({ id: 'b' }), entry({ id: 'a' })] }))).toBe(
      fp(facts({ order: { items: [item('i1', 2, 0), item('i2', 1, 0)] }, commission: [entry({ id: 'a' }), entry({ id: 'b' })] }))
    );
  });
});

/* ═════════════════════════ 4 · THE PRESS, AGAINST THE REAL RECORDERS ═════════════════════════ */

describe('what each recorder writes — and what the undo must therefore reverse (the undo is held to the REAL code)', () => {
  const orderDiff = (before: Row, after: Row) => Object.keys(after).filter((k) => JSON.stringify(before[k]) !== JSON.stringify(after[k])).sort();

  it('THE DOOR RECORDER changes exactly: the status, the date, the version — the lines’ quantities — the customer’s two counters — and appends', async () => {
    const w = new World();
    const before = w.snapshot();
    await recordAtTheDoor(w, allTaken(w), 'سلّم الزبون');
    const after = w.snapshot();

    expect(orderDiff(before.order, after.order)).toEqual(['deliveredAt', 'shippingStatus', 'version']);
    expect(after.order).toMatchObject({ shippingStatus: 'DELIVERED', settlementStatus: 'PENDING_COLLECTION', collectedAmount: null, status: 'SHIPPED' });
    // the lines
    for (const i of after.items) expect([i.deliveredQty, i.returnedQty]).toEqual([i.quantity + i.freeQuantity, 0]);
    // the customer: one delivery and the door's expected collection — never `cancelledOrders`
    expect(after.customer.deliveredOrders).toBe(before.customer.deliveredOrders + 1);
    expect(after.customer.cancelledOrders).toBe(before.customer.cancelledOrders);
    const row = after.activities.find((a) => a.action === DOOR_MARK)!;
    const figure = figureOf(row.metadata)!;
    expect(figure).toBe(55);
    expect(after.customer.totalPurchaseValue).toBeCloseTo(before.customer.totalPurchaseValue + figure, 9);
    // the history it appended — the marks the undo reads
    expect(row).toMatchObject({ newStatus: 'DELIVERED' });
    expect(after.attempts).toHaveLength(1);
    expect(after.notes).toHaveLength(1);
    // the stock was consumed (the ledger's SALE line) — the undo will leave it
    expect(after.movements.map((m) => m.type)).toEqual(['SALE']);
    expect(w.forbidden).toEqual([]);
  });

  it('THE ORDER’S OWN DOOR changes exactly: the status, the date, the legacy status, COLLECTED — and writes the marks the undo reads; never the lines or the customer', async () => {
    const w = new World();
    const before = w.snapshot();
    await recordThroughTheShippingRoute(w, 'DELIVERED');
    const after = w.snapshot();

    expect(orderDiff(before.order, after.order)).toEqual(['deliveredAt', 'settlementStatus', 'shippingStatus', 'status', 'version']);
    expect(after.order).toMatchObject({ shippingStatus: 'DELIVERED', settlementStatus: 'COLLECTED', status: 'DELIVERED' });
    expect(after.items).toEqual(before.items);
    expect(after.customer).toEqual(before.customer);
    expect(after.activities.map((a) => [a.action, a.previousStatus, a.newStatus])).toEqual([[SHIPPING_MARK, 'OUT_FOR_DELIVERY', 'DELIVERED']]);
    expect(after.logs.map((l) => [l.statusType, l.previousValue, l.newValue])).toEqual([['SHIPPING', 'OUT_FOR_DELIVERY', 'DELIVERED']]);
  });

  it('THE ORDER’S OWN DOOR, partially: the status and the date only (COLLECTED is written for a whole delivery alone)', async () => {
    const w = new World();
    const before = w.snapshot();
    await recordThroughTheShippingRoute(w, 'PARTIALLY_DELIVERED');
    expect(orderDiff(before.order, w.snapshot().order)).toEqual(['deliveredAt', 'shippingStatus', 'version']);
  });

  it('the single «استلم» door and «استلم المحدد» record through the very function the fixture above runs, and write no order column of their own — and the courier’s feed cannot record a delivery at all', async () => {
    const read = (p: string) => stripComments(readFileSync(join(process.cwd(), p), 'utf8'));
    for (const f of ['src/app/api/ops/tracking/deliver/route.ts', 'src/lib/parcel-tracking/deliver-many.ts']) {
      const src = read(f);
      expect(src, f).toMatch(/recordPartialDelivery\(\s*tx/);
      expect(src, f).not.toMatch(/\.(update|updateMany|create|createMany|upsert|delete|deleteMany)\(/);
    }
    // the poll: a delivery is a human's word (`COURIER_CANNOT_ASSERT`), so no feed row can be the evidence of one
    const { isAutoApplicable, COURIER_CANNOT_ASSERT } = await import('./couriers/types');
    expect(COURIER_CANNOT_ASSERT).toEqual(expect.arrayContaining(['DELIVERED', 'PARTIALLY_DELIVERED']));
    for (const status of ['DELIVERED', 'PARTIALLY_DELIVERED']) expect(isAutoApplicable({ status } as never), status).toBe(false);
  });

  it('the three action names the undo reads are the ones the recorders really write — in the source, not only in a fixture', () => {
    const read = (p: string) => stripComments(readFileSync(join(process.cwd(), p), 'utf8'));
    expect(read('src/lib/partial-delivery.ts')).toContain(`action: '${DOOR_MARK}'`);
    expect(read('src/lib/shipping-move.ts')).toContain(`action: '${SHIPPING_MARK}'`);
    expect(read('src/app/api/orders/[id]/route.ts')).toContain(`action: '${OVERRIDE_MARK}'`);
    // …and the order's own door really calls the helpers the fixture above calls, in this order
    const route = read('src/app/api/orders/[id]/shipping/route.ts');
    const at = (s: string) => route.indexOf(s);
    expect(at('shippingMoveColumns(newShippingStatus, now)')).toBeGreaterThan(0);
    expect(at('consumeOrderStock(tx')).toBeGreaterThan(0);
    expect(at('appendDeliveryAttempt(tx')).toBeGreaterThan(at('consumeOrderStock(tx'));
    expect(at('recordShippingMove(db')).toBeGreaterThan(at('appendDeliveryAttempt(tx'));
  });
});

describe('the press — a delivery recorded at the door, taken back', () => {
  it('puts the order, its lines and the customer back EXACTLY, writes one reversing commission entry, appends history, and touches nothing it must not', async () => {
    const w = new World();
    const initial = w.snapshot();
    w.state.commission.push(accrued());
    await recordAtTheDoor(w, allTaken(w), 'سلّم الزبون');
    const delivered = w.snapshot();
    const movementsAfterDelivery = clone(w.state.movements);

    const done = await press(w);
    const after = w.snapshot();

    expect(done).toMatchObject({ orderNumber: 'ORD-2026-1696', voided: 1 });
    expect(done.plan).toMatchObject({ path: 'DOOR', from: 'DELIVERED', to: 'SHIPPED' });

    // THE ORDER: back to what it was before the recording — except that the door never kept where it was («مشحون» is the answer), and the
    // version is a counter that only goes up
    expect(after.order).toEqual({ ...initial.order, shippingStatus: 'SHIPPED', version: initial.order.version + 2 });
    // THE LINES: «the door has not spoken» again
    expect(after.items).toEqual(initial.items);
    // THE CUSTOMER: exactly what the door added is taken off
    expect(after.customer.deliveredOrders).toBe(initial.customer.deliveredOrders);
    expect(after.customer.totalPurchaseValue).toBeCloseTo(initial.customer.totalPurchaseValue, 9);
    expect(after.customer.cancelledOrders).toBe(initial.customer.cancelledOrders);

    // THE STOCK: untouched — the SALE line the delivery wrote is still the only movement, and nothing else was reached
    expect(after.movements).toEqual(movementsAfterDelivery);
    expect(w.forbidden).toEqual([]);

    // THE COMMISSION: a reversing entry; the original is exactly as it was
    expect(after.commission).toHaveLength(2);
    expect(after.commission[0]).toEqual(delivered.commission[0]);
    expect(after.commission[1]).toMatchObject({ status: 'REVERSED', amount: -2.1, reversalOfId: 'ce1', orderId: 'o1', userId: 'ag1' });
    expect(after.commission[1].reversalReason).toContain(UNDO_NOTE_PREFIX);

    // HISTORY IS APPENDED TO — every earlier row is still there, unedited — and nothing was deleted
    expect(after.activities.slice(0, delivered.activities.length)).toEqual(delivered.activities);
    expect(after.activities).toHaveLength(delivered.activities.length + 1);
    expect(after.notes.slice(0, delivered.notes.length)).toEqual(delivered.notes);
    expect(after.notes).toHaveLength(delivered.notes.length + 1);
    expect(after.attempts).toEqual(delivered.attempts);

    // …and what it appended
    const undone = after.activities[after.activities.length - 1];
    expect(undone).toMatchObject({ action: DELIVERY_UNDO_ACTION, previousStatus: 'DELIVERED', newStatus: 'SHIPPED', userId: 'u1', orderId: 'o1', companyId: 'c1' });
    expect(JSON.parse(undone.metadata)).toMatchObject({ reason: REASON, path: 'DOOR', commissionVoided: 1, stock: 'KEPT', customer: { delivered: -1, value: -55 } });
    expect(after.logs).toHaveLength(1);
    expect(after.logs[0]).toMatchObject({
      statusType: 'SHIPPING',
      previousValue: 'DELIVERED',
      newValue: 'SHIPPED',
      changedById: 'u1',
      changedByRole: 'SUPER_ADMIN',
      note: `${UNDO_NOTE_PREFIX}: ${REASON}`,
    });
    expect(after.notes[after.notes.length - 1]).toMatchObject({ kind: 'internal', authorId: 'u1', body: `${UNDO_NOTE_PREFIX}: ${REASON}` });
  });

  it('writes through the transaction’s client only, and opens ONE transaction for the press', async () => {
    const w = new World();
    await recordAtTheDoor(w, allTaken(w));
    w.txCount = 0;
    w.trace = [];
    await press(w);
    expect(w.txCount, 'the press ran without a transaction, or in several: a refusal after the claim could not take it back').toBe(1);
    // the measure's reads happened outside it (this helper reads once before opening the press)
    const writes = w.trace.filter((t) => /\.(update|updateMany|create)$/.test(t));
    expect(writes).toEqual([
      'order.updateMany', // the claim
      'orderItem.updateMany',
      'customer.update',
      'customer.updateMany',
      'customer.updateMany',
      'orderStatusLog.create',
      'orderActivity.create',
      'orderNote.create',
    ]);
  });

  it('claims BEFORE it writes anything, and reads the statements and the commission AGAIN after the claim, before the first write', async () => {
    const w = new World();
    w.state.commission.push(accrued());
    await recordAtTheDoor(w, allTaken(w));
    w.trace = [];
    await press(w);
    const claim = w.trace.indexOf('order.updateMany');
    const firstWrite = w.trace.findIndex((t, i) => i > claim && /\.(update|updateMany|create)$/.test(t));
    const statementReads = w.trace.map((t, i) => [t, i] as const).filter(([t]) => t === 'statementLine.findMany').map(([, i]) => i);
    const commissionReads = w.trace.map((t, i) => [t, i] as const).filter(([t]) => t === 'commissionEntry.findMany').map(([, i]) => i);
    expect(statementReads.some((i) => i < claim), 'a read before the claim').toBe(true);
    expect(statementReads.some((i) => i > claim && i < firstWrite), 'a statement read AFTER the claim and before any write').toBe(true);
    expect(commissionReads.some((i) => i > claim && i < firstWrite), 'a commission read AFTER the claim and before any write').toBe(true);
    // nothing at all is written before the claim
    expect(w.trace.slice(0, claim).some((t) => /\.(update|updateMany|create)$/.test(t))).toBe(false);
  });

  it('the second press, after the first succeeded, is refused as «already undone» and writes nothing', async () => {
    const w = new World();
    await recordAtTheDoor(w, allTaken(w));
    await press(w);
    const before = w.snapshot();
    const { measure } = await measureOf(w);
    expect(measure.refusal?.code).toBe('ALREADY_UNDONE');
    const e = await refusedBy(w, { fingerprint: 'f'.repeat(24) });
    expect(e).toMatchObject({ status: 409, body: { code: 'ALREADY_UNDONE' } });
    expect(w.snapshot()).toEqual(before);
  });

  it('a delivery recorded again after the undo, then undone again, ends where it started — each undo takes off ITS OWN figure', async () => {
    const w = new World();
    const initial = w.snapshot();
    await recordAtTheDoor(w, allTaken(w)); // 55
    await press(w);
    // the real delivery, later: only the cream (2 × 10 + fee 5 = 25), the drops refused
    await recordAtTheDoor(w, [{ itemId: 'i1', deliveredQty: 2 }, { itemId: 'i2', deliveredQty: 0 }]);
    expect(w.state.order.shippingStatus).toBe('PARTIALLY_DELIVERED');
    const { facts: f } = await measureOf(w);
    expect(planOf(f).customer).toEqual({ value: 25 });
    await press(w);
    const after = w.snapshot();
    expect(after.order).toMatchObject({ shippingStatus: 'SHIPPED', deliveredAt: null, settlementStatus: initial.order.settlementStatus });
    expect(after.customer.deliveredOrders).toBe(initial.customer.deliveredOrders);
    expect(after.customer.totalPurchaseValue).toBeCloseTo(initial.customer.totalPurchaseValue, 9);
    expect(after.items).toEqual(initial.items);
    // the stock was drawn ONCE per recording the real door makes; the undo never put any back, so a re-delivery never doubles it
    expect(w.forbidden).toEqual([]);
  });

  it('after an undo the commission that was voided is not voided a second time by the next undo', async () => {
    const w = new World();
    w.state.commission.push(accrued());
    await recordAtTheDoor(w, allTaken(w));
    await press(w);
    expect(w.state.commission).toHaveLength(2);
    await recordAtTheDoor(w, allTaken(w));
    const { facts: f } = await measureOf(w);
    // the original still reads ACCRUED, but a reversing entry points at it: nothing left to void
    expect(planOf(f).commission).toEqual([]);
    const done = await press(w);
    expect(done.voided).toBe(0);
    expect(w.state.commission).toHaveLength(2);
  });

  it('only this order’s commission is reversed; another order’s entry and an unrelated entry are not touched', async () => {
    const w = new World();
    w.state.commission.push(accrued(), accrued({ id: 'ce-other', orderId: 'o2' }));
    await recordAtTheDoor(w, allTaken(w));
    await press(w);
    expect(w.state.commission.filter((r) => r.reversalOfId).map((r) => r.reversalOfId)).toEqual(['ce1']);
    expect(w.state.commission.find((r) => r.id === 'ce-other')).toEqual(accrued({ id: 'ce-other', orderId: 'o2' }));
  });

  it('the customer’s counters never go below zero — a record that already fell under what the door added is brought to zero, not under it', async () => {
    const w = new World({ customer: { deliveredOrders: 0, totalPurchaseValue: 0 } });
    await recordAtTheDoor(w, allTaken(w));
    // somebody (a correction, another undo) had already taken more than the door added
    w.state.customer.deliveredOrders = 0;
    w.state.customer.totalPurchaseValue = 3;
    await press(w);
    expect(w.state.customer.deliveredOrders).toBe(0);
    expect(w.state.customer.totalPurchaseValue).toBe(0);
    expect(w.state.customer.cancelledOrders).toBe(1);
  });

  it('the measure, read from the real ledgers, says how many units the delivery took off the shelf and where the customer’s record stands', async () => {
    const w = new World({ customer: { deliveredOrders: 4, totalPurchaseValue: 120 } });
    await recordAtTheDoor(w, allTaken(w));
    const { measure } = await measureOf(w);
    // 2 + (1 + 1 gift) units left the shelf; the door added one delivered order and 55 to the customer
    expect(measure.stays[0].text).toBe(UNDO_STAYS_AR.stock(4, 0));
    expect(measure.lines.find((l) => l.key === 'CUSTOMER')).toMatchObject({ text: expect.stringContaining('من 5 لـ4'), amount: { value: 55, currency: 'USD' } });
    // a return line already in the ledger is said too
    w.state.movements.push({ id: 'mvr', companyId: 'c1', type: 'RETURN', quantity: 1, referenceId: 'o1' });
    expect((await measureOf(w)).measure.stays[0].text).toBe(UNDO_STAYS_AR.stock(4, 1));
    // …and another order's ledger lines are not this order's
    w.state.movements.push({ id: 'mvx', companyId: 'c1', type: 'SALE', quantity: -9, referenceId: 'someone-else' });
    expect((await measureOf(w)).measure.stays[0].text).toBe(UNDO_STAYS_AR.stock(4, 1));
  });

  it('the bounds on the reason are the owner’s: at least five characters, at most three hundred', () => {
    expect(UNDO_REASON_MIN).toBe(5);
    expect(UNDO_REASON_MAX).toBe(300);
  });

  it('a stock that cannot be proven is no reason to refuse — the stock is never touched, so there is nothing to prove', async () => {
    const w = new World();
    await recordAtTheDoor(w, allTaken(w));
    w.state.movements = []; // a delivery on an empty shelf wrote no SALE line
    const done = await press(w);
    expect(done.plan.shelf).toEqual({ out: 0, back: 0 });
    expect(w.state.movements).toEqual([]);
    expect(w.forbidden).toEqual([]);
  });
});

describe('the press — a delivery recorded through the order’s own door, taken back', () => {
  it('whole: back to the state the timeline says, COLLECTED and the legacy status put back, the lines and the customer untouched', async () => {
    const w = new World();
    const initial = w.snapshot();
    await recordThroughTheShippingRoute(w, 'DELIVERED');
    const delivered = w.snapshot();
    await press(w);
    const after = w.snapshot();

    expect(after.order).toEqual({ ...initial.order, version: initial.order.version + 2, shippingStatus: 'OUT_FOR_DELIVERY', settlementStatus: 'PENDING_COLLECTION', status: 'SHIPPED' });
    expect(after.items).toEqual(initial.items);
    expect(after.customer).toEqual(initial.customer);
    expect(after.movements).toEqual(delivered.movements);
    expect(after.logs.slice(-2).map((l) => [l.statusType, l.previousValue, l.newValue])).toEqual([
      ['SHIPPING', 'DELIVERED', 'OUT_FOR_DELIVERY'],
      ['SETTLEMENT', 'COLLECTED', 'PENDING_COLLECTION'],
    ]);
    expect(after.logs.slice(0, delivered.logs.length)).toEqual(delivered.logs);
    expect(w.forbidden).toEqual([]);
  });

  it('partial: back to «مشحون» when that is where it was, and nothing else of the order changes', async () => {
    const w = new World({ order: { shippingStatus: 'SHIPPED' } });
    const initial = w.snapshot();
    await recordThroughTheShippingRoute(w, 'PARTIALLY_DELIVERED', 'SHIPPED');
    await press(w);
    expect(w.snapshot().order).toEqual({ ...initial.order, version: initial.order.version + 2 });
    expect(w.state.logs).toHaveLength(2); // the delivery line and the undo's; no settlement line, as COLLECTED was never written
  });

  it('from «فشل التوصيل»: goes back there', async () => {
    const w = new World({ order: { shippingStatus: 'FAILED_DELIVERY' } });
    await recordThroughTheShippingRoute(w, 'DELIVERED', 'FAILED_DELIVERY');
    await press(w);
    expect(w.state.order.shippingStatus).toBe('FAILED_DELIVERY');
  });
});

describe('the announcement that stays — read from what the REAL recorders left', () => {
  const eventsOf = async (w: World) => {
    const { measure } = await measureOf(w);
    expect(measure.allowed).toBe(true);
    return measure.stays.some((l) => l.key === 'EVENTS');
  };

  it('a FULL delivery through the order’s own door sent an announcement, and the dialog says it stays', async () => {
    const w = new World();
    await recordThroughTheShippingRoute(w, 'DELIVERED');
    expect(await eventsOf(w)).toBe(true);
  });

  it('a PARTIAL delivery through the same door sent none: the dialog does not say there is one to leave', async () => {
    const w = new World({ order: { shippingStatus: 'SHIPPED' } });
    await recordThroughTheShippingRoute(w, 'PARTIALLY_DELIVERED', 'SHIPPED');
    expect(w.state.order.shippingStatus).toBe('PARTIALLY_DELIVERED');
    expect(await eventsOf(w)).toBe(false);
  });

  it('a delivery at the door (whole or partial) sent none either', async () => {
    const whole = new World();
    await recordAtTheDoor(whole, allTaken(whole));
    expect(await eventsOf(whole)).toBe(false);
    const part = new World();
    await recordAtTheDoor(part, [{ itemId: 'i1', deliveredQty: 2 }, { itemId: 'i2', deliveredQty: 0 }]);
    expect(part.state.order.shippingStatus).toBe('PARTIALLY_DELIVERED');
    expect(await eventsOf(part)).toBe(false);
  });
});

describe('every read of the undo is for THIS order — another order’s rows sit in the same tables and change nothing', () => {
  /** Rows of the order next door, written AFTER this one's (so a read that forgot its order meets them first), each shaped to flip the answer if it were read. */
  const NEXT_DOOR = new Date(Date.UTC(2026, 10, 13, 1, 0, 0));
  const neighbour = {
    commission: () => [
      accrued({ id: 'ce-n-payable', orderId: 'o2', userId: 'ag2', status: 'PAYABLE' }),
      accrued({ id: 'ce-n-paid', orderId: 'o2', userId: 'ag2', status: 'PAID', payoutId: 'po9' }),
      accrued({ id: 'ce-n-accrued', orderId: 'o2', userId: 'ag3' }),
    ],
    shippingLine: () => ({ id: 'l-n', companyId: 'c1', orderId: 'o2', statusType: 'SHIPPING', previousValue: 'FAILED_DELIVERY', newValue: 'DELIVERED', createdAt: NEXT_DOOR }),
    rows: () => [
      { id: 'a-n1', companyId: 'c1', orderId: 'o2', action: DELIVERY_UNDO_ACTION, previousStatus: 'DELIVERED', newStatus: 'SHIPPED', metadata: null, createdAt: NEXT_DOOR },
      { id: 'a-n2', companyId: 'c1', orderId: 'o2', action: SHIPPING_MARK, previousStatus: 'FAILED_DELIVERY', newStatus: 'DELIVERED', metadata: null, createdAt: NEXT_DOOR },
    ],
  };
  const theNeighbours = (s: State) => ({
    commission: s.commission.filter((r) => r.orderId === 'o2'),
    logs: s.logs.filter((r) => r.orderId === 'o2'),
    activities: s.activities.filter((r) => r.orderId === 'o2'),
  });

  it('COMMISSION: another order’s PAYABLE or PAID entry does not refuse this undo, and its ACCRUED one is not counted among this order’s', async () => {
    const w = new World();
    w.state.commission.push(accrued());
    await recordAtTheDoor(w, allTaken(w));
    w.state.commission.push(...neighbour.commission());

    const { facts: f, measure } = await measureOf(w);
    expect(f.commission.map((e) => e.id)).toEqual(['ce1']);
    expect(measure.allowed, 'a payable entry of ANOTHER order refused this one').toBe(true);
    expect(measure.lines.find((l) => l.key === 'COMMISSION')?.text).toBe(UNDO_LINE_AR.commission(1));
    expect(planOf(f).commission.map((e) => e.id)).toEqual(['ce1']);

    // the press reads it again after the claim, with the transaction's client: the same answer, and the neighbour's entries are exactly as they were
    const before = theNeighbours(w.snapshot());
    const done = await press(w);
    expect(done.voided).toBe(1);
    expect(theNeighbours(w.snapshot())).toEqual(before);
    expect(w.state.commission.filter((r) => r.reversalOfId)).toHaveLength(1);
  });

  it('THE «BEFORE» STATE: the state it goes back to is read from THIS order’s timeline, never from another order’s newer line', async () => {
    const w = new World({ order: { shippingStatus: 'OUT_FOR_DELIVERY' } });
    await recordThroughTheShippingRoute(w, 'DELIVERED', 'OUT_FOR_DELIVERY');
    w.state.logs.push(neighbour.shippingLine());

    const { facts: f, measure } = await measureOf(w);
    expect(f.shippingLog.map((l) => [l.previousValue, l.newValue])).toEqual([['OUT_FOR_DELIVERY', 'DELIVERED']]);
    expect(measure.to, 'the timeline of another order decided where this one goes back to').toBe('OUT_FOR_DELIVERY');
    expect(measure.lines[0].text).toContain('«خرج للتوصيل»');

    const before = theNeighbours(w.snapshot());
    await press(w);
    expect(w.state.order.shippingStatus).toBe('OUT_FOR_DELIVERY');
    expect(theNeighbours(w.snapshot())).toEqual(before);
  });

  it('WHICH DOOR RECORDED IT: another order’s newer undo or delivery row does not decide the path — this order’s own newest row does', async () => {
    const w = new World();
    await recordAtTheDoor(w, allTaken(w));
    w.state.activities.push(...neighbour.rows());

    const { facts: f, measure } = await measureOf(w);
    expect(f.marks.map((m) => m.action)).toEqual([DOOR_MARK]);
    expect(measure.allowed, 'another order’s row blinded or redirected this one').toBe(true);
    expect(planOf(f).path).toBe('DOOR');

    const before = theNeighbours(w.snapshot());
    await press(w);
    expect(w.state.order.shippingStatus).toBe('SHIPPED');
    expect(theNeighbours(w.snapshot())).toEqual(before);
  });

  it('the whole neighbourhood at once: with rows of another order in every one of those tables, the measure and the plan are the very ones the order gets alone', async () => {
    const alone = new World();
    alone.state.commission.push(accrued());
    await recordThroughTheShippingRoute(alone, 'DELIVERED');
    const crowded = new World();
    crowded.state.commission.push(accrued());
    await recordThroughTheShippingRoute(crowded, 'DELIVERED');
    crowded.state.commission.push(...neighbour.commission());
    crowded.state.logs.push(neighbour.shippingLine());
    crowded.state.activities.push(...neighbour.rows());
    crowded.state.movements.push({ id: 'mv-n', companyId: 'c1', type: 'SALE', quantity: -9, referenceId: 'o2' });

    const a = await measureOf(alone);
    const b = await measureOf(crowded);
    expect(b.facts).toEqual(a.facts);
    expect(b.measure).toEqual(a.measure);
    expect(b.measure.fingerprint).toBe(a.measure.fingerprint);
  });

  it('and the COMPANY is named on every one of those reads: this order’s own id under another company (it cannot happen, so nothing else would notice) changes nothing either', async () => {
    const alone = new World();
    alone.state.commission.push(accrued());
    await recordThroughTheShippingRoute(alone, 'DELIVERED');
    const strangers = new World();
    strangers.state.commission.push(accrued());
    await recordThroughTheShippingRoute(strangers, 'DELIVERED');
    strangers.state.commission.push(accrued({ id: 'ce-x', companyId: 'c2', orderId: 'o1', userId: 'agx', status: 'PAYABLE' }));
    strangers.state.logs.push({ ...neighbour.shippingLine(), id: 'l-x', companyId: 'c2', orderId: 'o1' });
    strangers.state.activities.push(...neighbour.rows().map((r) => ({ ...r, id: r.id + 'x', companyId: 'c2', orderId: 'o1' })));
    strangers.state.movements.push({ id: 'mv-x', companyId: 'c2', type: 'SALE', quantity: -9, referenceId: 'o1' });

    const a = await measureOf(alone);
    const b = await measureOf(strangers);
    expect(b.facts).toEqual(a.facts);
    expect(b.measure).toEqual(a.measure);
  });
});

describe('after an undo, the shortfall engine does not blame the one who pressed «استلم» by mistake — the REAL recorder, the REAL undo, the REAL engine', () => {
  const PEOPLE: Row[] = [
    { id: 'uA', companyId: 'c1', name: 'سارة', role: 'FOLLOW_UP_AGENT', status: 'ACTIVE' },
    { id: 'uB', companyId: 'c1', name: 'منى', role: 'FOLLOW_UP_AGENT', status: 'ACTIVE' },
    { id: 'u1', companyId: 'c1', name: 'المالك', role: 'SUPER_ADMIN', status: 'ACTIVE' },
    { id: 'u-approver', companyId: 'c1', name: 'المحاسب', role: 'ACCOUNTANT', status: 'ACTIVE' },
  ];
  const SHORT_SCOPE = {
    companyId: 'c1',
    storeId: 's1',
    approverId: 'u-approver',
    statement: { id: 'st1', reference: 'JO-ST-7', currencyCode: 'JOD', importedAt: new Date(Date.UTC(2026, 10, 14)) },
    fallbackDeliveredAt: new Date(Date.UTC(2026, 10, 13)),
    minorUnit: 3,
  };
  /** The company's line says 38 + 2 against our 43 + 2: five dinars short. */
  const FIVE_SHORT = { matchId: 'm1', orderId: 'o1', orderNumber: 'ORD-2026-1696', expectedAmount: 43, expectedFee: 2, statementAmount: 38, statementFee: 2, explanation: 'الشركة دفعت أقل' };

  /** The engine's own client over the SAME world: it answers from the rows the real recorder and the real undo left, and honours select (a column it did not ask for is missing). */
  function shortfallTx(w: World) {
    const proposed: Row[] = [];
    const newest = (rows: Row[]) => [...rows].sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
    const project = (row: Row, select: Row): Row => {
      const out: Row = {};
      for (const [k, spec] of Object.entries(select)) {
        if (spec === true) out[k] = row[k];
        else if (k === 'activities') out[k] = newest(w.state.activities.filter((a) => a.orderId === row.id && matches(a, spec.where))).slice(0, spec.take).map((a) => project(a, spec.select));
        else throw new Error('the fake does not know the relation ' + k);
      }
      return out;
    };
    const tx = {
      order: { findMany: async ({ where, select }: Row) => [w.state.order].filter((o) => matches(o, where)).map((o) => project(o, select)) },
      deliveryAttempt: { findMany: async ({ where, select }: Row) => newest(w.state.attempts.filter((a) => matches(a, where))).map((a) => project(a, select)) },
      user: { findMany: async ({ where, select }: Row) => PEOPLE.filter((u) => matches(u, where)).map((u) => project(u, select)) },
      penalty: { findMany: async () => [], create: async ({ data }: Row) => (proposed.push(data), { id: 'pen' + proposed.length }) },
      orderActivity: { create: async () => ({}) },
    };
    return { tx, proposed };
  }
  const approve = async (w: World, naming?: Record<string, string>) => {
    const { tx, proposed } = shortfallTx(w);
    const result = await proposeShortfalls(tx as never, { ...SHORT_SCOPE, naming }, [FIVE_SHORT]);
    return { result, proposed };
  };
  const whoCarries = (r: Awaited<ReturnType<typeof approve>>) => r.result.charges.map((c) => [c.userId, c.amount]);

  it('A presses «استلم» by mistake → the owner takes it back → the company delivers it and pays 38 + 2 against 43 + 2: A is charged NOTHING, and the approval asks who', async () => {
    const w = new World();
    await recordAtTheDoor(w, allTaken(w), null, 'uA');
    expect(w.state.attempts.map((a) => [a.result, a.deliveryAgentId])).toEqual([['DELIVERED', 'uA']]);
    await press(w);
    expect(w.state.activities.some((a) => a.action === DELIVERY_UNDO_ACTION)).toBe(true);
    w.state.order.shippingStatus = 'DELIVERED'; // the company's statement delivers it later (what the approval writes)

    const r = await approve(w);
    expect(r.result.charges).toEqual([]);
    expect(r.result.stop).toMatchObject({ code: 'SHORTFALL_UNNAMED', lines: [{ matchId: 'm1', orderNumber: 'ORD-2026-1696', amount: 5, currencyCode: 'JOD' }] });
    expect(r.proposed).toEqual([]);

    // …and once the approver names the person who really followed the parcel, that person carries it
    expect(whoCarries(await approve(w, { m1: 'uB' }))).toEqual([['uB', 5]]);
  });

  it('CONTROL: the same press WITHOUT the undo still names A — the engine charges whoever stood at the door when the delivery stands', async () => {
    const w = new World();
    await recordAtTheDoor(w, allTaken(w), null, 'uA');
    const r = await approve(w);
    expect(whoCarries(r)).toEqual([['uA', 5]]);
    expect(r.proposed[0]).toMatchObject({ userId: 'uA', amount: 5, status: 'PROPOSED', settlementMatchId: 'm1' });
  });

  it('A (mistake) → undone → B presses it for real: B carries it, not A — and a second undo of B’s press names nobody again', async () => {
    const w = new World();
    await recordAtTheDoor(w, allTaken(w), null, 'uA');
    await press(w);
    await recordAtTheDoor(w, allTaken(w), null, 'uB');
    expect(whoCarries(await approve(w))).toEqual([['uB', 5]]);

    await press(w);
    w.state.order.shippingStatus = 'DELIVERED';
    const r = await approve(w);
    expect(r.result.charges).toEqual([]);
    expect(r.result.stop).toMatchObject({ code: 'SHORTFALL_UNNAMED' });
  });
});

/* ═════════════════════════ 5 · EVERY REFUSAL WRITES NOTHING — PROVED BY THE WHOLE WORLD ═════════════════════════ */

describe('every refusal writes NOTHING — the whole world is compared, before and after', () => {
  const recorded = async (over: ConstructorParameters<typeof World>[0] = {}) => {
    const w = new World(over);
    await recordAtTheDoor(w, allTaken(w));
    return w;
  };
  const expectUntouched = async (w: World, code: string, fingerprint?: string) => {
    const before = w.snapshot();
    const e = await refusedBy(w, fingerprint ? { fingerprint } : {});
    expect(e.body.code).toBe(code);
    expect(w.snapshot(), 'a refusal changed something').toEqual(before);
    expect(w.forbidden).toEqual([]);
    return e;
  };

  it('money recorded on the order', async () => {
    const w = await recorded();
    w.state.order.settlementStatus = 'SETTLED';
    await expectUntouched(w, 'MONEY_RECORDED');
    w.state.order.settlementStatus = 'PENDING_COLLECTION';
    w.state.order.collectedAmount = 30;
    await expectUntouched(w, 'MONEY_RECORDED');
  });

  it('a statement names the order — by its reference, by the courier’s barcode within that courier, or by a line tied by hand', async () => {
    const statement = (over: Row = {}) => ({ reference: 'ST-1', status: 'DRAFT', approvedAt: null, deliveryProviderId: 'p1', ...over });
    const cases: [string, (w: World) => void][] = [
      ['by reference', (w) => w.state.lines.push({ merchantRef: 'MR-1696', barcode: null, statement: statement(), matches: [] })],
      ['by barcode', (w) => w.state.lines.push({ merchantRef: null, barcode: '100550615867', statement: statement(), matches: [] })],
      ['by an approved statement', (w) => w.state.lines.push({ merchantRef: 'MR-1696', barcode: null, statement: statement({ status: 'APPROVED', approvedAt: new Date() }), matches: [] })],
      ['by a line tied by hand', (w) => w.state.links.push({ orderId: 'o1', result: 'MATCHED', statement: statement() })],
    ];
    for (const [what, add] of cases) {
      const w = await recorded();
      add(w);
      const e = await expectUntouched(w, 'ON_A_STATEMENT');
      expect(e.body.error, what).toContain('ORD-2026-1696');
    }
  });

  it('a barcode of ANOTHER courier’s statement does not speak for the order; a zero «تم إرجاعها» line the matching excluded does not either', async () => {
    const w = await recorded();
    w.state.lines.push({ merchantRef: null, barcode: '100550615867', statement: { reference: 'ST-2', status: 'DRAFT', approvedAt: null, deliveryProviderId: 'someone-else' }, matches: [] });
    w.state.lines.push({ merchantRef: 'MR-1696', barcode: null, statement: { reference: 'ST-3', status: 'APPROVED', approvedAt: new Date(), deliveryProviderId: 'p1' }, matches: [{ result: EXCLUDED_RESULT }] });
    w.state.links.push({ orderId: 'o1', result: EXCLUDED_RESULT, statement: { reference: 'ST-3', status: 'APPROVED', approvedAt: new Date(), deliveryProviderId: 'p1' } });
    await press(w);
    expect(w.state.order.shippingStatus).toBe('SHIPPED');
  });

  it('a counted return', async () => {
    const w = await recorded();
    w.state.order.returnReceipt = { id: 'rr1' };
    await expectUntouched(w, 'RETURN_COUNTED');
  });

  it('a commission that is payable', async () => {
    const w = new World();
    w.state.commission.push(accrued({ status: 'PAYABLE' }));
    await recordAtTheDoor(w, allTaken(w));
    await expectUntouched(w, 'COMMISSION_MOVED');
  });

  it('a recording the ledgers cannot prove (no row at all)', async () => {
    const w = await recorded();
    w.state.activities = [];
    await expectUntouched(w, 'PATH_UNKNOWN');
  });

  it('a delivery recorded by the combined-status override', async () => {
    const w = await recorded();
    w.state.activities = [{ id: 'x', companyId: 'c1', orderId: 'o1', action: OVERRIDE_MARK, previousStatus: 'SHIPPED', newStatus: 'DELIVERED', metadata: null }];
    await expectUntouched(w, 'PATH_UNKNOWN');
  });

  it('an order that is no longer delivered, and one of another store', async () => {
    const w = await recorded();
    w.state.order.shippingStatus = 'RETURN_REQUESTED';
    await expectUntouched(w, 'NOT_DELIVERED');
    const other = await recorded();
    other.state.order.storeId = 's2';
    const before = other.snapshot();
    expect((await readUndoFacts(other.tx(), SCOPE, 'o1')) === null).toBe(true);
    await expect(
      other.transaction((tx) => undoDelivery(tx, { scope: SCOPE, user: USER, orderId: 'o1', reason: REASON, fingerprint: 'f'.repeat(24) }))
    ).rejects.toMatchObject({ status: 404, body: { code: 'NOT_FOUND' } });
    expect(other.snapshot()).toEqual(before);
  });

  it('the numbers changed since the dialog (a wrong fingerprint): «changed», nothing written — even though every rule is satisfied', async () => {
    const w = await recorded();
    const e = await expectUntouched(w, 'CHANGED', 'a'.repeat(24));
    expect(e.body.error).toBe(UNDO_CHANGED_AR);
  });

  it('the order was edited after the dialog (a stale version): the fingerprint moves, so «changed»', async () => {
    const w = await recorded();
    const { measure } = await measureOf(w);
    w.state.order.version += 1;
    const before = w.snapshot();
    const e = await refusedBy(w, { fingerprint: measure.fingerprint as string });
    expect(e.body.code).toBe('CHANGED');
    expect(w.snapshot()).toEqual(before);
  });

  it('TWO PRESSES AT ONCE: the claim is short for the loser — «ORDERS_CHANGED», and the winner’s write is all that remains', async () => {
    const w = await recorded();
    // the other press commits between this one's read and its claim
    w.hooks.beforeClaim = () => w.concurrentChange((s) => { s.order.version += 1; });
    const before = w.snapshot();
    const e = await refusedBy(w);
    expect(e).toMatchObject({ status: 409, body: { code: 'ORDERS_CHANGED', error: UNDO_ORDERS_CHANGED_AR } });
    expect(w.snapshot()).toEqual({ ...before, order: { ...before.order, version: before.order.version + 1 } });
  });

  it('a collection or an approval settled the order between the read and the claim: the claim is short, nothing is written', async () => {
    const w = await recorded();
    w.hooks.beforeClaim = () => w.concurrentChange((s) => { s.order.settlementStatus = 'SETTLED'; });
    const before = w.snapshot();
    const e = await refusedBy(w);
    expect(e.body.code).toBe('ORDERS_CHANGED');
    expect(w.snapshot()).toEqual({ ...before, order: { ...before.order, settlementStatus: 'SETTLED' } });
  });

  it('a return was counted between the read and the claim: the claim (which holds «no receipt») is short', async () => {
    const w = await recorded();
    w.hooks.beforeClaim = () => w.concurrentChange((s) => { s.order.returnReceipt = { id: 'rr9' }; });
    expect((await refusedBy(w)).body.code).toBe('ORDERS_CHANGED');
  });

  it('A STATEMENT UPLOADED WHILE THE PRESS WAITED FOR THE ROW (visible only to the read after the claim): everything — the claim included — is taken back', async () => {
    const w = await recorded();
    w.state.commission.push(accrued());
    w.hooks.afterClaim = () =>
      w.concurrentChange((s) => {
        s.lines.push({ merchantRef: 'MR-1696', barcode: null, statement: { reference: 'ST-LATE', status: 'DRAFT', approvedAt: null, deliveryProviderId: 'p1' }, matches: [] });
      });
    const before = w.snapshot();
    const e = await refusedBy(w);
    expect(e).toMatchObject({ status: 409, body: { code: 'ON_A_STATEMENT', error: UNDO_LATE_STATEMENT_AR } });
    // the order is back to DELIVERED: the claim's write was undone with the rest (compared to the world with the statement added)
    expect(w.snapshot()).toEqual({ ...before, lines: w.state.lines });
    expect(w.state.order.shippingStatus).toBe('DELIVERED');
  });

  it('A COMMISSION MADE PAYABLE WHILE THE PRESS WAITED: everything is taken back', async () => {
    const w = await recorded();
    w.state.commission.push(accrued());
    w.hooks.afterClaim = () => w.concurrentChange((s) => { s.commission[0].status = 'PAYABLE'; });
    const e = await refusedBy(w);
    expect(e).toMatchObject({ status: 409, body: { code: 'COMMISSION_MOVED', error: UNDO_LATE_COMMISSION_AR } });
    expect(w.state.order.shippingStatus).toBe('DELIVERED');
    expect(w.state.commission).toHaveLength(1);
    expect(w.state.commission[0].status).toBe('PAYABLE');
    expect(w.state.activities.some((a) => a.action === DELIVERY_UNDO_ACTION)).toBe(false);
  });

  it('a failure in the middle of the writes (the database refuses a write) takes the claim and every earlier write back', async () => {
    const w = await recorded();
    const tx = w.tx();
    const boom = { ...tx, orderNote: { create: async () => { throw new Error('connection reset'); } } };
    const before = w.snapshot();
    const { measure } = await measureOf(w);
    await expect(
      w.transaction(() => undoDelivery(boom, { scope: SCOPE, user: USER, orderId: 'o1', reason: REASON, fingerprint: measure.fingerprint as string }))
    ).rejects.toThrow('connection reset');
    expect(w.snapshot(), 'the order, the lines, the counters and the log were left half-written').toEqual(before);
  });
});

/* ═════════════════════════ 6 · THE CLAIM'S OWN WHERE AND DATA ═════════════════════════ */

describe('the claim — what it holds the order to, and what it writes', () => {
  const f = facts({ order: { settlementStatus: 'COLLECTED', status: 'DELIVERED' }, marks: [routeMark()], shippingLog: [{ previousValue: 'OUT_FOR_DELIVERY', newValue: 'DELIVERED' }] });
  const plan = planOf(f);

  it('holds the order to this store, this version, this delivery, this settlement state, no collected amount and no counted return', () => {
    expect(claimWhere(SCOPE, f.order, plan)).toEqual({
      id: 'o1',
      companyId: 'c1',
      storeId: 's1',
      version: 9,
      shippingStatus: 'DELIVERED',
      settlementStatus: 'COLLECTED',
      collectedAmount: null,
      returnReceipt: null,
    });
  });

  it('writes the status, no delivery date, the next version — and the two columns the delivery itself wrote, only when it wrote them', () => {
    expect(claimData(plan)).toEqual({ shippingStatus: 'OUT_FOR_DELIVERY', deliveredAt: null, version: { increment: 1 }, status: 'SHIPPED', settlementStatus: 'PENDING_COLLECTION' });
    const door = planOf(facts());
    expect(claimData(door)).toEqual({ shippingStatus: 'SHIPPED', deliveredAt: null, version: { increment: 1 } });
    // never a money column, never the lines' stock columns
    for (const key of Object.keys(claimData(plan))) expect(['shippingStatus', 'deliveredAt', 'version', 'status', 'settlementStatus']).toContain(key);
  });
});

/* ═════════════════════════ 7 · PROPERTIES ═════════════════════════ */

/** A seeded generator: the same orders every run, so a failure is a failure of the code and never of the dice. */
function prng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const round2 = (n: number) => Math.round(n * 100) / 100;

describe('PROPERTY — recorded at the door by the REAL recorder, then undone: the world comes back, whatever the order was', () => {
  it('120 random orders (lines, gifts, discounts, a fee in or out of the price, add-ons, any partial taken): the order, the lines and the customer return; the stock and the money are never touched; history only grows', async () => {
    let partials = 0;
    let wholes = 0;
    for (let seed = 1; seed <= 120; seed++) {
      const rnd = prng(seed);
      const count = 1 + Math.floor(rnd() * 4);
      const items = Array.from({ length: count }, (_, k) => {
        const quantity = 1 + Math.floor(rnd() * 5);
        const unitPrice = round2(1 + rnd() * 40);
        return {
          id: `i${k}`,
          orderId: 'o1',
          productId: `p${k}`,
          productName: `منتج ${k}`,
          quantity,
          freeQuantity: Math.floor(rnd() * 3),
          unitPrice,
          discountShare: 0,
          lineTotal: round2(quantity * unitPrice),
          deliveredQty: null,
          returnedQty: null,
        };
      });
      const customer = { deliveredOrders: Math.floor(rnd() * 6), totalPurchaseValue: round2(rnd() * 300), cancelledOrders: Math.floor(rnd() * 3) };
      const w = new World({
        items,
        customer,
        order: {
          deliveryFee: round2(rnd() * 8),
          priceIncludesDelivery: rnd() < 0.3,
          shippingStatus: (['SHIPPED', 'OUT_FOR_DELIVERY', 'FAILED_DELIVERY'] as const)[Math.floor(rnd() * 3)],
          settlementStatus: (['PENDING_COLLECTION', 'NOT_APPLICABLE', 'PENDING', 'UNSETTLED'] as const)[Math.floor(rnd() * 4)],
          status: rnd() < 0.5 ? 'SHIPPED' : 'CONFIRMED',
        },
      });
      const given = items.map((i) => ({ itemId: i.id, deliveredQty: Math.floor(rnd() * (i.quantity + i.freeQuantity + 1)) }));
      if (given.every((g) => g.deliveredQty === 0)) given[0].deliveredQty = items[0].quantity + items[0].freeQuantity; // something was taken: this is a delivery
      if (seed % 5 === 0) items.forEach((i, k) => (given[k].deliveredQty = i.quantity + i.freeQuantity)); // and every fifth one is a whole delivery
      if (rnd() < 0.5) w.state.commission.push(accrued({ amount: round2(rnd() * 9 + 0.5) }));

      const initial = w.snapshot();
      await recordAtTheDoor(w, given, rnd() < 0.5 ? 'سلّم الزبون' : null);
      const delivered = w.snapshot();
      expect(['DELIVERED', 'PARTIALLY_DELIVERED'], `seed ${seed}`).toContain(delivered.order.shippingStatus);
      if (delivered.order.shippingStatus === 'DELIVERED') wholes += 1;
      else partials += 1;

      await press(w);
      const after = w.snapshot();

      expect(after.order, `seed ${seed}: the order`).toEqual({ ...initial.order, shippingStatus: 'SHIPPED', version: initial.order.version + 2 });
      expect(after.items, `seed ${seed}: the lines`).toEqual(initial.items);
      expect(after.customer.deliveredOrders, `seed ${seed}: delivered`).toBe(initial.customer.deliveredOrders);
      expect(after.customer.cancelledOrders, `seed ${seed}: cancelled`).toBe(initial.customer.cancelledOrders);
      expect(after.customer.totalPurchaseValue, `seed ${seed}: value`).toBeCloseTo(initial.customer.totalPurchaseValue, 6);
      expect(after.customer.deliveredOrders).toBeGreaterThanOrEqual(0);
      expect(after.customer.totalPurchaseValue).toBeGreaterThanOrEqual(0);
      // the stock: exactly the ledger the delivery left — the undo added no line, edited none, removed none
      expect(after.movements, `seed ${seed}: the stock ledger`).toEqual(delivered.movements);
      expect(w.forbidden, `seed ${seed}: a wallet, the stock or a financial row was touched`).toEqual([]);
      // history only grows, and the earlier rows are byte-for-byte what they were
      expect(after.activities.slice(0, delivered.activities.length)).toEqual(delivered.activities);
      expect(after.notes.slice(0, delivered.notes.length)).toEqual(delivered.notes);
      expect(after.attempts).toEqual(delivered.attempts);
      expect(after.activities.length).toBe(delivered.activities.length + 1);
      // the commission: net zero for what was accrued, the original intact
      const live = after.commission.reduce((n, r) => n + Number(r.amount), 0);
      expect(live, `seed ${seed}: the commission nets to zero`).toBeCloseTo(0, 6);
      expect(after.commission.filter((r) => r.status === 'ACCRUED').length).toBe(delivered.commission.length);
    }
    // the generator really exercised both shapes
    expect(wholes).toBeGreaterThanOrEqual(24);
    expect(partials).toBeGreaterThanOrEqual(20);
  });
});

/* ═════════════════════════ 8 · THE WORDS ═════════════════════════ */

describe('the words — Arabic, all of them, and the history says them too', () => {
  it('every sentence the door and the dialog can say has no English word and no database code in it', () => {
    const sentences: string[] = [
      UNDO_FORBIDDEN_AR,
      UNDO_ACK_AR,
      UNDO_NOT_FOUND_AR,
      UNDO_CHANGED_AR,
      UNDO_ORDERS_CHANGED_AR,
      UNDO_LATE_STATEMENT_AR,
      UNDO_LATE_COMMISSION_AR,
      UNDO_WHY_AR.notDelivered('مشحون'),
      UNDO_WHY_AR.alreadyUndone('مشحون'),
      ...['SETTLED', 'PARTIALLY_SETTLED', 'REFUNDED', 'PARTIALLY_REFUNDED', 'CANCELLED', 'COLLECTED', 'PENDING_COLLECTION'].map((s) => UNDO_WHY_AR.moneyState(s)),
      UNDO_WHY_AR.moneyAmount,
      UNDO_WHY_AR.returnCounted,
      UNDO_WHY_AR.commissionMoved(2),
      UNDO_WHY_AR.noRecord,
      UNDO_WHY_AR.override,
      UNDO_WHY_AR.changedAfter,
      UNDO_WHY_AR.collectedUnexplained,
      UNDO_WHY_AR.noFigure,
      UNDO_LINE_AR.status('مسلَّم', 'مشحون', true),
      UNDO_LINE_AR.status('مسلَّم', 'مشحون', false),
      UNDO_LINE_AR.items(2),
      UNDO_LINE_AR.settlement('محصَّل', 'لم يُحصَّل'),
      UNDO_LINE_AR.customer(4, 5),
      UNDO_LINE_AR.customer(0, 0),
      UNDO_LINE_AR.commission(1),
      UNDO_STAYS_AR.stock(4, 0),
      UNDO_STAYS_AR.stock(4, 2),
      UNDO_STAYS_AR.stock(0, 0),
      UNDO_STAYS_AR.money,
      UNDO_STAYS_AR.history,
      UNDO_STAYS_AR.events,
      UNDO_STAYS_AR.noCommission,
      UNDO_SUCCESS_AR('٠', 'مشحون'),
    ];
    expect(sentences.length).toBeGreaterThan(30);
    for (const s of sentences) expect(s, s).not.toMatch(/[A-Za-z]/);
  });

  it('the order’s timeline and the audit view each carry a word for the activity — a row with no word would print a database code', () => {
    const read = (p: string) => readFileSync(join(process.cwd(), p), 'utf8');
    for (const f of ['src/lib/order-timeline.ts', 'src/lib/audit-view.ts']) {
      const word = new RegExp(`${DELIVERY_UNDO_ACTION}: '([^']+)'`).exec(read(f))?.[1];
      expect(word, `${f} has no word for ${DELIVERY_UNDO_ACTION}`).toBeTruthy();
      expect(word, f).not.toMatch(/[A-Za-z]/);
    }
  });

  it('the key’s own words in the roles screen say there is no time limit, in Arabic', () => {
    const catalog = readFileSync(join(process.cwd(), 'src/lib/permission-catalog.ts'), 'utf8');
    expect(catalog).toMatch(/key: 'ops\.undo_delivery', requires: 'ops\.track', ar: '[^']*بلا مدة زمنية[^']*'/);
  });
});

/* ═════════════════════════ 9 · NO CLOCK, NO MONEY, NO STOCK — IN THE SOURCE ═════════════════════════ */

describe('the sources — no time window, no money writer, no stock writer', () => {
  const read = (p: string) => stripComments(readFileSync(join(process.cwd(), p), 'utf8'));
  const FILES = [
    'src/lib/delivery-undo.ts',
    'src/lib/delivery-undo-words.ts',
    'src/app/api/ops/tracking/undo-delivery/route.ts',
    'src/components/screens/tracking/UndoDeliveryDialog.tsx',
  ];

  it('not one of them reads a clock: no `Date.now`, no `new Date(`, no `getTime`, no timer — a delivery is never «too old» or «too new»', () => {
    for (const f of FILES) {
      const src = read(f);
      expect(src, f).not.toMatch(/Date\.now|new Date\(|\.getTime\(|setTimeout|setInterval|differenceIn|hoursAgo|minutesAgo|daysAgo/);
    }
  });

  it('the order read never selects a date or an age, so no rule could compare one', () => {
    const src = read('src/lib/delivery-undo.ts');
    const select = src.slice(src.indexOf('const ORDER_SELECT'), src.indexOf('} satisfies Prisma.OrderSelect'));
    expect(select).not.toMatch(/deliveredAt|shippedAt|createdAt|updatedAt|returnedAt|outForDeliveryAt/);
  });

  it('writes no wallet, no financial row, no stock line or batch, no collected amount, no app event, no conversion — and only the order columns the claim names', () => {
    for (const f of ['src/lib/delivery-undo.ts', 'src/app/api/ops/tracking/undo-delivery/route.ts']) {
      const src = read(f);
      expect(src, f).not.toMatch(/recordMovement|walletMovement|financialTransaction|inventoryMovement\.(create|update|delete)|productionBatch|drawDownStock|restoreOrderStock|consumeOrderStock|takeOffUnreturned|emitAppEvent|queueConversions/);
      // the collected amount is only ever SELECTED (`true`) or held to «none» (`null`) — never given a value
      for (const line of src.split('\n').filter((l) => /collectedAmount:/.test(l))) expect(line, f).toMatch(/collectedAmount:\s*(true|null)\b/);
    }
    // the stock's own tables are only READ here
    expect(read('src/lib/delivery-undo.ts')).toMatch(/inventoryMovement\.findMany/);
  });

  it('deletes nothing: history is only appended to', () => {
    for (const f of FILES) expect(read(f), f).not.toMatch(/\.delete\(|\.deleteMany\(|\.upsert\(/);
  });

  it('the one commission writer it calls is the existing reversing helper — it writes no commission row of its own', () => {
    const src = read('src/lib/delivery-undo.ts');
    expect(src).toContain('reverseForOrder(tx');
    expect(src).not.toMatch(/commissionEntry\.(create|update|updateMany|delete)/);
  });

  it('writes the settlement only as the delivery’s own COLLECTED going back to «لم يُحصَّل» — never SETTLED or any other word', () => {
    const src = read('src/lib/delivery-undo.ts');
    expect(src).not.toMatch(/'SETTLED'|'PARTIALLY_SETTLED'|'REFUNDED'|'PARTIALLY_REFUNDED'/);
    expect(src).toContain(`BACK_TO_AWAITING = 'PENDING_COLLECTION'`);
  });
});
