import { afterAll, describe, expect, it, vi } from 'vitest';
import { execSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

/**
 * A1 (25/11) — «NOTHING CONFIGURED = TODAY, BYTE FOR BYTE»: A STORE WITH NO COURIER STATEMENT GETS WHAT `osm/main` GAVE IT.
 *
 * The profit epoch is null for a store that has never uploaded a statement, and then nothing may change for it. The set did change
 * (`shippingStatus`, not the legacy column) — on purpose, and only where the two columns disagree, which is the bug itself. So the
 * books below are written the way the order's OWN shipping door writes them (`shipping-move.shippingMoveColumns`: the legacy column
 * kept in step, no collected figure before a statement) — every order state, other stores and companies, cancelled expenses, expenses
 * with no store, commissions on every kind of order — with no window and with random spans of days.
 *
 * Every answer (`expenses`, `liveExpenses`, `deliveredOrders`, `summary`) is serialised and hashed (sha256, base64url) and compared
 *   1. ALWAYS (CI too) with `the-profit-of-a-store-with-no-statement.main-golden.json`, written by THIS file from `git show osm/main:
 *      src/lib/profit-to-date.ts` (A1_WRITE_GOLDEN=1) before A1 changed a line;
 *   2. where `osm/main` (or `origin/main`) is fetched, with that file run live beside this branch's.
 */

type Row = Record<string, any>;

const { tables } = vi.hoisted(() => ({ tables: { order: [] as Row[], expense: [] as Row[], commissionEntry: [] as Row[] } }));

vi.mock('@/lib/db', () => {
  const ok = (have: unknown, want: unknown): boolean => {
    if (want === null) return have === null || have === undefined;
    if (want && typeof want === 'object' && !(want instanceof Date)) {
      const w = want as Row;
      if (Array.isArray(w.in)) return w.in.includes(have);
      if ('not' in w) return w.not === null ? have !== null && have !== undefined : have !== w.not;
      const t = (have as Date | null)?.getTime?.();
      if (t === undefined || Number.isNaN(t)) return false;
      return (w.gte === undefined || t >= w.gte.getTime()) && (w.lt === undefined || t < w.lt.getTime());
    }
    return have === want;
  };
  const matches = (row: Row, where: Row = {}): boolean =>
    Object.entries(where).every(([key, want]) => (key === 'OR' ? (want as Row[]).some((w) => matches(row, w)) : ok(row[key], want)));
  const pick = (row: Row, select?: Row) => (select ? Object.fromEntries(Object.keys(select).map((k) => [k, row[k]])) : { ...row });
  const sortBy = (orderBy: Row | undefined) => (a: Row, b: Row) => {
    if (!orderBy) return 0;
    const [[key, dir]] = Object.entries(orderBy) as [string, string][];
    const x = a[key]?.getTime?.() ?? 0;
    const y = b[key]?.getTime?.() ?? 0;
    return dir === 'desc' ? y - x : x - y;
  };
  return {
    db: {
      order: { findMany: async (q: Row) => tables.order.filter((r) => matches(r, q.where)).sort(sortBy(q.orderBy)).map((r) => pick(r, q.select)) },
      expense: { findMany: async (q: Row) => tables.expense.filter((r) => matches(r, q.where)).sort(sortBy(q.orderBy)).map((r) => pick(r, q.select)) },
      // No store in these books has a statement — the case this file is about.
      courierStatement: { findMany: async () => [] },
      store: { findUnique: async () => null },
    },
  };
});
vi.mock('@/lib/commission', async () => {
  const { db } = (await import('@/lib/db')) as unknown as { db: { order: { findMany: (q: Row) => Promise<Row[]> } } };
  return {
    commissionCostForOrders: async (where: Row) => {
      const ids = new Set((await db.order.findMany({ where })).map((o) => o.id));
      return tables.commissionEntry.filter((e) => ids.has(e.orderId)).reduce((s, e) => s + e.amount, 0);
    },
  };
});

import { profitToDate, profitWindow } from './profit-to-date';

const GOLDEN = join(__dirname, 'the-profit-of-a-store-with-no-statement.main-golden.json');
const SEEDS = Array.from({ length: 300 }, (_, i) => 20261125 + i);
const TZ = 'Asia/Damascus';

function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** The legacy column exactly as the order's own shipping door writes it beside `shippingStatus` (`shippingMoveColumns`). */
const LEGACY: Record<string, string> = { NOT_SHIPPED: 'CONFIRMED', SHIPPED: 'SHIPPED', OUT_FOR_DELIVERY: 'SHIPPED', DELIVERED: 'DELIVERED', RETURNED: 'RETURNED' };

/** One book and one question: the store, and a span of days or none. */
function scenario(seed: number): { window: ReturnType<typeof profitWindow> } {
  const r = rng(seed);
  const int = (lo: number, hi: number) => lo + Math.floor(r() * (hi - lo + 1));
  const money = (max: number) => Math.round(r() * max * 100) / [100, 100, 1000][int(0, 2)];
  tables.order.length = 0;
  tables.expense.length = 0;
  tables.commissionEntry.length = 0;
  const day = () => new Date(Date.UTC(2026, 9, int(1, 55), int(0, 23), int(0, 59)));
  for (let i = 0; i < int(2, 18); i++) {
    const shippingStatus = ['NOT_SHIPPED', 'SHIPPED', 'OUT_FOR_DELIVERY', 'DELIVERED', 'DELIVERED', 'DELIVERED', 'RETURNED'][int(0, 6)];
    const delivered = shippingStatus === 'DELIVERED';
    tables.order.push({
      id: `o${i}`, orderNumber: `ORD-${seed}-${i}`, companyId: r() < 0.93 ? 'c1' : 'c2', storeId: r() < 0.85 ? 's1' : 's2',
      shippingStatus, status: LEGACY[shippingStatus], collectedAmount: null,
      totalAmount: money(800), shippingCost: money(9), estimatedCostOfGoods: r() < 0.35 ? 0 : money(300),
      deliveredAt: delivered ? day() : r() < 0.2 ? day() : null,
    });
    if (r() < 0.6) tables.commissionEntry.push({ orderId: `o${i}`, amount: money(12) });
  }
  for (let i = 0; i < int(0, 6); i++) {
    tables.expense.push({
      id: `e${i}`, companyId: r() < 0.93 ? 'c1' : 'c2', storeId: [null, 's1', 's1', 's2'][int(0, 3)], amount: money(400), title: `e${i}`,
      category: 'OTHER', voidedAt: r() < 0.2 ? new Date('2026-11-20T00:00:00Z') : null, expenseDate: day(), walletId: 'w1',
    });
  }
  if (r() < 0.4) return { window: null };
  const a = int(1, 55);
  const b = a + int(-1, 30);
  const ymd = (n: number) => new Date(Date.UTC(2026, 9, n)).toISOString().slice(0, 10);
  return { window: profitWindow(ymd(a), ymd(b), TZ) };
}

type Engine = (scope: { companyId: string; storeId: string }, window?: ReturnType<typeof profitWindow>) => Promise<Row>;

/** The answer as bytes: every field main returned, dates as ISO, then sha256 → base64url. `since` is main-less and asserted apart. */
function digest(answer: Row): string {
  const { expenses, liveExpenses, deliveredOrders, summary } = answer;
  const bytes = JSON.stringify({ expenses, liveExpenses, deliveredOrders, summary });
  return createHash('sha256').update(bytes).digest('base64url');
}

async function digestsOf(engine: Engine): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  for (const seed of SEEDS) {
    for (const storeId of ['s1', 's2']) {
      const { window } = scenario(seed);
      out[`${seed}:${storeId}`] = digest(await engine({ companyId: 'c1', storeId }, window));
    }
  }
  return out;
}

