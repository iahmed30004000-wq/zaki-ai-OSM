import { describe, expect, it, vi } from 'vitest';

vi.mock('./db', () => ({ db: {} }));

import { CONFIRMATION_STATUSES } from './confirmation-workflow';
import { SHIPPING_GONE } from './order-state';
import { SEALED_BATCH_STATUSES } from './order-seal';
import { findRecentTwins } from './recent-twin-order';
import { SHIPPING_STATUSES } from './shipping-workflow';
import { TWIN_CONFIRMED_CODE } from './twin-refusal';
import {
  MAX_TWINS_NAMED,
  TWIN_CONFIRM_ACK_ACTION,
  TWIN_CONFIRM_WINDOW_HOURS,
  findConfirmedTwins,
  guardConfirmAgainstTwins,
  recordTwinAcknowledged,
  sameProductWhere,
  twinConfirmedBody,
} from './confirmed-twin';

/**
 * ═══════════════════════════════════════════════════════════════════════
 * WHAT A CONFIRMED TWIN IS — THE TABLE (the owner, 2/11: «زبون بعت الطلب 3 مرات … بنزلو 3 طلبات مؤكدة»)
 *
 * The database below is not told what to return. It holds real-looking orders and answers the query's own `where` the way Postgres
 * would (equality, null, `in`, `notIn`, `not`, `gte`, `AND`, `OR`, `items.some`, `shippingBatch.is`), then sorts, cuts and projects
 * as the query asks. A window that is widened, a status that is let in, a product test that is loosened or a handover line that is
 * moved changes the ANSWER — which is what a test of a detector has to be able to see. An operator it does not know throws.
 * ═══════════════════════════════════════════════════════════════════════
 */

const NOW = new Date('2026-11-02T12:00:00.000Z');
const hoursBefore = (h: number) => new Date(NOW.getTime() - h * 3_600_000);

type Row = Record<string, unknown> & {
  id: string;
  orderNumber: string;
  companyId: string;
  storeId: string | null;
  customerId: string;
  productId: string;
  items: { productId: string }[];
  confirmationStatus: string;
  replacesOrderId: string | null;
  createdAt: Date;
  confirmedAt: Date | null;
  confirmedById: string | null;
  shippingStatus: string;
  shippedAt: Date | null;
  shippingBatchId: string | null;
  shippingBatch: { status: string } | null;
};

const USERS: Record<string, string> = { u1: 'سارة', u2: 'ريم' };

const twin = (over: Partial<Row> & Pick<Row, 'id'>): Row => ({
  orderNumber: `ORD-${over.id}`,
  companyId: 'co1',
  storeId: 's1',
  customerId: 'cu1',
  productId: 'p1',
  items: [{ productId: 'p1' }],
  confirmationStatus: 'CONFIRMED',
  replacesOrderId: null,
  createdAt: hoursBefore(5),
  confirmedAt: hoursBefore(4),
  confirmedById: 'u1',
  shippingStatus: 'NOT_READY',
  shippedAt: null,
  shippingBatchId: null,
  shippingBatch: null,
  ...over,
});

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Where = any;

function holds(value: unknown, filter: Where): boolean {
  if (filter === null) return value === null || value === undefined;
  if (filter instanceof Date) return value instanceof Date && +value === +filter;
  if (typeof filter !== 'object') return value === filter;
  return Object.entries(filter as Record<string, unknown>).every(([op, arg]) => {
    switch (op) {
      case 'in':
        return (arg as unknown[]).includes(value);
      case 'notIn':
        return !(arg as unknown[]).includes(value);
      case 'not':
        return !holds(value, arg);
      case 'gte':
        return value instanceof Date && +value >= +(arg as Date);
      default:
        throw new Error(`the fake database does not know the operator «${op}» — teach it before trusting it`);
    }
  });
}

