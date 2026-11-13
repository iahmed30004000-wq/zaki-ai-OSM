import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * ═══════════════════════════════════════════════════════════════════════
 * THE STRIP ABOVE THE CUSTOMER LIST IS COUNTED ONCE A MINUTE PER BOOK, NOT ONCE PER REQUEST.
 *
 * `GET /api/customers` read EVERY customer of the book (no `take`) and scored each, for the figures above the list, on every
 * mount, every page turn and every pause in typing. The figures are kept for a minute under the book's own `where`
 * (`short-memo.ts`); the page of rows is read afresh each time. The window is the reports' (`REPORT_TTL_MS`: zero under test,
 * so no other test inherits an answer) — here it is stood at a minute, so that keeping can be held at all.
 *
 *   1. kept: two requests inside the minute read the book once; the figures are the fresh figures; after the minute, again;
 *   2. the page is NOT kept: a customer added in between is on the next page at once;
 *   3. never shared across scopes — simultaneously, which is the only way a shared answer shows itself under a zero window:
 *      two companies, two stores, two people who see only their own customers;
 *   4. a read that fails is not remembered; the limited view reads no figures at all.
 * ═══════════════════════════════════════════════════════════════════════
 */

const { db, requireContext, can, getPermissionScope } = vi.hoisted(() => ({
  db: { customer: { findMany: vi.fn(), count: vi.fn() } },
  requireContext: vi.fn(),
  can: vi.fn(),
  getPermissionScope: vi.fn(),
}));

vi.mock('@/lib/db', () => ({ db }));
vi.mock('@/lib/auth', () => ({ requireCompanyTenant: vi.fn() }));
vi.mock('@/lib/geo-context', () => ({ requireContext: (...a: unknown[]) => requireContext(...a) }));
vi.mock('@/lib/authorization', () => ({
  can: (...a: unknown[]) => can(...a),
  getPermissionScope: (...a: unknown[]) => getPermissionScope(...a),
  requirePermission: vi.fn(),
}));
vi.mock('@/lib/audit', () => ({ logAudit: vi.fn(), redactCustomerForAudit: (c: unknown) => c }));
vi.mock('@/lib/pii-alert', () => ({ noteCustomersHandedOut: vi.fn() }));
vi.mock('@/lib/heavy-lane', async (orig) => ({ ...(await orig<typeof import('@/lib/heavy-lane')>()), REPORT_TTL_MS: 60_000 }));

import { customerFacts } from '@/lib/customer-insights';

// The memo lives in the route's module, so each test takes a fresh module: no test inherits an answer another one kept.
let GET: (req: Request) => Promise<Response>;

const NOW = new Date('2026-11-13T12:00:00.000Z');

const row = (over: Record<string, unknown> = {}) => ({
  city: 'دمشق', totalOrders: 2, deliveredOrders: 1, cancelledOrders: 0, totalPurchaseValue: 100, lastOrderDate: new Date('2026-11-01'), ...over,
});

/** The book read (the strip's counters) has no `orders` and no `id` in its select; the page's select has both. */
const isBookRead = (args: { select?: Record<string, unknown> }) => !!args.select && !('orders' in args.select) && !('id' in args.select);
const bookReads = () => db.customer.findMany.mock.calls.filter(([args]) => isBookRead(args)).length;
const pageReads = () => db.customer.findMany.mock.calls.filter(([args]) => !isBookRead(args)).length;

/** What the book holds, by company — so two scopes asking together get different figures, and a shared answer shows. */
let books: Record<string, ReturnType<typeof row>[]>;

const asks = (over: Record<string, unknown> = {}) =>
  requireContext.mockResolvedValue({
    user: { id: 'u1', role: 'MANAGER', status: 'ACTIVE', permissions: [] },
    companyId: 'c1', storeId: 's1', country: { code: 'SY' }, ...over,
  });
const get = () => GET(new Request('http://localhost/api/customers'));
const factsOf = async (res: Response) => ((await res.json()) as { facts: unknown }).facts;
const fresh = (rows: ReturnType<typeof row>[]) => JSON.parse(JSON.stringify(customerFacts(rows, NOW)));

beforeEach(async () => {
  vi.clearAllMocks();
  vi.resetModules();
  ({ GET } = await import('./route'));
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  books = { c1: [row(), row({ city: 'حلب', cancelledOrders: 2 }), row({ totalOrders: 0, deliveredOrders: 0 })], c2: [row({ city: 'عمّان', totalOrders: 9, deliveredOrders: 9 })] };
  asks();
  can.mockReturnValue(true);
  getPermissionScope.mockReturnValue({ scope: 'ALL_COMPANY' });
  db.customer.count.mockResolvedValue(0);
  db.customer.findMany.mockImplementation(async (args: { where: { companyId: string }; select?: Record<string, unknown> }) =>
    isBookRead(args) ? books[args.where.companyId] ?? [] : []
  );
});
afterEach(() => vi.useRealTimers());

