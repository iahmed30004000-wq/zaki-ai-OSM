import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * ═══════════════════════════════════════════════════════════════════════
 * «تراجع عن إقفال القديمة» (25/11) — THE RULES, THE PRESS AND THE WHOLE ROAD AFTER IT, AGAINST A DATABASE THAT REMEMBERS.
 *
 *   «اعملها بالكود» (the owner, on orders «إقفال القديمة» closed as collected while the company's statement says they came back at zero)
 *
 * The world here (1) KEEPS STATE — the delivery is recorded by the REAL door recorder (`recordPartialDelivery`), the close by the REAL mark
 * writer (`markClosed`), the undo of the delivery by the REAL `undoDelivery`, the returns desk by the REAL `receiveReturn` —, (2) ROLLS
 * BACK a thrown transaction, so «a refusal writes nothing» is proved by comparing the whole world before and after, and (3) records every
 * touch of anything the take-back must NEVER touch (a wallet, the stock, a financial row).
 * ═══════════════════════════════════════════════════════════════════════
 */

const { current, audits } = vi.hoisted(() => ({
  current: { world: null as unknown as { onConsume: (id: string) => void; tx: () => any; transaction: (fn: (tx: any) => Promise<any>) => Promise<any>; stock: string[] } },
  audits: [] as Record<string, unknown>[],
}));

// The module's client IS the world's, and its transaction is the world's: the returns desk (`receiveReturn`) reads `db` directly.
vi.mock('./db', () => ({
  db: new Proxy(
    {},
    {
      get: (_t, p: string) => (p === '$transaction' ? (fn: (tx: any) => Promise<any>) => current.world.transaction(fn) : current.world.tx()[p]),
    }
  ),
}));
// The stock is the desk's and the recorder's, never the take-back's: stand-ins that write a line the tests can count.
vi.mock('./stock-consumption', () => ({
  consumeOrderStock: vi.fn(async (_tx: unknown, input: { orderId: string }) => {
    current.world.onConsume(input.orderId);
    return { taken: 0, short: 0, alreadyDone: false, cost: 0 };
  }),
  restoreOrderStock: vi.fn(async () => {
    current.world.stock.push('RETURN');
  }),
  takeOffUnreturned: vi.fn(async () => ({ moved: 0 })),
}));
vi.mock('./audit', () => ({ logAudit: vi.fn(async (row: Record<string, unknown>) => void audits.push(row)) }));

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { stripComments } from './guard-source';
import { recordPartialDelivery } from './partial-delivery';
import { markClosed, NO_MONEY_SETTLEMENT } from './legacy-closeout';
import { LEGACY_CLOSE_ACTION, LEGACY_CLOSE_NOTE, PICKED_CLOSE_NOTE } from './legacy-closeout-words';
import { measureUndo, readUndoFacts, undoDelivery, UndoStopped } from './delivery-undo';
import { receiveReturn } from './return-receipt';
import { PROMOTABLE_BY_PAYOUT, markPayableForOrders, promoteSettledToPayable } from './commission';
import { PARKED_ROW, rowParkedNoMoney, zeroReturnCarriesNoMoney } from './settlement-gates';
import { PARKED } from './settlement-difference';
import {
  CLOSE_NOTES,
  TakeBackStopped,
  claimWhere,
  judgeTakeBack,
  measureTakeBack,
  readTakeBackFacts,
  rowCarriesMoney,
  takeBackLegacyClose,
} from './legacy-take-back';
import {
  LEGACY_MARK_UNDONE,
  LEGACY_TAKE_BACK_ACTION,
  TAKE_BACK_CHANGED_AR,
  TAKE_BACK_LATE_MONEY_AR,
  TAKE_BACK_LINE_AR,
  TAKE_BACK_NOTE_PREFIX,
  TAKE_BACK_ORDERS_CHANGED_AR,
  TAKE_BACK_STAYS_AR,
  TAKE_BACK_SUCCESS_AR,
  TAKE_BACK_WHY_AR,
  TAKE_BACK_ACK_AR,
  TAKE_BACK_FORBIDDEN_AR,
} from './legacy-take-back-words';

/* ═════════════════════════ a database that remembers ═════════════════════════ */

type Row = Record<string, any>;
const clone = <T,>(v: T): T => structuredClone(v);

/** Prisma's filter semantics over plain objects — the subset these doors use, relations included (`none`, `is`, a nested filter). */
function matches(row: unknown, where?: unknown): boolean {
  if (!where) return true;
  if (row == null || typeof row !== 'object') return false;
  const r = row as Row;
  for (const [k, v] of Object.entries(where as Row)) {
    if (k === 'OR') {
      if (!(v as unknown[]).some((c) => matches(r, c))) return false;
      continue;
    }
    const have = r[k];
    if (v === null) {
      if (have != null) return false;
      continue;
    }
    if (v && typeof v === 'object' && !(v instanceof Date) && !Array.isArray(v)) {
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
      } else if ('none' in v) {
        if ((Array.isArray(have) ? have : []).some((x: unknown) => matches(x, v.none))) return false;
      } else if ('is' in v) {
        if (v.is === null ? have != null : !matches(have, v.is)) return false;
      } else if (have === undefined) {
        // a relation filter on a row the fake does not join (the statement of a line): read as «this store's», as the reads ask
        continue;
      } else if (!matches(have, v)) return false;
      continue;
    }
    if (have !== v) return false;
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
  wallet: Row[];
  lines: Row[];
  rows: Row[];
  receipt: Row | null;
  seq: number;
}

class World {
  state: State;
  snap: State | null = null;
  forbidden: string[] = [];
  stock: string[] = [];
  hooks: { afterClaim?: () => void; beforeClaim?: () => void } = {};

  constructor(over: { order?: Row } = {}) {
    this.state = {
      order: {
        id: 'o1',
        companyId: 'c1',
        storeId: 's1',
        orderNumber: 'ORD-2026-0001',
        merchantRef: 'MR-0001',
        trackingNumber: '100550000001',
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
        regionId: 'r1',
        sourceWarehouseId: null,
        returnReceipt: null,
        ...over.order,
      },
      items: [
        { id: 'i1', orderId: 'o1', productId: 'p1', productName: 'كريم', quantity: 2, freeQuantity: 0, unitPrice: 10, discountShare: 0, lineTotal: 20, deliveredQty: null, returnedQty: null, reservedQty: 0 },
        { id: 'i2', orderId: 'o1', productId: 'p2', productName: 'قطرة', quantity: 1, freeQuantity: 1, unitPrice: 30, discountShare: 0, lineTotal: 30, deliveredQty: null, returnedQty: null, reservedQty: 0 },
      ],
      customer: { id: 'cu1', companyId: 'c1', deliveredOrders: 4, cancelledOrders: 1, totalPurchaseValue: 120 },
      activities: [],
      logs: [],
      notes: [],
      attempts: [],
      commission: [],
      movements: [],
      wallet: [],
      lines: [],
      rows: [],
      receipt: null,
      seq: 0,
    };
    current.world = this;
  }

  onConsume(orderId: string) {
    if (this.state.movements.some((m) => m.type === 'SALE' && m.referenceId === orderId)) return;
    this.state.movements.push({ id: `mv${++this.state.seq}`, type: 'SALE', quantity: -4, referenceId: orderId });
  }

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

/** The client a transaction hands out: it reads and writes the world, and anything it was not told about is recorded as forbidden. */
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
    const stamp = (row: Row) => ({ createdAt: new Date(Date.UTC(2026, 10, 25, 0, 0, w.state.seq)), ...row });
    const newestFirst = (rows: Row[]) => [...rows].reverse();
    const orderView = () => ({
      ...clone(w.state.order),
      items: clone(w.state.items),
      addOns: [],
      deliveryProvider: { name: 'الباشا' },
      returnReceipt: w.state.receipt ? clone(w.state.receipt) : null,
      store: { warehousePlacement: null },
    });
    const commissionView = (e: Row) => ({
      ...e,
      order: e.orderId === 'o1' ? { ...w.state.order, activities: w.state.activities } : null,
      reversedBy: w.state.commission.find((x) => x.reversalOfId === e.id) ?? null,
    });
    return {
      order: strict('order', {
        async findFirst({ where }: { where: Row }) {
          return matches(w.state.order, where) ? orderView() : null;
        },
        async update({ data }: { data: Row }) {
          apply(w.state.order, data);
          return clone(w.state.order);
        },
        async updateMany({ where, data }: { where: Row; data: Row }) {
          w.hooks.beforeClaim?.();
          if (!matches({ ...w.state.order, returnReceipt: w.state.receipt }, where)) return { count: 0 };
          apply(w.state.order, data);
          w.hooks.afterClaim?.();
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
          for (const i of w.state.items) if (matches(i, where)) (apply(i, data), (count += 1));
          return { count };
        },
      }),
      customer: strict('customer', {
        async findFirst({ where }: { where: Row }) {
          return matches(w.state.customer, where) ? clone(w.state.customer) : null;
        },
        async update({ data }: { data: Row }) {
          apply(w.state.customer, data);
          return clone(w.state.customer);
        },
        async updateMany({ where, data }: { where: Row; data: Row }) {
          if (!matches(w.state.customer, where)) return { count: 0 };
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
        async createMany({ data }: { data: Row[] }) {
          for (const d of data) w.state.activities.push(stamp({ id: next('a'), ...d }));
          return { count: data.length };
        },
        async findMany({ where }: { where: Row }) {
          return clone(newestFirst(w.state.activities.filter((r) => matches(r, where))));
        },
        async count({ where }: { where: Row }) {
          return w.state.activities.filter((r) => matches(r, where)).length;
        },
        async updateMany({ where, data }: { where: Row; data: Row }) {
          let count = 0;
          for (const a of w.state.activities) if (matches(a, where)) (apply(a, data), (count += 1));
          return { count };
        },
      }),
      orderStatusLog: strict('orderStatusLog', {
        async create({ data }: { data: Row }) {
          const row = stamp({ id: next('l'), ...data });
          w.state.logs.push(row);
          return clone(row);
        },
        async createMany({ data }: { data: Row[] }) {
          for (const d of data) w.state.logs.push(stamp({ id: next('l'), ...d }));
          return { count: data.length };
        },
        async findMany({ where, take }: { where: Row; take?: number }) {
          const rows = newestFirst(w.state.logs.filter((r) => matches(r, where)));
          return clone(take ? rows.slice(0, take) : rows);
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
        async create({ data }: { data: Row }) {
          const row = stamp({ id: next('d'), ...data });
          w.state.attempts.push(row);
          return clone(row);
        },
      }),
      commissionEntry: strict('commissionEntry', {
        async findMany({ where }: { where: Row }) {
          return clone(w.state.commission.map(commissionView).filter((r) => matches(r, where)).map((r) => ({ ...r, order: undefined })));
        },
        async findUnique({ where }: { where: Row }) {
          return clone(w.state.commission.find((r) => r.reversalOfId === where.reversalOfId) ?? null);
        },
        async create({ data }: { data: Row }) {
          const row = stamp({ id: next('ce'), payoutId: null, ...data });
          w.state.commission.push(row);
          return clone(row);
        },
        async updateMany({ where, data }: { where: Row; data: Row }) {
          let count = 0;
          for (const e of w.state.commission) if (matches(commissionView(e), where)) (apply(e, data), (count += 1));
          return { count };
        },
      }),
      inventoryMovement: strict('inventoryMovement', {
        async findMany({ where }: { where: Row }) {
          return clone(w.state.movements.filter((r) => matches(r, where)));
        },
      }),
      statementLine: strict('statementLine', {
        async findMany() {
          return clone(w.state.lines);
        },
      }),
      settlementMatch: strict('settlementMatch', {
        async findMany({ where }: { where: Row }) {
          return clone(w.state.rows.filter((r) => matches(r, { orderId: where.orderId, ...(where.statementLineId ? { statementLineId: where.statementLineId } : {}) })));
        },
      }),
      walletMovement: strict('walletMovement', {
        async count({ where }: { where: Row }) {
          return w.state.wallet.filter((r) => matches(r, where)).length;
        },
      }),
      returnReceipt: strict('returnReceipt', {
        async create({ data }: { data: Row }) {
          w.state.receipt = { id: next('rr'), ...data };
          return clone(w.state.receipt);
        },
      }),
      financialTransaction: strict('financialTransaction', {}),
      productionBatch: strict('productionBatch', {}),
      wallet: strict('wallet', {}),
      warehouse: strict('warehouse', {}),
    };
}

const SCOPE = { companyId: 'c1', storeId: 's1' };
const USER = { id: 'u1', role: 'SUPER_ADMIN' };
const REASON = 'الشركة بتقول الطرد رجع — سطرو بالكشف بصفر';
const allTaken = (w: World) => w.state.items.map((i) => ({ itemId: i.id, deliveredQty: i.quantity + i.freeQuantity }));

/** The delivery, recorded by the REAL door recorder. */
const deliverAtTheDoor = (w: World) =>
  w.transaction((tx) => recordPartialDelivery(tx, { companyId: 'c1', storeId: 's1', orderId: 'o1', lines: allTaken(w), minorUnit: 2, userId: 'u1', note: null }));

/** «إقفال القديمة»: the press's claim, then the REAL mark writer — the same pair both presses run. */
const closeAsLegacy = (w: World, note = LEGACY_CLOSE_NOTE) =>
  w.transaction(async (tx) => {
    const before = w.state.order.settlementStatus;
    const claimed = await tx.order.updateMany({
      where: { id: 'o1', settlementStatus: { in: [...NO_MONEY_SETTLEMENT] } },
      data: { settlementStatus: 'SETTLED' },
    });
    expect(claimed.count).toBe(1);
    await markClosed(tx, { scope: SCOPE, user: { id: 'owner', role: 'SUPER_ADMIN' }, rows: [{ id: 'o1', settlementStatus: before }], note, metadata: { note } });
  });

const ST = (over: Row = {}) => ({ reference: 'ST-9', status: 'APPROVED', approvedAt: new Date('2026-11-21T10:00:00Z'), matchingClosedAt: null, deliveryProviderId: 'p1', ...over });

/** The company's line: «تم إرجاعها» at zero, and the match row the REAL matching wrote against the delivered order (MISMATCHED). */
function zeroReturnedLine(w: World, rowOver: Row = {}, statementOver: Row = {}) {
  const statement = ST(statementOver);
  const row = { result: 'MISMATCHED', resolution: null, appliedAt: null, matchedBy: 'BARCODE', ...rowOver };
  w.state.lines.push({ merchantRef: null, barcode: '100550000001', amount: 0, collected: 0, fee: 0, status: 'تم إرجاعها', statement, matches: [row] });
  w.state.rows.push({ orderId: 'o1', statementLineId: 'sl1', ...row, statement, statementLine: { amount: 0, collected: 0, fee: 0, status: 'تم إرجاعها' } });
}

/** The order as the four live cases stand: delivered at the door, closed by «إقفال القديمة», the company's zero «returned» line. */
async function liveCase(over: { note?: string; settlementBefore?: string; row?: Row; statement?: Row } = {}) {
  const w = new World({ order: over.settlementBefore ? { settlementStatus: over.settlementBefore } : {} });
  await deliverAtTheDoor(w);
  await closeAsLegacy(w, over.note);
  zeroReturnedLine(w, over.row, over.statement);
  return w;
}

async function measureOf(w: World) {
  const facts = (await readTakeBackFacts(w.tx(), SCOPE, 'o1'))!;
  return { facts, measure: measureTakeBack(facts) };
}
async function press(w: World, over: { fingerprint?: string } = {}) {
  const { measure } = await measureOf(w);
  return w.transaction((tx) =>
    takeBackLegacyClose(tx, { scope: SCOPE, user: USER, orderId: 'o1', reason: REASON, fingerprint: over.fingerprint ?? (measure.fingerprint as string) })
  );
}
async function refusedUntouched(w: World, over: { fingerprint?: string } = {}): Promise<TakeBackStopped> {
  const before = w.snapshot();
  try {
    await press(w, over);
  } catch (e) {
    if (!(e instanceof TakeBackStopped)) throw e;
    expect(w.snapshot(), 'a refusal changed something').toEqual(before);
    return e;
  }
  throw new Error('the press was not refused');
}

/** The undo of the delivery, as its dialog does it: measure, then press with what it showed. */
async function undoTheDelivery(w: World) {
  const facts = (await readUndoFacts(w.tx(), SCOPE, 'o1'))!;
  const m = measureUndo(facts);
  return w.transaction((tx) => undoDelivery(tx, { scope: SCOPE, user: USER, orderId: 'o1', reason: REASON, fingerprint: m.fingerprint ?? 'none-was-offered' }));
}

/** The returns desk, the REAL door: everything expected back, sound. */
const receiveAtTheDesk = (w: World) =>
  receiveReturn({ user: { id: 'u2' }, companyId: 'c1', storeId: 's1', minorUnit: 2 }, { orderId: 'o1', receivedQty: 4, damagedQty: 0, chargeCourierFee: false });

beforeEach(() => {
  audits.length = 0;
});

/* ═════════════════════════ 1 · THE WHOLE ROAD ═════════════════════════ */

describe('the road the owner asked for — take-back → «تراجع عن التسليم» → the returns desk receives it', () => {
  it('BEFORE: the close holds both doors shut — the undo refuses it as money recorded, the desk as delivered and settled', async () => {
    const w = await liveCase();
    expect(w.state.order).toMatchObject({ shippingStatus: 'DELIVERED', settlementStatus: 'SETTLED' });
    await expect(undoTheDelivery(w)).rejects.toMatchObject({ body: { code: 'MONEY_RECORDED' } });
    expect(await receiveAtTheDesk(w)).toMatchObject({ ok: false, code: 'DELIVERED_AND_SETTLED' });
  });

  it('AFTER: the take-back, then the undo of the delivery, then the desk receives it — RETURNED, with nothing written to money', async () => {
    const w = await liveCase();
    const moneyBefore = { wallet: clone(w.state.wallet), movements: clone(w.state.movements), collected: w.state.order.collectedAmount };

    const done = await press(w);
    expect(done.plan.to).toBe('PENDING_COLLECTION');
    expect(w.state.order).toMatchObject({ shippingStatus: 'DELIVERED', settlementStatus: 'PENDING_COLLECTION' });

    await undoTheDelivery(w);
    expect(w.state.order).toMatchObject({ shippingStatus: 'SHIPPED', settlementStatus: 'PENDING_COLLECTION', deliveredAt: null });

    const received = await receiveAtTheDesk(w);
    expect(received.ok).toBe(true);
    expect(w.state.order).toMatchObject({ shippingStatus: 'RETURNED', settlementStatus: 'NOT_APPLICABLE' });
    expect(w.stock, 'the desk — not the take-back — put the goods back').toEqual(['RETURN']);

    expect({ wallet: w.state.wallet, movements: w.state.movements, collected: w.state.order.collectedAmount }).toEqual(moneyBefore);
    expect(w.forbidden).toEqual([]);
  });

  it('the same road when the statement that names the order is already CLOSED, its zero line parked «قيد المراجعة»', async () => {
    const w = await liveCase({ row: { resolution: 'UNDER_REVIEW' }, statement: { matchingClosedAt: new Date('2026-11-24T10:00:00Z'), status: 'APPROVED' } });
    await press(w);
    await undoTheDelivery(w);
    expect(w.state.order.shippingStatus).toBe('SHIPPED');
    expect((await receiveAtTheDesk(w)).ok).toBe(true);
    expect(w.state.order.shippingStatus).toBe('RETURNED');
    expect(w.forbidden).toEqual([]);
  });

  it('the owner’s press on ticked orders (its own sentence on the log) is taken back the same way', async () => {
    const w = await liveCase({ note: PICKED_CLOSE_NOTE });
    await press(w);
    await undoTheDelivery(w);
    expect(w.state.order.shippingStatus).toBe('SHIPPED');
  });

  it('back to EXACTLY the state the close took it from — every no-money state', async () => {
    for (const s of NO_MONEY_SETTLEMENT) {
      const w = await liveCase({ settlementBefore: s });
      expect((await press(w)).plan.to).toBe(s);
      expect(w.state.order.settlementStatus, s).toBe(s);
    }
  });
});

/* ═════════════════════════ 2 · WHAT IT WRITES ═════════════════════════ */

describe('what the press writes — and nothing else', () => {
  it('the settlement and the version, the mark RENAMED (not deleted), one settlement log line, one activity — no note, no counter, no money, no stock', async () => {
    const w = await liveCase();
    const before = w.snapshot();
    await press(w);
    const after = w.snapshot();

    expect(after.order).toEqual({ ...before.order, settlementStatus: 'PENDING_COLLECTION', version: before.order.version + 1 });
    // the mark: the same row, the same id and states — only its name
    const mark = before.activities.find((a) => a.action === LEGACY_CLOSE_ACTION)!;
    expect(after.activities.find((a) => a.id === mark.id)).toEqual({ ...mark, action: LEGACY_MARK_UNDONE });
    expect(after.activities.filter((a) => a.action === LEGACY_CLOSE_ACTION)).toEqual([]);
    const added = after.activities.slice(before.activities.length);
    expect(added).toHaveLength(1);
    expect(added[0]).toMatchObject({ action: LEGACY_TAKE_BACK_ACTION, previousStatus: 'SETTLED', newStatus: 'PENDING_COLLECTION', userId: 'u1' });
    expect(JSON.parse(added[0].metadata)).toMatchObject({ reason: REASON, marks: [mark.id], money: 'NONE' });
    const logs = after.logs.slice(before.logs.length);
    expect(logs).toEqual([expect.objectContaining({ statusType: 'SETTLEMENT', previousValue: 'SETTLED', newValue: 'PENDING_COLLECTION', note: `${TAKE_BACK_NOTE_PREFIX}: ${REASON}` })]);

    for (const k of ['items', 'customer', 'notes', 'attempts', 'commission', 'movements', 'wallet', 'lines', 'rows', 'receipt'] as const) {
      expect(after[k], k).toEqual(before[k]);
    }
    expect(w.forbidden).toEqual([]);
    expect(w.stock).toEqual([]);
  });

  it('PRESSING TWICE: the second press is refused in words and writes nothing', async () => {
    const w = await liveCase();
    const { measure } = await measureOf(w);
    await press(w, { fingerprint: measure.fingerprint! });
    // the same dialog pressed again with what it showed
    const e = await refusedUntouched(w, { fingerprint: measure.fingerprint! });
    expect(e.body).toEqual({ code: 'ALREADY_TAKEN_BACK', error: TAKE_BACK_WHY_AR.alreadyTakenBack('لم يُحصَّل') });
    // and a fresh measure says the same
    expect((await measureOf(w)).measure.refusal?.code).toBe('ALREADY_TAKEN_BACK');
  });

  it('two presses at once: the second finds the claim taken and rolls back — one take-back, one log line, one activity', async () => {
    const w = await liveCase();
    const { measure } = await measureOf(w);
    w.hooks.beforeClaim = () => {
      w.hooks.beforeClaim = undefined;
      w.concurrentChange((s) => {
        s.order.settlementStatus = 'PENDING_COLLECTION';
        s.order.version += 1;
      });
    };
    const before = w.snapshot();
    await expect(
      w.transaction((tx) => takeBackLegacyClose(tx, { scope: SCOPE, user: USER, orderId: 'o1', reason: REASON, fingerprint: measure.fingerprint! }))
    ).rejects.toMatchObject({ body: { code: 'ORDERS_CHANGED', error: TAKE_BACK_ORDERS_CHANGED_AR } });
    expect(w.state.activities).toEqual(before.activities);
    expect(w.state.logs).toEqual(before.logs);
  });
});

/* ═════════════════════════ 3 · WHAT IT REFUSES ═════════════════════════ */

describe('what it refuses — one reason, in words, and nothing written', () => {
  it('not SETTLED (an ordinary delivered order awaiting collection)', async () => {
    const w = new World();
    await deliverAtTheDoor(w);
    const e = await refusedUntouched(w, { fingerprint: 'x'.repeat(24) });
    expect(e.body).toEqual({ code: 'NOT_SETTLED', error: TAKE_BACK_WHY_AR.notSettled('لم يُحصَّل') });
  });

  it('SETTLED but not by the close (a statement or «استلمت منه» settled it — no mark)', async () => {
    const w = new World();
    await deliverAtTheDoor(w);
    w.state.order.settlementStatus = 'SETTLED';
    w.state.logs.push({ id: 'lx', companyId: 'c1', orderId: 'o1', statusType: 'SETTLEMENT', previousValue: 'PENDING_COLLECTION', newValue: 'SETTLED', note: 'كشف' });
    const e = await refusedUntouched(w, { fingerprint: 'x'.repeat(24) });
    expect(e.body).toEqual({ code: 'NOT_BY_LEGACY_CLOSE', error: TAKE_BACK_WHY_AR.notByLegacy });
  });

  it('SETTLED again by another door after an earlier take-back (the newest row is the take-back, not a live mark)', async () => {
    const w = await liveCase();
    await press(w);
    w.state.order.settlementStatus = 'SETTLED';
    const e = await refusedUntouched(w, { fingerprint: 'x'.repeat(24) });
    expect(e.body.code).toBe('NOT_BY_LEGACY_CLOSE');
  });

  it('the close’s log line is there but its mark was already renamed (the owner’s rollback script) — no live mark, nothing to take back', async () => {
    const w = await liveCase();
    w.state.activities.find((a) => a.action === LEGACY_CLOSE_ACTION)!.action = LEGACY_MARK_UNDONE;
    const e = await refusedUntouched(w, { fingerprint: 'x'.repeat(24) });
    expect(e.body).toEqual({ code: 'NOT_BY_LEGACY_CLOSE', error: TAKE_BACK_WHY_AR.notByLegacy });
    // and the measure offers nothing to press
    expect((await measureOf(w)).measure.fingerprint).toBeNull();
  });

  it('the mark is there but the settlement log’s newest line is another door’s', async () => {
    const w = await liveCase();
    w.state.logs.push({ id: 'lz', companyId: 'c1', orderId: 'o1', statusType: 'SETTLEMENT', previousValue: 'SETTLED', newValue: 'SETTLED', note: 'شي تاني' });
    const e = await refusedUntouched(w, { fingerprint: 'x'.repeat(24) });
    expect(e.body).toEqual({ code: 'NOT_BY_LEGACY_CLOSE', error: TAKE_BACK_WHY_AR.changedAfter });
  });

  it('the mark’s «before» is a state with money, or disagrees with the log', async () => {
    const w = await liveCase();
    w.state.activities.find((a) => a.action === LEGACY_CLOSE_ACTION)!.previousStatus = 'COLLECTED';
    expect((await refusedUntouched(w, { fingerprint: 'x'.repeat(24) })).body).toEqual({ code: 'NOT_BY_LEGACY_CLOSE', error: TAKE_BACK_WHY_AR.unknownBefore });
    const v = await liveCase();
    v.state.activities.find((a) => a.action === LEGACY_CLOSE_ACTION)!.previousStatus = 'PENDING';
    expect((await refusedUntouched(v, { fingerprint: 'x'.repeat(24) })).body.code).toBe('NOT_BY_LEGACY_CLOSE');
  });

  it.each([
    ['a collected amount', (w: World) => void (w.state.order.collectedAmount = 25), TAKE_BACK_WHY_AR.moneyAmount],
    ['a wallet movement of «استلمت منه» naming it', (w: World) => void w.state.wallet.push({ companyId: 'c1', referenceType: 'MANUAL_COLLECTION', referenceId: 'o1' }), TAKE_BACK_WHY_AR.wallet(1)],
    ['an order-level wallet line', (w: World) => void w.state.wallet.push({ companyId: 'c1', referenceType: 'ORDER', referenceId: 'o1' }), TAKE_BACK_WHY_AR.wallet(1)],
    ['«استلمت منه» on a handover where it was not the first order', (w: World) => void w.state.activities.push({ id: 'mc', companyId: 'c1', orderId: 'o1', action: 'MANUAL_COLLECTION', createdAt: new Date(0) }), TAKE_BACK_WHY_AR.manualCollection],
    ['a statement row the approval settled', (w: World) => void w.state.rows.push({ orderId: 'o1', result: 'MATCHED', resolution: null, appliedAt: new Date(), statement: ST({ reference: 'ST-2' }) }), TAKE_BACK_WHY_AR.statement('ST-2')],
    ['a row the approval settled, whatever its word', (w: World) => void w.state.rows.push({ orderId: 'o1', result: 'MISMATCHED', resolution: null, appliedAt: new Date(), statement: ST({ reference: 'ST-6' }) }), TAKE_BACK_WHY_AR.statement('ST-6')],
    ['a clean match', (w: World) => void w.state.rows.push({ orderId: 'o1', result: 'MATCHED', resolution: null, appliedAt: null, statement: ST({ reference: 'ST-3' }) }), TAKE_BACK_WHY_AR.statement('ST-3')],
    ['«اعتُمد رقم الشركة»', (w: World) => void w.state.rows.push({ orderId: 'o1', result: 'MISMATCHED', resolution: 'ACCEPTED_COURIER', appliedAt: null, statement: ST({ reference: 'ST-4' }) }), TAKE_BACK_WHY_AR.statement('ST-4')],
    ['«رقمنا هو المعتمد»', (w: World) => void w.state.rows.push({ orderId: 'o1', result: 'MISMATCHED', resolution: 'OURS_STANDS', appliedAt: null, statement: ST({ reference: 'ST-5' }) }), TAKE_BACK_WHY_AR.statement('ST-5')],
  ] as [string, (w: World) => void, string][])('ANY money trace: %s → MONEY_RECORDED', async (_n, add, text) => {
    const w = await liveCase();
    add(w);
    const e = await refusedUntouched(w, { fingerprint: 'x'.repeat(24) });
    expect(e.body).toEqual({ code: 'MONEY_RECORDED', error: text });
  });

  it('a commission payable, paid, or inside a payout → COMMISSION_MOVED', async () => {
    for (const over of [{ status: 'PAYABLE' }, { status: 'PAID' }, { status: 'ACCRUED', payoutId: 'po1' }]) {
      const w = await liveCase();
      w.state.commission.push({ id: 'ce1', companyId: 'c1', orderId: 'o1', userId: 'ag', amount: 2, currencyCode: 'USD', reversalOfId: null, payoutId: null, ...over });
      const e = await refusedUntouched(w, { fingerprint: 'x'.repeat(24) });
      expect(e.body).toEqual({ code: 'COMMISSION_MOVED', error: TAKE_BACK_WHY_AR.commissionMoved(1) });
    }
  });

  it('NOT refused because a statement NAMES it: a zero line unanswered, parked, or excluded carries no money', async () => {
    for (const row of [{}, { resolution: 'UNDER_REVIEW' }, { result: 'EXCLUDED' }, { result: 'MISSING_IN_STATEMENT' }]) {
      const w = await liveCase({ row });
      expect((await measureOf(w)).measure.allowed, JSON.stringify(row)).toBe(true);
    }
    expect(rowCarriesMoney({ result: 'MISMATCHED', resolution: 'UNDER_REVIEW', appliedAt: null })).toBe(false);
  });

  it('the order changed since the measure (an edit bumped its version): CHANGED, nothing written', async () => {
    const w = await liveCase();
    const { measure } = await measureOf(w);
    w.state.order.version += 1;
    const e = await refusedUntouched(w, { fingerprint: measure.fingerprint! });
    expect(e.body).toEqual({ code: 'CHANGED', error: TAKE_BACK_CHANGED_AR });
  });

  it('money that lands while the press waits for the row is seen AFTER the claim: LATE_MONEY, the claim rolled back', async () => {
    const w = await liveCase();
    const before = w.snapshot();
    w.hooks.afterClaim = () => {
      w.hooks.afterClaim = undefined;
      w.concurrentChange((s) => void s.wallet.push({ companyId: 'c1', referenceType: 'MANUAL_COLLECTION', referenceId: 'o1' }));
    };
    await expect(press(w)).rejects.toMatchObject({ body: { code: 'LATE_MONEY', error: TAKE_BACK_LATE_MONEY_AR } });
    expect(w.state.order).toEqual(before.order);
    expect(w.state.activities).toEqual(before.activities);
  });

  it('an order of another store is not found', async () => {
    const w = await liveCase();
    expect(await readTakeBackFacts(w.tx(), { companyId: 'c1', storeId: 's2' }, 'o1')).toBeNull();
    await expect(
      w.transaction((tx) => takeBackLegacyClose(tx, { scope: { companyId: 'c1', storeId: 's2' }, user: USER, orderId: 'o1', reason: REASON, fingerprint: 'x'.repeat(24) }))
    ).rejects.toMatchObject({ status: 404, body: { code: 'NOT_FOUND' } });
  });

  it('the claim holds the order to SETTLED, this version, no collected amount, this store', () => {
    expect(claimWhere(SCOPE, { id: 'o1', version: 9 })).toEqual({ id: 'o1', companyId: 'c1', storeId: 's1', version: 9, settlementStatus: 'SETTLED', collectedAmount: null });
  });
});

/* ═════════════════════════ 4 · THE COMMISSION ═════════════════════════ */

describe('the commission — the mark stops counting, so a later real settlement pays it once', () => {
  const accrued = { id: 'ce1', companyId: 'c1', orderId: 'o1', userId: 'ag', amount: 2.1, currencyCode: 'USD', status: 'ACCRUED', payoutId: null, reversalOfId: null };

  it('CONTROL: while the close stands, a SETTLED order with the mark is not promotable by the payout', async () => {
    const w = await liveCase();
    w.state.commission.push(clone(accrued));
    expect(await promoteSettledToPayable(w.tx(), { companyId: 'c1', userId: 'ag', entryIds: ['ce1'] })).toBe(0);
    expect(PROMOTABLE_BY_PAYOUT.order).toEqual({ settlementStatus: 'SETTLED', activities: { none: { action: LEGACY_CLOSE_ACTION } } });
  });

  it('after the take-back the close leaves the entry exactly as it was (ACCRUED)', async () => {
    const w = await liveCase();
    w.state.commission.push(clone(accrued));
    await press(w);
    expect(w.state.commission).toEqual([accrued]);
  });

  it('a later statement settles it: the commission becomes payable EXACTLY ONCE — the approval’s moment or the payout’s state, never both', async () => {
    for (const road of ['approval', 'payout'] as const) {
      const w = await liveCase();
      w.state.commission.push(clone(accrued));
      await press(w);
      // the statement settles the order with real money (the approval writes SETTLED)
      w.state.order.settlementStatus = 'SETTLED';
      const first =
        road === 'approval'
          ? await markPayableForOrders(w.tx(), 'c1', ['o1'])
          : await promoteSettledToPayable(w.tx(), { companyId: 'c1', userId: 'ag', entryIds: ['ce1'] });
      expect(first, road).toBe(1);
      expect(await promoteSettledToPayable(w.tx(), { companyId: 'c1', userId: 'ag', entryIds: ['ce1'] }), road).toBe(0);
      expect(await markPayableForOrders(w.tx(), 'c1', ['o1']), road).toBe(0);
      expect(w.state.commission.filter((e) => e.status === 'PAYABLE'), road).toHaveLength(1);
    }
  });

  it('the owner’s rollback script reads the same two spellings: the old mark it puts back, the renamed one it leaves', () => {
    const sql = readFileSync(join(process.cwd(), 'scripts', 'backfills', '20261112-legacy-closeout.rollback.sql'), 'utf8');
    expect(sql).toContain(`a."action" = '${LEGACY_CLOSE_ACTION}'`);
    expect(sql).toContain(`SET "action" = '${LEGACY_MARK_UNDONE}'`);
  });
});

/* ═════════════════════════ 5 · THE MEASURE AND THE WORDS ═════════════════════════ */

describe('the measure — what the dialog draws', () => {
  it('every line it writes, every line it leaves, a fingerprint — and only the facts it reads', async () => {
    const w = await liveCase();
    const { measure } = await measureOf(w);
    expect(measure).toMatchObject({ orderNumber: 'ORD-2026-0001', courier: 'الباشا', allowed: true, refusal: null, from: 'SETTLED', to: 'PENDING_COLLECTION' });
    expect(measure.fingerprint).toMatch(/^[0-9a-f]{24}$/);
    expect(measure.lines.map((l) => l.key)).toEqual(['SETTLEMENT', 'MARK', 'NEXT']);
    expect(measure.lines[0].text).toBe(TAKE_BACK_LINE_AR.settlement('مسوّى', 'لم يُحصَّل'));
    expect(measure.stays.map((l) => l.key)).toEqual(['SHIPPING', 'MONEY', 'STOCK', 'COMMISSION', 'HISTORY']);
    expect(measure.stays[0].text).toBe(TAKE_BACK_STAYS_AR.shipping('مسلَّم'));
  });

  it('a refusal has no fingerprint and no lines', async () => {
    const w = new World();
    await deliverAtTheDoor(w);
    const { measure } = await measureOf(w);
    expect(measure).toMatchObject({ allowed: false, fingerprint: null, to: null, lines: [], stays: [] });
  });

  it('the judgement is pure — the same facts, the same answer', async () => {
    const w = await liveCase();
    const { facts } = await measureOf(w);
    expect(judgeTakeBack(clone(facts))).toEqual(judgeTakeBack(facts));
    expect(CLOSE_NOTES).toEqual([LEGACY_CLOSE_NOTE, PICKED_CLOSE_NOTE]);
  });

  it('every sentence is Arabic', () => {
    const latin = /[A-Za-z]{3,}/;
    const all = [
      TAKE_BACK_ACK_AR, TAKE_BACK_FORBIDDEN_AR, TAKE_BACK_CHANGED_AR, TAKE_BACK_ORDERS_CHANGED_AR, TAKE_BACK_LATE_MONEY_AR, TAKE_BACK_NOTE_PREFIX,
      TAKE_BACK_LINE_AR.mark, TAKE_BACK_LINE_AR.next, TAKE_BACK_LINE_AR.settlement('أ', 'ب'), TAKE_BACK_SUCCESS_AR('ORD-1', 'أ'),
      ...Object.values(TAKE_BACK_STAYS_AR).map((f) => (typeof f === 'function' ? f('أ') : f)),
      ...Object.values(TAKE_BACK_WHY_AR).map((f) => (typeof f === 'function' ? (f as (x: never) => string)(1 as never) : f)),
    ];
    for (const s of all) expect(s.replace('ORD-1', ''), s).not.toMatch(latin);
  });
});

describe('the sources — no money writer, no stock writer, no counter', () => {
  const src = stripComments(readFileSync(join(process.cwd(), 'src', 'lib', 'legacy-take-back.ts'), 'utf8'));
  it('NEGATIVE: it never writes a wallet, a movement, a commission, the stock, a customer, a receipt or a note', () => {
    for (const w of ['walletMovement.create', 'recordMovement', 'commissionEntry.update', 'commissionEntry.create', 'reverseForOrder', 'markPayableForOrders', 'inventoryMovement', 'consumeOrderStock', 'restoreOrderStock', 'customer.update', 'returnReceipt', 'orderNote.create']) {
      expect(src, w).not.toContain(w);
    }
  });
  it('NEGATIVE: the mark is renamed, never deleted', () => {
    expect(src).not.toMatch(/orderActivity\.delete/);
    // the collected amount is only READ (a select) and asked to be still none (the claim) — never written
    expect(src).not.toMatch(/collectedAmount:(?!\s*(?:null|true)\b)/);
    expect(src).toContain('data: { action: LEGACY_MARK_UNDONE }');
  });
});

describe('«تراجع عن التسليم» (25/11) — a zero «returned» line whose row is only PARKED does not hold it either', () => {
  const ROW = { result: 'MISMATCHED', resolution: 'UNDER_REVIEW', appliedAt: null, matchedBy: 'BARCODE' };
  it('the spelling is the matching screen’s own «قيد المراجعة»', () => {
    expect(PARKED_ROW).toBe(PARKED);
  });
  it('parked, on a difference or an exclusion → carries no money', () => {
    expect(rowParkedNoMoney(ROW)).toBe(true);
    expect(rowParkedNoMoney({ ...ROW, result: 'EXCLUDED' })).toBe(true);
    expect(rowParkedNoMoney({ ...ROW, matchedBy: null })).toBe(true);
  });
  it.each([
    ['answered with the courier’s figure', { resolution: 'ACCEPTED_COURIER' }],
    ['answered with ours', { resolution: 'OURS_STANDS' }],
    ['not answered at all (the other rule’s)', { resolution: null }],
    ['settled by the approval', { appliedAt: '2026-11-20T10:00:00.000Z' }],
    ['tied by a person', { matchedBy: 'MANUAL' }],
    ['a clean match', { result: 'MATCHED' }],
    ['a read that did not ask for the stamp', { appliedAt: undefined }],
    ['a read that did not ask who made it', { matchedBy: undefined }],
  ] as [string, Record<string, unknown>][])('NEGATIVE — %s → not «parked»', (_n, over) => {
    expect(rowParkedNoMoney({ ...ROW, ...over } as never)).toBe(false);
  });
  it('NEGATIVE — a parked row on a line WITH money still speaks (the line rule comes first)', () => {
    const line = { amount: 25, collected: 30, fee: 5, word: { outcome: 'RETURNED', known: true } };
    expect(zeroReturnCarriesNoMoney(line, [ROW])).toBe(false);
  });
});

describe('the undo of the delivery after a take-back — undo refused while the close stands, as on main', () => {
  it('UndoStopped is what it throws', async () => {
    const w = await liveCase();
    await expect(undoTheDelivery(w)).rejects.toBeInstanceOf(UndoStopped);
  });
});
