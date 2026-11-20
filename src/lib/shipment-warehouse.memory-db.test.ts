import { describe, expect, it } from 'vitest';
import { Prisma } from '@prisma/client';

/**
 * A SMALL IN-MEMORY DATABASE FOR THE «ONE SHIPMENT, ONE WAREHOUSE» TESTS (W4a) — shared by
 * `a-shipment-leaves-from-one-warehouse.test.ts`, `unplaced-shipment-blocks-equal-main.test.ts` and the door test
 * `src/app/api/ops/shipments/a-trolley-leaves-from-one-warehouse.test.ts`.
 *
 * Any table exists on first use. It judges `where` itself (equality, null, in / notIn / not / gt / gte / lt / lte,
 * OR / AND / NOT, an order item's or add-on's `order`), so WHICH rows a read or a write touches is decided by the code
 * under test. It answers `findMany` / `findFirst` / `findUnique` / `count` / `aggregate` / `groupBy` / `create` /
 * `update` (P2025 when the condition matches nothing) / `updateMany` / `deleteMany`, a store's `warehousePlacement`
 * relation, and a transaction that is all or nothing. A money table — a wallet, an expense, a profit, a settlement —
 * throws. Every call is logged (`calls`), so a test can compare WHAT was asked, not only what was answered.
 */

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- an in-memory row; every field is read by name
export type Row = Record<string, any>;

const known = (code: string) => new Prisma.PrismaClientKnownRequestError(code, { code, clientVersion: 'memory' });
const MONEY = /wallet|expense|profit|settlement|commission|payout/i;

