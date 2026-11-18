import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * THE BENCH DOOR CARRIES EACH PRODUCT'S TEST AND VERDICT, AND WRITES ONLY THE
 * OWNER'S NUMBERS (18/11, request B3).
 *
 * GET adds per product: spend to date, orders, confirmed, confirmation rate,
 * cost per order and per confirmed order, the day of the test and the
 * verdict — and the store day and money are the BENCH STORE's. POST writes a
 * product's rules and its spend by day into the company's settings, under
 * the key the screen already needs (`growth.intelligence`), refuses in Arabic,
 * and never writes to an order or a money table.
 */

const h = vi.hoisted(() => ({
  settings: null as string | null,
  allowed: true,
  products: [] as { id: string; storeId: string }[],
  orders: [] as { productId: string; storeId: string; createdAt: Date; confirmationStatus: string; shippingStatus: string }[],
  logAudit: vi.fn(),
  writes: [] as string[],
}));

const BENCH = { id: 'bench-1', name: 'منصّة', country: { currencyCode: 'JOD', minorUnit: 3, timezone: 'Asia/Amman' } };

vi.mock('@/lib/db', () => {
  const refuse = (what: string) => async () => {
    h.writes.push(what);
    throw new Error(`write to ${what}`);
  };
  return {
    db: {
      company: { findUnique: async () => ({ settings: h.settings }), update: refuse('company') },
      store: { findMany: async () => [BENCH] },
      product: {
        findMany: async (q: { where: { storeId?: unknown } }) =>
          q.where.storeId
            ? h.products.map((p) => ({ ...p, name: 'منتج', sku: null, basePrice: 10, createdAt: new Date(), category: null }))
            : [],
        findFirst: async (q: { where: { id: string; store: { isTest: boolean } } }) => {
          const p = h.products.find((x) => x.id === q.where.id);
          return p && q.where.store.isTest ? { id: p.id, name: 'منتج', store: { country: BENCH.country } } : null;
        },
      },
      order: {
        groupBy: async () => [],
        findMany: async () => h.orders,
        create: refuse('order'),
        update: refuse('order'),
        updateMany: refuse('order'),
      },
      expense: { create: refuse('expense') },
    },
  };
});
vi.mock('@/lib/audit', () => ({ logAudit: (...a: unknown[]) => h.logAudit(...a) }));
vi.mock('@/lib/geo-context', () => ({
  requireContext: async () => ({
    user: { id: 'u1' },
    companyId: 'c1',
    country: { currencyCode: 'USD', minorUnit: 2, timezone: 'Asia/Damascus' },
  }),
}));
vi.mock('@/lib/authorization', () => ({
  requirePermission: async (key: string) => {
    if (key !== 'growth.intelligence') throw new Error(`wrong key ${key}`);
    if (!h.allowed) throw new Error(`Forbidden: missing required permission ${key}`);
    return { id: 'u1' };
  },
}));
vi.mock('@/lib/product-dna', () => ({
  readDna: () => ({ sellers: 0, minSellers: 10, traits: null }),
  whyNoDna: () => 'لا',
  dnaLineAr: () => '',
}));
vi.mock('@/lib/company-settings', () => ({
  updateCompanySettings: async (_c: string, key: string, change: (cur: unknown) => unknown) => {
    const all = h.settings ? JSON.parse(h.settings) : {};
    const next = change(all[key]);
    if (next === undefined) delete all[key];
    else all[key] = next;
    h.settings = JSON.stringify(all);
    return next;
  },
}));

import { GET, POST } from './route';
import { localDay } from '@/lib/eod-report';

const post = (body: unknown) => POST(new Request('http://x/api/growth/bench', { method: 'POST', body: JSON.stringify(body) }));
const today = () => localDay(new Date(), 'Asia/Amman');
const daysAgo = (n: number) => localDay(new Date(Date.now() - n * 86_400_000), 'Asia/Amman');
const read = async () => (await (await GET()).json()) as { results: Record<string, any>[] };

beforeEach(() => {
  vi.clearAllMocks();
  h.settings = null;
  h.allowed = true;
  h.products = [{ id: 'p1', storeId: 'bench-1' }];
  h.orders = [];
  h.writes = [];
});

