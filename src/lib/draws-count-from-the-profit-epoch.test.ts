import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * THE PARTNERS' DRAWS COUNT FROM THE PROFIT'S START (25/11, F13 — the owner's choice «ب» on A1's open question).
 *
 * A draw whose REAL date (the typed moment, else its registration) is before the store's profit epoch — the first instant of the store's
 * day of its first courier statement, on the store's clock (Damascus here, UTC+3) — is counted in no share, balance, «مكسور عليه» or
 * dashboard total; it stays LISTED and marked. A reversal follows its original. A store with no statement is exactly osm/main: pinned
 * by a frozen golden of base64url digests made with `git show osm/main:<file>` of the three readers (see the last block).
 *
 * The real `partnerStatement`, `withdrawalsBook` and `withdrawalHistory` run over an in-memory ledger that evaluates the `where` they
 * are handed. The net profit is a fixed figure (the profit's own arithmetic is A1's and is not touched); the EPOCH is the real
 * `profitEpoch` over the fake courier statements. No expected figure is computed with a function under test.
 */

type Row = Record<string, any>;

const { db, tables, writes, NET } = vi.hoisted(() => {
  const tables = {
    partner: [] as Row[],
    walletMovement: [] as Row[],
    user: [] as Row[],
    courierStatement: [] as Row[],
    store: [] as Row[],
    country: [] as Row[],
    wallet: [] as Row[],
    partnerWithdrawal: [] as Row[],
  };
  const writes: string[] = [];
  const NET = { value: 1000 };
  const walletOf = (r: Row) => tables.wallet.find((w) => w.id === r.walletId) ?? {};
  const matches = (row: Row, where: Row | undefined): boolean => {
    if (!where) return true;
    return Object.entries(where).every(([k, v]) => {
      if (k === 'OR') return (v as Row[]).some((w) => matches(row, w));
      if (k === 'AND') return (v as Row[]).every((w) => matches(row, w));
      if (k === 'wallet' && 'walletId' in row) return matches(walletOf(row), v as Row);
      const cell = row[k];
      if (v === null) return cell === null || cell === undefined;
      if (v instanceof Date) return cell instanceof Date && cell.getTime() === v.getTime();
      if (typeof v === 'object') {
        const o = v as Row;
        if ('in' in o && !(o.in as unknown[]).includes(cell)) return false;
        if ('not' in o && cell === o.not) return false;
        if ('gte' in o && !(cell instanceof Date && cell.getTime() >= o.gte.getTime())) return false;
        if ('lt' in o && !(cell instanceof Date && cell.getTime() < o.lt.getTime())) return false;
        return true;
      }
      return cell === v;
    });
  };
  const decorate = (name: string) => (r: Row): Row => {
    if (name === 'walletMovement') {
      const by = tables.walletMovement.find((x) => x.reversalOfId === r.id);
      const of = r.reversalOfId ? tables.walletMovement.find((x) => x.id === r.reversalOfId) : null;
      const w = walletOf(r);
      return {
        ...r,
        wallet: { storeId: w.storeId ?? null, name: w.name },
        reversedBy: by ? { id: by.id, reversalReason: by.reversalReason ?? null, createdAt: by.createdAt } : null,
        reversalOf: of ? { id: of.id, note: of.note } : null,
      };
    }
    if (name === 'wallet') return { ...r, country: tables.country.find((c) => c.id === r.countryId) };
    if (name === 'store') return { ...r, country: tables.country.find((c) => c.id === r.countryId) };
    return r;
  };
  const sortBy = (rows: Row[], orderBy: Row | Row[] | undefined) => {
    const keys = (orderBy === undefined ? [] : Array.isArray(orderBy) ? orderBy : [orderBy]).flatMap((o) => Object.entries(o) as [string, string][]);
    return [...rows].sort((a, b) => {
      for (const [k, d] of keys) {
        const x = a[k] instanceof Date ? a[k].getTime() : a[k];
        const y = b[k] instanceof Date ? b[k].getTime() : b[k];
        if (x !== y) return (x < y ? -1 : 1) * (d === 'desc' ? -1 : 1);
      }
      return 0;
    });
  };
  const model = (name: keyof typeof tables) => ({
    findMany: async (args: Row = {}) => {
      let rows = sortBy(tables[name].filter((r) => matches(r, args.where)), args.orderBy).map(decorate(name));
      if (args.distinct) rows = rows.filter((r, i) => rows.findIndex((x) => args.distinct.every((d: string) => x[d] === r[d])) === i);
      if (typeof args.take === 'number') rows = rows.slice(0, args.take);
      return rows;
    },
    findFirst: async (args: Row = {}) => tables[name].filter((r) => matches(r, args.where)).map(decorate(name))[0] ?? null,
    findUnique: async (args: Row = {}) => tables[name].filter((r) => matches(r, args.where)).map(decorate(name))[0] ?? null,
    aggregate: async ({ where }: Row) => ({ _sum: { amount: tables[name].filter((r) => matches(r, where)).reduce((s, r) => s + Number(r.amount), 0) } }),
    count: async ({ where }: Row = {}) => tables[name].filter((r) => matches(r, where)).length,
    create: async () => void writes.push(`${name}.create`),
    update: async () => void writes.push(`${name}.update`),
    updateMany: async () => void writes.push(`${name}.updateMany`),
    upsert: async () => void writes.push(`${name}.upsert`),
    delete: async () => void writes.push(`${name}.delete`),
    deleteMany: async () => void writes.push(`${name}.deleteMany`),
  });
  const db: Row = {};
  for (const name of Object.keys(tables) as (keyof typeof tables)[]) db[name] = model(name);
  return { db, tables, writes, NET };
});

