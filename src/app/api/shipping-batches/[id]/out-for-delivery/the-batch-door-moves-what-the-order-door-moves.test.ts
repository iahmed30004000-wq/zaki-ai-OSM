import { beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { SessionUser } from '@/types/auth';
import { stripComments } from '@/lib/guard-source';

/**
 * ═══════════════════════════════════════════════════════════════════════
 * DEFINITION OF DONE — «خرج للتوصيل لكل الدفعة» (2/11)
 *
 * The status «خرج للتوصيل» was pressed by hand, order by order, on the shipping card: a batch of 160 parcels was 160 presses
 * (a courier worked by hand has no feed). One press for the batch now, and it is the order's own move repeated — not a second
 * way to move an order.
 *
 *  1. It moves every parcel of THIS batch (this company, this store) that is «مشحون» to «خرج للتوصيل», and nothing else:
 *     the others are skipped and counted, never an error, and pressing again changes nothing.
 *  2. Each parcel gets exactly what the order's door gives it: the same columns (`outForDeliveryAt` from the server's clock, the
 *     version stepped), one line on the status timeline, one activity row, one audit row — and no message, no notification, no
 *     event to the apps, no stock, no ledger, no money (OUT_FOR_DELIVERY has none of those at the order's door either).
 *  3. Each parcel is asked what the order's door asks: the person's scope over THAT order, an edit lock, a confirmed order, the
 *     transition table, a blocking change request, the version. One that cannot move is named with its sentence, and the rest go.
 *  4. Both `ops.batches` and `orders.change_status` are asked, every time, before anything is read or written.
 *  5. An unknown batch, another store's or another company's, and an empty one are refused in Arabic with nothing written.
 *
 * Blockers: money arithmetic, order creation, the courier poll and its gate, the confirmation queue — none touched.
 * The proof is a world, not a list of mocks: a strict in-memory fake with the real authorization engine and the REAL order door
 * beside it, so «the same» is measured by running both.
 * ═══════════════════════════════════════════════════════════════════════
 */

type Row = Record<string, any>;

const world = vi.hoisted(() => ({ db: null as unknown, ctx: null as unknown }));

vi.mock('@/lib/db', () => {
  const proxy = new Proxy({}, { get: (_t, p) => (world.db as Record<string | symbol, unknown>)[p] });
  return { db: proxy, default: proxy };
});
vi.mock('@/lib/geo-context', () => ({ requireContext: async () => world.ctx }));
vi.mock('@/lib/notify', () => ({ notify: vi.fn(), afterResponse: vi.fn() }));
vi.mock('@/lib/apps/events', () => ({ emitAppEvent: vi.fn() }));
vi.mock('@/lib/conversions/emit', () => ({ queueConversions: vi.fn() }));
// The transition table as both doors read it: the real one, unless a test closes the one step this file is about.
const table = vi.hoisted(() => ({ closed: false }));
vi.mock('@/lib/shipping-workflow', async (importOriginal) => {
  const real = await importOriginal<typeof import('@/lib/shipping-workflow')>();
  return {
    ...real,
    isValidShippingTransition: (from: string, to: string) =>
      table.closed && from === 'SHIPPED' && to === 'OUT_FOR_DELIVERY' ? false : real.isValidShippingTransition(from, to),
  };
});

import { emitAppEvent } from '@/lib/apps/events';
import { notify } from '@/lib/notify';
import { queueConversions } from '@/lib/conversions/emit';
import { POST as batchDoor } from './route';
import { POST as orderDoor } from '@/app/api/orders/[id]/shipping/route';

/* ─────────────────────────────── the world ─────────────────────────────── */

/**
 * A STRICT FAKE: every model has a closed list of columns and a closed list of methods. A `where`, a `select` or a `data` that
 * names a column that does not exist throws; so does a model nobody gave the world (a stock movement, a wallet, a ledger line).
 * A door that reaches for something it should not does not pass quietly — it breaks the test that let it.
 */
const COLUMNS: Record<string, string[]> = {
  order: [
    'id', 'orderNumber', 'companyId', 'storeId', 'version', 'status', 'shippingStatus', 'confirmationStatus', 'settlementStatus',
    'assignedToId', 'claimedById', 'currentOwnerId', 'moderatorId', 'lockedById', 'lockExpiresAt',
    'deliveryProviderId', 'trackingNumber', 'shippingBatchId', 'shippedAt', 'outForDeliveryAt', 'deliveredAt', 'failedAt',
    'returnedAt', 'deliveryFailureReason', 'returnReason', 'shippingNote', 'createdAt',
  ],
  orderChangeRequest: ['id', 'orderId', 'companyId', 'status', 'blocking', 'intent', 'appliedAt', 'reason'],
  shippingBatch: ['id', 'companyId', 'storeId', 'batchNumber', 'status', 'deliveryProviderId'],
  user: ['id', 'name'],
};

const CREATE_COLUMNS: Record<string, { required: string[]; optional: string[] }> = {
  orderStatusLog: {
    required: ['companyId', 'orderId', 'statusType', 'changedById', 'changedByRole'],
    optional: ['previousValue', 'newValue', 'note'],
  },
  orderActivity: {
    required: ['companyId', 'orderId', 'action'],
    optional: ['userId', 'previousStatus', 'newStatus', 'metadata'],
  },
  auditLog: {
    required: ['companyId', 'action', 'entity', 'entityId'],
    optional: ['userId', 'previousData', 'newData'],
  },
};

const NEVER_A_MODEL = new Set(['then', 'default', '__esModule', 'toJSON', 'asymmetricMatch', '$$typeof', 'nodeType', 'tagName', 'constructor']);

function matches(model: string, row: Row, where: Row | undefined): boolean {
  if (!where) return true;
  return Object.entries(where).every(([key, want]) => {
    if (key === 'OR') return (want as Row[]).some((w) => matches(model, row, w));
    if (key === 'AND') return (want as Row[]).every((w) => matches(model, row, w));
    if (!COLUMNS[model].includes(key)) throw new Error(`strict fake: ${model} has no column «${key}» (where)`);
    const have = row[key];
    if (want !== null && typeof want === 'object' && !(want instanceof Date)) {
      for (const op of Object.keys(want)) {
        if (!['in', 'not', 'equals'].includes(op)) throw new Error(`strict fake: the operator «${op}» is not part of this world`);
      }
      if ('in' in want && !(want.in as unknown[]).includes(have)) return false;
      if ('not' in want && have === want.not) return false;
      if ('equals' in want && have !== want.equals) return false;
      return true;
    }
    return have === want;
  });
}

function shape(model: string, row: Row, args: Row): Row {
  if (!args.select) return { ...row };
  const out: Row = {};
  for (const [key, on] of Object.entries(args.select as Row)) {
    if (!COLUMNS[model].includes(key)) throw new Error(`strict fake: ${model} has no column «${key}» (select)`);
    if (on) out[key] = row[key];
  }
  return out;
}

interface Hooks {
  /** Runs at the start of every `order.updateMany`, before its `where` is read — the moment another writer can get in. */
  beforeOrderWrite?: (where: Row, state: State) => void;
  /** Makes one create throw, like a connection that dropped. */
  failCreate?: (model: string, data: Row) => boolean;
}
interface State {
  orders: Row[];
  requests: Row[];
  batches: Row[];
  users: Row[];
  statusLogs: Row[];
  activities: Row[];
  audits: Row[];
}

function makeWorld(seed: { orders: Row[]; requests?: Row[]; batches?: Row[]; users?: Row[] }) {
  const state: State = {
    orders: seed.orders.map((o) => ({ ...o })),
    requests: (seed.requests ?? []).map((r) => ({ ...r })),
    batches: (seed.batches ?? [BATCH()]).map((b) => ({ ...b })),
    users: (seed.users ?? [{ id: 'u-other', name: 'سارة' }]).map((u) => ({ ...u })),
    statusLogs: [],
    activities: [],
    audits: [],
  };
  const touched = new Set<string>();
  const hooks: Hooks = {};
  let serial = 0;

  const create = (model: 'orderStatusLog' | 'orderActivity' | 'auditLog', into: Row[]) => async ({ data }: { data: Row }) => {
    touched.add(model);
    const spec = CREATE_COLUMNS[model];
    for (const key of spec.required) if (data[key] === undefined) throw new Error(`strict fake: ${model} needs «${key}»`);
    for (const key of Object.keys(data)) {
      if (!spec.required.includes(key) && !spec.optional.includes(key)) throw new Error(`strict fake: ${model} has no column «${key}»`);
    }
    if (hooks.failCreate?.(model, data)) throw new Error('the connection dropped');
    const row = { id: `${model}-${++serial}`, createdAt: new Date(), ...data };
    into.push(row);
    return row;
  };

  const sorted = (rows: Row[], orderBy: Row | undefined) => {
    if (!orderBy) return rows;
    if (Object.keys(orderBy).join() !== 'createdAt' || orderBy.createdAt !== 'asc') throw new Error('strict fake: only orderBy createdAt asc');
    return [...rows].sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
  };

  const models: Record<string, unknown> = {
    order: {
      findMany: async (args: Row = {}) => {
        touched.add('order');
        return sorted(state.orders.filter((r) => matches('order', r, args.where)), args.orderBy).map((r) => shape('order', r, args));
      },
      findFirst: async (args: Row = {}) => {
        touched.add('order');
        const hit = state.orders.find((r) => matches('order', r, args.where));
        return hit ? shape('order', hit, args) : null;
      },
      findUnique: async (args: Row) => {
        touched.add('order');
        if (Object.keys(args.where).join() !== 'id') throw new Error('strict fake: findUnique by id only');
        const hit = state.orders.find((r) => r.id === args.where.id);
        return hit ? shape('order', hit, args) : null;
      },
      updateMany: async ({ where, data }: { where: Row; data: Row }) => {
        touched.add('order');
        hooks.beforeOrderWrite?.(where, state);
        const hits = state.orders.filter((r) => matches('order', r, where));
        for (const row of hits) {
          for (const [key, value] of Object.entries(data)) {
            if (!COLUMNS.order.includes(key)) throw new Error(`strict fake: order has no column «${key}» (data)`);
            if (value !== null && typeof value === 'object' && !(value instanceof Date)) {
              if (!('increment' in value)) throw new Error(`strict fake: the write «${JSON.stringify(value)}» is not part of this world`);
              row[key] = (row[key] ?? 0) + (value as { increment: number }).increment;
            } else {
              row[key] = value;
            }
          }
        }
        return { count: hits.length };
      },
    },
    orderChangeRequest: {
      findMany: async (args: Row = {}) => {
        touched.add('orderChangeRequest');
        return state.requests.filter((r) => matches('orderChangeRequest', r, args.where)).map((r) => shape('orderChangeRequest', r, args));
      },
      findFirst: async (args: Row = {}) => {
        touched.add('orderChangeRequest');
        const hit = state.requests.find((r) => matches('orderChangeRequest', r, args.where));
        return hit ? shape('orderChangeRequest', hit, args) : null;
      },
    },
    shippingBatch: {
      findFirst: async (args: Row = {}) => {
        touched.add('shippingBatch');
        const hit = state.batches.find((r) => matches('shippingBatch', r, args.where));
        return hit ? shape('shippingBatch', hit, args) : null;
      },
    },
    user: {
      findUnique: async (args: Row) => {
        touched.add('user');
        const hit = state.users.find((r) => r.id === args.where.id);
        return hit ? shape('user', hit, args) : null;
      },
    },
    orderStatusLog: { create: create('orderStatusLog', state.statusLogs) },
    orderActivity: { create: create('orderActivity', state.activities) },
    auditLog: { create: create('auditLog', state.audits) },
    /** A transaction that really rolls back: what the callback wrote is undone when it throws. */
    $transaction: async (fn: (tx: unknown) => Promise<unknown>) => {
      touched.add('$transaction');
      const before = structuredClone({ orders: state.orders, statusLogs: state.statusLogs, activities: state.activities });
      try {
        return await fn(db);
      } catch (error) {
        state.orders.splice(0, state.orders.length, ...before.orders);
        state.statusLogs.splice(0, state.statusLogs.length, ...before.statusLogs);
        state.activities.splice(0, state.activities.length, ...before.activities);
        throw error;
      }
    },
  };

  const db: any = new Proxy(models, {
    get(target, prop) {
      if (typeof prop === 'symbol' || NEVER_A_MODEL.has(prop)) return undefined;
      if (!(prop in target)) throw new Error(`strict fake: db.${prop} is not part of this world (no stock, no wallet, no ledger here)`);
      return target[prop];
    },
  });

  return { db, state, hooks, touched };
}

/* ─────────────────────────────── the cast ─────────────────────────────── */

const COMPANY = 'c1';
const STORE = 's1';
const STAFF = 'u-qabas';

/** A person is the grants the engine would have computed for her: the real `can` and `authorize` read exactly this. */
const person = (grants: Record<string, string>, over: Row = {}): SessionUser =>
  ({
    id: STAFF, email: 'qabas@zaki.test', name: 'قبس', role: 'WAREHOUSE', status: 'ACTIVE', companyId: COMPANY,
    permissions: Object.keys(grants),
    effectiveGrants: { fullAccess: false, grants: Object.fromEntries(Object.entries(grants).map(([k, scope]) => [k, { scope }])) },
    ...over,
  }) as unknown as SessionUser;

const BOTH = { 'ops.batches': 'ALL_COMPANY', 'orders.view': 'ALL_COMPANY', 'orders.change_status': 'ALL_COMPANY' };

const BATCH = (over: Row = {}): Row => ({
  id: 'b1', companyId: COMPANY, storeId: STORE, batchNumber: 'BATCH-2026-0007', status: 'SHIPPED', deliveryProviderId: 'dp1', ...over,
});

let clock = 0;
const order = (n: number, over: Row = {}): Row => ({
  id: `o${n}`, orderNumber: `ORD-2026-${String(n).padStart(4, '0')}`, companyId: COMPANY, storeId: STORE,
  version: 2, status: 'SHIPPED', shippingStatus: 'SHIPPED', confirmationStatus: 'CONFIRMED', settlementStatus: 'PENDING_COLLECTION',
  assignedToId: null, claimedById: null, currentOwnerId: null, moderatorId: null, lockedById: null, lockExpiresAt: null,
  deliveryProviderId: 'dp1', trackingNumber: `BSH-${n}`, shippingBatchId: 'b1',
  shippedAt: new Date('2026-11-02T08:00:00Z'), outForDeliveryAt: null, deliveredAt: null, failedAt: null, returnedAt: null,
  deliveryFailureReason: null, returnReason: null, shippingNote: null,
  createdAt: new Date(Date.UTC(2026, 10, 2, 7, 0, 0) + 60_000 * (++clock)),
  ...over,
});

const ctxFor = (user: SessionUser) => ({ user, companyId: COMPANY, storeId: STORE, country: { minorUnit: 2, allowNegativeStock: false } });

let w: ReturnType<typeof makeWorld>;
const start = (seed: Parameters<typeof makeWorld>[0], user: SessionUser = person(BOTH)) => {
  w = makeWorld(seed);
  world.db = w.db;
  world.ctx = ctxFor(user);
  return w;
};

const press = async (batchId = 'b1') => {
  const res = await batchDoor(new Request(`http://localhost/api/shipping-batches/${batchId}/out-for-delivery`, { method: 'POST' }), {
    params: Promise.resolve({ id: batchId }),
  });
  return { status: res.status, body: (await res.json()) as Row };
};

const orderRow = (id: string) => w.state.orders.find((o) => o.id === id)!;
const parse = (json: string | null) => (json ? JSON.parse(json) : null);

beforeEach(() => {
  vi.clearAllMocks();
  clock = 0;
  table.closed = false;
});

/** The standard trolley: three parcels waiting, three that are not, and three that are not this trolley's. */
const trolley = () => [
  order(1), order(2), order(3),
  order(4, { shippingStatus: 'OUT_FOR_DELIVERY', outForDeliveryAt: new Date('2026-11-02T09:00:00Z'), version: 3 }),
  order(5, { shippingStatus: 'DELIVERED', status: 'DELIVERED', deliveredAt: new Date('2026-11-02T10:00:00Z'), version: 4 }),
  order(6, { shippingStatus: 'CANCELLED', status: 'CANCELLED', confirmationStatus: 'CANCELLED' }),
  order(7, { shippingStatus: 'READY_FOR_PICKUP', status: 'CONFIRMED', shippedAt: null }),
  // Not this trolley's: another trolley of the same shop, another shop's order and another company's, all «مشحون».
  order(11, { shippingBatchId: 'b2' }),
  order(12, { storeId: 's2' }),
  order(13, { companyId: 'c2' }),
];

/* ═════════════════════════ 1 · WHO IS MOVED ═════════════════════════ */

describe('1 · the press moves the «مشحون» parcels of THIS trolley, and only them', () => {
  it('moves the three waiting parcels and counts the rest as skipped — never an error', async () => {
    start({ orders: trolley(), batches: [BATCH(), BATCH({ id: 'b2', batchNumber: 'BATCH-2026-0008' })] });

    const res = await press();

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body).toMatchObject({ success: true, total: 7, moved: 3, skipped: 4, failed: 0, failedOrders: [], failures: [] });
    for (const id of ['o1', 'o2', 'o3']) {
      expect(orderRow(id).shippingStatus, id).toBe('OUT_FOR_DELIVERY');
      expect(orderRow(id).version, `${id} version stepped once`).toBe(3);
      expect(orderRow(id).outForDeliveryAt, `${id} stamp`).toBeInstanceOf(Date);
    }
  });

  it('leaves every parcel that is not «مشحون» exactly as it was — not a column, not a version', async () => {
    start({ orders: trolley(), batches: [BATCH(), BATCH({ id: 'b2', batchNumber: 'BATCH-2026-0008' })] });
    const before = structuredClone(w.state.orders);

    await press();

    for (const id of ['o4', 'o5', 'o6', 'o7']) {
      expect(orderRow(id), `${id} was touched`).toEqual(before.find((o) => o.id === id));
    }
  });

  it('never touches another trolley, another store or another company — even when they are «مشحون» and share the trolley id', async () => {
    start({ orders: trolley(), batches: [BATCH(), BATCH({ id: 'b2', batchNumber: 'BATCH-2026-0008' })] });
    const before = structuredClone(w.state.orders);

    const res = await press();

    expect(res.body.total, 'the other shop and the other company are not even counted').toBe(7);
    for (const id of ['o11', 'o12', 'o13']) {
      expect(orderRow(id), `${id} was touched`).toEqual(before.find((o) => o.id === id));
    }
  });

  it('stamps every parcel with the SAME server time, and steps the version once', async () => {
    start({ orders: trolley(), batches: [BATCH(), BATCH({ id: 'b2', batchNumber: 'BATCH-2026-0008' })] });
    await press();
    const stamps = ['o1', 'o2', 'o3'].map((id) => (orderRow(id).outForDeliveryAt as Date).getTime());
    expect(new Set(stamps).size, 'one press, one moment').toBe(1);
    expect(Math.abs(stamps[0] - Date.now()), 'the stamp is the server clock').toBeLessThan(60_000);
  });

  it('writes the same columns the order’s door writes for this move — and the legacy `status` is NOT one of them', async () => {
    start({ orders: [order(1)] });
    await press();
    expect(orderRow('o1').status, 'OUT_FOR_DELIVERY has no legacy sync').toBe('SHIPPED');
    expect(orderRow('o1').settlementStatus, 'no money column moves').toBe('PENDING_COLLECTION');
    expect(orderRow('o1').shippedAt, 'the shipped stamp is left').toEqual(new Date('2026-11-02T08:00:00Z'));
    expect(orderRow('o1').deliveredAt).toBeNull();
  });

  it('a trolley with nothing at «مشحون» answers with counts and writes nothing — the second press of the same trolley', async () => {
    start({ orders: [order(4, { shippingStatus: 'OUT_FOR_DELIVERY', outForDeliveryAt: new Date('2026-11-02T09:00:00Z') }), order(5, { shippingStatus: 'DELIVERED' })] });
    const before = JSON.stringify(w.state);

    const res = await press();

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ moved: 0, skipped: 2, failed: 0 });
    expect(JSON.stringify(w.state), 'nothing was written').toBe(before);
  });
});

