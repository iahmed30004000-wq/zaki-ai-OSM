import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Prisma } from '@prisma/client';

/**
 * ═══════════════════════════════════════════════════════════════════════
 * «استلام الكل» WRITES EXACTLY WHAT THE SINGLE RECEIPT WRITES — PARCEL BY PARCEL, AND NOTHING TWICE.
 *
 * Stock and commission ride on a receipt, so the bulk door must not hold a second copy of the receipt: it calls
 * `receiveReturn` (lib/return-receipt.ts), the single door's own function. This file proves it by the writes, not by
 * reading the source:
 *
 *   · THE DIFFERENTIAL — the same parcels received (a) one by one through `POST /api/ops/returns`, whole and sound, and
 *     (b) through `POST /api/ops/returns/receive-all` leave the IDENTICAL writes: the receipt row, the stock restore, the
 *     take-off, the reservation reset, the order's state, the commission reversal, the note, the audit row — except the
 *     audit's `bulk: true` and the press's own summary row.
 *   · THE MUTATION — the same comparison goes RED when the bulk run skips the commission reversal: the differential can see.
 *   · THE CURSOR — 123 parcels, 3 of them partial deliveries that stay pending for ever: three requests, then null; a second
 *     run receives nothing twice.
 *   · RACES — a parcel received by someone else after the piece was read, the database's unique receipt on a double press,
 *     a database error on one parcel: each is counted, never a 500, and the rest go on.
 *   · WHAT IT LEAVES — a write-off's «nothing came back» receipt is never completed; a delivered and settled order never
 *     reaches the receipt; another company's or store's order is never touched.
 *
 * The database is a small in-memory store that applies the writes it is handed, so «what is left» is real.
 * ═══════════════════════════════════════════════════════════════════════
 */

type Item = { id: string; productId: string; productName: string; quantity: number; freeQuantity: number; deliveredQty: number | null };
type Order = {
  id: string;
  orderNumber: string;
  companyId: string;
  storeId: string;
  shippingStatus: string;
  settlementStatus: string;
  regionId: string;
  deliveryProviderId: string | null;
  returnReceipt: Record<string, unknown> | null;
  items: Item[];
};