vi.mock('@/lib/db', () => ({ db }));
vi.mock('@/lib/geo-context', () => ({ geoReach: async () => null }));
vi.mock('@/lib/exchange-rates', () => ({ readRateTable: async () => ({ auto: undefined, manual: { rates: {} } }) }));
vi.mock('@/lib/authorization', () => ({ hasFullAccess: () => true }));
// The profit's FIGURE is A1's and is fixed here; its START is the real `profitEpoch` over the fake statements.
vi.mock('@/lib/profit-to-date', async (orig) => {
  const real = await orig<typeof import('@/lib/profit-to-date')>();
  return {
    ...real,
    profitToDate: async (scope: { companyId: string; storeId: string; timeZone?: string | null }) => ({
      summary: { netProfit: NET.value },
      deliveredOrders: [],
      since: await real.profitEpoch(scope, scope.timeZone),
    }),
  };
});

import { partnerStatement } from './partner-statement';
import { withdrawalsBook } from './partner-withdrawals';
import { withdrawalHistory } from './history-export';
import { NO_FILTERS, withdrawalSheet, type WithdrawalLine } from './history-export-core';
import { walletBalance } from './wallets';
import { BEFORE_PROFIT_AR, drawBeforeProfit } from './draw-epoch';

const ZONE = 'Asia/Damascus';
/** The first statement is registered 2026-10-28 10:00 UTC → the store's day 2026-10-28 → the epoch is its first instant, 21:00 UTC the evening before. */
const FIRST_STATEMENT = new Date('2026-10-28T10:00:00.000Z');
const EPOCH = new Date('2026-10-27T21:00:00.000Z');
const USER = { id: 'u1', role: 'SUPER_ADMIN', permissions: [] } as never;
const S1 = { currencyCode: 'USD', minorUnit: 2, timezone: ZONE };