function matches(row: Row, where: Where): boolean {
  return Object.entries(where as Record<string, unknown>).every(([key, value]) => {
    if (key === 'AND') return (Array.isArray(value) ? value : [value]).every((w) => matches(row, w as Where));
    if (key === 'OR') return (value as Where[]).some((w) => matches(row, w));
    if (key === 'items') {
      const rel = value as { some?: Where };
      if (!rel.some) throw new Error('the fake database only knows `items.some`');
      return row.items.some((i) => matches(i as unknown as Row, rel.some));
    }
    if (key === 'shippingBatch') {
      const rel = value as { is?: Where };
      if (!rel.is) throw new Error('the fake database only knows `shippingBatch.is`');
      return row.shippingBatch !== null && matches(row.shippingBatch as unknown as Row, rel.is);
    }
    return holds(row[key], value);
  });
}

type OrderBy = Record<string, 'asc' | 'desc' | { sort: 'asc' | 'desc'; nulls?: 'first' | 'last' }>;

function compare(a: Row, b: Row, orderBy: OrderBy[]): number {
  for (const clause of orderBy) {
    const [field, spec] = Object.entries(clause)[0];
    const dir = typeof spec === 'string' ? spec : spec.sort;
    const nulls = typeof spec === 'string' ? 'first' : (spec.nulls ?? 'first');
    const av = a[field] as Date | null;
    const bv = b[field] as Date | null;
    if (av === null && bv === null) continue;
    // Postgres puts NULLs first on DESC unless asked otherwise; `nulls` is what the query asked.
    if (av === null) return nulls === 'last' ? 1 : -1;
    if (bv === null) return nulls === 'last' ? -1 : 1;
    if (+av !== +bv) return (+av - +bv) * (dir === 'desc' ? -1 : 1);
  }
  return 0;
}

function fakeClient(rows: Row[]) {
  const findMany = vi.fn(async (q: { where: Where; orderBy?: OrderBy[]; take?: number; select: Record<string, unknown> }) => {
    const hits = rows.filter((r) => matches(r, q.where)).sort((a, b) => compare(a, b, q.orderBy ?? []));
    return hits.slice(0, q.take ?? 1000).map((r) => ({
      orderNumber: r.orderNumber,
      confirmedAt: r.confirmedAt,
      confirmer: r.confirmedById ? (USERS[r.confirmedById] ? { name: USERS[r.confirmedById] } : null) : null,
    }));
  });
  return { client: { order: { findMany } } as never, findMany };
}

const subject = (over: Partial<{ id: string; customerId: string; productIds: string[]; replacesOrderId: string | null }> = {}) => ({
  id: 'new',
  customerId: 'cu1',
  productIds: ['p1'],
  replacesOrderId: null,
  ...over,
});
const ask = (rows: Row[], over: Partial<{ companyId: string; storeId: string | null; order: ReturnType<typeof subject> }> = {}) => {
  const { client, findMany } = fakeClient(rows);
  return {
    findMany,
    run: () => findConfirmedTwins(client, { companyId: 'co1', storeId: 's1', order: subject(), now: NOW, ...over }),
  };
};
const numbers = async (rows: Row[], over: Parameters<typeof ask>[1] = {}) => (await ask(rows, over).run()).map((t) => t.orderNumber);