/* ═════════════════════════ 2 · WHAT IS WRITTEN ═════════════════════════ */

describe('2 · each parcel gets the order’s own rows — and nothing more', () => {
  it('one timeline line per moved parcel: «الشحن: مشحون ← خرج للتوصيل», by the person, with the trolley named', async () => {
    start({ orders: trolley(), batches: [BATCH(), BATCH({ id: 'b2', batchNumber: 'BATCH-2026-0008' })] });
    await press();

    expect(w.state.statusLogs).toHaveLength(3);
    for (const id of ['o1', 'o2', 'o3']) {
      const rows = w.state.statusLogs.filter((r) => r.orderId === id);
      expect(rows, id).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        companyId: COMPANY, orderId: id, statusType: 'SHIPPING',
        previousValue: 'SHIPPED', newValue: 'OUT_FOR_DELIVERY',
        changedById: STAFF, changedByRole: 'WAREHOUSE',
        note: 'خرجت الدفعة BATCH-2026-0007 للتوصيل',
      });
    }
  });

  it('one activity row per moved parcel, with the courier of the order and the person’s name', async () => {
    start({ orders: trolley(), batches: [BATCH(), BATCH({ id: 'b2', batchNumber: 'BATCH-2026-0008' })] });
    await press();

    expect(w.state.activities).toHaveLength(3);
    const row = w.state.activities.find((r) => r.orderId === 'o2')!;
    expect(row).toMatchObject({ companyId: COMPANY, userId: STAFF, action: 'SHIPPING_STATUS_CHANGED', previousStatus: 'SHIPPED', newStatus: 'OUT_FOR_DELIVERY' });
    expect(parse(row.metadata)).toEqual({ by: 'قبس', role: 'WAREHOUSE', provider: 'dp1', note: null });
  });

  it('one audit row per moved parcel — the order’s own shape — and ONE row for the press itself, with the counts', async () => {
    start({ orders: trolley(), batches: [BATCH(), BATCH({ id: 'b2', batchNumber: 'BATCH-2026-0008' })] });
    await press();

    const orders = w.state.audits.filter((a) => a.entity === 'Order');
    expect(orders).toHaveLength(3);
    const one = orders.find((a) => a.entityId === 'o1')!;
    expect(one).toMatchObject({ companyId: COMPANY, userId: STAFF, action: 'SHIPPING_STATUS_CHANGED', entity: 'Order' });
    expect(parse(one.previousData)).toEqual({ shippingStatus: 'SHIPPED', trackingNumber: 'BSH-1' });
    expect(parse(one.newData)).toEqual({ shippingStatus: 'OUT_FOR_DELIVERY', action: 'transition', by: 'قبس' });

    const press1 = w.state.audits.filter((a) => a.entity === 'ShippingBatch');
    expect(press1).toHaveLength(1);
    expect(press1[0]).toMatchObject({ companyId: COMPANY, userId: STAFF, action: 'SHIPPING_BATCH_OUT_FOR_DELIVERY', entityId: 'b1' });
    expect(parse(press1[0].newData)).toEqual({ status: 'OUT_FOR_DELIVERY', moved: 3, skipped: 4, failed: 0, by: 'قبس' });
    expect(w.state.audits, 'no other audit row').toHaveLength(4);
  });

  it('writes nothing else, anywhere: no event to the apps, no notification, no conversion, no stock, no wallet', async () => {
    start({ orders: trolley(), batches: [BATCH(), BATCH({ id: 'b2', batchNumber: 'BATCH-2026-0008' })] });
    await press();

    expect(emitAppEvent, 'OUT_FOR_DELIVERY announces nothing at the order’s door').not.toHaveBeenCalled();
    expect(notify).not.toHaveBeenCalled();
    expect(queueConversions).not.toHaveBeenCalled();
    // The strict world has no stock, wallet or ledger model — reaching for one would have thrown. What it was given, it used:
    expect([...w.touched].sort()).toEqual(['$transaction', 'auditLog', 'order', 'orderActivity', 'orderChangeRequest', 'orderStatusLog', 'shippingBatch']);
  });

  it('a parcel that did not move leaves no row at all', async () => {
    start({ orders: trolley(), batches: [BATCH(), BATCH({ id: 'b2', batchNumber: 'BATCH-2026-0008' })] });
    await press();
    for (const id of ['o4', 'o5', 'o6', 'o7', 'o11', 'o12', 'o13']) {
      expect(w.state.statusLogs.some((r) => r.orderId === id), `${id} status log`).toBe(false);
      expect(w.state.activities.some((r) => r.orderId === id), `${id} activity`).toBe(false);
      expect(w.state.audits.some((r) => r.entityId === id), `${id} audit`).toBe(false);
    }
  });

  it('pressing again changes nothing: no second row of any kind, no second step of the version, no second row for the press', async () => {
    start({ orders: trolley(), batches: [BATCH(), BATCH({ id: 'b2', batchNumber: 'BATCH-2026-0008' })] });
    await press();
    const afterFirst = JSON.stringify(w.state);

    const again = await press();

    expect(again.status).toBe(200);
    expect(again.body).toMatchObject({ moved: 0, skipped: 7, failed: 0 });
    expect(JSON.stringify(w.state), 'the second press wrote something').toBe(afterFirst);
  });
});

