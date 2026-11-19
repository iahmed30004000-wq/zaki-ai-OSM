import { describe, expect, it } from 'vitest';
import { Prisma } from '@prisma/client';

/**
 * A SMALL IN-MEMORY DATABASE FOR THE STOCK-TRANSFER TESTS (W3a) — shared by `stock-transfers.test.ts` and the doors'
 * test. It judges `where` itself (equality, null, in / notIn / not / gt, OR / AND, an order item's `order`), so WHICH
 * rows a read or a write touches is decided by the code under test, not by the fake. A transaction is all or nothing
 * (the state is restored when it throws), a conditional `update` that matches nothing throws P2025 as Prisma does, a
 * duplicate id throws P2002, and a table the transfers may not touch — a wallet, an expense, a profit — throws.
 *
 * It holds a few self-checks below so that the file runs as a test on its own (vitest runs every `*.test.ts`).
 */

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- an in-memory row; every field is read by name
export type Row = Record<string, any>;

const TABLES = [
  'country',
  'store',
  'user',
  'product',
  'productionBatch',
  'inventoryMovement',
  'warehouse',
  'warehousePlacement',
  'stockTransfer',
  'stockTransferLine',
  'order',
  'orderItem',
  'orderAddOn',
  'userCountryAccess',
  'userStoreAccess',
  'userWarehouseAccess',
] as const;

const known = (code: string) => new Prisma.PrismaClientKnownRequestError(code, { code, clientVersion: 'memory' });