describe('what counts as a confirmed twin', () => {
  it('a confirmed order of the same customer and product, still ours, is one — and what comes back is a number, a time and a colleague', async () => {
    const got = await ask([twin({ id: 'a' })]).run();
    expect(got).toEqual([{ orderNumber: 'ORD-a', confirmedAt: hoursBefore(4), confirmedByName: 'سارة' }]);
    expect(Object.keys(got[0]).sort()).toEqual(['confirmedAt', 'confirmedByName', 'orderNumber']);
  });

  it.each(CONFIRMATION_STATUSES.filter((s) => s !== 'CONFIRMED'))(
    'an order that is %s is not a twin — only a yes that stands counts (unconfirmed, in progress, postponed, rejected, cancelled)',
    async (status) => {
      expect(await numbers([twin({ id: 'a', confirmationStatus: status })])).toEqual([]);
    }
  );

  it.each(SHIPPING_GONE)('a twin the courier already has (%s) is not a twin: the parcel is the company’s now', async (shippingStatus) => {
    expect(await numbers([twin({ id: 'a', shippingStatus })])).toEqual([]);
  });

  it.each(SHIPPING_STATUSES.filter((s) => !(SHIPPING_GONE as readonly string[]).includes(s)))(
    'a twin whose shipping status is %s is still ours — it can still be cancelled or held',
    async (shippingStatus) => {
      expect(await numbers([twin({ id: 'a', shippingStatus })])).toEqual(['ORD-a']);
    }
  );

  it('a stamp on shippedAt is enough on its own to take it out, whatever the status says', async () => {
    expect(await numbers([twin({ id: 'a', shippedAt: hoursBefore(1) })])).toEqual([]);
  });

  it('a parcel on a trolley the press has closed is the company’s even if its own status has not moved; on an open trolley it is ours', async () => {
    for (const status of SEALED_BATCH_STATUSES) {
      expect(await numbers([twin({ id: 'a', shippingStatus: 'READY_FOR_PICKUP', shippingBatchId: 'b1', shippingBatch: { status } })]), status).toEqual([]);
    }
    expect(await numbers([twin({ id: 'a', shippingStatus: 'READY_FOR_PICKUP', shippingBatchId: 'b1', shippingBatch: { status: 'READY' } })])).toEqual(['ORD-a']);
  });

  it('seventy-two hours is the window: 71 counts, exactly 72 counts, a millisecond past it does not', async () => {
    expect(TWIN_CONFIRM_WINDOW_HOURS).toBe(72);
    const at = (createdAt: Date) => numbers([twin({ id: 'a', createdAt })]);
    expect(await at(hoursBefore(71))).toEqual(['ORD-a']);
    expect(await at(hoursBefore(72))).toEqual(['ORD-a']);
    expect(await at(new Date(hoursBefore(72).getTime() - 1))).toEqual([]);
    expect(await at(hoursBefore(200))).toEqual([]);
  });

  it('a different product is not a twin', async () => {
    expect(await numbers([twin({ id: 'a', productId: 'p2', items: [{ productId: 'p2' }] })])).toEqual([]);
  });

  it('a basket counts on either side: the new order’s second line repeats the product, or the twin’s does', async () => {
    expect(await numbers([twin({ id: 'a' })], { order: subject({ productIds: ['p9', 'p1'] }) })).toEqual(['ORD-a']);
    expect(await numbers([twin({ id: 'a', productId: 'p2', items: [{ productId: 'p2' }, { productId: 'p1' }] })])).toEqual(['ORD-a']);
    // the head product alone, with no lines at all, is a product too
    expect(await numbers([twin({ id: 'a', items: [] })])).toEqual(['ORD-a']);
  });

  it('another customer, another company and another store are not twins', async () => {
    expect(await numbers([twin({ id: 'a', customerId: 'cu2' })])).toEqual([]);
    expect(await numbers([twin({ id: 'a', companyId: 'co2' })])).toEqual([]);
    expect(await numbers([twin({ id: 'a', storeId: 's2' })])).toEqual([]);
    expect(await numbers([twin({ id: 'a', storeId: null })])).toEqual([]);
  });

  it('an order with no store only has twins with no store, and an empty store is asked as «none», not as «any»', async () => {
    expect(await numbers([twin({ id: 'a', storeId: null }), twin({ id: 'b', storeId: 's1' })], { storeId: null })).toEqual(['ORD-a']);
  });

  it('the order itself is never its own twin', async () => {
    expect(await numbers([twin({ id: 'new' })])).toEqual([]);
  });

  it('a replacement or a win-back that is already CONFIRMED is not a twin: the repeat is the point of it', async () => {
    expect(await numbers([twin({ id: 'a', replacesOrderId: 'old' })])).toEqual([]);
  });

  it('and when the order being confirmed IS a replacement or a win-back the guard does not apply — and asks nothing', async () => {
    const asked = ask([twin({ id: 'a' })], { order: subject({ replacesOrderId: 'old' }) });
    expect(await asked.run()).toEqual([]);
    expect(asked.findMany).not.toHaveBeenCalled();
  });

  it('no products means nothing to compare, and no query', async () => {
    const asked = ask([twin({ id: 'a' })], { order: subject({ productIds: [] }) });
    expect(await asked.run()).toEqual([]);
    expect(asked.findMany).not.toHaveBeenCalled();
    const blanks = ask([twin({ id: 'a' })], { order: subject({ productIds: ['', ''] }) });
    expect(await blanks.run()).toEqual([]);
    expect(blanks.findMany).not.toHaveBeenCalled();
  });
});