/* ═════════════════════════ 3 · WHO MAY PRESS ═════════════════════════ */

describe('3 · both keys, every time, before anything is read', () => {
  const cases: [string, Record<string, string>][] = [
    ['only the batches key', { 'ops.batches': 'ALL_COMPANY', 'orders.view': 'ALL_COMPANY' }],
    ['only the shipping-status key', { 'orders.view': 'ALL_COMPANY', 'orders.change_status': 'ALL_COMPANY' }],
    ['neither', { 'orders.view': 'ALL_COMPANY' }],
  ];

  it.each(cases)('%s: 403, in Arabic, and the world is not even read', async (_name, grants) => {
    start({ orders: trolley(), batches: [BATCH(), BATCH({ id: 'b2', batchNumber: 'BATCH-2026-0008' })] }, person(grants));
    const before = JSON.stringify(w.state);

    const res = await press();

    expect(res.status).toBe(403);
    expect(String(res.body.errorAr)).toMatch(/[؀-ۿ]/);
    expect(w.touched.size, 'something was read before the keys were asked').toBe(0);
    expect(JSON.stringify(w.state)).toBe(before);
  });

  it('the refusal names the missing key’s own words, so the person knows whom to ask', async () => {
    start({ orders: trolley() }, person({ 'ops.batches': 'ALL_COMPANY', 'orders.view': 'ALL_COMPANY' }));
    expect((await press()).body.errorAr).toContain('تغيير حالة الشحن');
    start({ orders: trolley() }, person({ 'orders.view': 'ALL_COMPANY', 'orders.change_status': 'ALL_COMPANY' }));
    expect((await press()).body.errorAr).toContain('دفعات الشحن');
  });

  it('an account that is not active holds no key at all', async () => {
    start({ orders: trolley() }, person(BOTH, { status: 'SUSPENDED' }));
    expect((await press()).status).toBe(403);
    expect(w.touched.size).toBe(0);
  });
});