export function shipDb(seed: Record<string, Row[]> = {}) {
  let data: Record<string, Row[]> = Object.fromEntries(Object.entries(seed).map(([t, rows]) => [t, rows.map((r) => ({ ...r }))]));
  let seq = 0;
  const calls: { call: string; args: unknown }[] = [];
  const rows = (t: string) => (data[t] ??= []);

  const scalar = (v: unknown, c: unknown): boolean => {
    if (c === null) return v === null || v === undefined;
    if (c instanceof Date) return v instanceof Date && v.getTime() === c.getTime();
    if (c && typeof c === 'object' && !Array.isArray(c)) {
      const o = c as Row;
      const val = v instanceof Date ? v.getTime() : v;
      const num = (x: unknown) => (x instanceof Date ? x.getTime() : x) as number;
      if ('equals' in o && !scalar(v, o.equals)) return false;
      if ('in' in o && !(o.in as unknown[]).includes(v)) return false;
      if ('notIn' in o && (o.notIn as unknown[]).includes(v)) return false;
      if ('not' in o && (o.not === null ? v === null || v === undefined : scalar(v, o.not))) return false;
      if ('gt' in o && !(v !== null && v !== undefined && (val as number) > num(o.gt))) return false;
      if ('gte' in o && !(v !== null && v !== undefined && (val as number) >= num(o.gte))) return false;
      if ('lt' in o && !(v !== null && v !== undefined && (val as number) < num(o.lt))) return false;
      if ('lte' in o && !(v !== null && v !== undefined && (val as number) <= num(o.lte))) return false;
      return true;
    }
    return (v ?? null) === c;
  };
  const matches = (table: string, r: Row, w: Row = {}): boolean =>
    Object.entries(w).every(([k, c]) => {
      if (c === undefined) return true;
      if (k === 'OR') return (c as Row[]).some((x) => matches(table, r, x));
      if (k === 'AND') return (Array.isArray(c) ? c : [c]).every((x) => matches(table, r, x));
      if (k === 'NOT') return !(Array.isArray(c) ? c : [c]).some((x) => matches(table, r, x));
      if (k === 'order' && (table === 'orderItem' || table === 'orderAddOn')) {
        const o = rows('order').find((x) => x.id === r.orderId);
        return !!o && matches('order', o, c as Row);
      }
      if (k === 'store' && c && typeof c === 'object' && !Array.isArray(c) && table !== 'store') {
        const s = rows('store').find((x) => x.id === r.storeId);
        const rel = (c as Row).is ?? c;
        return !!s && matches('store', s, rel as Row);
      }
      return scalar(r[k], c);
    });
  const sortBy = (list: Row[], orderBy?: Row | Row[]) => {
    if (!orderBy) return list;
    const keys = (Array.isArray(orderBy) ? orderBy : [orderBy]).flatMap((o) => Object.entries(o)) as [string, 'asc' | 'desc'][];
    return [...list].sort((a, b) => {
      for (const [k, dir] of keys) {
        const x = a[k] instanceof Date ? a[k].getTime() : a[k];
        const y = b[k] instanceof Date ? b[k].getTime() : b[k];
        if (x < y) return dir === 'asc' ? -1 : 1;
        if (x > y) return dir === 'asc' ? 1 : -1;
      }
      return 0;
    });
  };
  const pick = (table: string, r: Row, select?: Row, include?: Row): Row => {
    const base: Row = select ? {} : { ...r };
    const spec = { ...(select ?? {}), ...(include ?? {}) };
    for (const [k, v] of Object.entries(spec)) {
      if (v === true && !(k === 'warehousePlacement' && table === 'store')) base[k] = r[k];
      else if (k === 'warehousePlacement' && table === 'store') {
        const p = rows('warehousePlacement').find((x) => x.storeId === r.id);
        base[k] = p ? pick('warehousePlacement', p, (v as Row).select) : null;
      } else if (k === '_count') {
        base[k] = {};
      } else if (table === 'order' && (k === 'items' || k === 'addOns') && v && typeof v === 'object') {
        const child = k === 'items' ? 'orderItem' : 'orderAddOn';
        base[k] = rows(child).filter((x) => x.orderId === r.id).map((x) => pick(child, x, (v as Row).select));
      } else if (v && typeof v === 'object') {
        // A relation: `<name>Id` on the row points into the table `<name>`; a row may also carry it embedded; a plural
        // name with neither is a list nobody seeded (empty).
        const target = typeof r[`${k}Id`] === 'string' ? rows(k).find((x) => x.id === r[`${k}Id`]) : undefined;
        const embedded = r[k] && typeof r[k] === 'object' ? (r[k] as Row) : undefined;
        if (target ?? embedded) base[k] = pick(k, (target ?? embedded) as Row, (v as Row).select, (v as Row).include);
        else base[k] = k.endsWith('s') ? [] : null;
      }
    }
    return base;
  };
  const apply = (r: Row, d: Row) => {
    for (const [k, v] of Object.entries(d)) {
      if (v && typeof v === 'object' && !(v instanceof Date) && 'increment' in v) r[k] = (r[k] ?? 0) + v.increment;
      else if (v && typeof v === 'object' && !(v instanceof Date) && 'decrement' in v) r[k] = (r[k] ?? 0) - v.decrement;
      else r[k] = v;
    }
  };

  const table = (name: string) => {
    if (MONEY.test(name)) throw new Error(`a shipment touched the money table «${name}»`);
    const log = (method: string, args: unknown) => calls.push({ call: `${name}.${method}`, args: structuredClone(args ?? null) });
    return {
      findMany: async (a: Row = {}) => {
        log('findMany', a);
        const list = sortBy(rows(name).filter((r) => matches(name, r, a.where)), a.orderBy);
        return (a.take ? list.slice(0, a.take) : list).map((r) => pick(name, r, a.select, a.include));
      },
      findFirst: async (a: Row = {}) => {
        log('findFirst', a);
        const r = sortBy(rows(name).filter((x) => matches(name, x, a.where)), a.orderBy)[0];
        return r ? pick(name, r, a.select, a.include) : null;
      },
      findUnique: async (a: Row) => {
        log('findUnique', a);
        const r = rows(name).find((x) => matches(name, x, a.where));
        return r ? pick(name, r, a.select, a.include) : null;
      },
      count: async (a: Row = {}) => {
        log('count', a);
        return rows(name).filter((r) => matches(name, r, a.where)).length;
      },
      aggregate: async (a: Row) => {
        log('aggregate', a);
        const hit = rows(name).filter((r) => matches(name, r, a.where));
        const sum: Row = {};
        for (const k of Object.keys(a._sum ?? {})) sum[k] = hit.length ? hit.reduce((s, r) => s + (r[k] ?? 0), 0) : null;
        return { _sum: sum };
      },
      groupBy: async (a: Row) => {
        log('groupBy', a);
        const groups = new Map<string, Row[]>();
        for (const r of rows(name).filter((x) => matches(name, x, a.where))) {
          const key = JSON.stringify((a.by as string[]).map((k) => r[k]));
          groups.set(key, [...(groups.get(key) ?? []), r]);
        }
        return [...groups.values()].map((g) => {
          const out: Row = Object.fromEntries((a.by as string[]).map((k) => [k, g[0][k]]));
          if (a._sum) out._sum = Object.fromEntries(Object.keys(a._sum).map((k) => [k, g.reduce((s, r) => s + (r[k] ?? 0), 0)]));
          if (a._count) out._count = { _all: g.length };
          return out;
        });
      },
      create: async (a: Row) => {
        log('create', a);
        // The one column default these tests lean on: a new trolley is READY (`ShippingBatch.status @default("READY")`).
        const defaults: Row = name === 'shippingBatch' ? { status: 'READY' } : {};
        const row: Row = { createdAt: new Date(), ...defaults, ...a.data, id: a.data.id ?? `${name}-${++seq}` };
        if (rows(name).some((x) => x.id === row.id)) throw known('P2002');
        rows(name).push(row);
        return pick(name, row, a.select, a.include);
      },
      update: async (a: Row) => {
        log('update', a);
        const r = rows(name).find((x) => matches(name, x, a.where));
        if (!r) throw known('P2025');
        apply(r, a.data);
        return pick(name, r, a.select, a.include);
      },
      updateMany: async (a: Row) => {
        log('updateMany', a);
        const hit = rows(name).filter((r) => matches(name, r, a.where));
        for (const r of hit) apply(r, a.data);
        return { count: hit.length };
      },
      deleteMany: async (a: Row = {}) => {
        log('deleteMany', a);
        const keep = rows(name).filter((r) => !matches(name, r, a.where));
        const count = rows(name).length - keep.length;
        data[name] = keep;
        return { count };
      },
    };
  };

  const tables = new Map<string, ReturnType<typeof table>>();
  const root: Row = {};
  const db: Row = new Proxy(root, {
    get(target, prop) {
      if (prop in target) return target[prop as string];
      if (typeof prop !== 'string' || prop === 'then' || prop.startsWith('$')) return undefined;
      if (!tables.has(prop)) tables.set(prop, table(prop));
      return tables.get(prop);
    },
  });
  // The transaction client: the same tables, and no `$transaction` on it (that is how the stock lock knows it is inside one).
  const tx: Row = new Proxy(root, {
    get: (_t, prop) => (prop === '$transaction' ? undefined : (db as Row)[prop as string]),
    has: (_t, prop) => prop !== '$transaction',
  });
  root.$executeRaw = async () => 1;
  root.$queryRaw = async () => [];
  root.$transaction = async (fn: unknown) => {
    if (Array.isArray(fn)) return Promise.all(fn);
    const before = structuredClone(data);
    const seqBefore = seq;
    try {
      return await (fn as (t: Row) => unknown)(tx);
    } catch (e) {
      data = before;
      seq = seqBefore;
      throw e;
    }
  };

  return {
    db: db as never,
    get data() {
      return data;
    },
    calls,
  };
}

