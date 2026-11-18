import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * A SINGLE PRODUCT STORE IS A LINK SOMEBODY WILL PUT IN AN ADVERT.
 *
 * So every guard here is about that link: it may only open when it leads
 * to something that sells, its front page must be its own and must sell a
 * product, and a store this user may not enter must not be switchable from
 * here by id — this is the one screen that spans stores.
 */

const { db, requireContext, requirePermission, listAccessibleStores, logAudit } = vi.hoisted(() => ({
  db: {
    store: { findMany: vi.fn(), findFirst: vi.fn(), update: vi.fn() },
    product: { count: vi.fn() },
    order: { count: vi.fn(), aggregate: vi.fn() },
    landingPage: { findFirst: vi.fn() },
  },
  requireContext: vi.fn(),
  requirePermission: vi.fn(),
  listAccessibleStores: vi.fn(),
  logAudit: vi.fn(),
}));

vi.mock('@/lib/db', () => ({ db }));
vi.mock('@/lib/geo-context', () => ({
  requireContext: (...a: unknown[]) => requireContext(...a),
  listAccessibleStores: (...a: unknown[]) => listAccessibleStores(...a),
}));
vi.mock('@/lib/authorization', () => ({ requirePermission: (...a: unknown[]) => requirePermission(...a) }));
vi.mock('@/lib/audit', () => ({ logAudit: (...a: unknown[]) => logAudit(...a) }));
vi.mock('@/lib/landing-domain', () => ({ forgetHost: vi.fn() }));

import { GET, PATCH } from './route';

const MINE = '11111111-1111-4111-8111-111111111111';
const THEIRS = '22222222-2222-4222-8222-222222222222';
const PAGE = '33333333-3333-4333-8333-333333333333';

const patch = (body: unknown) =>
  PATCH(new Request('http://localhost/api/growth/storefronts', { method: 'PATCH', body: JSON.stringify(body) }));

let store: Record<string, unknown>;
let page: Record<string, unknown> | null;
/** A store of any company holding the same slug — none unless a test says so. */
let sameSlug: Record<string, unknown> | null;

beforeEach(() => {
  vi.clearAllMocks();
  requireContext.mockResolvedValue({ user: { id: 'u1' }, companyId: 'c1', countryId: 'k1', storeId: MINE });
  requirePermission.mockResolvedValue(undefined);
  listAccessibleStores.mockResolvedValue([{ id: MINE }]);
  store = {
    id: MINE, companyId: 'c1', name: 'متجري', slug: 'mine', type: 'SINGLE_PRODUCT', status: 'ACTIVE',
    storefrontEnabled: false, landingPageId: null, domain: null,
  };
  page = {
    id: PAGE, name: 'صفحة', slug: 'offer', storeId: MINE, productId: 'p1', isPublished: true, domain: null,
    frontOf: null, product: { status: 'ACTIVE', storeId: MINE },
  };
  sameSlug = null;
  db.store.findFirst.mockImplementation(async ({ where }: { where: Record<string, unknown> }) =>
    'slug' in where ? sameSlug : store
  );
  db.store.update.mockResolvedValue({});
  // The page by id (binding, and storefrontFacts); any OTHER page by slug is
  // the shared-slug check — none unless a test says so.
  db.landingPage.findFirst.mockImplementation(async ({ where }: { where: Record<string, unknown> }) =>
    'slug' in where ? null : page
  );
  db.product.count.mockResolvedValue(1);
});

describe('a bench (منصّة تجريب) is never opened here either — B1, 18/11', () => {
  it('refuses with the sentence, before the page rules and before any write', async () => {
    store.isTest = true;
    store.landingPageId = PAGE;
    const res = await patch({ storeId: MINE, live: true });
    expect(res.status).toBe(409);
    expect((await res.json()).error).toContain('منصّة تجريب');
    expect(db.store.update).not.toHaveBeenCalled();
  });

  it('closing a store is never refused, bench or not', async () => {
    store.isTest = true;
    expect((await patch({ storeId: MINE, live: false })).status).toBe(200);
  });

  it('reads the mark from the store it is about to open', async () => {
    await patch({ storeId: MINE, live: true });
    expect(db.store.findFirst.mock.calls[0][0].select.isTest).toBe(true);
  });
});

describe('opening', () => {
  it('refuses a store whose slug a store of another company also holds', async () => {
    store.landingPageId = PAGE;
    sameSlug = { id: 'legacy-main' };
    const res = await patch({ storeId: MINE, live: true });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toContain('slug');
    expect(db.store.update).not.toHaveBeenCalled();
    // Asked across every company, never this store itself.
    expect(db.store.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: { slug: 'mine', id: { not: MINE } } })
    );
  });

  it('opens a store whose front page is published and sells', async () => {
    store.landingPageId = PAGE;
    const res = await patch({ storeId: MINE, live: true });
    expect(res.status).toBe(200);
    expect(db.store.update).toHaveBeenCalledWith({ where: { id: MINE }, data: { storefrontEnabled: true } });
  });

  it('refuses when the front page is not published — the link would answer 404', async () => {
    store.landingPageId = PAGE;
    page!.isPublished = false;
    const res = await patch({ storeId: MINE, live: true });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toContain('غير منشورة');
    expect(db.store.update).not.toHaveBeenCalled();
  });

  it('opens a store with no front page yet on its own products — the page is asked for as a warning', async () => {
    db.product.count.mockResolvedValue(3);
    expect((await patch({ storeId: MINE, live: true })).status).toBe(200);
  });

  it('refuses a store with nothing to sell', async () => {
    db.product.count.mockResolvedValue(0);
    const res = await patch({ storeId: MINE, live: true });
    expect(res.status).toBe(400);
    expect(db.store.update).not.toHaveBeenCalled();
  });

  it('closes without asking anything', async () => {
    store.storefrontEnabled = true;
    db.product.count.mockResolvedValue(0);
    expect((await patch({ storeId: MINE, live: false })).status).toBe(200);
  });

  it('refuses a store this user may not enter', async () => {
    expect((await patch({ storeId: THEIRS, live: true })).status).toBe(404);
    expect(db.store.update).not.toHaveBeenCalled();
  });
});

