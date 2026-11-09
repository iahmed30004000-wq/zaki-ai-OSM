/* eslint-disable @typescript-eslint/no-explicit-any */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * «استلم» FOR A PAGE OF PARCELS — THE DOOR, AGAINST A DATABASE THAT HOLDS THE PARCELS.
 *
 * Ten parcels the delivery company calls «تم التوصيل» are recorded with one request; a parcel whose newest word is anything
 * else, or that has none, or whose word was taken back, is refused BY THE SERVER with a reason while the others go on. What is
 * held here, end to end through the real route, the real `recordPartialDelivery`, the real `consumeOrderStock` and the real
 * `drawDownStock` — only the database is a fake:
 *
 *   • the words are the lines the real feed writes (`wordLine` is held to the real adapter + gate by its own test; a few
 *     parcels here take their word through the real gate itself), with a free note beside the code that says the OPPOSITE;
 *   • the fake REJECTS what it was not taught: a column it does not hold, a `where` key it does not know, a model it has
 *     never heard of (there is no wallet in it — an attempt to write money has nowhere to land);
 *   • its transactions really roll back and its row locks really make the second press wait, so «a parcel that fails halfway
 *     does not take the others down» and «two presses on one parcel have one winner» are claims about behaviour, not about
 *     calls.
 */

const h = vi.hoisted(() => ({
  db: {} as Record<string | symbol, unknown>,
  held: new Set<string>(),
  audit: vi.fn<(...a: unknown[]) => Promise<undefined>>(async () => undefined),
}));
vi.mock('@/lib/db', () => ({ db: new Proxy({}, { get: (_t, k) => h.db[k] }) }));
vi.mock('@/lib/geo-context', () => ({
  requireContext: async () => ({
    user: { id: 'u1', name: 'عاملة المتابعة', role: 'MODERATOR', status: 'ACTIVE' },
    companyId: 'c1',
    storeId: 's1',
    country: { minorUnit: 2, currencyCode: 'JOD' },
  }),
}));
vi.mock('@/lib/authorization', () => ({
  can: (_u: unknown, k: string) => h.held.has(k),
  requirePermission: async (k: string) => {
    if (!h.held.has(k)) throw new Error(`Forbidden: missing required permission ${k}`);
    return {};
  },
}));
vi.mock('@/lib/audit', () => ({ logAudit: (...a: unknown[]) => h.audit(...a) }));

import { POST as many } from './route';
import { POST as single } from '../deliver/route';
import { applyCourierEvent } from '@/lib/couriers/apply-event';
import { COURIER_SAID } from '@/lib/couriers/courier-said';
import { theCompanySends, wordLine } from '@/lib/couriers/courier-said-lines.fixture';
import { BULK_DELIVER_MOST, BULK_DELIVER_NOTE_AR } from '@/lib/parcel-tracking/bulk-deliver';
import { REFUSAL_AR, otherWordReason } from '@/lib/parcel-tracking/deliver-many';

/* ───────────────────────── the database ───────────────────────── */

const MIN = 60_000;
const START = Date.parse('2026-11-09T09:00:00.000Z');
const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const lazy = () => new Promise<void>((r) => setTimeout(r, 15));

/** A column the fake does not hold, read: the fake says so instead of answering `undefined`. */
function project(row: any, select: any): any {
  const out: any = {};
  for (const [k, v] of Object.entries(select)) {
    if (!(k in row)) throw new Error(`the fake database holds no column «${k}»`);
    if (v === true) out[k] = row[k] instanceof Date ? new Date(row[k]) : row[k];
    else if (v && typeof v === 'object' && 'select' in (v as any)) {
      const inner = row[k];
      out[k] = Array.isArray(inner) ? inner.map((x) => project(x, (v as any).select)) : inner === null ? null : project(inner, (v as any).select);
    } else throw new Error(`the fake database was not taught the select «${k}»`);
  }
  return out;
}