describe('the in-memory database the W4a tests stand on', () => {
  it('judges the where itself: in, not, a nested order, OR', async () => {
    const m = shipDb({
      order: [{ id: 'o1', storeId: 's1', confirmationStatus: 'CONFIRMED' }, { id: 'o2', storeId: 's2', confirmationStatus: 'CANCELLED' }],
      orderItem: [{ id: 'i1', orderId: 'o1', reservedQty: 2 }, { id: 'i2', orderId: 'o2', reservedQty: 3 }],
    });
    const db = m.db as Row;
    const held = await db.orderItem.aggregate({ where: { reservedQty: { gt: 0 }, order: { confirmationStatus: { notIn: ['CANCELLED'] } } }, _sum: { reservedQty: true } });
    expect(held._sum.reservedQty).toBe(2);
    expect(await db.order.count({ where: { OR: [{ storeId: 's2' }, { id: { in: ['o1'] } }] } })).toBe(2);
  });

  it('a transaction that throws leaves nothing behind, and a missed conditional update is P2025', async () => {
    const m = shipDb({ order: [{ id: 'o1', version: 1 }] });
    const db = m.db as Row;
    await expect(db.$transaction(async (t: Row) => {
      await t.order.update({ where: { id: 'o1' }, data: { version: 2 } });
      await t.order.update({ where: { id: 'o1', version: 1 }, data: {} });
    })).rejects.toMatchObject({ code: 'P2025' });
    expect(m.data.order[0].version).toBe(1);
  });

  it('NEGATIVE: a money table does not exist', () => {
    const m = shipDb();
    expect(() => (m.db as Row).walletMovement).toThrow(/walletMovement/);
  });
});
