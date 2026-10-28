import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * `?limit=-5` AND `?limit=0` — THE FOUR DOORS THE FIRST SWEEP MISSED.
 *
 * `0aea050` fixed seven paginated doors and listed those seven in
 * `src/lib/a-page-number-is-not-a-crash.test.ts`. Four more had the same
 * fault and were in no list, so nothing checked them. These tests assert
 * THE ROWS RETURNED and THE ARGUMENT HANDED TO PRISMA — never the text of
 * an expression — because the whole family of faults here is invisible in
 * the response.
 *
 * MEASURED against this database (12 products, 44 landing pages) before any
 * fix, because the three plausible outcomes of a negative `take` are very
 * different and only one of them is loud:
 *
 *     db.product.findMany({ orderBy: { name: 'asc' }, take: -5 })
 *       → ACCEPTED. Returns the LAST five rows.
 *     db.product.findMany({ take: 0 })
 *       → ACCEPTED. Returns nothing.
 *     db.product.findMany({ take: 5, skip: -5 })
 *       → PrismaClientUnknownRequestError: «Invalid value for skip
 *         argument: Value can only be positive, found: -5»
 *
 * So `?limit=-5` is not a crash and not an empty page: it is a DIFFERENT SET
 * OF ROWS, presented as the answer to the question that was asked. On
 * `finance/profitability` — a profit report — it dropped the last five
 * products via `.slice(0, -5)`. On `landing-pages` it also made
 * `?page=2&limit=-5` a `skip: -5`, which is the HTTP 500 «حدث خطأ داخلي»
 * that this whole family was named after.
 *
 * `?limit=0` had its own fault: `|| 20` and `|| 50` are falsy guards, so the
 * one request that asks for nothing was answered with the default.
 */

/* ── the doors' dependencies ───────────────────────────────────────────── */

const { db, requireContext, requireCompanyTenant, requirePermission, getCompanyAnalytics } = vi.hoisted(() => ({
  db: {
    appDelivery: { findMany: vi.fn(), count: vi.fn() },
    // `groupBy` counts the tabs under the list's own scope; the list's size is still `findMany`'s `take`.
    telegramMessage: { findMany: vi.fn(), groupBy: vi.fn() },
    landingPage: { findMany: vi.fn(), count: vi.fn() },
    order: { findMany: vi.fn() },
  },
  requireContext: vi.fn(),
  requireCompanyTenant: vi.fn(),
  requirePermission: vi.fn(),
  getCompanyAnalytics: vi.fn(),
}));

vi.mock('@/lib/db', () => ({ db, default: db }));
vi.mock('@/lib/geo-context', () => ({ requireContext: (...a: unknown[]) => requireContext(...a) }));
vi.mock('@/lib/auth', () => ({
  requireCompanyTenant: (...a: unknown[]) => requireCompanyTenant(...a),
  requirePermission: (...a: unknown[]) => requirePermission(...a),
}));
// `can` for the telegram door's store scoping, which this file does not test.
vi.mock('@/lib/authorization', () => ({ requirePermission: (...a: unknown[]) => requirePermission(...a), can: () => true }));
vi.mock('@/lib/analytics', () => ({ getCompanyAnalytics: (...a: unknown[]) => getCompanyAnalytics(...a) }));

import { GET as PROFITABILITY } from './finance/profitability/route';
import { GET as DELIVERIES } from './apps/deliveries/route';
import { GET as TELEGRAM } from './telegram/messages/route';
import { GET as LANDING } from './landing-pages/route';
import { GET as DISCOUNTS } from './control/discount-alerts/route';

/** Twenty-five products, each with its own profit, so order is checkable. */
const PRODUCTS = Array.from({ length: 25 }, (_, i) => ({
  id: `p${i + 1}`,
  name: `منتج ${i + 1}`,
  sku: `SKU-${i + 1}`,
  totalOrders: 10,
  deliveredOrders: 5,
  revenue: 100,
  cogs: 40,
  shippingCost: 5,
  // Descending profit, so the report's own sort leaves them in this order.
  netProfit: 1000 - i,
  profitMargin: 10,
}));

beforeEach(() => {
  vi.clearAllMocks();
  requireContext.mockResolvedValue({ user: { id: 'u1' }, companyId: 'c1', storeId: 's1', country: { minorUnit: 2 } });
  requireCompanyTenant.mockResolvedValue({ user: { id: 'u1' }, companyId: 'c1' });
  requirePermission.mockResolvedValue(undefined);
  getCompanyAnalytics.mockResolvedValue({ productStats: PRODUCTS });
  db.appDelivery.findMany.mockResolvedValue([]);
  db.appDelivery.count.mockResolvedValue(0);
  db.telegramMessage.findMany.mockResolvedValue([]);
  db.telegramMessage.groupBy.mockResolvedValue([]);
  db.landingPage.findMany.mockResolvedValue([]);
  db.landingPage.count.mockResolvedValue(44);
  db.order.findMany.mockResolvedValue([]);
});