function makeWorld() {
  const S = {
    orders: [] as any[],
    activities: [] as any[],
    notes: [] as any[],
    attempts: [] as any[],
    customers: {} as Record<string, any>,
    movements: [] as any[],
    batches: [] as any[],
    requests: [] as any[],
  };
  const log = { orderWrites: [] as any[], customerWrites: [] as any[], transactions: 0, rolledBack: 0, orderReads: [] as any[], wordReads: [] as any[], rawLocks: [] as string[] };
  const flags = {
    slow: false,
    breakOn: null as null | ((model: string, op: string, args: any) => boolean),
    /** Changes an answer on its way out: the order as it is read for the `n`-th time. */
    tamper: null as null | ((out: any, args: any, n: number) => void),
  };
  let reads = 0;
  const locks = new Map<string, Promise<void>>();
  let clock = START;
  // One counter per kind of row: a note written must not move the number the next activity gets.
  const counters: Record<string, number> = {};
  const nid = (kind: string) => `${kind}-${(counters[kind] = (counters[kind] ?? 0) + 1)}`;

  const tick = () => (clock += MIN);
  const guard = (model: string, op: string, args: any) => {
    if (flags.breakOn?.(model, op, args)) throw new Error(`the fake database broke on ${model}.${op}`);
  };
  const only = (where: any, keys: string[], what: string) => {
    for (const k of Object.keys(where ?? {})) if (!keys.includes(k)) throw new Error(`the fake database was not taught «${k}» in ${what}`);
  };
  const apply = (row: any, data: any) => {
    for (const [k, v] of Object.entries(data)) {
      if (v && typeof v === 'object' && !(v instanceof Date) && 'increment' in (v as any)) row[k] = (row[k] ?? 0) + (v as any).increment;
      else row[k] = v;
    }
  };
  const newest = (rows: any[], orderBy: any) => {
    const keys: Record<string, 'asc' | 'desc'>[] = [].concat(orderBy ?? []);
    const cell = (r: any, f: string) => (r[f] instanceof Date ? r[f].getTime() : r[f]);
    return [...rows].sort((a, b) => {
      for (const k of keys) {
        const [f, dir] = Object.entries(k)[0];
        const x = cell(a, f);
        const y = cell(b, f);
        if (x !== y) return (x < y ? -1 : 1) * (dir === 'desc' ? -1 : 1);
      }
      return 0;
    });
  };

  const models = (release: (() => void)[]) => ({
    $queryRaw: async (strings: TemplateStringsArray, ...values: unknown[]) => {
      const sql = strings.join('?').replace(/\s+/g, ' ').trim();
      if (sql !== 'SELECT "id" FROM "orders" WHERE "id" = ? FOR UPDATE') throw new Error(`the fake database was not taught this SQL: ${sql}`);
      const id = String(values[0]);
      log.rawLocks.push(id);
      const before = locks.get(id) ?? Promise.resolve();
      let free!: () => void;
      locks.set(id, before.then(() => new Promise<void>((r) => (free = r))));
      await before;
      release.push(() => free());
      return [{ id }];
    },
    order: {
      findFirst: async (args: any) => {
        guard('order', 'findFirst', args);
        only(args.where, ['id', 'companyId', 'storeId'], 'order.findFirst');
        log.orderReads.push({ where: args.where, select: Object.keys(args.select) });
        const row = S.orders.find((o) => Object.entries(args.where).every(([k, v]) => o[k] === v));
        // The answer is as old as the moment it was asked for: a slow read hands back what was true THEN.
        const out = row ? project(row, args.select) : null;
        if (out) flags.tamper?.(out, args, ++reads);
        if (flags.slow) await lazy();
        return out;
      },
      update: async (args: any) => {
        guard('order', 'update', args);
        const row = S.orders.find((o) => o.id === args.where.id);
        if (!row) throw new Error('order.update: no such row');
        apply(row, args.data);
        log.orderWrites.push({ id: row.id, data: args.data });
        return row;
      },
    },
    orderItem: {
      findMany: async (args: any) => {
        only(args.where, ['orderId', 'order'], 'orderItem.findMany');
        const order = S.orders.find((o) => o.id === args.where.orderId && Object.entries(args.where.order).every(([k, v]) => o[k] === v));
        return (order?.items ?? []).map((i: any) => project(i, args.select));
      },
      update: async (args: any) => {
        guard('orderItem', 'update', args);
        const item = S.orders.flatMap((o) => o.items).find((i: any) => i.id === args.where.id);
        if (!item) throw new Error('orderItem.update: no such row');
        apply(item, args.data);
        return item;
      },
      updateMany: async (args: any) => {
        const order = S.orders.find((o) => o.id === args.where.orderId);
        const items = (order?.items ?? []).filter((i: any) => i.reservedQty > 0);
        for (const i of items) apply(i, args.data);
        return { count: items.length };
      },
    },
    orderAddOn: { updateMany: async () => ({ count: 0 }) },
    orderActivity: {
      findFirst: async (args: any) => {
        guard('orderActivity', 'findFirst', args);
        only(args.where, ['orderId', 'companyId', 'action'], 'orderActivity.findFirst');
        if (args.where.action === COURIER_SAID && args.where.companyId) log.wordReads.push(args.where);
        const rows = S.activities.filter((a) => Object.entries(args.where).every(([k, v]) => a[k] === v));
        const row = newest(rows, args.orderBy)[0];
        return row ? (args.select ? project(row, args.select) : row) : null;
      },
      create: async (args: any) => {
        guard('orderActivity', 'create', args);
        const row = { id: nid("act"), createdAt: new Date(tick()), ...args.data };
        S.activities.push(row);
        return row;
      },
    },
    orderNote: {
      create: async (args: any) => {
        guard('orderNote', 'create', args);
        S.notes.push({ id: nid("note"), ...args.data });
        return {};
      },
    },
    customer: {
      update: async (args: any) => {
        guard('customer', 'update', args);
        const row = S.customers[args.where.id];
        if (!row) throw new Error('customer.update: no such row');
        apply(row, args.data);
        log.customerWrites.push({ id: args.where.id, data: args.data });
        return row;
      },
    },
    deliveryAttempt: {
      findFirst: async (args: any) => {
        const mine = S.attempts.filter((a) => a.orderId === args.where.orderId);
        const top = newest(mine, args.orderBy)[0];
        return top ? { attemptNumber: top.attemptNumber } : null;
      },
      create: async (args: any) => {
        guard('deliveryAttempt', 'create', args);
        S.attempts.push({ id: nid("att"), ...args.data });
        return {};
      },
    },
    inventoryMovement: {
      findFirst: async (args: any) => S.movements.find((m) => m.referenceId === args.where.referenceId && m.type === args.where.type) ?? null,
      create: async (args: any) => {
        guard('inventoryMovement', 'create', args);
        S.movements.push({ id: nid("mov"), ...args.data });
        return {};
      },
    },
    productFixedCost: { findMany: async () => [] },
    productionBatch: {
      findMany: async (args: any) =>
        S.batches
          .filter((b) => b.companyId === args.where.companyId && b.productId === args.where.productId && b.quantityRemaining > 0 && (!args.where.storeId || b.storeId === args.where.storeId))
          .map((b) => ({ id: b.id, quantityRemaining: b.quantityRemaining, quantitySold: b.quantitySold, costPerUnit: b.costPerUnit })),
      update: async (args: any) => {
        guard('productionBatch', 'update', args);
        return Object.assign(S.batches.find((b) => b.id === args.where.id), args.data);
      },
      aggregate: async (args: any) => ({
        _sum: { quantityRemaining: S.batches.filter((b) => b.companyId === args.where.companyId && b.productId === args.where.productId).reduce((s, b) => s + b.quantityRemaining, 0) },
      }),
    },
    orderChangeRequest: {
      findFirst: async (args: any) => {
        only(args.where, ['orderId', 'status', 'blocking'], 'orderChangeRequest.findFirst');
        const row = S.requests.find((r) => Object.entries(args.where).every(([k, v]) => r[k] === v));
        return row ? project(row, args.select) : null;
      },
    },
  });

  const db = {
    ...models([]),
    $transaction: async (fn: (tx: any) => Promise<unknown>) => {
      log.transactions++;
      const snapshot = structuredClone(S);
      const release: (() => void)[] = [];
      try {
        return await fn(models(release));
      } catch (e) {
        log.rolledBack++;
        for (const k of Object.keys(S) as (keyof typeof S)[]) (S as any)[k] = snapshot[k];
        throw e;
      } finally {
        for (const r of release) r();
      }
    },
  };

  S.batches.push({ id: 'b1', companyId: 'c1', storeId: 's1', productId: 'p1', quantityRemaining: 1000, quantitySold: 0, costPerUnit: 5, productionDate: new Date(START - 30 * 86_400_000), createdAt: new Date(START - 30 * 86_400_000) });

  const world = {
    S, log, flags, db,
    /** One parcel on the road, one line of two units. */
    add(id: string, over: Record<string, any> = {}) {
      S.orders.push({
        id, companyId: 'c1', storeId: 's1', orderNumber: `ORD-${id.slice(-3)}`, shippingStatus: 'SHIPPED',
        deliveredAt: null, returnedAt: null, customerId: `cu-${id}`, deliveryProviderId: 'dp1',
        deliveryFee: 3, priceIncludesDelivery: false, settlementStatus: 'NOT_APPLICABLE', source: 'Manual', version: 1,
        items: [{ id: `${id}-i1`, productId: 'p1', productName: 'كريم', quantity: 2, freeQuantity: 0, unitPrice: 10, discountShare: 0, lineTotal: 20, deliveredQty: null, returnedQty: null, reservedQty: 2 }],
        addOns: [], returnReceipt: null, store: { country: { minorUnit: 2 } },
        ...over,
      });
      S.customers[over.customerId ?? `cu-${id}`] = { deliveredOrders: 0, cancelledOrders: 0, totalPurchaseValue: 0 };
      return id;
    },
    /** The company's word, as the real feed writes it. */
    say(orderId: string, code: string, over: { notes?: string; minutesAgo?: number; id?: string } = {}) {
      const line = wordLine({ orderId, code, at: new Date(START - (over.minutesAgo ?? 30) * MIN), notes: over.notes, id: over.id });
      S.activities.push({ ...line, companyId: 'c1', action: COURIER_SAID, userId: null, previousStatus: null });
    },
    /** A line exactly as written, damaged or not. */
    sayRaw(orderId: string, line: { newStatus: string | null; metadata: string | null; minutesAgo?: number; id?: string }) {
      S.activities.push({ id: line.id ?? nid("raw"), orderId, companyId: 'c1', action: COURIER_SAID, userId: null, previousStatus: null, newStatus: line.newStatus, metadata: line.metadata, createdAt: new Date(START - (line.minutesAgo ?? 30) * MIN) });
    },
    /** The word through the REAL gate: the real adapter makes the event, `applyCourierEvent` decides and writes the line. */
    async theCompanySays(orderId: string, code: string, notes = '') {
      const event = await theCompanySends(code, notes);
      const order = S.orders.find((o) => o.id === orderId);
      return applyCourierEvent({ order: { id: orderId, companyId: 'c1', shippingStatus: order.shippingStatus }, event, courierName: 'الباشا', source: 'POLL' });
    },
    snapshot: () => JSON.stringify(S),
    order: (id: string) => S.orders.find((o) => o.id === id),
    stock: () => S.batches[0].quantityRemaining as number,
    sales: () => S.movements.filter((m) => m.type === 'SALE'),
  };
  return world;
}