describe('3b · the scope of `orders.change_status` is asked of EACH parcel', () => {
  it('«المسندة إليه»: the parcels she holds move, the others are named — OUT_OF_SCOPE — and stay untouched', async () => {
    start(
      {
        orders: [
          order(1, { claimedById: STAFF }), // hers by a claim
          order(2, { moderatorId: 'u-other' }), // somebody else's
          order(3, { currentOwnerId: STAFF }), // hers by ownership
        ],
      },
      person({ ...BOTH, 'orders.change_status': 'ASSIGNED' })
    );
    const before = structuredClone(orderRow('o2'));

    const res = await press();

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ moved: 2, skipped: 0, failed: 1, failedOrders: ['ORD-2026-0002'] });
    expect(res.body.failures[0]).toMatchObject({ orderNumber: 'ORD-2026-0002', code: 'OUT_OF_SCOPE' });
    expect(res.body.failures[0].errorAr).toMatch(/[؀-ۿ]/);
    expect(orderRow('o2'), 'the parcel that is not hers was written').toEqual(before);
    expect(orderRow('o1').shippingStatus).toBe('OUT_FOR_DELIVERY');
    expect(orderRow('o3').shippingStatus).toBe('OUT_FOR_DELIVERY');
    expect(w.state.statusLogs.map((r) => r.orderId).sort()).toEqual(['o1', 'o3']);
  });

  it('«طلباتي المنشأة»: only the parcels she entered herself', async () => {
    start(
      { orders: [order(1, { moderatorId: STAFF }), order(2, { moderatorId: 'u-other' })] },
      person({ ...BOTH, 'orders.change_status': 'OWN' })
    );
    const res = await press();
    expect(res.body).toMatchObject({ moved: 1, failed: 1, failedOrders: ['ORD-2026-0002'] });
  });

  it('a scope orders do not have (a category) moves nothing and names every parcel', async () => {
    start({ orders: [order(1), order(2)] }, person({ ...BOTH, 'orders.change_status': 'CATEGORY' }));
    const res = await press();
    expect(res.body).toMatchObject({ moved: 0, failed: 2 });
    expect(res.body.failures.every((f: Row) => f.code === 'OUT_OF_SCOPE')).toBe(true);
  });

  it('a parcel named for her that nobody holds yet is hers to TAKE, not to move (the held-row rule of `authorize`)', async () => {
    // NEW, unclaimed, named for her: the work doors do not count that name as ownership until she holds the order.
    start(
      { orders: [order(1, { assignedToId: STAFF, claimedById: null, confirmationStatus: 'NEW' })] },
      person({ ...BOTH, 'orders.change_status': 'ASSIGNED' })
    );
    const res = await press();
    expect(res.body.failures[0]).toMatchObject({ code: 'OUT_OF_SCOPE' });
    expect(orderRow('o1').shippingStatus).toBe('SHIPPED');
  });

  it('the owner (full access) is not asked a scope', async () => {
    start({ orders: [order(1, { moderatorId: 'u-other' })] }, person({}, { effectiveGrants: { fullAccess: true, grants: {} } }));
    const res = await press();
    expect(res.body).toMatchObject({ moved: 1, failed: 0 });
  });
});