describe('the figures are kept a minute, and are the fresh figures', () => {
  it('two requests inside the minute read the book once, and both carry exactly what a fresh count says', async () => {
    const first = await factsOf(await get());
    vi.setSystemTime(new Date(NOW.getTime() + 59_000));
    const second = await factsOf(await get());
    expect(bookReads()).toBe(1);
    expect(second).toEqual(first);
    expect(first).toEqual(fresh(books.c1));
  });

  it('after the minute the book is read again, and the new figures are the new book’s', async () => {
    await get();
    books.c1 = [...books.c1, row({ city: 'اللاذقية', totalOrders: 5, deliveredOrders: 5 })];
    vi.setSystemTime(new Date(NOW.getTime() + 60_001));
    const again = await factsOf(await get());
    expect(bookReads()).toBe(2);
    expect(again).toEqual(JSON.parse(JSON.stringify(customerFacts(books.c1, new Date(NOW.getTime() + 60_001)))));
  });

  it('the page of rows is NOT kept: it is read afresh by every request', async () => {
    await get();
    await get();
    await get();
    expect(pageReads()).toBe(3);
    expect(bookReads()).toBe(1);
  });
});

describe('one scope is never handed another’s figures — asked at the same moment', () => {
  it('two companies at once each get their own book’s figures', async () => {
    const run = async (companyId: string) => {
      requireContext.mockResolvedValueOnce({
        user: { id: 'u1', role: 'MANAGER', status: 'ACTIVE', permissions: [] }, companyId, storeId: 's1', country: { code: 'SY' },
      });
      return factsOf(await get());
    };
    const [a, b] = await Promise.all([run('c1'), run('c2')]);
    expect(bookReads()).toBe(2);
    expect(a).toEqual(fresh(books.c1));
    expect(b).toEqual(fresh(books.c2));
    expect(a).not.toEqual(b);
  });

  it('two stores of one company at once read their own books', async () => {
    const run = async (storeId: string) => {
      requireContext.mockResolvedValueOnce({
        user: { id: 'u1', role: 'MANAGER', status: 'ACTIVE', permissions: [] }, companyId: 'c1', storeId, country: { code: 'SY' },
      });
      return get();
    };
    await Promise.all([run('s1'), run('s2')]);
    expect(bookReads()).toBe(2);
    const wheres = db.customer.findMany.mock.calls.filter(([args]) => isBookRead(args)).map(([args]) => args.where.storeId).sort();
    expect(wheres).toEqual(['s1', 's2']);
  });

  it('two people who see only their own customers, at once, read their own books', async () => {
    getPermissionScope.mockReturnValue({ scope: 'OWN' });
    const run = async (id: string) => {
      requireContext.mockResolvedValueOnce({
        user: { id, role: 'MODERATOR', status: 'ACTIVE', permissions: [] }, companyId: 'c1', storeId: 's1', country: { code: 'SY' },
      });
      return get();
    };
    await Promise.all([run('u1'), run('u2')]);
    expect(bookReads()).toBe(2);
    const moderators = db.customer.findMany.mock.calls
      .filter(([args]) => isBookRead(args))
      .map(([args]) => args.where.orders.some.moderatorId)
      .sort();
    expect(moderators).toEqual(['u1', 'u2']);
  });

  it('and the same person, asking again, shares their own', async () => {
    getPermissionScope.mockReturnValue({ scope: 'OWN' });
    await get();
    await get();
    expect(bookReads()).toBe(1);
  });
});

describe('a failure is not kept, and the limited view reads no figures', () => {
  it('a book read that fails is read again by the next request', async () => {
    let calls = 0;
    db.customer.findMany.mockImplementation(async (args: { where: { companyId: string }; select?: Record<string, unknown> }) => {
      if (!isBookRead(args)) return [];
      calls++;
      if (calls === 1) throw new Error('timeout');
      return books.c1;
    });
    const failed = await get();
    expect(failed.status).toBeGreaterThanOrEqual(500);
    const ok = await get();
    expect(ok.status).toBe(200);
    expect(calls).toBe(2);
    expect(await factsOf(ok)).toEqual(fresh(books.c1));
  });

  it('a person with the limited view gets no figures and the book is not read', async () => {
    can.mockImplementation((_user: unknown, key: string) => key === 'customers.view_basic');
    const body = (await (await get()).json()) as { facts: unknown; limited: boolean };
    expect(body.facts).toBeNull();
    expect(body.limited).toBe(true);
    expect(bookReads()).toBe(0);
  });
});