type World = ReturnType<typeof makeWorld>;
let w: World;

const press = async (orderIds: unknown, body?: unknown) => {
  const res = await many(
    new Request('http://x/api/ops/tracking/deliver-many', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: body === undefined ? JSON.stringify({ orderIds }) : String(body),
    })
  );
  return { status: res.status, body: (await res.json().catch(() => ({}))) as any };
};
const result = (r: { body: any }, id: string) => r.body.results.find((x: any) => x.orderId === id);

const A = uuid(1);
const B = uuid(2);
const C = uuid(3);

beforeEach(() => {
  vi.clearAllMocks();
  w = makeWorld();
  h.db = w.db as any;
  // Every test starts from the one key the door asks.
  h.held = new Set(['ops.deliver']);
});
afterEach(() => vi.restoreAllMocks());

/* ───────────────────────── the gate ───────────────────────── */

describe('the gate: the same box as the single «استلم» — nobody gains one', () => {
  it('NEGATIVE: the tracking key alone is a 403, and nothing is read, written or logged', async () => {
    h.held.clear();
    h.held.add('ops.track');
    w.add(A);
    w.say(A, 'DELIVERED_TO_RECIPIENT');
    const before = w.snapshot();
    const res = await press([A]);
    expect(res.status).toBe(403);
    expect(w.snapshot()).toBe(before);
    expect(w.log.transactions).toBe(0);
    expect(h.audit).not.toHaveBeenCalled();
  });

  it('NEGATIVE: the transfer, write-off and collect boxes do not open it', async () => {
    h.held.clear();
    for (const k of ['ops.transfer', 'ops.write_off', 'finance.cashbox', 'orders.change_status']) h.held.add(k);
    expect((await press([A])).status).toBe(403);
  });

  it('the box alone gets through', async () => {
    w.add(A);
    w.say(A, 'DELIVERED_TO_RECIPIENT');
    expect((await press([A])).status).toBe(200);
  });
});

/* ───────────────────────── the request ───────────────────────── */

describe('the request', () => {
  it.each([
    ['a body that is not json', 'not json'],
    ['an empty object', '{}'],
    ['an empty list', JSON.stringify({ orderIds: [] })],
    ['a word instead of an id', JSON.stringify({ orderIds: ['abc'] })],
    ['a number instead of an id', JSON.stringify({ orderIds: [7] })],
    ['a list that is not a list', JSON.stringify({ orderIds: A })],
  ])('NEGATIVE — %s: 400, and nothing is touched', async (_name, raw) => {
    w.add(A);
    const before = w.snapshot();
    const res = await press(undefined, raw);
    expect(res.status).toBe(400);
    expect(typeof res.body.error).toBe('string');
    expect(w.snapshot()).toBe(before);
    expect(w.log.transactions).toBe(0);
  });

  it(`NEGATIVE: more than ${BULK_DELIVER_MOST} ids is refused whole — not cut, not done in part`, async () => {
    const ids = Array.from({ length: BULK_DELIVER_MOST + 1 }, (_, i) => w.add(uuid(100 + i)));
    for (const id of ids) w.say(id, 'DELIVERED_TO_RECIPIENT');
    const before = w.snapshot();
    const res = await press(ids);
    expect(res.status).toBe(400);
    expect(w.snapshot()).toBe(before);
    expect(w.log.transactions).toBe(0);
    expect(h.audit).not.toHaveBeenCalled();
  });

  it(`exactly ${BULK_DELIVER_MOST} ids is answered — fifty small doors, each its own transaction`, async () => {
    const ids = Array.from({ length: BULK_DELIVER_MOST }, (_, i) => w.add(uuid(200 + i)));
    for (const id of ids) w.say(id, 'DELIVERED_TO_RECIPIENT');
    const res = await press(ids);
    expect(res.status).toBe(200);
    expect(res.body.delivered).toBe(BULK_DELIVER_MOST);
    expect(res.body.refused).toBe(0);
    expect(w.log.transactions).toBe(BULK_DELIVER_MOST);
    expect(w.sales()).toHaveLength(BULK_DELIVER_MOST);
  });

  it('a repeated id is judged once, in the order it was first asked', async () => {
    w.add(A);
    w.add(B);
    w.say(A, 'DELIVERED_TO_RECIPIENT');
    w.say(B, 'DELIVERED_TO_RECIPIENT');
    const res = await press([B, A, B, A, A]);
    expect(res.body.results.map((r: any) => r.orderId)).toEqual([B, A]);
    expect(res.body.delivered).toBe(2);
    expect(w.log.transactions).toBe(2);
    expect(w.S.customers[`cu-${A}`].deliveredOrders).toBe(1);
  });

  it('the answer is one line per parcel — id, number, ok — and the two totals', async () => {
    w.add(A);
    w.add(B);
    w.say(A, 'DELIVERED_TO_RECIPIENT');
    const res = await press([A, B]);
    expect(res.body).toEqual({
      results: [
        { orderId: A, orderNumber: 'ORD-001', ok: true },
        { orderId: B, orderNumber: 'ORD-002', ok: false, reason: REFUSAL_AR.NO_WORD },
      ],
      delivered: 1,
      refused: 1,
    });
  });
});