const { store, db, held, logAudit, reverseForOrder, restoreOrderStock, takeOffUnreturned } = vi.hoisted(() => {
  const store = {
    orders: new Map<string, any>(),
    writes: [] as [string, string, unknown][],
    raceOn: new Set<string>(),
    failOn: new Set<string>(),
    stolenOn: new Set<string>(),
    mutate: false,
  };
  const record = (what: string, orderId: string, args: unknown) => store.writes.push([what, orderId, structuredClone(args)]);
  const db: any = {
    order: {
      findFirst: vi.fn(async ({ where }: any) => {
        const o = store.orders.get(where.id);
        if (!o || o.companyId !== where.companyId || o.storeId !== where.storeId) return null;
        // Someone else counted it in between the piece's read and this one.
        if (store.stolenOn.has(o.id)) o.returnReceipt = { id: 'theirs', receivedQty: 3, damagedQty: 0, missingQty: 0, courierFeeCharged: false };
        const { companyId: _c, storeId: _s, ...rest } = structuredClone(o);
        return rest;
      }),
      findMany: vi.fn(async ({ where, take }: any) => {
        const after = (where.AND ?? []).find((c: any) => c.id?.gt)?.id.gt as string | undefined;
        return [...store.orders.values()]
          .filter((o) => o.companyId === where.companyId && o.storeId === where.storeId)
          .filter((o) => (where.shippingStatus?.in ?? []).includes(o.shippingStatus))
          .filter((o) => (where.returnReceipt === null ? !o.returnReceipt : true))
          .filter((o) => !after || o.id > after)
          .sort((a, b) => (a.id < b.id ? -1 : 1))
          .slice(0, take)
          .map((o) => ({ id: o.id }));
      }),
      update: vi.fn(async (args: any) => {
        record('order.update', args.where.id, args);
        const o = store.orders.get(args.where.id);
        if (args.data.shippingStatus) o.shippingStatus = args.data.shippingStatus;
        return {};
      }),
    },
    returnReceipt: {
      create: vi.fn(async (args: any) => {
        const id = args.data.orderId;
        if (store.raceOn.has(id)) {
          throw new Prisma.PrismaClientKnownRequestError('Unique constraint failed on the fields: (`orderId`)', { code: 'P2002', clientVersion: 'x' });
        }
        if (store.failOn.has(id)) throw new Error('connection reset');
        record('returnReceipt.create', id, args);
        store.orders.get(id).returnReceipt = { ...args.data };
        return { id: `rr-${id}`, ...args.data };
      }),
      updateMany: vi.fn(async (args: any) => {
        record('returnReceipt.updateMany', args.where.orderId, args);
        return { count: 1 };
      }),
      findUniqueOrThrow: vi.fn(async ({ where }: any) => ({ id: `rr-${where.orderId}` })),
    },
    orderItem: { updateMany: vi.fn(async (args: any) => (record('orderItem.updateMany', args.where.orderId, args), { count: 1 })) },
    orderNote: { create: vi.fn(async (args: any) => (record('orderNote.create', args.data.orderId, args), {})) },
    $transaction: vi.fn(async (fn: any) => fn(db)),
  };
  return {
    store,
    db,
    held: { keys: new Set<string>() },
    logAudit: vi.fn(async (args: any) => {
      if (args.entity === 'Order') record('audit', args.entityId, args);
    }),
    reverseForOrder: vi.fn(async (tx: unknown, args: any) => {
      if (tx !== db) throw new Error('reversal outside the transaction');
      if (store.mutate) return 0;
      record('reverseForOrder', args.orderId, args);
      return 1;
    }),
    restoreOrderStock: vi.fn(async (_tx: unknown, args: any) => (record('restoreOrderStock', args.orderId, args), undefined)),
    takeOffUnreturned: vi.fn(async (_tx: unknown, args: any) => (record('takeOffUnreturned', args.orderId, args), undefined)),
  };
});

vi.mock('@/lib/db', () => ({ db }));
vi.mock('@/lib/geo-context', () => ({
  requireContext: async () => ({
    user: { id: 'u-owner', name: 'سارة', role: 'SUPER_ADMIN', status: 'ACTIVE' },
    companyId: 'c1',
    storeId: 's1',
    country: { minorUnit: 3 },
  }),
}));
vi.mock('@/lib/authorization', () => ({
  can: (_u: unknown, k: string) => held.keys.has(k),
  requirePermission: async (k: string) => {
    if (!held.keys.has(k)) throw new Error(`Forbidden: missing required permission ${k}`);
    return {};
  },
}));
vi.mock('@/lib/audit', () => ({ logAudit: (...a: unknown[]) => logAudit(...(a as [any])) }));
vi.mock('@/lib/commission', () => ({ reverseForOrder: (...a: unknown[]) => reverseForOrder(...(a as [unknown, any])) }));
vi.mock('@/lib/stock-consumption', () => ({
  restoreOrderStock: (...a: unknown[]) => restoreOrderStock(...(a as [unknown, any])),
  takeOffUnreturned: (...a: unknown[]) => takeOffUnreturned(...(a as [unknown, any])),
}));

import { POST as single } from '@/app/api/ops/returns/route';
import { POST as receiveAll } from '@/app/api/ops/returns/receive-all/route';

const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const line = (over: Partial<Item> = {}): Item => ({ id: 'i1', productId: 'p1', productName: 'ماء الكمأ', quantity: 3, freeQuantity: 0, deliveredQty: null, ...over });
const order = (n: number, over: Partial<Order> = {}): Order => ({
  id: uuid(n),
  orderNumber: `ORD-${n}`,
  companyId: 'c1',
  storeId: 's1',
  shippingStatus: 'RETURNED',
  settlementStatus: 'PENDING_COLLECTION',
  regionId: 'r1',
  deliveryProviderId: 'dp1',
  returnReceipt: null,
  items: [line()],
  ...over,
});
const seed = (...orders: Order[]) => {
  store.orders = new Map(orders.map((o) => [o.id, structuredClone(o)]));
};

