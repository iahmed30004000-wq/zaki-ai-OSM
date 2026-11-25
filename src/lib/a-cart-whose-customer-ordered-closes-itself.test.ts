import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Prisma } from '@prisma/client';

/**
 * «له طلب» → «طلب لحاله», AND ONE CART PER CUSTOMER PER PRODUCT (the owner, 21/11).
 *
 * The owner's screenshot: in «السلات المهجورة» one customer (same phone, same product) showed as TWO carts five minutes
 * apart — two visits, each its own externalId — both «جديدة», both «له طلب» pointing at his order. The team kept ringing
 * him. Held here over an in-memory database, with the REAL landing door (`upsertLandingCart`, `recoverLandingCart`), the
 * REAL «له طلب» match (`ordersBehindCarts`), the REAL close (`cart-has-order.ts`) and the REAL automatic-order rules
 * (`autoOrderForCart`); only the order engine itself (`takeCartOrder`) is a spy — any call to it is an automatic order.
 */

type Row = Record<string, any>;

const h = vi.hoisted(() => ({
  state: {
    settings: null as string | null,
    carts: [] as Row[],
    activities: [] as Row[],
    aliases: [] as Row[],
    customers: [] as Row[],
    orders: [] as Row[],
    seq: 0,
  },
  logAudit: vi.fn(),
  takeCartOrder: vi.fn(),
}));
const s = h.state;

vi.mock('@/lib/audit', () => ({ logAudit: (...a: unknown[]) => h.logAudit(...a) }));
vi.mock('@/lib/blacklist', () => ({ isBlocked: async () => false }));
vi.mock('@/lib/v1/landing-door', () => ({ takeCartOrder: (...a: unknown[]) => h.takeCartOrder(...a) }));