const get = (handler: (r: Request) => Promise<Response>, url: string) =>
  handler(new Request(`http://localhost${url}`));

/* ════════════════════════════════════════════════════════════════════════
   finance/profitability — a profit report that quietly dropped products.
   ════════════════════════════════════════════════════════════════════════ */

describe('a profit report answers with the products it was asked for', () => {
  const names = async (qs: string) => {
    const res = await get(PROFITABILITY, `/api/finance/profitability${qs}`);
    expect(res.status).toBe(200);
    return (await res.json()).products.map((p: { name: string }) => p.name);
  };

  it('`?limit=-5` used to drop the last five products — now it is one product, not twenty', async () => {
    // What `.slice(0, -5)` did with the clamp missing, stated as rows.
    expect(PRODUCTS.slice(0, -5)).toHaveLength(20);
    const rows = await names('?limit=-5');
    expect(rows).toEqual(['منتج 1']);
  });

  it('`?limit=0` used to be answered with twenty — the falsy guard', async () => {
    // The guard that did it, and the number it produced.
    expect(parseInt('0', 10) || 20).toBe(20);
    const rows = await names('?limit=0');
    expect(rows).toHaveLength(1);
  });

  it('a limit that was asked for is the limit that is answered', async () => {
    expect(await names('?limit=3')).toEqual(['منتج 1', 'منتج 2', 'منتج 3']);
  });

  it('and the default is twenty, with the ceiling still a hundred', async () => {
    expect(await names('')).toHaveLength(20);
    expect(await names('?limit=1000')).toHaveLength(25); // 25 exist; 100 is the cap
  });

  it('and `?limit=abc` falls to the default rather than becoming NaN', async () => {
    expect(parseInt('abc', 10)).toBeNaN();
    expect(await names('?limit=abc')).toHaveLength(20);
  });
});

/* ════════════════════════════════════════════════════════════════════════
   apps/deliveries and telegram/messages — `take` as Prisma received it.
   ════════════════════════════════════════════════════════════════════════ */

describe('a negative limit never reaches Prisma as a negative `take`', () => {
  const takeFor = async (
    handler: (r: Request) => Promise<Response>,
    url: string,
    spy: { mock: { calls: any[][] } }
  ) => {
    const res = await handler(new Request(`http://localhost${url}`));
    expect(res.status).toBe(200);
    return spy.mock.calls[0][0].take;
  };

  it('apps/deliveries: `?limit=-5` asked for the five OLDEST deliveries, reversed', async () => {
    expect(await takeFor(DELIVERIES, '/api/apps/deliveries?limit=-5', db.appDelivery.findMany)).toBe(1);
  });

  it('apps/deliveries: `?limit=0` was silently fifty', async () => {
    expect(await takeFor(DELIVERIES, '/api/apps/deliveries?limit=0', db.appDelivery.findMany)).toBe(1);
  });

  it('apps/deliveries: the asked-for size, the default, and the ceiling', async () => {
    expect(await takeFor(DELIVERIES, '/api/apps/deliveries?limit=25', db.appDelivery.findMany)).toBe(25);
    db.appDelivery.findMany.mockClear();
    expect(await takeFor(DELIVERIES, '/api/apps/deliveries', db.appDelivery.findMany)).toBe(50);
    db.appDelivery.findMany.mockClear();
    expect(await takeFor(DELIVERIES, '/api/apps/deliveries?limit=99999', db.appDelivery.findMany)).toBe(200);
  });

  it('telegram/messages: `?limit=0` was an empty inbox for a door that had messages', async () => {
    expect(await takeFor(TELEGRAM, '/api/telegram/messages?limit=0', db.telegramMessage.findMany)).toBe(1);
  });

  it('telegram/messages: `?limit=-5` asked for the five oldest, reversed', async () => {
    expect(await takeFor(TELEGRAM, '/api/telegram/messages?limit=-5', db.telegramMessage.findMany)).toBe(1);
  });

  it('telegram/messages: the asked-for size, the default, and the ceiling', async () => {
    expect(await takeFor(TELEGRAM, '/api/telegram/messages?limit=10', db.telegramMessage.findMany)).toBe(10);
    db.telegramMessage.findMany.mockClear();
    expect(await takeFor(TELEGRAM, '/api/telegram/messages', db.telegramMessage.findMany)).toBe(50);
    db.telegramMessage.findMany.mockClear();
    expect(await takeFor(TELEGRAM, '/api/telegram/messages?limit=5000', db.telegramMessage.findMany)).toBe(100);
  });
});