describe('how many, in what order, and what is asked', () => {
  it('names at most five, the newest yes first — a customer who sent it fifty times needs a refusal, not fifty numbers', async () => {
    expect(MAX_TWINS_NAMED).toBe(5);
    const many = Array.from({ length: 8 }, (_, i) => twin({ id: `t${i}`, confirmedAt: hoursBefore(1 + i) }));
    expect(await numbers(many)).toEqual(['ORD-t0', 'ORD-t1', 'ORD-t2', 'ORD-t3', 'ORD-t4']);
  });

  it('an order whose yes carries no time sorts after the ones that do, and the order of creation breaks the tie', async () => {
    const rows = [
      twin({ id: 'blank-old', confirmedAt: null, createdAt: hoursBefore(30) }),
      twin({ id: 'blank-new', confirmedAt: null, createdAt: hoursBefore(10) }),
      twin({ id: 'stamped', confirmedAt: hoursBefore(20) }),
    ];
    expect(await numbers(rows)).toEqual(['ORD-stamped', 'ORD-blank-new', 'ORD-blank-old']);
    const got = await ask(rows).run();
    expect(got.find((t) => t.orderNumber === 'ORD-blank-new')?.confirmedAt).toBeNull();
  });

  it('a colleague whose account is gone is a null name, not a crash', async () => {
    const got = await ask([twin({ id: 'a', confirmedById: null }), twin({ id: 'b', confirmedById: 'deleted-user', confirmedAt: hoursBefore(9) })]).run();
    expect(got.map((t) => t.confirmedByName)).toEqual([null, null]);
  });

  it('it SELECTS a number, a time and the confirming colleague’s name — no id, nothing about the customer can leave through it', async () => {
    const asked = ask([twin({ id: 'a' })]);
    await asked.run();
    const { select } = asked.findMany.mock.calls[0][0];
    expect(Object.keys(select).sort()).toEqual(['confirmedAt', 'confirmer', 'orderNumber']);
    expect(select.confirmer).toEqual({ select: { name: true } });
  });

  it('it asks with the window counted back from the moment it is given', async () => {
    const asked = ask([]);
    await asked.run();
    const { where } = asked.findMany.mock.calls[0][0];
    expect(+where.createdAt.gte).toBe(+hoursBefore(72));
    expect(where.confirmationStatus).toBe('CONFIRMED');
    expect(where.replacesOrderId).toBeNull();
    expect(where.id).toEqual({ not: 'new' });
  });
});