describe('picking the front page', () => {
  it('takes one of the store\'s own pages that sells a product', async () => {
    const res = await patch({ storeId: MINE, landingPageId: PAGE });
    expect(res.status).toBe(200);
    expect(db.store.update).toHaveBeenCalledWith({ where: { id: MINE }, data: { landingPageId: PAGE } });
    expect(logAudit).toHaveBeenCalledWith(expect.objectContaining({ action: 'STOREFRONT_PAGE_SET' }));
  });

  it('refuses another store\'s page', async () => {
    page!.storeId = THEIRS;
    expect((await patch({ storeId: MINE, landingPageId: PAGE })).status).toBe(400);
    expect(db.store.update).not.toHaveBeenCalled();
  });

  it('refuses a page that sells nothing', async () => {
    page!.productId = null;
    expect((await patch({ storeId: MINE, landingPageId: PAGE })).status).toBe(400);
  });

  it('refuses a page with a domain of its own — the store\'s domain is its address', async () => {
    page!.domain = 'page.example.com';
    const res = await patch({ storeId: MINE, landingPageId: PAGE });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toContain('page.example.com');
  });

  it('refuses a page already fronting another store', async () => {
    page!.frontOf = { id: THEIRS };
    expect((await patch({ storeId: MINE, landingPageId: PAGE })).status).toBe(409);
  });

  it('refuses an unpublished page for a store that is open', async () => {
    store.storefrontEnabled = true;
    page!.isPublished = false;
    expect((await patch({ storeId: MINE, landingPageId: PAGE })).status).toBe(400);
  });

  it('refuses to un-pick the page of an open store that would then show nothing', async () => {
    store.storefrontEnabled = true;
    store.landingPageId = PAGE;
    db.product.count.mockResolvedValue(0);
    expect((await patch({ storeId: MINE, landingPageId: null })).status).toBe(400);
    expect(db.store.update).not.toHaveBeenCalled();
  });

  it('refuses a page selling another store\'s product', async () => {
    page!.product = { status: 'ACTIVE', storeId: THEIRS };
    expect((await patch({ storeId: MINE, landingPageId: PAGE })).status).toBe(400);
    expect(db.store.update).not.toHaveBeenCalled();
  });

  it('refuses a page whose slug another page also holds — its orders are taken by slug', async () => {
    db.landingPage.findFirst.mockImplementation(async ({ where }: { where: Record<string, unknown> }) =>
      'slug' in where ? { id: 'other-company-page' } : page
    );
    expect((await patch({ storeId: MINE, landingPageId: PAGE })).status).toBe(409);
    expect(db.store.update).not.toHaveBeenCalled();
  });

  it('on an open store, refuses a page whose product is switched off', async () => {
    store.storefrontEnabled = true;
    page!.product = { status: 'ARCHIVED', storeId: MINE };
    expect((await patch({ storeId: MINE, landingPageId: PAGE })).status).toBe(400);
  });

  it('refuses a front page on a store that sells many products', async () => {
    store.type = 'MULTI_PRODUCT';
    expect((await patch({ storeId: MINE, landingPageId: PAGE })).status).toBe(400);
  });
});

describe('the list', () => {
  beforeEach(() => {
    db.store.findMany.mockResolvedValue([
      { ...store, landingPageId: PAGE, logo: null, tagline: null, supportPhone: null, country: { currencyCode: 'SYP' },
        landingPages: [{ id: PAGE, name: 'صفحة', slug: 'p', isPublished: true, domain: null, productId: 'p1', product: { name: 'كريم' } }] },
    ]);
    db.order.count.mockResolvedValue(4);
    db.order.aggregate.mockResolvedValue({ _sum: { collectedAmount: 90, totalAmount: 100 } });
  });

  it('asks only for Single Product stores this user may enter', async () => {
    await GET();
    const where = db.store.findMany.mock.calls[0][0].where;
    expect(where).toMatchObject({ id: { in: [MINE] }, companyId: 'c1', type: 'SINGLE_PRODUCT' });
  });

  it('counts what the store\'s own address sold: its front page and its product page', async () => {
    const body = await (await GET()).json();
    const where = db.order.count.mock.calls[0][0].where;
    expect(where.OR).toEqual([{ source: 'Store' }, { landingPageId: PAGE }]);
    expect(body.stores[0]).toMatchObject({ orders: 4, revenue: 90, frontPage: { id: PAGE }, current: true, refusal: null });
    expect(body.stores[0].frontPage).not.toHaveProperty('productId');
    expect(body.stores[0].warnings).toContain('لا رقم دعم للزبون');
  });
});