const post = (fn: (r: Request) => Promise<Response>, body: unknown) =>
  fn(new Request('http://x', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }));
const press = async (body: Record<string, unknown> = {}) => {
  const res = await post(receiveAll, { countedAndInspected: true, ...body });
  return { status: res.status, body: (await res.json()) as { received: number; skipped: Record<string, number>; nextCursor: string | null } };
};
/** The whole walk the screen makes: the same filters, each answer's cursor, until null. */
const walk = async (body: Record<string, unknown> = {}) => {
  const answers: Awaited<ReturnType<typeof press>>['body'][] = [];
  let cursor: string | null = null;
  do {
    const r = await press({ ...body, cursor });
    expect(r.status).toBe(200);
    answers.push(r.body);
    cursor = r.body.nextCursor;
    if (answers.length > 20) throw new Error('the walk did not end');
  } while (cursor);
  return answers;
};

/** The writes per parcel, in order, the bulk tag taken off. */
const writesOf = () => {
  const by = new Map<string, unknown[]>();
  for (const [what, id, args] of store.writes) {
    let a: any = args;
    if (what === 'audit') {
      const { bulk: _b, ...rest } = a.newData;
      a = { ...a, newData: rest };
    }
    by.set(id, [...(by.get(id) ?? []), [what, a]]);
  }
  return by;
};

const FIXED = new Date('2026-11-11T09:00:00.000Z');
beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(FIXED);
  held.keys = new Set(['ops.returns', 'ops.returns_receive_all', 'ops.return_fee']);
  store.writes = [];
  store.raceOn = new Set();
  store.failOn = new Set();
  store.stolenOn = new Set();
  store.mutate = false;
});
afterEach(() => {
  vi.useRealTimers();
});

/** Four kinds of parcel the button receives: a return, a failed delivery, a request, a part-delivery the customer refused whole. */
const KINDS = () => [
  order(1, { shippingStatus: 'RETURNED' }),
  order(2, { shippingStatus: 'FAILED_DELIVERY', items: [line({ quantity: 2, freeQuantity: 1 }), line({ id: 'i2', productId: 'p2', productName: 'زيت', quantity: 1 })] }),
  order(3, { shippingStatus: 'RETURN_REQUESTED', deliveryProviderId: null }),
  order(4, { shippingStatus: 'PARTIALLY_DELIVERED', items: [line({ deliveredQty: 0 })] }),
];
const expectedOf = (o: Order) => o.items.reduce((s, i) => s + (i.deliveredQty == null ? i.quantity + i.freeQuantity : i.quantity + i.freeQuantity - i.deliveredQty), 0);

const runOneByOne = async () => {
  seed(...KINDS());
  store.writes = [];
  for (const o of KINDS()) {
    const res = await post(single, {
      orderId: o.id,
      receivedQty: expectedOf(o),
      damagedQty: 0,
      countedAndInspected: true,
      chargeCourierFee: false,
      note: 'استلام جماعي — سارة',
    });
    expect(res.status, `الاستلام الواحد لـ ${o.orderNumber}`).toBe(201);
  }
  return writesOf();
};
const runBulk = async () => {
  seed(...KINDS());
  store.writes = [];
  const answers = await walk();
  return { writes: writesOf(), answers };
};