function base() {
  for (const t of Object.values(tables)) t.length = 0;
  writes.length = 0;
  NET.value = 1000;
  tables.country.push(
    { id: 'cu', companyId: 'c1', currencyCode: 'USD', minorUnit: 2, timezone: ZONE },
    { id: 'cs', companyId: 'c1', currencyCode: 'SYP', minorUnit: 0, timezone: ZONE }
  );
  tables.store.push({ id: 's1', companyId: 'c1', name: 'المتجر الأول', countryId: 'cu' }, { id: 's2', companyId: 'c1', name: 'المتجر التاني', countryId: 'cu' });
  tables.wallet.push(
    { id: 'wu', companyId: 'c1', storeId: 's1', name: 'الصندوق', currencyCode: 'USD', countryId: 'cu', openingBalance: 5000 },
    { id: 'ws', companyId: 'c1', storeId: 's1', name: 'الليرة', currencyCode: 'SYP', countryId: 'cs', openingBalance: 0 },
    { id: 'wb', companyId: 'c1', storeId: 's2', name: 'صندوق التاني', currencyCode: 'USD', countryId: 'cu', openingBalance: 0 }
  );
  tables.partner.push(
    { id: 'pa', companyId: 'c1', name: 'شريك أ', sharePercent: 50, isActive: true, sortOrder: 0, createdAt: new Date('2026-01-01') },
    { id: 'pb', companyId: 'c1', name: 'شريك ب', sharePercent: 50, isActive: true, sortOrder: 1, createdAt: new Date('2026-01-02') }
  );
  tables.user.push({ id: 'u1', name: 'المالك' });
}
const withEpoch = (storeId = 's1') =>
  tables.courierStatement.push({ id: `cs-${storeId}`, companyId: 'c1', storeId, createdAt: FIRST_STATEMENT, fileHash: 'a'.repeat(64) });

let seq = 0;
function draw(over: Row): Row {
  const row = {
    id: `m${++seq}`, companyId: 'c1', walletId: 'wu', category: 'PARTNER_DRAW', direction: 'OUT', amount: 100, currencyCode: 'USD',
    valueInStoreCurrency: 100, partnerId: 'pa', party: 'شريك أ', note: '', reversalOfId: null, reversalReason: null,
    createdAt: new Date('2026-11-05T10:00:00.000Z'), occurredAt: null, createdById: 'u1', referenceType: null, referenceId: null,
    equivalentRate: null, equivalentRateKind: null, equivalentRateSource: null, equivalentRateAt: null, ...over,
  };
  if (row.walletId === 'ws' && !('currencyCode' in over)) row.currencyCode = 'SYP';
  tables.walletMovement.push(row);
  return row;
}
const reverse = (of: Row, createdAt: Date) =>
  draw({ direction: 'IN', reversalOfId: of.id, walletId: of.walletId, currencyCode: of.currencyCode, amount: of.amount, valueInStoreCurrency: of.valueInStoreCurrency, partnerId: of.partnerId, reversalReason: 'غلط', createdAt });

const statement = () => partnerStatement({ companyId: 'c1', storeId: 's1', currency: 'USD', minorUnit: 2 });
const book = (filters = NO_FILTERS) => withdrawalsBook({ user: USER, companyId: 'c1', storeId: 's1', country: S1, filters });
const lineOf = (s: Awaited<ReturnType<typeof statement>>, id: string) => s.lines.find((l) => l.id === id)!;

beforeEach(() => {
  seq = 0;
  base();
});