/* ═════════════════════════ 4 · THE ORDER'S OWN GATES ═════════════════════════ */

describe('4 · every parcel is asked what the order’s door asks', () => {
  const future = () => new Date(Date.now() + 5 * 60_000);
  const past = () => new Date(Date.now() - 5 * 60_000);

  it('another person’s active edit lock stops THAT parcel (ORDER_LOCKED); the others go', async () => {
    start({ orders: [order(1), order(2, { lockedById: 'u-other', lockExpiresAt: future() }), order(3)] });
    const res = await press();
    expect(res.body).toMatchObject({ moved: 2, failed: 1, failedOrders: ['ORD-2026-0002'] });
    expect(res.body.failures[0].code).toBe('ORDER_LOCKED');
    expect(orderRow('o2').shippingStatus).toBe('SHIPPED');
    expect(orderRow('o3').shippingStatus, 'a refusal stops nothing behind it').toBe('OUT_FOR_DELIVERY');
  });

  it('…unless she may break locks (`orders.unlock`), or the lock is her own, or it has run out', async () => {
    start(
      {
        orders: [
          order(1, { lockedById: 'u-other', lockExpiresAt: future() }),
          order(2, { lockedById: STAFF, lockExpiresAt: future() }),
          order(3, { lockedById: 'u-other', lockExpiresAt: past() }),
        ],
      },
      person({ ...BOTH, 'orders.unlock': 'ALL_COMPANY' })
    );
    expect((await press()).body).toMatchObject({ moved: 3, failed: 0 });

    start(
      { orders: [order(2, { lockedById: STAFF, lockExpiresAt: future() }), order(3, { lockedById: 'u-other', lockExpiresAt: past() })] },
      person(BOTH)
    );
    expect((await press()).body, 'own lock and expired lock, without the unlock key').toMatchObject({ moved: 2, failed: 0 });
  });

  it('an order that is not confirmed cannot be sent out (CONFIRMATION_REQUIRED)', async () => {
    start({ orders: [order(1), order(2, { confirmationStatus: 'REJECTED' })] });
    const res = await press();
    expect(res.body).toMatchObject({ moved: 1, failed: 1, failedOrders: ['ORD-2026-0002'] });
    expect(res.body.failures[0].code).toBe('CONFIRMATION_REQUIRED');
    expect(orderRow('o2').shippingStatus).toBe('SHIPPED');
  });

  it('a BLOCKING change request waiting for an answer stops that parcel (CHANGE_REQUEST_PENDING)…', async () => {
    start({
      orders: [order(1), order(2), order(3)],
      requests: [{ id: 'r1', orderId: 'o2', companyId: COMPANY, status: 'PENDING', blocking: true, intent: 'EDIT', appliedAt: null, reason: 'x' }],
    });
    const res = await press();
    expect(res.body).toMatchObject({ moved: 2, failed: 1, failedOrders: ['ORD-2026-0002'] });
    expect(res.body.failures[0].code).toBe('CHANGE_REQUEST_PENDING');
    expect(orderRow('o2').shippingStatus).toBe('SHIPPED');
  });

  it('…and only a pending, blocking one: a request that does not block, or is already answered, or is about another parcel, stops nobody', async () => {
    start({
      orders: [order(1), order(2), order(3)],
      requests: [
        { id: 'r1', orderId: 'o1', companyId: COMPANY, status: 'PENDING', blocking: false, intent: 'EDIT', appliedAt: null, reason: 'x' },
        { id: 'r2', orderId: 'o2', companyId: COMPANY, status: 'APPROVED', blocking: true, intent: 'EDIT', appliedAt: null, reason: 'x' },
        { id: 'r3', orderId: 'o99', companyId: COMPANY, status: 'PENDING', blocking: true, intent: 'EDIT', appliedAt: null, reason: 'x' },
      ],
    });
    expect((await press()).body).toMatchObject({ moved: 3, failed: 0 });
  });

  it('the question is asked ONCE for the whole trolley, not once per parcel', async () => {
    start({ orders: [order(1), order(2), order(3)] });
    const spy = vi.spyOn((w.db as any).orderChangeRequest, 'findMany');
    await press();
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy.mock.calls[0][0].where).toEqual({ orderId: { in: ['o1', 'o2', 'o3'] }, status: 'PENDING', blocking: true });
  });

  it('the first gate that fails is the one named (scope before lock before confirmation before the request)', async () => {
    start(
      {
        orders: [order(1, { moderatorId: 'u-other', lockedById: 'u-other', lockExpiresAt: future(), confirmationStatus: 'REJECTED' })],
        requests: [{ id: 'r1', orderId: 'o1', companyId: COMPANY, status: 'PENDING', blocking: true, intent: 'EDIT', appliedAt: null, reason: 'x' }],
      },
      person({ ...BOTH, 'orders.change_status': 'ASSIGNED' })
    );
    expect((await press()).body.failures[0].code).toBe('OUT_OF_SCOPE');

    start(
      {
        orders: [order(1, { lockedById: 'u-other', lockExpiresAt: future(), confirmationStatus: 'REJECTED' })],
        requests: [{ id: 'r1', orderId: 'o1', companyId: COMPANY, status: 'PENDING', blocking: true, intent: 'EDIT', appliedAt: null, reason: 'x' }],
      }
    );
    expect((await press()).body.failures[0].code).toBe('ORDER_LOCKED');
  });
});