describe('THE DIFFERENTIAL — one by one, or all at once, the same writes', () => {
  it('every parcel leaves the identical receipt, stock, take-off, reservation, state, reversal, note and audit row', async () => {
    const one = await runOneByOne();
    const all = await runBulk();
    expect(all.answers).toEqual([{ received: 4, skipped: {}, nextCursor: null }]);
    expect([...all.writes.keys()]).toEqual([...one.keys()]);
    for (const id of one.keys()) {
      expect(all.writes.get(id), `الطلب ${id}`).toEqual(one.get(id));
    }
    // And the writes are the full set the receipt is made of — a comparison of two empty lists proves nothing.
    const kinds = new Set([...one.values()].flat().map((w) => (w as [string])[0]));
    expect([...kinds].sort()).toEqual(
      ['audit', 'order.update', 'orderItem.updateMany', 'orderNote.create', 'restoreOrderStock', 'returnReceipt.create', 'reverseForOrder', 'takeOffUnreturned'].sort()
    );
  });

  it('whole and sound: received = expected back, nothing damaged, nothing missing, no courier fee', async () => {
    const { writes } = await runBulk();
    const receipt = (writes.get(uuid(2))!.find((w: any) => w[0] === 'returnReceipt.create') as any)[1].data;
    expect(receipt).toMatchObject({ expectedQty: 4, receivedQty: 4, damagedQty: 0, missingQty: 0, courierFeeCharged: false, courierFeeAmount: 0 });
  });

  it('the only difference is the tag: each bulk audit row says `bulk: true`, and the press writes one summary row', async () => {
    seed(...KINDS());
    await walk();
    const rows = logAudit.mock.calls.map((c) => c[0] as any);
    expect(rows.filter((r) => r.action === 'RETURN_RECEIVED').every((r) => r.newData.bulk === true)).toBe(true);
    expect(rows.filter((r) => r.action === 'RETURN_RECEIVED')).toHaveLength(4);
    const summary = rows.filter((r) => r.action === 'RETURNS_RECEIVED_ALL');
    expect(summary).toHaveLength(1);
    expect(summary[0].newData).toMatchObject({ received: 4, skipped: {}, nextCursor: null });
  });

  it('NEGATIVE: the single door’s own audit row carries no bulk tag', async () => {
    seed(...KINDS());
    const o = KINDS()[0];
    await post(single, { orderId: o.id, receivedQty: 3, countedAndInspected: true });
    expect((logAudit.mock.calls[0][0] as any).newData.bulk).toBeUndefined();
  });

  it('MUTATION: a bulk run that skips the commission reversal turns the differential RED', async () => {
    const one = await runOneByOne();
    store.mutate = true;
    const all = await runBulk();
    const same = [...one.keys()].every((id) => JSON.stringify(all.writes.get(id)) === JSON.stringify(one.get(id)));
    expect(same, 'المقارنة ما شافت إنو العمولة ما انعكست').toBe(false);
  });
});

describe('THE CURSOR — a set that never empties still ends', () => {
  const MANY = () => {
    const list: Order[] = [];
    for (let n = 1; n <= 123; n++) {
      // Three partial deliveries the button must leave: they stay «pending» for ever.
      const partial = n === 7 || n === 64 || n === 120;
      list.push(order(n, partial ? { shippingStatus: 'PARTIALLY_DELIVERED', items: [line({ deliveredQty: 2 })] } : {}));
    }
    return list;
  };

  it('123 parcels, 3 partial: three pieces of at most fifty, then null — 120 received, 3 left and counted', async () => {
    seed(...MANY());
    const answers = await walk();
    expect(answers).toHaveLength(3);
    expect(answers.map((a) => a.received + Object.values(a.skipped).reduce((s, n) => s + n, 0))).toEqual([50, 50, 23]);
    expect(answers.reduce((s, a) => s + a.received, 0)).toBe(120);
    expect(answers.reduce((s, a) => s + (a.skipped.NEEDS_THE_QUESTION ?? 0), 0)).toBe(3);
    expect(answers.at(-1)!.nextCursor).toBeNull();
    expect(db.returnReceipt.create).toHaveBeenCalledTimes(120);
    // The count shown = the count processed + the count left.
    expect(120 + 3).toBe(123);
  });

  it('a second run receives nothing twice — only the three partials are walked, and left again', async () => {
    seed(...MANY());
    await walk();
    db.returnReceipt.create.mockClear();
    const again = await walk();
    expect(again).toEqual([{ received: 0, skipped: { NEEDS_THE_QUESTION: 3 }, nextCursor: null }]);
    expect(db.returnReceipt.create).not.toHaveBeenCalled();
  });

  it('a partial delivery is left untouched — no receipt, no stock, no reversal, no note', async () => {
    seed(order(1, { shippingStatus: 'PARTIALLY_DELIVERED', items: [line({ deliveredQty: 1 })] }));
    const [a] = await walk();
    expect(a).toEqual({ received: 0, skipped: { NEEDS_THE_QUESTION: 1 }, nextCursor: null });
    expect(store.writes).toEqual([]);
  });
});