describe('the boundary: the first instant of the store\'s day', () => {
  it('one instant before the epoch is not counted; at the epoch it is (Damascus day, UTC+3)', async () => {
    withEpoch();
    const early = draw({ amount: 30, valueInStoreCurrency: 30, createdAt: new Date(EPOCH.getTime() - 1) });
    const onTime = draw({ amount: 70, valueInStoreCurrency: 70, createdAt: new Date(EPOCH.getTime()) });
    const s = await statement();
    expect(s.sinceDay).toBe('2026-10-28');
    expect(lineOf(s, 'pa').draws).toBe(70);
    expect(lineOf(s, 'pa').balance).toBe(430);
    expect(s.totals.draws).toBe(70);
    expect(s.beforeProfitCount).toBe(1);
    expect(s.draws.find((d) => d.id === early.id)?.beforeProfit).toBe(true);
    expect(s.draws.find((d) => d.id === onTime.id)).not.toHaveProperty('beforeProfit');

    const b = await book();
    expect(b.totals.map((t) => [t.partnerId, t.currencyCode, t.total, t.count])).toEqual([['pa', 'USD', 70, 1]]);
    expect(b.beforeProfit?.totals.map((t) => [t.partnerId, t.currencyCode, t.total, t.count])).toEqual([['pa', 'USD', 30, 1]]);
    expect(b.equivalentSums.store).toEqual({ value: 70, count: 1 });
    expect(b.rows.find((r) => r.id === early.id)?.beforeProfit).toBe(true);
    expect(b.rows.find((r) => r.id === onTime.id)).not.toHaveProperty('beforeProfit');
  });

  it('the pure rule: no epoch → never before; the real date wins over the registration', () => {
    const at = (iso: string | null, created: string) => ({ occurredAt: iso, createdAt: created });
    expect(drawBeforeProfit(at(null, '2020-01-01T00:00:00Z'), null)).toBe(false);
    expect(drawBeforeProfit(at(null, '2020-01-01T00:00:00Z'), undefined)).toBe(false);
    expect(drawBeforeProfit(at('2026-10-27T20:59:59.999Z', '2026-11-30T00:00:00Z'), EPOCH)).toBe(true);
    expect(drawBeforeProfit(at('2026-10-27T21:00:00.000Z', '2026-11-30T00:00:00Z'), EPOCH)).toBe(false);
    expect(drawBeforeProfit(at(null, '2026-10-27T21:00:00.000Z'), EPOCH)).toBe(false);
    expect(BEFORE_PROFIT_AR).toBe('قبل بداية الأرباح — ما بتنحسب');
  });
});

describe('the real date decides', () => {
  it('a backdated draw (typed before the epoch, registered after) is not counted', async () => {
    withEpoch();
    draw({ amount: 40, valueInStoreCurrency: 40, occurredAt: new Date('2026-10-20T09:00:00.000Z'), createdAt: new Date('2026-11-02T09:00:00.000Z') });
    draw({ amount: 15, valueInStoreCurrency: 15 });
    const s = await statement();
    expect(lineOf(s, 'pa').draws).toBe(15);
    expect(s.beforeProfitCount).toBe(1);
    const b = await book();
    expect(b.totals[0].total).toBe(15);
    expect(b.beforeProfit?.totals[0].total).toBe(40);
  });

  it('NEGATIVE: a draw typed after the epoch for a draw registered after it is counted, whatever its registration', async () => {
    withEpoch();
    draw({ amount: 40, valueInStoreCurrency: 40, occurredAt: new Date('2026-10-29T09:00:00.000Z'), createdAt: new Date('2026-11-02T09:00:00.000Z') });
    const s = await statement();
    expect(lineOf(s, 'pa').draws).toBe(40);
    expect(s.beforeProfitCount).toBe(0);
  });
});

describe('a reversal follows its original', () => {
  it('a pre-epoch draw reversed after the epoch: nothing counted, nothing «before», the row marked both ways', async () => {
    withEpoch();
    const d = draw({ amount: 60, valueInStoreCurrency: 60, createdAt: new Date('2026-10-01T10:00:00.000Z') });
    reverse(d, new Date('2026-11-10T10:00:00.000Z'));
    const s = await statement();
    expect(lineOf(s, 'pa').draws).toBe(0);
    expect(s.beforeProfitCount).toBe(0);
    expect(s.draws).toHaveLength(1);
    expect(s.draws[0]).toMatchObject({ id: d.id, reversed: true, beforeProfit: true });
    const b = await book();
    expect(b.totals).toEqual([]);
    expect(b.beforeProfit?.totals).toEqual([]);
    expect(b.rows.map((r) => [r.id, r.wasReversed, r.beforeProfit])).toEqual([[d.id, true, true]]);
  });

  it('the other way round: a counted draw whose reversal is dated before the epoch still comes back as nothing', async () => {
    withEpoch();
    const d = draw({ amount: 60, valueInStoreCurrency: 60, createdAt: new Date('2026-11-01T10:00:00.000Z') });
    reverse(d, new Date('2026-10-01T10:00:00.000Z'));
    const s = await statement();
    expect(lineOf(s, 'pa').draws).toBe(0);
    expect(s.draws[0]).toMatchObject({ id: d.id, reversed: true });
    expect(s.draws[0]).not.toHaveProperty('beforeProfit');
    const b = await book();
    expect(b.totals).toEqual([]);
    expect(b.rows[0].beforeProfit).toBeUndefined();
  });
});