/* ───────────────────────── whose parcels ───────────────────────── */

describe('whose parcels: this company and this store, exactly as the single door', () => {
  it('NEGATIVE: an id of another store of the company is not found — no number given away, nothing written', async () => {
    w.add(A, { storeId: 's2' });
    w.say(A, 'DELIVERED_TO_RECIPIENT');
    const before = w.snapshot();
    const res = await press([A]);
    expect(res.status).toBe(200);
    expect(res.body.results[0]).toEqual({ orderId: A, orderNumber: null, ok: false, reason: REFUSAL_AR.NOT_FOUND });
    expect(w.snapshot()).toBe(before);
    expect(w.sales()).toHaveLength(0);
  });

  it('NEGATIVE: an id of another company is not found either', async () => {
    w.add(A, { companyId: 'c2' });
    w.say(A, 'DELIVERED_TO_RECIPIENT');
    const res = await press([A]);
    expect(res.body.results[0]).toMatchObject({ orderNumber: null, ok: false, reason: REFUSAL_AR.NOT_FOUND });
    expect(w.order(A).shippingStatus).toBe('SHIPPED');
  });

  it('NEGATIVE: an id nobody has is not found', async () => {
    expect(result(await press([A]), A)).toMatchObject({ ok: false, reason: REFUSAL_AR.NOT_FOUND });
  });

  it('every read that decides the parcel carries the company AND the store — this door’s own, and the shared function’s', async () => {
    w.add(A);
    w.say(A, 'DELIVERED_TO_RECIPIENT');
    await press([A]);
    // The two reads that look at the dates are this door’s and `recordPartialDelivery`’s; the stock consumer’s later read of the
    // same order (by company, as it always was) is the parcel this door has already found in this store.
    const deciding = w.log.orderReads.filter((r) => r.select.includes('deliveredAt'));
    expect(deciding.length).toBe(2);
    for (const r of deciding) expect(r.where).toMatchObject({ id: A, companyId: 'c1', storeId: 's1' });
  });

  it('the company’s word is asked for with the COMPANY in the question — the table’s index leads with it', async () => {
    w.add(A);
    w.say(A, 'DELIVERED_TO_RECIPIENT');
    await press([A]);
    expect(w.log.wordReads).toEqual([{ orderId: A, companyId: 'c1', action: COURIER_SAID }]);
  });

  it('this store’s parcels are recorded while the foreign id beside them is refused', async () => {
    w.add(A);
    w.add(B, { storeId: 's2' });
    w.say(A, 'DELIVERED_TO_RECIPIENT');
    w.say(B, 'DELIVERED_TO_RECIPIENT');
    const res = await press([B, A]);
    expect(res.body.delivered).toBe(1);
    expect(w.order(A).shippingStatus).toBe('DELIVERED');
    expect(w.order(B).shippingStatus).toBe('SHIPPED');
  });
});

/* ───────────────────────── the company's word ───────────────────────── */

describe('the qualification — the NEWEST word, read by its CODE, on a parcel that has the «استلم» box', () => {
  it.each(['SHIPPED', 'OUT_FOR_DELIVERY'])('a parcel %s whose company says «تم التوصيل» is recorded: delivered, off the shelf, counted for the customer', async (status) => {
    w.add(A, { shippingStatus: status });
    w.say(A, 'DELIVERED_TO_RECIPIENT');
    const res = await press([A]);
    expect(result(res, A)).toEqual({ orderId: A, orderNumber: 'ORD-001', ok: true });
    const order = w.order(A);
    expect(order.shippingStatus).toBe('DELIVERED');
    expect(order.deliveredAt).toBeInstanceOf(Date);
    expect(order.returnedAt).toBeNull();
    expect(order.items[0]).toMatchObject({ deliveredQty: 2, returnedQty: 0 });
    expect(w.stock()).toBe(998);
    expect(w.S.customers[`cu-${A}`].deliveredOrders).toBe(1);
    expect(w.S.attempts).toHaveLength(1);
    expect(w.S.attempts[0]).toMatchObject({ orderId: A, result: 'DELIVERED' });
  });

  it('a free note that says the OPPOSITE beside the delivered code changes nothing: the code decides', async () => {
    w.add(A);
    w.say(A, 'DELIVERED_TO_RECIPIENT', { notes: 'العميل طلب يأجّلها ليوم الخميس' });
    expect(result(await press([A]), A).ok).toBe(true);
  });

  it('NEGATIVE: and the reverse — a postponed code with the note «تم التوصيل» is NOT delivered', async () => {
    w.add(A);
    w.say(A, 'POSTPONED_DELIVERY', { notes: 'تم التوصيل' });
    const before = w.snapshot();
    const res = await press([A]);
    expect(result(res, A)).toMatchObject({ ok: false, reason: otherWordReason('مؤجلة') });
    expect(w.snapshot()).toBe(before);
  });

  it.each([
    ['PARTIALLY_DELIVERED', 'تم توصيلها بشكل جزئي'],
    ['POSTPONED_DELIVERY', 'مؤجلة'],
    ['RETURNED_BY_RECIPIENT', 'تم ارجاعها'],
    ['DELIVERED_TO_SENDER', 'مسلمة الى المرسل'],
    ['CANCELLED', 'ملغاة'],
  ])('NEGATIVE: the newest word %s is refused, said with the company’s own name «%s», and nothing is written', async (code, name) => {
    w.add(A);
    w.say(A, code);
    const before = w.snapshot();
    const res = await press([A]);
    expect(result(res, A)).toEqual({ orderId: A, orderNumber: 'ORD-001', ok: false, reason: otherWordReason(name) });
    expect(res.body).toMatchObject({ delivered: 0, refused: 1 });
    expect(w.snapshot()).toBe(before);
    expect(h.audit).not.toHaveBeenCalled();
  });

  it('NEGATIVE: a parcel the company has said nothing about (a courier with no feed) is refused, and says so', async () => {
    w.add(A);
    const before = w.snapshot();
    const res = await press([A]);
    expect(result(res, A)).toMatchObject({ ok: false, reason: REFUSAL_AR.NO_WORD });
    expect(w.snapshot()).toBe(before);
  });

  it('NEGATIVE: another parcel’s word is not this parcel’s', async () => {
    w.add(A);
    w.add(B);
    w.say(B, 'DELIVERED_TO_RECIPIENT');
    const res = await press([A, B]);
    expect(result(res, A)).toMatchObject({ ok: false, reason: REFUSAL_AR.NO_WORD });
    expect(result(res, B).ok).toBe(true);
  });

  it('NEWEST decides — an old «تم التوصيل» followed by a newer «مؤجلة» was taken back: refused', async () => {
    w.add(A);
    w.say(A, 'DELIVERED_TO_RECIPIENT', { minutesAgo: 300 });
    w.say(A, 'POSTPONED_DELIVERY', { minutesAgo: 20 });
    const before = w.snapshot();
    expect(result(await press([A]), A)).toMatchObject({ ok: false, reason: otherWordReason('مؤجلة') });
    expect(w.snapshot()).toBe(before);
  });

  it('NEWEST decides — an old «مؤجلة» followed by a newer «تم التوصيل» is recorded', async () => {
    w.add(A);
    w.say(A, 'POSTPONED_DELIVERY', { minutesAgo: 300 });
    w.say(A, 'DELIVERED_TO_RECIPIENT', { minutesAgo: 20 });
    expect(result(await press([A]), A).ok).toBe(true);
  });

  it('the same two lines, written in the OTHER order in the table, decide the same way (the table’s order is not the time)', async () => {
    w.add(A);
    w.say(A, 'DELIVERED_TO_RECIPIENT', { minutesAgo: 300 });
    w.say(A, 'POSTPONED_DELIVERY', { minutesAgo: 20 });
    w.S.activities.reverse();
    expect(result(await press([A]), A).ok).toBe(false);
  });

  it('two lines at the very same moment: the later id decides, as in the list', async () => {
    w.add(A);
    w.say(A, 'POSTPONED_DELIVERY', { minutesAgo: 20, id: 'a-1' });
    w.say(A, 'DELIVERED_TO_RECIPIENT', { minutesAgo: 20, id: 'a-2' });
    expect(result(await press([A]), A).ok).toBe(true);
    w.add(B);
    w.say(B, 'DELIVERED_TO_RECIPIENT', { minutesAgo: 20, id: 'b-1' });
    w.say(B, 'POSTPONED_DELIVERY', { minutesAgo: 20, id: 'b-2' });
    expect(result(await press([B]), B).ok).toBe(false);
  });

  it('NEGATIVE: a damaged NEWEST line says nothing — an older «تم التوصيل» under it is not trusted', async () => {
    w.add(A);
    w.say(A, 'DELIVERED_TO_RECIPIENT', { minutesAgo: 300 });
    w.sayRaw(A, { newStatus: 'DELIVERED', metadata: '{not json', minutesAgo: 5 });
    const before = w.snapshot();
    expect(result(await press([A]), A)).toMatchObject({ ok: false, reason: REFUSAL_AR.UNCLEAR_WORD });
    expect(w.snapshot()).toBe(before);
  });

  it.each([null, '', 'IN_TRANSIT', 'delivered', 'SHIPPED'])('NEGATIVE: a newest line whose state is %j is not one of the five words: refused', async (newStatus) => {
    w.add(A);
    w.say(A, 'DELIVERED_TO_RECIPIENT', { minutesAgo: 300 });
    w.sayRaw(A, { newStatus, metadata: JSON.stringify({ rawStatus: 'DELIVERED_TO_RECIPIENT', courierSaid: 'تم التوصيل' }), minutesAgo: 5 });
    expect(result(await press([A]), A)).toMatchObject({ ok: false, reason: REFUSAL_AR.UNCLEAR_WORD });
  });

  it('the word the REAL gate writes, with a driver’s note beside it, is recorded; a part delivery through the same gate is not', async () => {
    w.add(A);
    w.add(B);
    await w.theCompanySays(A, 'DELIVERED_TO_RECIPIENT', 'سلّمها للجارة');
    await w.theCompanySays(B, 'PARTIALLY_DELIVERED', 'تم التوصيل');
    expect(w.S.activities.filter((x) => x.action === COURIER_SAID)).toHaveLength(2);
    const res = await press([A, B]);
    expect(result(res, A).ok).toBe(true);
    expect(result(res, B)).toMatchObject({ ok: false, reason: otherWordReason('تم توصيلها بشكل جزئي') });
  });
});