describe('GET — the test and its verdict per product', () => {
  it('before any spend: not judged, the defaults shown, the bench store’s money', async () => {
    const [r] = (await read()).results;
    expect(r.verdict.state).toBe('NOT_JUDGED');
    expect(r.rules).toMatchObject({ targetCpo: 4, capSpend: 60, failMultiplier: 1.3 });
    expect(r.customRules).toBe(false);
    expect(r.currency).toBe('JOD');
    expect(r.minorUnit).toBe(3);
    expect(r.today).toBe(today());
  });

  it('three days of spend and cheap confirmed orders → success, with every figure', async () => {
    for (const n of [2, 1, 0]) expect((await post({ action: 'spend', productId: 'p1', day: daysAgo(n), amount: 10 })).status).toBe(200);
    // Orders on the days that have spend, mid-day so the store day is the same day.
    h.orders = Array.from({ length: 10 }, (_, i) => ({
      productId: 'p1', storeId: 'bench-1', createdAt: new Date(Date.now() - (i % 3) * 86_400_000),
      confirmationStatus: i < 8 ? 'CONFIRMED' : 'NO_ANSWER', shippingStatus: 'NOT_SHIPPED',
    }));
    const [r] = (await read()).results;
    expect(r.test).toMatchObject({ dayIndex: 3, spend: 30, orders: 10, confirmed: 8, confirmationRate: 80, costPerOrder: 3, costPerConfirmed: 3.75 });
    expect(r.verdict.state).toBe('SUCCESS');
    expect(r.spendEntries).toHaveLength(3);
  });

  it('NEGATIVE: orders on a day with no spend → «الصرف ناقص», not a verdict', async () => {
    await post({ action: 'spend', productId: 'p1', day: daysAgo(2), amount: 1 });
    h.orders = [{ productId: 'p1', storeId: 'bench-1', createdAt: new Date(), confirmationStatus: 'CONFIRMED', shippingStatus: 'NOT_SHIPPED' }];
    const [r] = (await read()).results;
    expect(r.verdict.state).toBe('NOT_JUDGED');
    expect(r.verdict.reason).toContain('الصرف ناقص');
  });

  it('NEGATIVE: shipping has no say — delivered or not, the verdict is the same', async () => {
    for (const n of [2, 1, 0]) await post({ action: 'spend', productId: 'p1', day: daysAgo(n), amount: 10 });
    const mk = (s: string) => Array.from({ length: 10 }, (_, i) => ({
      productId: 'p1', storeId: 'bench-1', createdAt: new Date(Date.now() - (i % 3) * 86_400_000), confirmationStatus: 'CONFIRMED', shippingStatus: s,
    }));
    h.orders = mk('DELIVERED');
    const a = (await read()).results[0].verdict;
    h.orders = mk('RETURNED');
    const b = (await read()).results[0].verdict;
    expect(a).toEqual(b);
  });
});

describe('POST — rules and spend, the owner’s numbers only', () => {
  it('saves a product’s rules, with an audit row; null puts the defaults back', async () => {
    expect((await post({ action: 'rules', productId: 'p1', rules: { targetCpo: 5 } })).status).toBe(200);
    expect(JSON.parse(h.settings!).benchRules.p1.targetCpo).toBe(5);
    expect(h.logAudit).toHaveBeenCalledWith(expect.objectContaining({ action: 'BENCH_RULES_UPDATED', entityId: 'p1' }));
    const [r] = (await read()).results;
    expect(r.customRules).toBe(true);
    expect(r.rules.targetCpo).toBe(5);
    await post({ action: 'rules', productId: 'p1', rules: null });
    expect(JSON.parse(h.settings!).benchRules).toBeUndefined();
  });

  it('NEGATIVE: bad rules are a 400 with Arabic sentences, and nothing is stored', async () => {
    const r = await post({ action: 'rules', productId: 'p1', rules: { targetCpo: 0, continueDay: 4, successDay: 2 } });
    expect(r.status).toBe(400);
    const body = await r.json();
    expect(body.errorAr).toMatch(/هدف تكلفة الطلب/);
    expect(body.errorAr).toMatch(/يوم النجاح/);
    expect(h.settings).toBeNull();
  });

  it('NEGATIVE: a product that is not on a bench is refused', async () => {
    const r = await post({ action: 'spend', productId: 'real-product', day: today(), amount: 5 });
    expect(r.status).toBe(400);
    expect((await r.json()).errorAr).toContain('منصّة التجريب');
    expect(h.settings).toBeNull();
  });

  it('NEGATIVE: without `growth.intelligence` nothing moves', async () => {
    h.allowed = false;
    const r = await post({ action: 'spend', productId: 'p1', day: today(), amount: 5 });
    expect(r.status).toBe(403);
    expect(h.settings).toBeNull();
  });

  it('NEGATIVE: an unknown action, a future day, a second entry for a day — 400 each', async () => {
    expect((await post({ action: 'delete', productId: 'p1' })).status).toBe(400);
    const tomorrow = localDay(new Date(Date.now() + 2 * 86_400_000), 'Asia/Amman');
    expect((await post({ action: 'spend', productId: 'p1', day: tomorrow, amount: 5 })).status).toBe(400);
    expect((await post({ action: 'spend', productId: 'p1', day: today(), amount: 5 })).status).toBe(200);
    const again = await post({ action: 'spend', productId: 'p1', day: today(), amount: 6 });
    expect(again.status).toBe(400);
    expect((await again.json()).errorAr).toContain('صحّحه');
  });

  it('void keeps the line; correct voids and rewrites — nothing is ever deleted', async () => {
    await post({ action: 'spend', productId: 'p1', day: today(), amount: 5 });
    const id = JSON.parse(h.settings!).benchSpend.p1[0].id;
    expect((await post({ action: 'correct', productId: 'p1', entryId: id, amount: 7 })).status).toBe(200);
    let list = JSON.parse(h.settings!).benchSpend.p1;
    expect(list).toHaveLength(2);
    expect(list[0].voidedAt).toBeTruthy();
    expect(list[1]).toMatchObject({ amount: 7, replaces: id });
    expect((await post({ action: 'void', productId: 'p1', entryId: list[1].id })).status).toBe(400); // no reason
    expect((await post({ action: 'void', productId: 'p1', entryId: list[1].id, reason: 'مش هالمنتج' })).status).toBe(200);
    list = JSON.parse(h.settings!).benchSpend.p1;
    expect(list).toHaveLength(2);
    expect(list.every((e: { voidedAt?: string }) => e.voidedAt)).toBe(true);
    expect((await read()).results[0].test.spend).toBeNull();
  });

  it('writes nothing but the settings: no order, no expense', async () => {
    await post({ action: 'spend', productId: 'p1', day: today(), amount: 5 });
    await post({ action: 'rules', productId: 'p1', rules: {} });
    expect(h.writes).toEqual([]);
  });
});