describe('the partner account: entitlement as A1 made it, draws floored, balance and «مكسور عليه» follow', () => {
  it('an old draw no longer makes a partner «مكسور عليه»', async () => {
    withEpoch();
    draw({ amount: 900, valueInStoreCurrency: 900, createdAt: new Date('2026-09-01T10:00:00.000Z') });
    draw({ amount: 100, valueInStoreCurrency: 100 });
    const s = await statement();
    expect(lineOf(s, 'pa')).toMatchObject({ entitlement: 500, draws: 100, balance: 400, broken: 0 });
    expect(s.totals).toEqual({ entitlement: 1000, draws: 100, broken: 0 });
  });

  it('NEGATIVE: the same draws with NO statement count from the beginning — he is «مكسور عليه» 500', async () => {
    draw({ amount: 900, valueInStoreCurrency: 900, createdAt: new Date('2026-09-01T10:00:00.000Z') });
    draw({ amount: 100, valueInStoreCurrency: 100 });
    const s = await statement();
    expect(lineOf(s, 'pa')).toMatchObject({ entitlement: 500, draws: 1000, balance: -500, broken: 500 });
    expect(s).not.toHaveProperty('beforeProfitCount');
    expect(s.draws.every((d) => !('beforeProfit' in d))).toBe(true);
  });

  it('a pre-epoch draw with no store value is not «uncounted»: it is before the profit, said apart', async () => {
    withEpoch();
    draw({ walletId: 'ws', amount: 500000, valueInStoreCurrency: null, createdAt: new Date('2026-10-01T10:00:00.000Z') });
    draw({ walletId: 'ws', amount: 300000, valueInStoreCurrency: null });
    const s = await statement();
    expect(s.uncounted).toBe(1);
    expect(s.beforeProfitCount).toBe(1);
  });
});

describe('the dashboard: per currency, never mixed; the early ones on a line of their own', () => {
  it('USD and SYP before and after the epoch: four lines, each in its own currency; the sums hold only counted stored values', async () => {
    withEpoch();
    draw({ amount: 10, valueInStoreCurrency: 10, createdAt: new Date('2026-10-01T10:00:00.000Z') });
    draw({ walletId: 'ws', amount: 150000, valueInStoreCurrency: 10, createdAt: new Date('2026-10-02T10:00:00.000Z') });
    draw({ amount: 20, valueInStoreCurrency: 20 });
    draw({ walletId: 'ws', amount: 300000, valueInStoreCurrency: null });
    const b = await book();
    const pick = (ts: { currencyCode: string; total: number; valueTotal: number; unvaluedTotal: number }[]) =>
      Object.fromEntries(ts.map((t) => [t.currencyCode, [t.total, t.valueTotal, t.unvaluedTotal]]));
    expect(pick(b.totals)).toEqual({ USD: [20, 20, 0], SYP: [300000, 0, 300000] });
    expect(pick(b.beforeProfit!.totals)).toEqual({ USD: [10, 10, 0], SYP: [150000, 10, 0] });
    expect(b.equivalentSums.store).toEqual({ value: 20, count: 1 });
    expect(b.beforeProfit!.label).toBe(BEFORE_PROFIT_AR);
    expect(b.beforeProfit!.sinceDay).toBe('2026-10-28');
  });

  it('each store is judged by ITS epoch: store 2 has none, so its old draw counts there', async () => {
    withEpoch('s1');
    draw({ walletId: 'wb', amount: 70, valueInStoreCurrency: 70, createdAt: new Date('2026-10-01T10:00:00.000Z') });
    draw({ amount: 5, valueInStoreCurrency: 5, createdAt: new Date('2026-10-01T10:00:00.000Z') });
    const b = await book();
    expect(b.byStore.map((t) => [t.storeId, t.total])).toEqual([['s2', 70]]);
    expect(b.beforeProfit?.byStore.map((t) => [t.storeId, t.total])).toEqual([['s1', 5]]);
  });

  it('NEGATIVE: no store with an epoch → the book carries no «beforeProfit» at all', async () => {
    draw({ createdAt: new Date('2026-10-01T10:00:00.000Z') });
    const b = await book();
    expect(b).not.toHaveProperty('beforeProfit');
    expect(b.rows.every((r) => !('beforeProfit' in r))).toBe(true);
  });
});