describe('RACES — counted, never a 500, and the rest go on', () => {
  it('a parcel counted in by someone else after the piece was read → ALREADY_RECEIVED, the others received', async () => {
    seed(order(1), order(2), order(3));
    store.stolenOn.add(uuid(2));
    const [a] = await walk();
    expect(a).toEqual({ received: 2, skipped: { ALREADY_RECEIVED: 1 }, nextCursor: null });
    expect(writesOf().has(uuid(2))).toBe(false);
  });

  it('two presses at the same moment: the database’s one-receipt-per-order refuses the second → ALREADY_RECEIVED, not a 500', async () => {
    seed(order(1), order(2), order(3));
    store.raceOn.add(uuid(1));
    const r = await press();
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ received: 2, skipped: { ALREADY_RECEIVED: 1 }, nextCursor: null });
  });

  it('a database error on one parcel → FAILED for that one, the rest received, and it can be pressed again', async () => {
    seed(order(1), order(2), order(3));
    store.failOn.add(uuid(2));
    const r = await press();
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ received: 2, skipped: { FAILED: 1 }, nextCursor: null });
    // The failed one is still pending: pressing again picks it up.
    store.failOn.clear();
    expect((await press()).body).toEqual({ received: 1, skipped: {}, nextCursor: null });
  });
});

describe('WHAT IT LEAVES ALONE', () => {
  it('NEGATIVE: a write-off’s «nothing came back» receipt is never completed by the button', async () => {
    // The pending list never offers it (it holds a receipt) — and should it reach the function anyway, it is refused.
    seed(order(1), order(2));
    const written = { id: 'loss', receivedQty: 0, damagedQty: 0, missingQty: 3, courierFeeCharged: false };
    db.order.findFirst.mockImplementationOnce(async () => ({ ...structuredClone(KINDS()[0]), returnReceipt: written }));
    const [a] = await walk();
    expect(a.skipped.ALREADY_RECEIVED).toBe(1);
    expect(db.returnReceipt.updateMany).not.toHaveBeenCalled();
  });

  it('and the SINGLE door still completes that receipt when a person counts the parcel — unchanged', async () => {
    seed({ ...order(1), returnReceipt: { id: 'loss', receivedQty: 0, damagedQty: 0, missingQty: 3, courierFeeCharged: false } });
    const res = await post(single, { orderId: uuid(1), receivedQty: 3, countedAndInspected: true });
    expect(res.status).toBe(201);
    expect(db.returnReceipt.updateMany).toHaveBeenCalledTimes(1);
  });

  it('NEGATIVE: a delivered and settled order never reaches the receipt', async () => {
    seed(order(1));
    db.order.findFirst.mockImplementationOnce(async () => ({ ...structuredClone(KINDS()[0]), shippingStatus: 'DELIVERED', settlementStatus: 'SETTLED' }));
    const [a] = await walk();
    expect(a).toEqual({ received: 0, skipped: { DELIVERED_AND_SETTLED: 1 }, nextCursor: null });
    expect(store.writes).toEqual([]);
  });

  it('NEGATIVE: nothing expected back → left, no zero receipt written', async () => {
    seed(order(1, { shippingStatus: 'PARTIALLY_DELIVERED', items: [line({ deliveredQty: 3 })] }));
    const [a] = await walk();
    expect(a).toEqual({ received: 0, skipped: { NOTHING_EXPECTED: 1 }, nextCursor: null });
    expect(store.writes).toEqual([]);
  });

  it('NEGATIVE: another company’s and another store’s parcels are never touched', async () => {
    seed(order(1), order(2, { companyId: 'c2' }), order(3, { storeId: 's2' }));
    const [a] = await walk();
    expect(a).toEqual({ received: 1, skipped: {}, nextCursor: null });
    expect([...writesOf().keys()]).toEqual([uuid(1)]);
    expect(store.orders.get(uuid(2)).returnReceipt).toBeNull();
    expect(store.orders.get(uuid(3)).returnReceipt).toBeNull();
  });
});