/* ════════════════════════════════════════════════════════════════════════
   landing-pages — the door the guard itself called «already right».
   ════════════════════════════════════════════════════════════════════════ */

describe('the landing-pages door clamps the page SIZE too, not only the page number', () => {
  const callAndBody = async (qs: string) => {
    const res = await get(LANDING, `/api/landing-pages${qs}`);
    expect(res.status).toBe(200);
    return { args: db.landingPage.findMany.mock.calls[0][0], body: await res.json() };
  };

  it('`?limit=0` published `totalPages: Infinity` beside an empty list of 44 pages', async () => {
    // The figure it printed, and the figure it asked Prisma for.
    expect(Math.ceil(44 / 0)).toBe(Infinity);
    const { args, body } = await callAndBody('?limit=0');
    expect(args.take).toBe(1);
    expect(body.pagination.totalPages).toBe(44);
    expect(Number.isFinite(body.pagination.totalPages)).toBe(true);
    // The clamped value is REPORTED back, which is why clamping is allowed.
    expect(body.pagination.limit).toBe(1);
  });

  it('`?limit=-5` asked Prisma for the last five landing pages', async () => {
    const { args, body } = await callAndBody('?limit=-5');
    expect(args.take).toBe(1);
    expect(args.take).toBeGreaterThan(0);
    expect(body.pagination.totalPages).toBe(44);
  });

  it('`?page=2&limit=-5` was `skip: -5`, which Prisma refuses — the 500 by the other road', async () => {
    const { args } = await callAndBody('?page=2&limit=-5');
    expect((2 - 1) * -5).toBe(-5); // what used to be sent
    expect(args.skip).toBeGreaterThanOrEqual(0);
    expect(args.skip).toBe(1);
  });

  it('and `?page=abc` is page one rather than `skip: NaN`', async () => {
    const { args, body } = await callAndBody('?page=abc');
    expect(args.skip).toBe(0);
    expect(Number.isNaN(args.skip)).toBe(false);
    expect(body.pagination.page).toBe(1);
  });

  it('and a page and a size that were asked for are the ones used', async () => {
    const { args, body } = await callAndBody('?page=3&limit=20');
    expect(args.skip).toBe(40);
    expect(args.take).toBe(20);
    expect(body.pagination).toMatchObject({ page: 3, limit: 20, total: 44, totalPages: 3 });
  });
});

/* ════════════════════════════════════════════════════════════════════════
   control/discount-alerts — `Math.max(NaN, 1)` is `NaN`.
   ════════════════════════════════════════════════════════════════════════ */

describe('a look-back window of «abc» is thirty days, not an Invalid Date', () => {
  const sinceFor = async (qs: string) => {
    const res = await get(DISCOUNTS, `/api/control/discount-alerts${qs}`);
    expect(res.status).toBe(200);
    return db.order.findMany.mock.calls[0][0].where.createdAt.gte as Date;
  };

  /** Whole days between `since` and now, as the window the door used. */
  const windowDays = (since: Date) => Math.round((Date.now() - since.getTime()) / 86_400_000);

  it('`?days=abc` built an Invalid Date and Prisma answered 500', async () => {
    // The two clamps that let it through, stated as values.
    expect(Math.max(Number('abc'), 1)).toBeNaN();
    expect(Math.min(NaN, 365)).toBeNaN();
    expect(new Date(Date.now() - NaN).getTime()).toBeNaN();

    const since = await sinceFor('?days=abc');
    expect(Number.isNaN(since.getTime()), 'تاريخٌ غيرُ صالحٍ وصل إلى بريزما').toBe(false);
    expect(windowDays(since)).toBe(30);
  });

  it('and `?days=0x10` was sixteen days, because `Number()` reads hex', async () => {
    expect(Number('0x10')).toBe(16);
    expect(windowDays(await sinceFor('?days=0x10'))).toBe(30);
  });

  it('and a window that was asked for is the window that is used', async () => {
    expect(windowDays(await sinceFor('?days=7'))).toBe(7);
    db.order.findMany.mockClear();
    expect(windowDays(await sinceFor(''))).toBe(30);
  });

  it('and the bounds still hold at both ends', async () => {
    expect(windowDays(await sinceFor('?days=-5'))).toBe(1);
    db.order.findMany.mockClear();
    expect(windowDays(await sinceFor('?days=100000'))).toBe(365);
  });
});