/** `osm/main`'s profit-to-date.ts, its relative imports pointed at this tree's modules so the same fakes stand behind both. */
const mainRef = (() => {
  for (const ref of ['osm/main', 'origin/main']) {
    try {
      execSync(`git rev-parse --verify --quiet ${ref}`, { stdio: 'pipe' });
      return ref;
    } catch {
      /* not fetched here */
    }
  }
  return null;
})();
const dir = mainRef ? mkdtempSync(join(tmpdir(), 'a1-profit-main-')) : null;
afterAll(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
});
async function mainEngine(): Promise<Engine> {
  const text = execSync(`git show ${mainRef}:src/lib/profit-to-date.ts`, { encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 });
  const lib = join(process.cwd(), 'src/lib').replace(/\\/g, '/');
  const file = join(dir!, 'profit-to-date.main.ts');
  writeFileSync(file, text.replace(/from '\.\/([^']+)'/g, (_m, p) => `from '${lib}/${p}'`));
  return ((await import(/* @vite-ignore */ pathToFileURL(file).href)) as { profitToDate: Engine }).profitToDate;
}

describe('a store with no courier statement: the profit is byte for byte what osm/main answered', () => {
  it('the golden file was written from osm/main, and covers every scenario', async () => {
    if (process.env.A1_WRITE_GOLDEN === '1' && mainRef) {
      const sha = execSync(`git rev-parse ${mainRef}`, { encoding: 'utf8' }).trim();
      writeFileSync(GOLDEN, `${JSON.stringify({ source: `${sha} src/lib/profit-to-date.ts`, digests: await digestsOf(await mainEngine()) }, null, 1)}\n`);
    }
    expect(existsSync(GOLDEN)).toBe(true);
    const golden = JSON.parse(readFileSync(GOLDEN, 'utf8'));
    expect(Object.keys(golden.digests)).toHaveLength(SEEDS.length * 2);
  });

  it('this branch’s answers hash to the golden ones — every scenario', async () => {
    const golden = JSON.parse(readFileSync(GOLDEN, 'utf8')).digests as Record<string, string>;
    const ours = await digestsOf(profitToDate as unknown as Engine);
    const differ = Object.keys(golden).filter((k) => golden[k] !== ours[k]);
    expect(differ, `scenarios that moved: ${differ.slice(0, 10).join(', ')}`).toEqual([]);
  });

  it('and no store in these books has a start line', async () => {
    for (const seed of SEEDS.slice(0, 20)) {
      const { window } = scenario(seed);
      expect((await profitToDate({ companyId: 'c1', storeId: 's1' }, window)).since).toBeNull();
    }
  });

  it.runIf(!!mainRef)('LIVE: osm/main’s own file, run now beside this branch, gives the same bytes', async () => {
    const main = await mainEngine();
    const theirs = await digestsOf(main);
    const ours = await digestsOf(profitToDate as unknown as Engine);
    expect(ours).toEqual(theirs);
  });

  it('the books are not empty: delivered revenue is non-zero in most of them (the comparison compares something)', async () => {
    let withMoney = 0;
    for (const seed of SEEDS) {
      const { window } = scenario(seed);
      if ((await profitToDate({ companyId: 'c1', storeId: 's1' }, window)).summary.totalRevenue > 0) withMoney++;
    }
    expect(withMoney).toBeGreaterThan(SEEDS.length / 3);
  });
});