describe('the qualification — the parcel’s own state', () => {
  it('NEGATIVE: our state is already «مسلَّم» with its date and the newest word is the same: refused as recorded before', async () => {
    w.add(A, { shippingStatus: 'DELIVERED', deliveredAt: new Date(START - 5 * MIN) });
    w.say(A, 'DELIVERED_TO_RECIPIENT');
    const before = w.snapshot();
    expect(result(await press([A]), A)).toMatchObject({ ok: false, reason: REFUSAL_AR.ALREADY_RECORDED });
    expect(w.snapshot()).toBe(before);
  });

  it('NEGATIVE: a parcel that came back (a return date) is recorded as settled by the door, whatever the company says', async () => {
    w.add(A, { shippingStatus: 'RETURNED', returnedAt: new Date(START - 5 * MIN) });
    w.say(A, 'DELIVERED_TO_RECIPIENT');
    expect(result(await press([A]), A)).toMatchObject({ ok: false, reason: REFUSAL_AR.ALREADY_RECORDED });
  });

  it.each(['NOT_READY', 'READY_FOR_SHIPPING', 'PACKING', 'READY_FOR_PICKUP', 'DELIVERED', 'PARTIALLY_DELIVERED', 'RETURN_REQUESTED', 'RETURNED', 'CANCELLED'])(
    'NEGATIVE: a parcel in state %s has no «استلم» at all — the single door’s own sentence, and nothing written',
    async (status) => {
      w.add(A, { shippingStatus: status });
      w.say(A, 'DELIVERED_TO_RECIPIENT');
      const before = w.snapshot();
      expect(result(await press([A]), A)).toMatchObject({ ok: false, reason: REFUSAL_AR.NOT_AT_DOOR });
      expect(w.snapshot()).toBe(before);
    }
  );

  it('NEGATIVE: «فشل التوصيل» — the single door would take it, the screen draws no «استلم» for it, so this door does not either', async () => {
    w.add(A, { shippingStatus: 'FAILED_DELIVERY' });
    w.say(A, 'DELIVERED_TO_RECIPIENT');
    const before = w.snapshot();
    expect(result(await press([A]), A)).toMatchObject({ ok: false, reason: REFUSAL_AR.NO_BOX });
    expect(w.snapshot()).toBe(before);
  });

  it('NEGATIVE: an order with no lines is refused in the single door’s sentence', async () => {
    w.add(A, { items: [] });
    w.say(A, 'DELIVERED_TO_RECIPIENT');
    expect(result(await press([A]), A)).toMatchObject({ ok: false, reason: REFUSAL_AR.NO_LINES });
  });

  it('NEGATIVE: a request nobody has answered (cancel, postpone or edit) is left for a person — only this door says so', async () => {
    w.add(A);
    w.add(B);
    w.say(A, 'DELIVERED_TO_RECIPIENT');
    w.say(B, 'DELIVERED_TO_RECIPIENT');
    w.S.requests.push({ id: 'r1', orderId: A, status: 'PENDING', blocking: true, intent: 'CANCEL' });
    const res = await press([A, B]);
    expect(result(res, A)).toMatchObject({ ok: false, reason: REFUSAL_AR.CHANGE_PENDING });
    expect(result(res, B).ok).toBe(true);
    expect(w.order(A).shippingStatus).toBe('SHIPPED');
  });

  it('a request that was answered, or does not block, does not stop it', async () => {
    w.add(A);
    w.add(B);
    w.say(A, 'DELIVERED_TO_RECIPIENT');
    w.say(B, 'DELIVERED_TO_RECIPIENT');
    w.S.requests.push({ id: 'r1', orderId: A, status: 'APPROVED', blocking: true, intent: 'POSTPONE' });
    w.S.requests.push({ id: 'r2', orderId: B, status: 'PENDING', blocking: false, intent: 'EDIT' });
    expect((await press([A, B])).body.delivered).toBe(2);
  });
});