describe('the lock, and what is read after it', () => {
  function recordingTx(opts: { lines?: { productId: string }[]; twins?: unknown[] } = {}) {
    const calls: string[] = [];
    const tx = {
      $executeRaw: vi.fn(async (strings: TemplateStringsArray, ...values: unknown[]) => {
        calls.push(`lock:${strings.join('?')}|${values.join(',')}`);
        return 1;
      }),
      orderItem: {
        findMany: vi.fn(async (q: { where: unknown; select: unknown }) => {
          calls.push(`lines:${JSON.stringify(q)}`);
          return opts.lines ?? [{ productId: 'p2' }];
        }),
      },
      order: {
        findMany: vi.fn(async (q: { where: Where }) => {
          calls.push('twins');
          void q;
          return opts.twins ?? [];
        }),
      },
    };
    return { tx: tx as never, raw: tx, calls };
  }
  const ORDER = { id: 'o1', customerId: 'cu1', productId: 'p1', storeId: 's1', replacesOrderId: null };

  it('takes the per-customer lock FIRST, then reads the order’s lines, then the twins — in that order', async () => {
    const { tx, calls } = recordingTx();
    await guardConfirmAgainstTwins(tx, { companyId: 'co1', order: ORDER, now: NOW });
    expect(calls.map((c) => c.split(':')[0])).toEqual(['lock', 'lines', 'twins']);
  });

  it('the lock is pg_advisory_xact_lock on a hash of «twin:<customer>», taken with $executeRaw like the two other lock sites', async () => {
    const { tx, raw } = recordingTx();
    await guardConfirmAgainstTwins(tx, { companyId: 'co1', order: ORDER, now: NOW });
    expect(raw.$executeRaw).toHaveBeenCalledTimes(1);
    const [strings, ...values] = raw.$executeRaw.mock.calls[0] as unknown as [TemplateStringsArray, ...unknown[]];
    const sql = strings.join('?');
    expect(sql).toContain('pg_advisory_xact_lock(');
    expect(sql).toContain('hashtextextended(');
    expect(values).toEqual(['twin:cu1']);
  });

  it('two customers never share a lock, and one customer always takes the same one', async () => {
    const key = async (customerId: string) => {
      const { tx, raw } = recordingTx();
      await guardConfirmAgainstTwins(tx, { companyId: 'co1', order: { ...ORDER, customerId }, now: NOW });
      return (raw.$executeRaw.mock.calls[0] as unknown[])[1];
    };
    expect(await key('cu1')).toBe(await key('cu1'));
    expect(await key('cu1')).not.toBe(await key('cu2'));
  });

  it('asks about the head product AND every line of the order being confirmed', async () => {
    const { tx, raw } = recordingTx({ lines: [{ productId: 'p2' }, { productId: 'p3' }] });
    await guardConfirmAgainstTwins(tx, { companyId: 'co1', order: ORDER, now: NOW });
    expect(raw.orderItem.findMany).toHaveBeenCalledWith({ where: { orderId: 'o1' }, select: { productId: true } });
    const { where } = raw.order.findMany.mock.calls[0][0];
    const or = where.AND.find((c: Where) => c.OR && c.OR[0]?.productId).OR;
    expect(or[0]).toEqual({ productId: { in: ['p1', 'p2', 'p3'] } });
  });

  it('a replacement or a win-back is not asked: no lock, no read, nothing', async () => {
    const { tx, calls } = recordingTx();
    expect(await guardConfirmAgainstTwins(tx, { companyId: 'co1', order: { ...ORDER, replacesOrderId: 'old' }, now: NOW })).toEqual([]);
    expect(calls).toEqual([]);
  });

  it('what the twins query returns is what the guard returns', async () => {
    const { tx } = recordingTx({ twins: [{ orderNumber: 'ORD-9', confirmedAt: hoursBefore(2), confirmer: { name: 'ريم' } }] });
    expect(await guardConfirmAgainstTwins(tx, { companyId: 'co1', order: ORDER, now: NOW })).toEqual([
      { orderNumber: 'ORD-9', confirmedAt: hoursBefore(2), confirmedByName: 'ريم' },
    ]);
  });
});

describe('the acknowledgement is one history row, in her name', () => {
  it('writes TWIN_CONFIRM_ACKNOWLEDGED with the confirmer and the numbers she was told — and nothing about the customer', async () => {
    const create = vi.fn(async () => ({}));
    await recordTwinAcknowledged({ orderActivity: { create } } as never, {
      companyId: 'co1',
      orderId: 'o1',
      userId: 'u1',
      twins: [
        { orderNumber: 'ORD-1', confirmedAt: hoursBefore(2), confirmedByName: 'ريم' },
        { orderNumber: 'ORD-2', confirmedAt: null, confirmedByName: null },
      ],
    });
    expect(create).toHaveBeenCalledTimes(1);
    const { data } = (create.mock.calls[0] as unknown as [{ data: Record<string, unknown> }])[0];
    expect(data).toEqual({
      companyId: 'co1',
      orderId: 'o1',
      userId: 'u1',
      action: 'TWIN_CONFIRM_ACKNOWLEDGED',
      metadata: JSON.stringify({ twins: ['ORD-1', 'ORD-2'] }),
    });
    expect(TWIN_CONFIRM_ACK_ACTION).toBe('TWIN_CONFIRM_ACKNOWLEDGED');
  });
});