describe('the history file (F5)', () => {
  it('a pre-epoch draw is in the file, its status says so, and it is totalled on its own line per currency', async () => {
    withEpoch();
    draw({ amount: 10, valueInStoreCurrency: 10, createdAt: new Date('2026-10-01T10:00:00.000Z') });
    draw({ walletId: 'ws', amount: 150000, valueInStoreCurrency: null, createdAt: new Date('2026-10-02T10:00:00.000Z') });
    draw({ amount: 20, valueInStoreCurrency: 20 });
    const out = await withdrawalHistory({ companyId: 'c1', storeId: 's1', timeZone: ZONE }, NO_FILTERS);
    if (!out.ok) throw new Error('refused');
    expect(out.sheet.rows).toHaveLength(3);
    expect(out.sheet.rows.map((r) => r.cells.at(-1))).toEqual(['ساري', BEFORE_PROFIT_AR, BEFORE_PROFIT_AR]);
    expect(out.sheet.totals.map((t) => [t.label, t.currency, t.amount, t.count])).toEqual([
      [BEFORE_PROFIT_AR, 'SYP', 150000, 1],
      [BEFORE_PROFIT_AR, 'USD', 10, 1],
      ['ما يعادله بعملة المتجر', 'USD', 20, 1],
      ['مسحوبات', 'USD', 20, 1],
    ]);
  });

  it('NEGATIVE: the sheet with no line marked is the sheet as it was — «ساري», and «مسحوبات» holds every standing draw', () => {
    const line = (over: Partial<WithdrawalLine>): WithdrawalLine => ({
      id: 'x', partnerName: 'شريك أ', walletName: 'الصندوق', currencyCode: 'USD', minorUnit: 2, amount: 10, valueInStoreCurrency: null,
      storeCurrency: 'USD', storeMinor: 2, note: null, createdAt: '2026-11-01T10:00:00.000Z', realDate: '2026-11-01T10:00:00.000Z',
      createdByName: null, reversedBy: null, storeName: 'المتجر الأول', ...over,
    });
    const sheet = withdrawalSheet([line({}), line({ id: 'y', amount: 5 })], ZONE);
    expect(sheet.rows.map((r) => r.cells.at(-1))).toEqual(['ساري', 'ساري']);
    expect(sheet.totals).toEqual([{ label: 'مسحوبات', currency: 'USD', minorUnit: 2, amount: 15, count: 2 }]);
  });
});

/** A small deterministic random source, so a failure names its seed. */
function rng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
}