/* ───────────────────────── a page: the good with the bad ───────────────────────── */

describe('a page of ten: the ones the company calls «تم التوصيل» go through, the rest are refused with a reason', () => {
  it('seven recorded, three refused — and the report says which is which', async () => {
    const ids = Array.from({ length: 10 }, (_, i) => w.add(uuid(300 + i), { shippingStatus: i % 2 ? 'OUT_FOR_DELIVERY' : 'SHIPPED' }));
    ids.forEach((id, i) => {
      if (i === 2) w.say(id, 'POSTPONED_DELIVERY');
      else if (i === 5) w.say(id, 'PARTIALLY_DELIVERED');
      else if (i === 8) return; // no word
      else w.say(id, 'DELIVERED_TO_RECIPIENT', { notes: i === 4 ? 'سلّمها للأخ' : undefined });
    });
    const res = await press(ids);
    expect(res.body.delivered).toBe(7);
    expect(res.body.refused).toBe(3);
    expect(res.body.results.filter((r: any) => r.ok).map((r: any) => r.orderId)).toEqual(ids.filter((_, i) => ![2, 5, 8].includes(i)));
    for (const i of [2, 5, 8]) expect(result(res, ids[i]).reason).toEqual(expect.any(String));
    // Seven parcels left the shelf — two units each — and the three refused left nothing.
    expect(w.stock()).toBe(1000 - 14);
    expect(w.sales()).toHaveLength(7);
    for (const i of [2, 5, 8]) expect(w.order(ids[i]).shippingStatus).toMatch(/SHIPPED|OUT_FOR_DELIVERY/);
    // One line for the press, listing what it recorded.
    expect(h.audit).toHaveBeenCalledTimes(1);
    const line = h.audit.mock.calls[0][0] as any;
    expect(line).toMatchObject({ companyId: 'c1', userId: 'u1', action: 'BULK_DELIVERY_RECORDED', newData: { delivered: 7, refused: 3 } });
    expect(line.newData.orderIds).toEqual(ids.filter((_, i) => ![2, 5, 8].includes(i)));
    expect(line.newData.refusedOrderIds).toEqual([ids[2], ids[5], ids[8]]);
  });
});

/* ───────────────────────── no money ───────────────────────── */

describe('this door writes no money', () => {
  it('no collected amount, no settlement, no wallet — only what the single door writes', async () => {
    w.add(A, { settlementStatus: 'NOT_APPLICABLE' });
    w.say(A, 'DELIVERED_TO_RECIPIENT');
    await press([A]);
    const order = w.order(A);
    expect('collectedAmount' in order).toBe(false);
    expect(order.settlementStatus).toBe('NOT_APPLICABLE');
    const keys = new Set(w.log.orderWrites.flatMap((x) => Object.keys(x.data)));
    for (const forbidden of ['collectedAmount', 'settlementStatus', 'settledAt', 'collectionStatus', 'totalAmount']) expect(keys.has(forbidden), forbidden).toBe(false);
    expect([...keys].sort()).toEqual(['deliveredAt', 'estimatedCostOfGoods', 'returnedAt', 'shippingStatus', 'version']);
  });

  it('the fake database has no wallet to write to — a door that reached for one would have been refused and the parcel failed', async () => {
    expect((w.db as any).wallet).toBeUndefined();
    expect((w.db as any).walletMovement).toBeUndefined();
    w.add(A);
    w.say(A, 'DELIVERED_TO_RECIPIENT');
    expect((await press([A])).body.delivered).toBe(1);
  });

  it('each recorded order carries the sentence that says how it came to be written, in its own thread', async () => {
    w.add(A);
    w.say(A, 'DELIVERED_TO_RECIPIENT');
    await press([A]);
    expect(w.S.notes).toHaveLength(1);
    expect(w.S.notes[0]).toMatchObject({ orderId: A, kind: 'internal', body: `تسليم كامل: ${BULK_DELIVER_NOTE_AR}` });
    expect(w.S.attempts[0].note).toBe(BULK_DELIVER_NOTE_AR);
  });
});

/* ───────────────────────── a row fails; the others do not ───────────────────────── */

describe('one parcel failing halfway does not take the others down', () => {
  it('the middle one breaks after it wrote: it goes back whole, the other two stay recorded, and the answer is still 200', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    for (const id of [A, B, C]) {
      w.add(id);
      w.say(id, 'DELIVERED_TO_RECIPIENT');
    }
    w.flags.breakOn = (model, op, args) => model === 'customer' && op === 'update' && args.where.id === `cu-${B}`;
    const res = await press([A, B, C]);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ delivered: 2, refused: 1 });
    expect(result(res, B)).toMatchObject({ ok: false, reason: REFUSAL_AR.FAILED });
    expect(w.order(A).shippingStatus).toBe('DELIVERED');
    expect(w.order(C).shippingStatus).toBe('DELIVERED');
    // B wrote its lines and its status before the break: all of it is gone.
    expect(w.order(B).shippingStatus).toBe('SHIPPED');
    expect(w.order(B).deliveredAt).toBeNull();
    expect(w.order(B).items[0].deliveredQty).toBeNull();
    expect(w.S.attempts.map((a) => a.orderId)).toEqual([A, C]);
    expect(w.S.notes.map((n) => n.orderId)).toEqual([A, C]);
    expect(w.stock()).toBe(1000 - 4);
    expect(w.log.rolledBack).toBe(1);
    // The log says what kind of failure it was, never the error’s own text.
    expect(spy).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(spy.mock.calls[0])).not.toContain('the fake database broke');
  });

  it('a parcel whose stock draw breaks last is rolled back from the first line to the last', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    w.add(A);
    w.say(A, 'DELIVERED_TO_RECIPIENT');
    w.flags.breakOn = (model, op) => model === 'productionBatch' && op === 'update';
    const before = w.snapshot();
    const res = await press([A]);
    expect(res.body).toMatchObject({ delivered: 0, refused: 1 });
    expect(w.snapshot()).toBe(before);
  });

  it('a refusal found by the shared function itself (a line that is not this order’s) rolls the parcel back and is reported in ITS sentence', async () => {
    w.add(A);
    w.say(A, 'DELIVERED_TO_RECIPIENT');
    // The shared function reads the order again, inside the same transaction: show it lines that are not the ones this door read.
    w.flags.tamper = (out, args) => {
      if ('deliveryFee' in args.select) out.items = out.items.map((i: any) => ({ ...i, id: `other-${i.id}` }));
    };
    const before = w.snapshot();
    const res = await press([A]);
    expect(result(res, A)).toEqual({ orderId: A, orderNumber: 'ORD-001', ok: false, reason: 'بند لا ينتمي لهذا الطلب' });
    expect(w.snapshot()).toBe(before);
    expect(w.sales()).toHaveLength(0);
  });
});