vi.mock('@/lib/db', () => {
  const dup = () => new Prisma.PrismaClientKnownRequestError('Unique constraint failed', { code: 'P2002', clientVersion: 'test' });
  const pick = (row: Row | undefined, select?: Row) => {
    if (!row) return null;
    if (!select) return { ...row };
    return Object.fromEntries(Object.keys(select).map((k) => [k, k === 'region' ? null : row[k]]));
  };
  const cond = (v: unknown, c: unknown) => {
    if (c === undefined) return true;
    if (c === null) return v == null;
    if (c && typeof c === 'object' && !(c instanceof Date)) {
      const o = c as Row;
      if ('in' in o) return o.in.includes(v);
      if ('not' in o) return o.not === null ? v != null : v !== o.not;
      if ('gte' in o) return (v as Date) >= o.gte;
    }
    return v === c;
  };
  const cartMatches = (c: Row, w: Row) =>
    ['id', 'companyId', 'status', 'orderId', 'productId', 'phoneNormalized', 'lastSeenAt', 'autoOrderAt', 'customerName'].every((k) =>
      cond(c[k], w[k])
    );
  const byExternal = (w: Row) => s.carts.find((c) => c.companyId === w.companyId && c.externalId === w.externalId);
  const write = (row: Row, data: Row) => {
    for (const [k, v] of Object.entries(data)) {
      if (k === 'activities') s.activities.push({ id: `a${++s.seq}`, cartId: row.id, userId: null, ...(v as Row).create });
      else row[k] = v;
    }
  };
  const sorted = (rows: Row[], orderBy: unknown) => {
    const first = (Array.isArray(orderBy) ? orderBy[0] : orderBy) as Row | undefined;
    if (!first?.lastSeenAt) return rows;
    const dir = first.lastSeenAt === 'desc' ? -1 : 1;
    return [...rows].sort((a, b) => dir * (+a.lastSeenAt - +b.lastSeenAt));
  };
  const db = {
    company: { findUnique: async () => ({ settings: s.settings }) },
    product: {
      findFirst: async ({ where }: Row) =>
        ['p1', 'p2'].includes(where.id) && where.companyId === 'c1' ? { id: where.id, name: 'قطرة طنين الأذن', store: { country: { code: 'SY' } } } : null,
    },
    country: { findFirst: async () => null },
    region: { findMany: async () => [] },
    customer: { findMany: async ({ where }: Row) => s.customers.filter((c) => c.companyId === where.companyId && where.phone.in.includes(c.phone)) },
    order: {
      findMany: async ({ where }: Row) =>
        s.orders.filter((o) => o.companyId === where.companyId && where.customerId.in.includes(o.customerId) && o.createdAt >= where.createdAt.gte),
      findFirst: async ({ where }: Row) => s.orders.find((o) => o.companyId === where.companyId && o.orderNumber === where.orderNumber) ?? null,
    },
    abandonedCart: {
      findUnique: async ({ where, select }: Row) =>
        pick(where.companyId_externalId ? byExternal(where.companyId_externalId) : s.carts.find((c) => c.id === where.id), select),
      findFirst: async ({ where, select, orderBy }: Row) => pick(sorted(s.carts.filter((c) => cartMatches(c, where)), orderBy)[0], select),
      findMany: async ({ where, select, orderBy, skip, take }: Row) =>
        sorted(s.carts.filter((c) => cartMatches(c, where)), orderBy)
          .slice(skip ?? 0, (skip ?? 0) + (take ?? 1e9))
          .map((c) => pick(c, select)),
      groupBy: async ({ where }: Row) =>
        [...new Set(s.carts.filter((c) => cartMatches(c, where)).map((c) => c.companyId))].map((companyId) => ({ companyId })),
      create: async ({ data, select }: Row) => {
        if (byExternal(data)) throw dup();
        const row: Row = { id: `cart${++s.seq}`, attempts: 0, orderId: null, autoOrderAt: null, assignedToId: null };
        write(row, data);
        s.carts.push(row);
        return pick(row, select);
      },
      update: async ({ where, data, select }: Row) => {
        const row = s.carts.find((c) => c.id === where.id)!;
        write(row, data);
        return pick(row, select);
      },
      updateMany: async ({ where, data }: Row) => {
        const hit = s.carts.filter((c) => cartMatches(c, where));
        for (const c of hit) write(c, data);
        return { count: hit.length };
      },
    },
    abandonedCartActivity: {
      create: async ({ data }: Row) => {
        s.activities.push({ id: `a${++s.seq}`, ...data });
        return data;
      },
      findMany: async ({ where }: Row) =>
        s.activities.filter((a) => where.cartId.in.includes(a.cartId) && a.userId != null && a.action === where.action),
    },
    abandonedCartAlias: {
      findUnique: async ({ where }: Row) => {
        const a = s.aliases.find((x) => x.companyId === where.companyId_externalId.companyId && x.externalId === where.companyId_externalId.externalId);
        if (!a) return null;
        const c = s.carts.find((x) => x.id === a.cartId)!;
        return { cart: { id: c.id, lastSeenAt: c.lastSeenAt } };
      },
      create: async ({ data }: Row) => {
        if (s.aliases.some((x) => x.companyId === data.companyId && x.externalId === data.externalId)) throw dup();
        s.aliases.push({ ...data });
        return data;
      },
    },
  };
  return { db, default: db };
});

import { landingCartSchema, recoverLandingCart, upsertLandingCart } from './v1/landing-carts';
import { closeOrderedCarts } from './cart-has-order';
import { convertWaitingCartsJob } from './jobs/definitions/convert-waiting-carts';

const NOW = new Date();
const minutesAgo = (m: number) => new Date(NOW.getTime() - m * 60_000).toISOString();

// The screenshot: phone 0949280255, «قطرة طنين الأذن», «عادل شهاب» then «عادل شهاي» five minutes later.
const visit = (over: Record<string, unknown> = {}) =>
  landingCartSchema.parse({
    externalId: 'visit-1',
    productId: 'p1',
    productName: 'قطرة طنين الأذن',
    customerName: 'عادل شهاب',
    phone: '0949280255',
    country: 'SY',
    lastSeenAt: minutesAgo(10),
    ...over,
  });
const SECOND = { externalId: 'visit-2', customerName: 'عادل شهاي', lastSeenAt: minutesAgo(5) };