/* ═════════════════════════ 5 · A PARCEL THAT CHANGES UNDER THE PRESS ═════════════════════════ */

describe('5 · one parcel failing never stops the others, and nothing is half-written', () => {
  it('a version conflict on one parcel is reported for it; the rest move', async () => {
    start({ orders: [order(1), order(2), order(3)] });
    // Somebody edits o2 (its address, say) between the read and the write: the version moves, the status does not.
    w.hooks.beforeOrderWrite = (where, state) => {
      if (where.id === 'o2') state.orders.find((o) => o.id === 'o2')!.version += 1;
    };

    const res = await press();

    expect(res.body).toMatchObject({ moved: 2, skipped: 0, failed: 1, failedOrders: ['ORD-2026-0002'] });
    expect(res.body.failures[0]).toMatchObject({ code: 'VERSION_CONFLICT', orderNumber: 'ORD-2026-0002' });
    expect(orderRow('o2').shippingStatus).toBe('SHIPPED');
    expect(orderRow('o3').shippingStatus, 'a conflict stops nobody behind it').toBe('OUT_FOR_DELIVERY');
    expect(w.state.statusLogs.some((r) => r.orderId === 'o2'), 'a parcel that did not move has no line').toBe(false);
  });

  it('…and the first parcel failing does not stop the last one either (order of the loop)', async () => {
    start({ orders: [order(1), order(2), order(3)] });
    w.hooks.beforeOrderWrite = (where, state) => {
      if (where.id === 'o1') state.orders.find((o) => o.id === 'o1')!.version += 1;
    };
    const res = await press();
    expect(res.body).toMatchObject({ moved: 2, failed: 1, failedOrders: ['ORD-2026-0001'] });
    expect(orderRow('o3').shippingStatus).toBe('OUT_FOR_DELIVERY');
  });

  it('a parcel the courier’s poll (or the order’s door) moved first is SKIPPED, not failed — the two are idempotent against each other', async () => {
    start({ orders: [order(1), order(2), order(3)] });
    w.hooks.beforeOrderWrite = (where, state) => {
      if (where.id === 'o2') {
        const row = state.orders.find((o) => o.id === 'o2')!;
        row.shippingStatus = 'OUT_FOR_DELIVERY';
        row.version += 1;
        row.outForDeliveryAt = new Date('2026-11-02T09:30:00Z');
      }
    };

    const res = await press();

    expect(res.body).toMatchObject({ moved: 2, skipped: 1, failed: 0, failedOrders: [] });
    expect(orderRow('o2').outForDeliveryAt, 'the poll’s stamp is not overwritten').toEqual(new Date('2026-11-02T09:30:00Z'));
    expect(w.state.statusLogs.some((r) => r.orderId === 'o2'), 'no line written over the poll’s move').toBe(false);
  });

  it('a save that throws (the connection dropped) is named SAVE_FAILED, the parcel is rolled back whole, the rest go', async () => {
    start({ orders: [order(1), order(2), order(3)] });
    w.hooks.failCreate = (model, data) => model === 'orderActivity' && data.orderId === 'o2';
    const quiet = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    const res = await press();

    expect(res.body).toMatchObject({ moved: 2, failed: 1, failedOrders: ['ORD-2026-0002'] });
    expect(res.body.failures[0].code).toBe('SAVE_FAILED');
    expect(orderRow('o2').shippingStatus, 'the status stayed with its missing rows').toBe('SHIPPED');
    expect(orderRow('o2').version).toBe(2);
    expect(w.state.statusLogs.some((r) => r.orderId === 'o2'), 'its timeline line rolled back with it').toBe(false);
    expect(orderRow('o3').shippingStatus).toBe('OUT_FOR_DELIVERY');
    quiet.mockRestore();
  });

  it('the answer lists every parcel that did not move, with the reason of each, in the trolley’s order', async () => {
    start({
      orders: [order(1, { confirmationStatus: 'REJECTED' }), order(2), order(3, { lockedById: 'u-other', lockExpiresAt: new Date(Date.now() + 60_000) })],
    });
    const res = await press();
    expect(res.body.failedOrders).toEqual(['ORD-2026-0001', 'ORD-2026-0003']);
    expect(res.body.failures.map((f: Row) => f.code)).toEqual(['CONFIRMATION_REQUIRED', 'ORDER_LOCKED']);
    expect(Object.keys(res.body).sort()).toEqual(['failed', 'failedOrders', 'failures', 'moved', 'skipped', 'success', 'total']);
    expect(Object.keys(res.body.failures[0]).sort()).toEqual(['code', 'errorAr', 'orderNumber']);
  });
});

/* ═════════════════════════ 6 · THE TROLLEY ITSELF ═════════════════════════ */