/* ───────────────────────── twice ───────────────────────── */

describe('a second press records nothing twice', () => {
  it('the same request again: every parcel is «recorded before», the shelf and the counters are where the first left them', async () => {
    for (const id of [A, B]) {
      w.add(id);
      w.say(id, 'DELIVERED_TO_RECIPIENT');
    }
    const first = await press([A, B]);
    expect(first.body.delivered).toBe(2);
    const after = w.snapshot();
    const second = await press([A, B]);
    expect(second.status).toBe(200);
    expect(second.body).toMatchObject({ delivered: 0, refused: 2 });
    for (const r of second.body.results) expect(r.reason).toBe(REFUSAL_AR.ALREADY_RECORDED);
    expect(w.snapshot()).toBe(after);
    expect(w.sales()).toHaveLength(2);
    expect(h.audit).toHaveBeenCalledTimes(1);
  });

  it('a parcel recorded by the SINGLE door is refused here in the same words, and the other goes through', async () => {
    for (const id of [A, B]) {
      w.add(id);
      w.say(id, 'DELIVERED_TO_RECIPIENT');
    }
    const r = await single(new Request('http://x', { method: 'POST', body: JSON.stringify({ orderId: A, outcome: 'ALL' }) }));
    expect(r.status).toBe(200);
    const res = await press([A, B]);
    expect(result(res, A)).toMatchObject({ ok: false, reason: REFUSAL_AR.ALREADY_RECORDED });
    expect(result(res, B).ok).toBe(true);
    expect(w.sales()).toHaveLength(2);
    expect(w.S.customers[`cu-${A}`].deliveredOrders).toBe(1);
  });

  it('TWO REQUESTS AT ONCE on the same parcel: one winner — the other waits for the row, then reads it recorded', async () => {
    w.flags.slow = true;
    w.add(A);
    w.say(A, 'DELIVERED_TO_RECIPIENT');
    const [x, y] = await Promise.all([press([A]), press([A])]);
    const delivered = [x.body.delivered, y.body.delivered].sort();
    expect(delivered).toEqual([0, 1]);
    const loser = x.body.delivered === 0 ? x : y;
    expect(result(loser, A)).toMatchObject({ ok: false, reason: REFUSAL_AR.ALREADY_RECORDED });
    // Once: one count for the customer, one knock, one note, one SALE line, two units off the shelf.
    expect(w.S.customers[`cu-${A}`].deliveredOrders).toBe(1);
    expect(w.S.attempts).toHaveLength(1);
    expect(w.S.notes).toHaveLength(1);
    expect(w.sales()).toHaveLength(1);
    expect(w.stock()).toBe(998);
    expect(w.log.rawLocks.filter((id) => id === A)).toHaveLength(2);
  });

  it('TWO REQUESTS AT ONCE over overlapping pages: every parcel is recorded exactly once between them', async () => {
    w.flags.slow = true;
    for (const id of [A, B, C]) {
      w.add(id);
      w.say(id, 'DELIVERED_TO_RECIPIENT');
    }
    const [x, y] = await Promise.all([press([A, B]), press([B, C])]);
    expect(x.body.delivered + y.body.delivered).toBe(3);
    for (const id of [A, B, C]) expect(w.S.customers[`cu-${id}`].deliveredOrders, id).toBe(1);
    expect(w.sales()).toHaveLength(3);
    expect(w.stock()).toBe(1000 - 6);
  });
});

/* ───────────────────────── what the door sees of the shelf ───────────────────────── */

describe('the goods leave the shelf exactly as the single door takes them', () => {
  it('gift units leave too: 2 paid + 1 gift = 3 units on the ledger line, and the lines say 3 taken', async () => {
    w.add(A, { items: [{ id: `${A}-i1`, productId: 'p1', productName: 'كريم', quantity: 2, freeQuantity: 1, unitPrice: 10, discountShare: 0, lineTotal: 20, deliveredQty: null, returnedQty: null, reservedQty: 3 }] });
    w.say(A, 'DELIVERED_TO_RECIPIENT');
    await press([A]);
    expect(w.order(A).items[0]).toMatchObject({ deliveredQty: 3, returnedQty: 0 });
    expect(w.sales()[0]).toMatchObject({ quantity: -3, referenceId: A });
    expect(w.stock()).toBe(997);
  });

  it('a shelf that cannot cover the parcel still records it (a delivery is a fact) and says the shortfall once on the order', async () => {
    w.S.batches[0].quantityRemaining = 1;
    w.add(A);
    w.say(A, 'DELIVERED_TO_RECIPIENT');
    const res = await press([A]);
    expect(res.body.delivered).toBe(1);
    expect(w.stock()).toBe(0);
    expect(w.S.activities.filter((x) => x.action === 'STOCK_SHORT_AT_DELIVERY')).toHaveLength(1);
  });
});

/* ───────────────────────── the same writes as the single door ───────────────────────── */

/** Every row the world holds, with the moment of the press (the only real clock in it) blanked. */
const normalised = (world: World) => JSON.parse(JSON.stringify(world.S), (k, v) => (k === 'deliveredAt' && v ? 'DATE' : v));
const pressSingle = async (orderId: string, note: string | null = BULK_DELIVER_NOTE_AR) => {
  const res = await single(new Request('http://x/api/ops/tracking/deliver', { method: 'POST', body: JSON.stringify({ orderId, outcome: 'ALL', ...(note ? { note } : {}) }) }));
  return { status: res.status, body: (await res.json().catch(() => ({}))) as any };
};
/** A fresh world, seeded, and made the one the doors talk to. */
const seeded = (seed: (world: World) => void): World => {
  const fresh = makeWorld();
  h.db = fresh.db as any;
  seed(fresh);
  return fresh;
};