/** His order, ORD-2026-5344, placed this week for the same product. */
const hisOrder = (over: Record<string, unknown> = {}) => {
  s.customers.push({ id: 'cust-adel', companyId: 'c1', phone: '949280255' });
  s.orders.push({ id: 'ord-5344', orderNumber: 'ORD-2026-5344', companyId: 'c1', customerId: 'cust-adel', productId: 'p1', items: [], createdAt: new Date(NOW.getTime() - 3600_000), ...over });
};

const closedLines = () => s.activities.filter((a) => a.action === 'RECOVERED');

beforeEach(() => {
  vi.clearAllMocks();
  Object.assign(s, { settings: null, carts: [], activities: [], aliases: [], customers: [], orders: [], seq: 0 });
  h.takeCartOrder.mockResolvedValue({ ok: false, status: 409, body: {} });
});

describe('the screenshot: two visits of a customer who already ordered', () => {
  it('→ ONE cart, RECOVERED, pointing at his order — never an automatic order', async () => {
    hisOrder();
    const a = await upsertLandingCart('c1', visit());
    expect(a).toEqual({ status: 201, body: { id: s.carts[0].id, status: 'RECOVERED' } });
    // The first cart is closed, so the second visit is not folded into it: it is its own cart — and closes too.
    const b = await upsertLandingCart('c1', visit(SECOND));
    expect(b.body.status).toBe('RECOVERED');
    expect(s.carts.every((c) => c.status === 'RECOVERED' && c.orderId === 'ord-5344')).toBe(true);
    expect(h.takeCartOrder).not.toHaveBeenCalled();
  });

  it('before he ordered: two visits → one cart; then his order arrives → the job closes it with a line and an audit row', async () => {
    s.settings = JSON.stringify({ abandonedCarts: { autoConvert: false } });
    const a = await upsertLandingCart('c1', visit());
    const b = await upsertLandingCart('c1', visit(SECOND));
    expect(b).toEqual({ status: 200, body: { id: a.body.id, status: 'NEW' } });
    expect(s.carts).toHaveLength(1);
    expect(s.carts[0]).toMatchObject({ customerName: 'عادل شهاي', externalId: 'visit-1' });

    hisOrder();
    const run = await convertWaitingCartsJob.run({ now: NOW } as never);
    expect(run.detail).toContain('1 سلة تسكّرت لأن الزبون عنده طلب');
    expect(s.carts[0]).toMatchObject({ status: 'RECOVERED', orderId: 'ord-5344' });
    expect(closedLines()).toHaveLength(1);
    expect(closedLines()[0]).toMatchObject({
      userId: null,
      fromStatus: 'NEW',
      toStatus: 'RECOVERED',
      note: 'الزبون عنده طلب #ORD-2026-5344 — تسكّرت لحالها',
    });
    expect(h.logAudit).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'ABANDONED_CART_RECOVERED', userId: null, entityId: s.carts[0].id, newData: expect.objectContaining({ via: 'has-order', orderNumber: 'ORD-2026-5344' }) })
    );

    // Zaki pages' «recovered» under the SECOND visit's id finds the same cart, and changes nothing.
    const before = JSON.stringify(s.carts);
    expect(await recoverLandingCart('c1', 'visit-2', 'ORD-2026-5344')).toEqual({ id: a.body.id, status: 'RECOVERED' });
    expect(JSON.stringify(s.carts)).toBe(before);
    expect(h.takeCartOrder).not.toHaveBeenCalled();
  });

  it('the carts ALREADY sitting there (both open, automatic order already tried as «له طلب») are closed by the job sweep', async () => {
    hisOrder();
    const base = { companyId: 'c1', productId: 'p1', phone: '0949280255', phoneNormalized: '949280255', status: 'NEW', orderId: null, autoOrderAt: new Date(NOW.getTime() - 600_000) };
    s.carts.push({ id: 'old-1', externalId: 'visit-1', lastSeenAt: new Date(NOW.getTime() - 600_000), ...base });
    s.carts.push({ id: 'old-2', externalId: 'visit-2', lastSeenAt: new Date(NOW.getTime() - 300_000), ...base });
    expect(await closeOrderedCarts(NOW)).toEqual({ closed: 2, checked: 2 });
    expect(s.carts.map((c) => [c.status, c.orderId])).toEqual([
      ['RECOVERED', 'ord-5344'],
      ['RECOVERED', 'ord-5344'],
    ]);
    // idempotent: a second run finds nothing to check
    expect(await closeOrderedCarts(NOW)).toEqual({ closed: 0, checked: 0 });
    expect(closedLines()).toHaveLength(2);
  });
});