/** Random draws around the epoch: two wallets of store 1 and one of store 2, a third partner sometimes, typed dates, no value, reversals. */
function scenario(seed: number) {
  const r = rng(seed);
  const pick = <T,>(xs: T[]) => xs[Math.floor(r() * xs.length)];
  NET.value = pick([0, -50, 333.33, 1000, 12345.67]);
  if (r() < 0.3) tables.partner.push({ id: 'pc', companyId: 'c1', name: 'شريك ج', sharePercent: 10, isActive: r() < 0.5, sortOrder: 2, createdAt: new Date('2026-01-03') });
  const n = 2 + Math.floor(r() * 9);
  const made: Row[] = [];
  for (let i = 0; i < n; i++) {
    const createdAt = new Date(EPOCH.getTime() + Math.round((r() - 0.5) * 60 * 86_400_000));
    const typed = r() < 0.3 ? new Date(createdAt.getTime() - Math.round(r() * 20 * 86_400_000)) : null;
    const walletId = pick(['wu', 'wu', 'ws', 'wb']);
    const amount = walletId === 'ws' ? Math.round(r() * 1e6) : Math.round(r() * 1e5) / 100;
    made.push(
      draw({
        walletId, amount, createdAt, occurredAt: typed,
        partnerId: r() < 0.1 ? null : pick(tables.partner.map((p) => p.id)),
        valueInStoreCurrency: walletId === 'ws' ? (r() < 0.5 ? null : Math.round(r() * 1e4) / 100) : amount,
      })
    );
  }
  for (const d of made) if (r() < 0.2) reverse(d, new Date(d.createdAt.getTime() + Math.round((r() - 0.3) * 40 * 86_400_000)));
  return made;
}

describe('the partners\' statement and the dashboard agree on what is counted — 40 seeded scenarios with an epoch', () => {
  it('per partner: the statement\'s draws = the expected sum of counted stored values = the dashboard\'s «المجموع»', async () => {
    for (let seed = 1; seed <= 40; seed++) {
      base();
      withEpoch();
      scenario(seed);
      const s = await statement();
      const b = await book();
      // Expected from the raw rows, with the rule written out by hand: an original OUT of store 1, not reversed, real date ≥ the epoch.
      const reversedIds = new Set(tables.walletMovement.filter((m) => m.reversalOfId).map((m) => m.reversalOfId));
      const storeOf = (m: Row) => tables.wallet.find((w) => w.id === m.walletId)!.storeId;
      const standing = tables.walletMovement.filter((m) => !m.reversalOfId && !reversedIds.has(m.id) && storeOf(m) === 's1');
      const realMs = (m: Row) => (m.occurredAt ?? m.createdAt).getTime();
      const cents: Record<string, number> = {};
      for (const m of standing) {
        if (realMs(m) < EPOCH.getTime() || !m.partnerId || m.valueInStoreCurrency === null) continue;
        cents[m.partnerId] = (cents[m.partnerId] ?? 0) + Math.round(m.valueInStoreCurrency * 100);
      }
      const fromStatement = Object.fromEntries(s.lines.filter((l) => l.draws !== 0).map((l) => [l.id, Math.round(l.draws * 100)]));
      const fromBook = Object.fromEntries(b.equivalentSums.byPartner.map((p) => [p.partnerId, Math.round(p.value * 100)]));
      const expected = Object.fromEntries(Object.entries(cents).filter(([, v]) => v !== 0));
      expect(fromStatement, `seed ${seed}`).toEqual(expected);
      expect(fromBook, `seed ${seed}`).toEqual(expected);
      // The early ones: the same count on both sides (with a partner), and none of them in any counted figure.
      const early = standing.filter((m) => realMs(m) < EPOCH.getTime());
      expect(s.beforeProfitCount, `seed ${seed}`).toBe(early.length);
      expect((b.beforeProfit?.totals ?? []).reduce((a, t) => a + t.count, 0), `seed ${seed}`).toBe(early.filter((m) => m.partnerId).length);
      for (const t of b.beforeProfit?.totals ?? []) expect(b.totals.some((c) => c.partnerId === t.partnerId && c.currencyCode === t.currencyCode && c.count === 0)).toBe(false);
    }
  });
});