describe('what it writes IS what the single «استلم» writes (outcome ALL) — through the same function, so the same rows', () => {
  const GIFT_AND_UPSELL = (world: World) => {
    world.add(A, {
      deliveryFee: 2.5,
      items: [
        { id: `${A}-i1`, productId: 'p1', productName: 'كريم', quantity: 2, freeQuantity: 1, unitPrice: 10, discountShare: 4, lineTotal: 16, deliveredQty: null, returnedQty: null, reservedQty: 3 },
        { id: `${A}-i2`, productId: 'p1', productName: 'قطرة', quantity: 1, freeQuantity: 0, unitPrice: 30, discountShare: 0, lineTotal: 30, deliveredQty: null, returnedQty: null, reservedQty: 1 },
      ],
      addOns: [{ productId: 'p1', productName: 'هدية', quantity: 1, price: 5 }],
    });
    world.say(A, 'DELIVERED_TO_RECIPIENT');
  };
  const PLAIN = (world: World) => {
    world.add(A);
    world.say(A, 'DELIVERED_TO_RECIPIENT');
  };
  const THREE = (world: World) => {
    for (const id of [A, B, C]) {
      world.add(id, { shippingStatus: id === B ? 'OUT_FOR_DELIVERY' : 'SHIPPED' });
      world.say(id, 'DELIVERED_TO_RECIPIENT');
    }
  };
  const SHORT_SHELF = (world: World) => {
    world.S.batches[0].quantityRemaining = 1;
    PLAIN(world);
  };

  it.each([
    ['one plain parcel', PLAIN, [A]],
    ['a parcel with a gift unit, a discount, a fee and an upsell on two lines', GIFT_AND_UPSELL, [A]],
    ['three parcels in one press, one of them already out for delivery', THREE, [A, B, C]],
    ['a parcel the shelf cannot cover', SHORT_SHELF, [A]],
  ])('— %s: the whole world after one bulk press equals the world after the single door on each', async (_name, seed, ids) => {
    const one = seeded(seed);
    for (const id of ids) expect((await pressSingle(id)).status).toBe(200);
    const afterSingle = normalised(one);

    const two = seeded(seed);
    const res = await press(ids);
    expect(res.body.delivered).toBe(ids.length);
    expect(normalised(two)).toEqual(afterSingle);
  });

  it('and the single «استلم» the screen sends (no note) differs from it in ONE thing: the note on the order and on the attempt', async () => {
    const one = seeded(PLAIN);
    await pressSingle(A, null);
    const two = seeded(PLAIN);
    await press([A]);
    const plain = normalised(one);
    const bulk = normalised(two);
    expect(plain.notes).toEqual([]);
    expect(bulk.notes).toHaveLength(1);
    expect(plain.attempts[0].note).toBeNull();
    expect(bulk.attempts[0].note).toBe(BULK_DELIVER_NOTE_AR);
    // Take the note out of both and nothing else is different.
    const withoutNote = (x: any) => ({
      ...x,
      notes: [],
      attempts: x.attempts.map((a: any) => ({ ...a, note: null })),
      activities: x.activities.map((a: any) => (a.action === 'PARTIAL_DELIVERY_RECORDED' ? { ...a, metadata: JSON.stringify({ ...JSON.parse(a.metadata), note: null }) } : a)),
    });
    expect(withoutNote(bulk)).toEqual(withoutNote(plain));
  });

  it('what the timeline line carries is the single door’s own: status, the expected collection, the fee in full — and no collected amount', async () => {
    const two = seeded(GIFT_AND_UPSELL);
    await press([A]);
    const line = two.S.activities.find((x) => x.action === 'PARTIAL_DELIVERY_RECORDED');
    expect(line).toMatchObject({ orderId: A, userId: 'u1', newStatus: 'DELIVERED' });
    const meta = JSON.parse(line.metadata);
    expect(meta).toMatchObject({ feeChargedInFull: true, linesDelivered: 2, linesReturned: 0, deliveryFee: 2.5, addOnValue: 5 });
    expect(Object.keys(meta)).not.toContain('collectedAmount');
  });

  /*
   * THE OLD-VS-NEW MATRIX. For every combination of a parcel’s state, its dates, the company’s newest word and a pending request,
   * the parcel is pressed through THIS door in one world and — when this door recorded it — through the SINGLE door in another:
   * the two worlds must be the same. When this door refused, the world must not have moved by a byte. So it can only ever do
   * LESS than the single door, and what it does is the same thing.
   */
  it('for every state × dates × word × pending request: what this door records the single door records identically; what it refuses moves nothing', async () => {
    const states = ['NOT_READY', 'READY_FOR_SHIPPING', 'PACKING', 'READY_FOR_PICKUP', 'SHIPPED', 'OUT_FOR_DELIVERY', 'DELIVERED', 'PARTIALLY_DELIVERED', 'FAILED_DELIVERY', 'RETURN_REQUESTED', 'RETURNED', 'CANCELLED'];
    const dates = [{}, { deliveredAt: new Date(START - MIN) }, { returnedAt: new Date(START - MIN) }];
    const words = [null, 'DELIVERED_TO_RECIPIENT', 'PARTIALLY_DELIVERED', 'POSTPONED_DELIVERY', 'RETURNED_BY_RECIPIENT', 'DELIVERED_TO_SENDER', 'CANCELLED', 'OLD_DELIVERED_THEN_POSTPONED'];
    let recorded = 0;
    let refused = 0;
    const recordedStates = new Set<string>();
    for (const status of states) {
      for (const [di, extra] of dates.entries()) {
        for (const word of words) {
          for (const pending of [false, true]) {
            const seed = (world: World) => {
              world.add(A, { shippingStatus: status, ...extra });
              if (word === 'OLD_DELIVERED_THEN_POSTPONED') {
                world.say(A, 'DELIVERED_TO_RECIPIENT', { minutesAgo: 90 });
                world.say(A, 'POSTPONED_DELIVERY', { minutesAgo: 10 });
              } else if (word) world.say(A, word, { notes: word === 'POSTPONED_DELIVERY' ? 'تم التوصيل' : undefined });
              if (pending) world.S.requests.push({ id: 'r1', orderId: A, status: 'PENDING', blocking: true, intent: 'POSTPONE' });
            };
            const bulk = seeded(seed);
            const before = bulk.snapshot();
            const res = await press([A]);
            const label = `${status}/dates#${di}/${word}/pending=${pending}`;
            expect(res.status, label).toBe(200);
            if (res.body.delivered === 1) {
              recorded++;
              recordedStates.add(status);
              const bulkAfter = normalised(bulk);
              // The single door does not look at a request at all: take it out of the picture so the two worlds compare whole.
              const alone = seeded(seed);
              alone.S.requests.length = 0;
              expect((await pressSingle(A)).status, label).toBe(200);
              expect(normalised(alone), label).toEqual(bulkAfter);
            } else {
              refused++;
              expect(bulk.snapshot(), label).toBe(before);
            }
          }
        }
      }
    }
    // The matrix is not vacuous: two cells record (a plain parcel on each of the two states with the box, the company saying
    // «تم التوصيل», nothing pending, no date) and every other cell is refused without moving the world.
    expect(recorded).toBe(2);
    expect(refused).toBe(states.length * dates.length * words.length * 2 - recorded);
    expect([...recordedStates].sort()).toEqual(['OUT_FOR_DELIVERY', 'SHIPPED']);
  });
});