describe('the refusal body', () => {
  const twins = [
    { orderNumber: 'ORD-2026-1711', confirmedAt: new Date('2026-11-02T09:30:00.000Z'), confirmedByName: 'سارة' },
    { orderNumber: 'ORD-2026-1701', confirmedAt: null, confirmedByName: null },
  ];

  it('is { error, errorAr, code, twins } and nothing else, and the twins are number, time and colleague only', () => {
    const body = twinConfirmedBody(twins);
    expect(Object.keys(body).sort()).toEqual(['code', 'error', 'errorAr', 'twins']);
    expect(body.code).toBe(TWIN_CONFIRMED_CODE);
    expect(body.twins).toEqual([
      { orderNumber: 'ORD-2026-1711', confirmedAt: '2026-11-02T09:30:00.000Z', confirmedByName: 'سارة' },
      { orderNumber: 'ORD-2026-1701', confirmedAt: null, confirmedByName: null },
    ]);
    for (const t of body.twins) expect(Object.keys(t).sort()).toEqual(['confirmedAt', 'confirmedByName', 'orderNumber']);
  });

  it('says it in one Arabic sentence that names the orders and says what to do', () => {
    const { error, errorAr } = twinConfirmedBody(twins);
    expect(error).toBe(errorAr);
    expect(error).toBe(
      'الزبون عنده طلب مؤكَّد بنفس المنتج (ORD-2026-1711، ORD-2026-1701) — إذا هالطلب مكرر ارفضه كمكرر، وإذا طلب تاني فعلاً أكّده وانت متأكد'
    );
    // the order numbers are data; every other word is Arabic
    expect(error.replace(/ORD-\d{4}-\d{4}/g, '')).not.toMatch(/[A-Za-z]/);
  });

  it('survives a list with nothing in it', () => {
    expect(twinConfirmedBody([]).error).toContain('الزبون عنده طلب مؤكَّد بنفس المنتج —');
  });

  it('carries only what it names: a twin that arrived with a customer, a phone and an id leaves none of them behind', () => {
    const dirty = [
      {
        orderNumber: 'ORD-1',
        confirmedAt: new Date('2026-11-02T09:30:00.000Z'),
        confirmedByName: 'سارة',
        id: 'row-id-77',
        customerId: 'cu1',
        customer: { fullName: 'سعاد محمود', phone: '0790000000', address: 'عمّان' },
      },
    ];
    const said = JSON.stringify(twinConfirmedBody(dirty as never));
    for (const leak of ['row-id-77', 'cu1', 'سعاد', '0790000000', 'عمّان', 'customer']) expect(said, leak).not.toContain(leak);
  });
});

describe('«the same product» is read the way the advisory flag reads it — held to it, not copied from it in silence', () => {
  it('the flag asks for the head product OR any line; so does the guard, clause for clause', async () => {
    const findMany = vi.fn(async () => []);
    await findRecentTwins({ order: { findMany } } as never, {
      companyId: 'co1',
      orderId: 'new',
      customerId: 'cu1',
      productIds: ['p1', 'p2', 'p1', ''],
      at: NOW,
    });
    const flagClause = (findMany.mock.calls[0] as unknown as [{ where: { OR: unknown } }])[0].where.OR;
    expect(sameProductWhere(['p1', 'p2', 'p1', ''])).toEqual({ OR: flagClause });
  });

  it('and has nothing to say when there is no product, exactly like the flag', async () => {
    expect(sameProductWhere([])).toBeNull();
    expect(sameProductWhere(['', ''])).toBeNull();
  });
});