describe('wallets and movements are untouched', () => {
  it('no reader writes anything, and every wallet balance is the same with and without an epoch', async () => {
    scenario(7);
    const before = await Promise.all(['wu', 'ws', 'wb'].map((id) => walletBalance(db as never, id, 2)));
    await statement();
    await book();
    await withdrawalHistory({ companyId: 'c1', storeId: 's1', timeZone: ZONE }, NO_FILTERS);
    withEpoch();
    await statement();
    await book();
    await withdrawalHistory({ companyId: 'c1', storeId: 's1', timeZone: ZONE }, NO_FILTERS);
    const after = await Promise.all(['wu', 'ws', 'wb'].map((id) => walletBalance(db as never, id, 2)));
    expect(after).toEqual(before);
    expect(writes).toEqual([]);
  });

  it('the rule imports nothing but the real date', () => {
    const src = readFileSync(join(process.cwd(), 'src', 'lib', 'draw-epoch.ts'), 'utf8');
    expect([...src.matchAll(/from\s+'([^']+)'/g)].map((m) => m[1])).toEqual(['./real-date']);
  });
});

/**
 * NO STATEMENT = osm/main, BYTE FOR BYTE. `draws-count-from-the-profit-epoch.main-golden.json` holds, per seeded scenario, the base64url
 * SHA-256 of the JSON of the three answers (the statement, the dashboard's book with no span and with a span, the history file). It was
 * frozen by running this file with `F13_WRITE_GOLDEN=1 F13_MAIN=1` while `src/lib/f13-main-partner-statement.ts`,
 * `f13-main-partner-withdrawals.ts`, `f13-main-history-export.ts` and `f13-main-history-export-core.ts` were `git show osm/main:<file>`
 * (main 7f4afc29, with A1) — those copies were removed after. Today's files must answer the same digests.
 */
const GOLDEN = join(process.cwd(), 'src', 'lib', 'draws-count-from-the-profit-epoch.main-golden.json');
const digest = (v: unknown) => createHash('sha256').update(JSON.stringify(v)).digest('base64url');

describe('a store with no statement is exactly osm/main', () => {
  it('60 scenarios: the same digests as main', async () => {
    const main = process.env.F13_MAIN === '1';
    const dir = join(process.cwd(), 'src', 'lib');
    const st: typeof import('./partner-statement') = main ? await import(/* @vite-ignore */ join(dir, 'f13-main-partner-statement.ts')) : await import('./partner-statement');
    const wd: typeof import('./partner-withdrawals') = main ? await import(/* @vite-ignore */ join(dir, 'f13-main-partner-withdrawals.ts')) : await import('./partner-withdrawals');
    const he: typeof import('./history-export') = main ? await import(/* @vite-ignore */ join(dir, 'f13-main-history-export.ts')) : await import('./history-export');
    const out: string[] = [];
    for (let seed = 100; seed < 160; seed++) {
      base();
      scenario(seed);
      const span = { ...NO_FILTERS, from: '2026-10-15', to: '2026-11-10' } as typeof NO_FILTERS;
      out.push(
        digest([
          await st.partnerStatement({ companyId: 'c1', storeId: 's1', currency: 'USD', minorUnit: 2 }),
          await wd.withdrawalsBook({ user: USER, companyId: 'c1', storeId: 's1', country: S1, filters: NO_FILTERS }),
          await wd.withdrawalsBook({ user: USER, companyId: 'c1', storeId: 's1', country: S1, filters: span }),
          await he.withdrawalHistory({ companyId: 'c1', storeId: 's1', timeZone: ZONE }, NO_FILTERS),
          await he.withdrawalHistory({ companyId: 'c1', storeId: 's1', timeZone: ZONE }, span),
        ])
      );
    }
    if (process.env.F13_WRITE_GOLDEN === '1') writeFileSync(GOLDEN, `${JSON.stringify(out, null, 1)}\n`);
    expect(existsSync(GOLDEN)).toBe(true);
    expect(out).toEqual(JSON.parse(readFileSync(GOLDEN, 'utf8')));
  });

  it('the golden is not empty: 60 distinct digests', () => {
    const golden = JSON.parse(readFileSync(GOLDEN, 'utf8')) as string[];
    expect(golden).toHaveLength(60);
    expect(new Set(golden).size).toBe(60);
    expect(golden.every((d) => /^[A-Za-z0-9_-]{43}$/.test(d))).toBe(true);
  });
});