describe('6 · the trolley is read inside the session’s company and store', () => {
  it('an unknown trolley: 404, in Arabic, nothing read after it', async () => {
    start({ orders: trolley() });
    const res = await press('nope');
    expect(res.status).toBe(404);
    expect(String(res.body.errorAr)).toContain('الدفعة غير موجودة');
    expect(w.touched.has('order'), 'the orders were read for a trolley that is not there').toBe(false);
  });

  it('another store’s trolley, and another company’s, are the same «not found»', async () => {
    start({ orders: trolley(), batches: [BATCH(), BATCH({ id: 'bs2', storeId: 's2' }), BATCH({ id: 'bc2', companyId: 'c2' })] });
    expect((await press('bs2')).status).toBe(404);
    expect((await press('bc2')).status).toBe(404);
    expect(w.touched.has('order')).toBe(false);
    expect(w.state.audits).toHaveLength(0);
  });

  it('an empty trolley is refused: 409 EMPTY_BATCH, in Arabic, nothing written', async () => {
    start({ orders: [order(11, { shippingBatchId: 'b2' })], batches: [BATCH(), BATCH({ id: 'b2' })] });
    const before = JSON.stringify(w.state);

    const res = await press();

    expect(res.status).toBe(409);
    expect(res.body.code).toBe('EMPTY_BATCH');
    expect(String(res.body.errorAr)).toContain('فاضية');
    expect(JSON.stringify(w.state)).toBe(before);
  });

  it('the status of the TROLLEY does not matter — the parcels do (a closed trolley with a parcel still at «مشحون» is moved too)', async () => {
    start({ orders: [order(1)], batches: [BATCH({ status: 'CLOSED' })] });
    expect((await press()).body).toMatchObject({ moved: 1 });
  });
});

/* ═════════════════════════ 7 · THE SAME MOVE, MEASURED ═════════════════════════ */

/**
 * "THE SAME" IS MEASURED BY RUNNING BOTH.
 *
 * A twin of the order in a second world is moved by the ORDER'S OWN DOOR (`POST /api/orders/:id/shipping`, `transition`); the
 * original is moved by the batch press. What each world holds afterwards must be the same, row by row — the order's columns, its
 * timeline line, its activity row, its audit row — except for the one sentence the batch press adds on purpose (which trolley).
 * If anyone gives the order's door a new effect (a message, a counter, a row), this fails until the batch press has it too.
 */
describe('7 · the batch press and the order’s own door leave the same trace', () => {
  const door = async (id: string, expectedVersion: number, extra: Row = {}) => {
    const res = await orderDoor(
      new Request(`http://localhost/api/orders/${id}/shipping`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'transition', to: 'OUT_FOR_DELIVERY', expectedVersion, ...extra }),
      }),
      { params: Promise.resolve({ id }) }
    );
    return { status: res.status, body: (await res.json()) as Row };
  };

  /** What a world holds about one order, without the things that differ by nature: ids, clocks. */
  const trace = (state: State, id: string) => {
    const strip = (r: Row): Row => Object.fromEntries(Object.entries(r).filter(([key]) => key !== 'id' && key !== 'createdAt'));
    const row = strip(state.orders.find((o) => o.id === id)!);
    row.outForDeliveryAt = row.outForDeliveryAt instanceof Date ? 'a Date' : row.outForDeliveryAt;
    return {
      row,
      statusLogs: state.statusLogs.filter((r) => r.orderId === id).map(strip),
      activities: state.activities.filter((r) => r.orderId === id).map(strip),
      audits: state.audits.filter((r) => r.entity === 'Order' && r.entityId === id).map(strip),
    };
  };

  it('the same columns, the same timeline line, the same activity row, the same audit row', async () => {
    // World A: the order’s own door, for a parcel with a typed tracking number and a courier.
    start({ orders: [order(1)] });
    const viaDoor = await door('o1', 2);
    expect(viaDoor.status, JSON.stringify(viaDoor.body)).toBe(200);
    const a = trace(w.state, 'o1');

    // World B: the identical parcel, moved by the batch press.
    start({ orders: [order(1)] });
    expect((await press()).status).toBe(200);
    const b = trace(w.state, 'o1');

    // The one sentence the press adds on purpose: which trolley it left with.
    expect(a.statusLogs[0].note).toBeNull();
    expect(b.statusLogs[0].note).toBe('خرجت الدفعة BATCH-2026-0007 للتوصيل');
    a.statusLogs[0].note = b.statusLogs[0].note = '·';

    expect(b.row).toEqual(a.row);
    expect(b.statusLogs).toEqual(a.statusLogs);
    expect(b.activities).toEqual(a.activities);
    expect(b.audits).toEqual(a.audits);
    // …and the world is not empty (a comparison of two empty traces would pass any mutation).
    expect(a.statusLogs).toHaveLength(1);
    expect(a.activities).toHaveLength(1);
    expect(a.audits).toHaveLength(1);
    expect(a.row.shippingStatus).toBe('OUT_FOR_DELIVERY');
    expect(a.row.outForDeliveryAt).toBe('a Date');
  });

  it('neither of them announces anything to the apps, notifies, or queues a conversion', async () => {
    start({ orders: [order(1)] });
    await door('o1', 2);
    start({ orders: [order(1)] });
    await press();
    expect(emitAppEvent).not.toHaveBeenCalled();
    expect(notify).not.toHaveBeenCalled();
    expect(queueConversions).not.toHaveBeenCalled();
  });

  /**
   * THE REFUSALS. Each row builds a parcel the order’s door refuses, and checks that the batch press refuses the SAME parcel for
   * the same reason: the order’s door by its code, the press by its failure code.
   */
  const future = () => new Date(Date.now() + 5 * 60_000);
  const requestOn = (status: string, blocking: boolean) => [
    { id: 'r1', orderId: 'o1', companyId: COMPANY, status, blocking, intent: 'EDIT', appliedAt: null, reason: 'x' },
  ];

  const refusals: {
    name: string;
    seed: () => Parameters<typeof makeWorld>[0];
    user?: () => SessionUser;
    door: { status: number; code?: string };
    press: string;
  }[] = [
    {
      name: 'another person is editing it',
      seed: () => ({ orders: [order(1, { lockedById: 'u-other', lockExpiresAt: future() })] }),
      door: { status: 423, code: 'ORDER_LOCKED' },
      press: 'ORDER_LOCKED',
    },
    {
      name: 'it is not confirmed',
      seed: () => ({ orders: [order(1, { confirmationStatus: 'REJECTED' })] }),
      door: { status: 409, code: 'CONFIRMATION_REQUIRED' },
      press: 'CONFIRMATION_REQUIRED',
    },
    {
      name: 'a blocking change request is waiting',
      seed: () => ({ orders: [order(1)], requests: requestOn('PENDING', true) }),
      door: { status: 409, code: 'CHANGE_REQUEST_PENDING' },
      press: 'CHANGE_REQUEST_PENDING',
    },
    {
      name: 'it is not hers (the scope of the key)',
      seed: () => ({ orders: [order(1, { moderatorId: 'u-other' })] }),
      user: () => person({ ...BOTH, 'orders.change_status': 'ASSIGNED', 'orders.view': 'ALL_COMPANY' }),
      door: { status: 403 },
      press: 'OUT_OF_SCOPE',
    },
  ];

  it.each(refusals)('refused alike — $name', async (c) => {
    start(c.seed(), c.user?.());
    const viaDoor = await door('o1', 2);
    expect(viaDoor.status, JSON.stringify(viaDoor.body)).toBe(c.door.status);
    if (c.door.code) expect(viaDoor.body.code).toBe(c.door.code);
    expect(orderRow('o1').shippingStatus, 'the order’s door wrote').toBe('SHIPPED');

    start(c.seed(), c.user?.());
    const viaPress = await press();
    expect(viaPress.body.failures[0]?.code, JSON.stringify(viaPress.body)).toBe(c.press);
    expect(orderRow('o1').shippingStatus, 'the press wrote').toBe('SHIPPED');
    expect(w.state.statusLogs).toHaveLength(0);
  });

  it('a parcel that is not «مشحون» is refused by the order’s door (INVALID_TRANSITION) and SKIPPED by the press — the one deliberate difference', async () => {
    const seed = () => ({ orders: [order(1, { shippingStatus: 'OUT_FOR_DELIVERY', outForDeliveryAt: new Date('2026-11-02T09:00:00Z') })] });
    start(seed());
    const viaDoor = await door('o1', 2);
    expect(viaDoor.status).toBe(409);
    expect(viaDoor.body.code).toBe('INVALID_TRANSITION');

    start(seed());
    const viaPress = await press();
    expect(viaPress.status).toBe(200);
    expect(viaPress.body).toMatchObject({ moved: 0, skipped: 1, failed: 0 });
  });

  it('ONE transition table: close «مشحون» → «خرج للتوصيل» in it and BOTH doors refuse; the press names INVALID_TRANSITION and writes nothing', async () => {
    table.closed = true;
    start({ orders: [order(1)] });
    const viaDoor = await door('o1', 2);
    expect(viaDoor.status).toBe(409);
    expect(viaDoor.body.code).toBe('INVALID_TRANSITION');

    start({ orders: [order(1), order(2)] });
    const res = await press();
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ moved: 0, skipped: 0, failed: 2 });
    expect(res.body.failures.map((f: Row) => f.code)).toEqual(['INVALID_TRANSITION', 'INVALID_TRANSITION']);
    expect(orderRow('o1').shippingStatus).toBe('SHIPPED');
    expect(w.state.statusLogs).toHaveLength(0);
    expect(w.state.audits, 'a press that moved nothing leaves no row').toHaveLength(0);
  });

  it('a stale version: the order’s door says VERSION_CONFLICT, the press says VERSION_CONFLICT for that parcel', async () => {
    start({ orders: [order(1)] });
    const viaDoor = await door('o1', 1); // the screen held version 1; the parcel is at 2
    expect(viaDoor.status).toBe(409);
    expect(viaDoor.body.code).toBe('VERSION_CONFLICT');

    start({ orders: [order(1)] });
    w.hooks.beforeOrderWrite = (_where, state) => { state.orders[0].version += 1; };
    expect((await press()).body.failures[0].code).toBe('VERSION_CONFLICT');
  });
});