export function memoryDb(seed: Partial<Record<(typeof TABLES)[number], Row[]>> = {}) {
  let data: Record<string, Row[]> = Object.fromEntries(TABLES.map((t) => [t, (seed[t] ?? []).map((r) => ({ ...r }))]));
  let seq = 0;
  const locks: string[] = [];
  const touched: string[] = [];
  /** Called just before every write of a production batch — the place a test makes «another door» write in between. */
  const hooks: { beforeBatchWrite?: (rows: Row[]) => void } = {};

  const scalar = (v: unknown, c: unknown): boolean => {
    if (c === null) return v === null || v === undefined;
    if (c instanceof Date) return v instanceof Date && v.getTime() === c.getTime();
    if (c && typeof c === 'object' && !Array.isArray(c)) {
      const o = c as Row;
      if ('in' in o && !(o.in as unknown[]).includes(v)) return false;
      if ('notIn' in o && (o.notIn as unknown[]).includes(v)) return false;
      if ('not' in o && (o.not === null ? v === null || v === undefined : v === o.not)) return false;
      if ('gt' in o && !((v as number) > o.gt)) return false;
      if ('lt' in o && !((v as number) < o.lt)) return false;
      if ('startsWith' in o && !String(v).startsWith(o.startsWith)) return false;
      return true;
    }
    return (v ?? null) === c;
  };
  const matches = (table: string, r: Row, w: Row = {}): boolean =>
    Object.entries(w).every(([k, c]) => {
      if (c === undefined) return true;
      if (k === 'OR') return (c as Row[]).some((x) => matches(table, r, x));
      if (k === 'AND') return (c as Row[]).every((x) => matches(table, r, x));
      if (k === 'order' && (table === 'orderItem' || table === 'orderAddOn')) {
        const o = data.order.find((x) => x.id === r.orderId);
        return !!o && matches('order', o, c as Row);
      }
      return scalar(r[k], c);
    });
  const sortBy = (rows: Row[], orderBy?: Row | Row[]) => {
    if (!orderBy) return rows;
    const keys = (Array.isArray(orderBy) ? orderBy : [orderBy]).map((o) => Object.entries(o)[0] as [string, 'asc' | 'desc']);
    return [...rows].sort((a, b) => {
      for (const [k, dir] of keys) {
        const x = a[k] instanceof Date ? a[k].getTime() : a[k];
        const y = b[k] instanceof Date ? b[k].getTime() : b[k];
        if (x < y) return dir === 'asc' ? -1 : 1;
        if (x > y) return dir === 'asc' ? 1 : -1;
      }
      return 0;
    });
  };
  const pick = (table: string, r: Row, select?: Row): Row => {
    if (!select) return { ...r };
    const out: Row = {};
    for (const [k, v] of Object.entries(select)) {
      if (v === true) out[k] = r[k];
      else if (k === 'lines' && table === 'stockTransfer') {
        const lines = sortBy(data.stockTransferLine.filter((l) => l.transferId === r.id), (v as Row).orderBy);
        out.lines = lines.map((l) => pick('stockTransferLine', l, (v as Row).select));
      } else if (k === 'product' && v && typeof v === 'object') {
        const p = data.product.find((x) => x.id === r.productId);
        out.product = p ? pick('product', p, (v as Row).select) : null;
      } else if (k === 'store' && v && typeof v === 'object') {
        const s = data.store.find((x) => x.id === r.storeId);
        out.store = s ? pick('store', s, (v as Row).select) : null;
      }
    }
    return out;
  };
  const apply = (r: Row, d: Row) => {
    for (const [k, v] of Object.entries(d)) {
      if (v && typeof v === 'object' && !(v instanceof Date) && 'increment' in v) r[k] += v.increment;
      else if (v && typeof v === 'object' && !(v instanceof Date) && 'decrement' in v) r[k] -= v.decrement;
      else r[k] = v;
    }
    r.updatedAt = new Date();
  };

  const table = (name: string) => ({
    findMany: async ({ where, select, orderBy, take }: Row = {}) => {
      const rows = sortBy(data[name].filter((r) => matches(name, r, where)), orderBy);
      return (take ? rows.slice(0, take) : rows).map((r) => pick(name, r, select));
    },
    findFirst: async ({ where, select, orderBy }: Row = {}) => {
      const r = sortBy(data[name].filter((x) => matches(name, x, where)), orderBy)[0];
      return r ? pick(name, r, select) : null;
    },
    findUnique: async ({ where, select }: Row) => {
      const r = data[name].find((x) => matches(name, x, where));
      return r ? pick(name, r, select) : null;
    },
    count: async ({ where }: Row = {}) => data[name].filter((r) => matches(name, r, where)).length,
    aggregate: async ({ where, _sum }: Row) => {
      const rows = data[name].filter((r) => matches(name, r, where));
      const sum: Row = {};
      for (const k of Object.keys(_sum ?? {})) sum[k] = rows.length ? rows.reduce((s, r) => s + (r[k] ?? 0), 0) : null;
      return { _sum: sum };
    },
    create: async ({ data: d, select }: Row) => {
      touched.push(`${name}.create`);
      if (name === 'productionBatch') hooks.beforeBatchWrite?.(data.productionBatch);
      const { lines, ...rest } = d;
      const row: Row = { createdAt: new Date(), updatedAt: new Date(), ...rest, id: rest.id ?? `${name}-${++seq}` };
      if (data[name].some((x) => x.id === row.id)) throw known('P2002');
      if (name === 'stockTransfer') row.status ??= 'SENT';
      if (name === 'stockTransfer') row.sentAt ??= new Date();
      data[name].push(row);
      if (lines?.create) {
        for (const l of lines.create as Row[]) {
          if (data.stockTransferLine.some((x) => x.transferId === row.id && x.productId === l.productId)) throw known('P2002');
          data.stockTransferLine.push({ id: `line-${++seq}`, transferId: row.id, quantityReceived: null, ...l });
        }
      }
      return pick(name, row, select);
    },
    update: async ({ where, data: d, select }: Row) => {
      touched.push(`${name}.update`);
      if (name === 'productionBatch') hooks.beforeBatchWrite?.(data.productionBatch);
      const r = data[name].find((x) => matches(name, x, where));
      if (!r) throw known('P2025');
      apply(r, d);
      return pick(name, r, select);
    },
    updateMany: async ({ where, data: d }: Row) => {
      touched.push(`${name}.updateMany`);
      if (name === 'productionBatch') hooks.beforeBatchWrite?.(data.productionBatch);
      const hit = data[name].filter((r) => matches(name, r, where));
      for (const r of hit) apply(r, d);
      return { count: hit.length };
    },
  });

  const db: Row = Object.fromEntries(TABLES.map((t) => [t, table(t)]));
  db.$executeRaw = async (strings: TemplateStringsArray, ...values: unknown[]) => {
    locks.push(`${strings.join('?').replace(/\s+/g, ' ').trim()} :: ${values.join(',')}`);
    return 1;
  };
  db.$queryRaw = async (strings: TemplateStringsArray, ...values: unknown[]) => {
    const sql = strings.join('?');
    locks.push(`${sql.replace(/\s+/g, ' ').trim()} :: ${values.join(',')}`);
    if (/FROM "warehouses"/.test(sql)) {
      const w = data.warehouse.find((x) => x.id === values[0]);
      return w ? [{ id: w.id, companyId: w.companyId, countryId: w.countryId, isActive: w.isActive, name: w.name }] : [];
    }
    throw new Error(`memoryDb: unexpected raw query ${sql}`);
  };
  /** The transaction client: the same tables, no `$transaction`, and nothing outside the list. */
  const tx = new Proxy(db, {
    get(target, prop) {
      if (typeof prop === 'string' && !(prop in target) && prop !== 'then') throw new Error(`a stock transfer touched «${prop}»`);
      return target[prop as string];
    },
    has: (o, p) => p !== '$transaction' && p in o,
  });
  db.$transaction = async (fn: (t: Row) => unknown) => {
    const before = structuredClone(data);
    const seqBefore = seq;
    try {
      return await fn(tx);
    } catch (e) {
      data = before;
      seq = seqBefore;
      throw e;
    }
  };

  return {
    db: db as never,
    /** The transaction client, for calling the lib directly (it refuses the root client, as a real one would be). */
    tx: tx as never,
    get data() {
      return data;
    },
    locks,
    touched,
    hooks,
  };
}

describe('the in-memory database the transfer tests stand on', () => {
  it('a transaction that throws leaves nothing behind', async () => {
    const m = memoryDb({ product: [{ id: 'p1' }] });
    await expect(
      (m.db as Row).$transaction(async (t: Row) => {
        await t.product.create({ data: { id: 'p2' } });
        throw new Error('stop');
      })
    ).rejects.toThrow('stop');
    expect(m.data.product.map((p) => p.id)).toEqual(['p1']);
  });

  it('a conditional update that matches nothing throws P2025, and a second row with one id P2002', async () => {
    const m = memoryDb({ productionBatch: [{ id: 'b1', quantityRemaining: 3 }] });
    await expect((m.db as Row).productionBatch.update({ where: { id: 'b1', quantityRemaining: 4 }, data: {} })).rejects.toMatchObject({ code: 'P2025' });
    await expect((m.db as Row).productionBatch.create({ data: { id: 'b1' } })).rejects.toMatchObject({ code: 'P2002' });
  });

  it('NEGATIVE: a money table does not exist inside a transaction', async () => {
    const m = memoryDb();
    await expect((m.db as Row).$transaction(async (t: Row) => t.walletMovement.create({}))).rejects.toThrow(/walletMovement/);
  });
});