describe('the door closes it whatever the switch says, and never touches the team’s word', () => {
  it('switch OFF → still closes when the customer has an order (this makes no order)', async () => {
    s.settings = JSON.stringify({ abandonedCarts: { autoConvert: false } });
    hisOrder();
    expect((await upsertLandingCart('c1', visit())).body.status).toBe('RECOVERED');
    expect(s.carts[0].orderId).toBe('ord-5344');
  });

  it('NEGATIVE: «غير مهتم», «رقم غير صالح», CONTACTED, CALLBACK, NO_ANSWER — never closed, by the door or the job', async () => {
    for (const status of ['NOT_INTERESTED', 'INVALID', 'CONTACTED', 'CALLBACK', 'NO_ANSWER']) {
      Object.assign(s, { carts: [], activities: [], customers: [], orders: [] });
      s.settings = JSON.stringify({ abandonedCarts: { autoConvert: false } });
      await upsertLandingCart('c1', visit());
      s.carts[0].status = status;
      hisOrder();
      const again = await upsertLandingCart('c1', visit({ customerName: 'عادل' }));
      expect(again.body.status, status).toBe(status);
      await closeOrderedCarts(NOW);
      expect(s.carts[0], status).toMatchObject({ status, orderId: null });
      expect(closedLines(), status).toEqual([]);
    }
    expect(h.takeCartOrder).not.toHaveBeenCalled();
  });

  it('NEGATIVE: a NEW a person put back by hand is the team’s word too', async () => {
    s.settings = JSON.stringify({ abandonedCarts: { autoConvert: false } });
    await upsertLandingCart('c1', visit());
    s.activities.push({ id: 'h1', companyId: 'c1', cartId: s.carts[0].id, userId: 'u1', action: 'STATUS_CHANGED', fromStatus: 'CALLBACK', toStatus: 'NEW' });
    hisOrder();
    expect(await closeOrderedCarts(NOW)).toEqual({ closed: 0, checked: 1 });
    expect(s.carts[0].status).toBe('NEW');
  });

  it('NEGATIVE: an order for another product, or older than the «له طلب» window, closes nothing', async () => {
    s.settings = JSON.stringify({ abandonedCarts: { autoConvert: false } });
    hisOrder({ productId: 'p2' });
    expect((await upsertLandingCart('c1', visit())).body.status).toBe('NEW');
    s.orders[0] = { ...s.orders[0], productId: 'p1', createdAt: new Date(NOW.getTime() - 8 * 24 * 3600_000) };
    expect(await closeOrderedCarts(NOW)).toEqual({ closed: 0, checked: 1 });
    expect(s.carts[0].status).toBe('NEW');
  });

  it('NEGATIVE: a cart whose product is unknown here keeps its badge but is not closed', async () => {
    hisOrder();
    expect((await upsertLandingCart('c1', visit({ productId: 'not-ours' }))).body.status).toBe('NEW');
    expect(s.carts[0]).toMatchObject({ status: 'NEW', productId: null });
  });

  it('the has-order check failing never fails the door: the cart stays NEW and the job asks again', async () => {
    s.settings = JSON.stringify({ abandonedCarts: { autoConvert: false } });
    hisOrder();
    const { db } = await import('./db');
    const spy = vi.spyOn(db.customer, 'findMany').mockRejectedValueOnce(new Error('db hiccup'));
    expect((await upsertLandingCart('c1', visit())).body.status).toBe('NEW');
    spy.mockRestore();
    expect((await closeOrderedCarts(NOW)).closed).toBe(1);
    expect(s.carts[0].status).toBe('RECOVERED');
  });
});