/* ═════════════════════════ 8 · ONE DEFINITION, NOT TWO COPIES ═════════════════════════ */

describe('8 · the two doors share their definitions in the SOURCE, not by coincidence', () => {
  const src = (rel: string) => stripComments(readFileSync(join(process.cwd(), rel), 'utf8'));
  const orderRoute = src('src/app/api/orders/[id]/shipping/route.ts');
  const batchLib = src('src/lib/batch-out-for-delivery.ts');
  const batchRoute = src('src/app/api/shipping-batches/[id]/out-for-delivery/route.ts');

  it('both write the move through the same four functions of `shipping-move`, and neither writes the rows by hand', () => {
    for (const fn of ['shippingMoveColumns', 'recordShippingMove', 'shippingAuditEntry', 'editLockHeldByAnother']) {
      expect(orderRoute, `the order’s door no longer calls ${fn}`).toMatch(new RegExp(`\\b${fn}\\(`));
      expect(batchLib, `the batch press no longer calls ${fn}`).toMatch(new RegExp(`\\b${fn}\\(`));
    }
    // The order’s door writes other activity rows (a courier assigned, a fee changed); the MOVE’s row is the one named below.
    const writesTheMoveActivity = (s: string) =>
      [...s.matchAll(/orderActivity\.create\(/g)].some((m) => s.slice(m.index!, m.index! + 300).includes("'SHIPPING_STATUS_CHANGED'"));
    for (const file of [orderRoute, batchLib]) {
      expect(file, 'a timeline line written by hand').not.toMatch(/orderStatusLog\.create\(/);
      expect(writesTheMoveActivity(file), 'the move’s activity row written by hand').toBe(false);
      expect(file, 'the status columns written by hand').not.toMatch(/\bSTATUS_TIMESTAMP\b/);
    }
    // …and the detector sees what it is looking for, or the line above proves nothing.
    expect(writesTheMoveActivity(src('src/lib/shipping-move.ts'))).toBe(true);
  });

  it('both ask the confirmation rule and the transition table of `shipping-workflow`', () => {
    for (const fn of ['canEnterShipping', 'isValidShippingTransition']) {
      expect(orderRoute, fn).toMatch(new RegExp(`\\b${fn}\\(`));
      expect(batchLib, fn).toMatch(new RegExp(`\\b${fn}\\(`));
    }
  });

  it('both ask the blocking-request predicate in the same words, and the order’s door still blocks OUT_FOR_DELIVERY with it', () => {
    expect(orderRoute).toMatch(/status: 'PENDING', blocking: true/);
    expect(batchLib).toMatch(/status: 'PENDING', blocking: true/);
    const forward = orderRoute.slice(orderRoute.indexOf('const FORWARD = ['));
    expect(forward.slice(0, forward.indexOf(']'))).toContain("'OUT_FOR_DELIVERY'");
  });

  it('the press asks the order scope of `orders.change_status` per parcel, with the real `authorize`', () => {
    expect(batchLib).toMatch(/authorize\(user, 'orders\.change_status', m\)/);
    expect(orderRoute).toMatch(/authorize\(user, 'orders\.change_status', order\)/);
  });

  it('the press cannot reach what OUT_FOR_DELIVERY never touches: stock, events, notices, conversions, attempts, money', () => {
    for (const forbidden of [
      'consumeOrderStock', 'emitAppEvent', 'notify', 'queueConversions', 'appendDeliveryAttempt', 'computeCod', 'codForOrder',
      'inventoryMovement', 'walletMovement', 'totalAmount', 'sellingPrice', 'discountAmount', 'estimatedCostOfGoods',
    ]) {
      expect(batchLib, `${forbidden} in the batch press`).not.toContain(forbidden);
      expect(batchRoute, `${forbidden} in the batch door`).not.toContain(forbidden);
    }
  });

  it('the door asks both keys before it reads a batch', () => {
    const body = batchRoute.slice(batchRoute.indexOf('export async function POST'));
    const batches = body.indexOf("can(user, 'ops.batches')");
    const move = body.indexOf("can(user, 'orders.change_status')");
    const read = body.indexOf('db.shippingBatch.findFirst');
    expect(batches, 'ops.batches is not asked').toBeGreaterThan(-1);
    expect(move, 'orders.change_status is not asked').toBeGreaterThan(-1);
    expect(read).toBeGreaterThan(Math.max(batches, move));
    expect(body).toMatch(/where: \{ id, companyId, storeId \}/);
  });
});
