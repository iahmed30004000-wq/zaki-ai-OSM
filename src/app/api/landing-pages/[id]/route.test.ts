import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * THE PAGE'S OWN DOOR: what it reads, and what one press may change.
 *
 *  · the READ carries the offers the published page shows (and the store's
 *    decimals), and the fingerprint a window hands back — both optional
 *    additions;
 *  · the PATCH refuses to make a page the FIRST one of a store's shelf: that
 *    is the owner's press («اعرض كل الصفحات المنشورة»), not a toggle;
 *  · an empty body is a 400, and a changed domain loses its verification
 *    while the same domain saved again keeps it;
 *  · going live for the first time stands down a redirect that would shadow
 *    the page.
 */

const { db, requirePermission, shownPageProductIds, activeOffersFor, draftState, publishContent, standDownRedirectsTo } =
  vi.hoisted(() => ({
    db: {
      landingPage: { findFirst: vi.fn(), update: vi.fn() },
      store: { findFirst: vi.fn() },
      product: { findFirst: vi.fn() },
    },
    requirePermission: vi.fn(),
    shownPageProductIds: vi.fn(),
    activeOffersFor: vi.fn(),
    draftState: vi.fn(),
    publishContent: vi.fn(),
    standDownRedirectsTo: vi.fn(),
  }));

vi.mock('@/lib/db', () => ({ db }));
vi.mock('@/lib/audit', () => ({ logAudit: vi.fn() }));
vi.mock('@/lib/landing-cache', () => ({ refreshLandingPages: vi.fn() }));
vi.mock('@/lib/geo-context', () => ({
  requireContext: async () => ({ user: { id: 'u1' }, companyId: 'c1', storeId: 's1' }),
}));
vi.mock('@/lib/authorization', () => ({ requirePermission: (...a: unknown[]) => requirePermission(...a) }));
vi.mock('@/lib/storefront', () => ({ shownPageProductIds: (...a: unknown[]) => shownPageProductIds(...a) }));
vi.mock('@/lib/offers', () => ({ activeOffersFor: (...a: unknown[]) => activeOffersFor(...a) }));
vi.mock('@/lib/landing-draft', () => ({
  draftState: (...a: unknown[]) => draftState(...a),
  publishContent: (...a: unknown[]) => publishContent(...a),
}));
vi.mock('@/lib/store-redirects', () => ({
  standDownRedirectsTo: (...a: unknown[]) => standDownRedirectsTo(...a),
  suggestSlugRedirect: vi.fn(),
}));
vi.mock('@/lib/landing-domain', () => ({
  validateDomain: (d: string) => ({ ok: true, domain: d.toLowerCase() }),
  forgetHost: vi.fn(),
  dashboardHosts: () => [],
}));

import { GET, PATCH } from './route';

const PRODUCT = 'prod-1234567';
const ctx = { params: Promise.resolve({ id: 'lp1' }) };
const patch = (body: unknown) =>
  PATCH(new Request('http://localhost/x', { method: 'PATCH', body: body === undefined ? undefined : JSON.stringify(body) }), ctx);
const get = () => GET(new Request('http://localhost/x'), ctx);

type Page = {
  id: string; companyId: string; storeId: string; slug: string; domain: string | null;
  domainVerifiedAt: Date | null; isPublished: boolean; showInStore: boolean; productId: string | null;
};
let page: Page;

beforeEach(() => {
  vi.resetAllMocks();
  requirePermission.mockResolvedValue(undefined);
  page = {
    id: 'lp1', companyId: 'c1', storeId: 's1', slug: 'p', domain: null, domainVerifiedAt: null,
    isPublished: false, showInStore: false, productId: null,
  };
  // The page itself is looked up by id; a lookup by domain or slug (is it taken?) finds nobody.
  db.landingPage.findFirst.mockImplementation(async ({ where }: { where: { id?: unknown } }) =>
    where.id === 'lp1'
      ? { ...page, store: { name: 'م', logo: null, supportPhone: null, theme: null, country: { currencyCode: 'JOD', minorUnit: 3 } } }
      : null
  );
  db.landingPage.update.mockImplementation(async ({ data }: { data: object }) => ({ ...page, ...data }));
  db.store.findFirst.mockResolvedValue(null); // fronts no store, no store holds a domain
  db.product.findFirst.mockResolvedValue({ id: PRODUCT });
  shownPageProductIds.mockResolvedValue(new Set());
  activeOffersFor.mockResolvedValue([]);
  publishContent.mockResolvedValue(true);
  standDownRedirectsTo.mockResolvedValue(undefined);
  draftState.mockResolvedValue({
    draft: null, hasUnpublished: false, canRevert: false, publishedAt: null, base: 'a'.repeat(32),
  });
});

describe('reading the page', () => {
  it('carries the offers the page shows, priced in the store’s own decimals', async () => {
    page.productId = PRODUCT;
    activeOffersFor.mockResolvedValue([{ id: 'o1', quantity: 2 }]);
    const json = await (await get()).json();
    expect(activeOffersFor).toHaveBeenCalledWith(db, 'c1', PRODUCT, 3);
    expect(json.offers).toEqual([{ id: 'o1', quantity: 2 }]);
    expect(json.minorUnit).toBe(3);
    expect(json.base).toBe('a'.repeat(32));
  });

  it('NEGATIVE: a page that sells nothing asks for no offers at all', async () => {
    const json = await (await get()).json();
    expect(activeOffersFor).not.toHaveBeenCalled();
    expect(json.offers).toEqual([]);
  });

  it('OLD WINDOW: everything it read before is still there', async () => {
    const json = await (await get()).json();
    for (const key of ['landingPage', 'hasUnpublished', 'canRevert', 'publishedAt', 'family']) {
      expect(key in json, key).toBe(true);
    }
  });
});

describe('the first page of the shelf is the owner’s press', () => {
  beforeEach(() => {
    page.productId = PRODUCT;
  });

  it('showing a published page that sells something is refused while the store has not switched', async () => {
    page.isPublished = true;
    const res = await patch({ showInStore: true, askBeforeSwitchingStore: true });
    expect(res.status).toBe(409);
    const json = await res.json();
    expect(json.error).toContain('اعرض كل الصفحات المنشورة');
    expect(json.code).toBe('STORE_NOT_SWITCHED');
    expect(db.landingPage.update).not.toHaveBeenCalled();
    // Asked of this store, in this company.
    expect(shownPageProductIds).toHaveBeenCalledWith('c1', 's1');
  });

  it('publishing a page that was marked to be shown is refused the same way', async () => {
    page.showInStore = true;
    const res = await patch({ isPublished: true, askBeforeSwitchingStore: true });
    expect(res.status).toBe(409);
    expect(db.landingPage.update).not.toHaveBeenCalled();
  });

  it('giving a shown, published page its product is refused too', async () => {
    page.productId = null;
    page.showInStore = true;
    page.isPublished = true;
    expect((await patch({ productId: PRODUCT, askBeforeSwitchingStore: true })).status).toBe(409);
  });

  it('NEGATIVE: a store that already switched takes the same press', async () => {
    page.isPublished = true;
    shownPageProductIds.mockResolvedValue(new Set(['other']));
    expect((await patch({ showInStore: true, askBeforeSwitchingStore: true })).status).toBe(200);
    expect(db.landingPage.update).toHaveBeenCalled();
  });

  it('NEGATIVE: a campaign page (no product) is never the switch', async () => {
    page.productId = null;
    page.isPublished = true;
    expect((await patch({ showInStore: true })).status).toBe(200);
    expect(shownPageProductIds).not.toHaveBeenCalled();
  });

  it('NEGATIVE: a page that already feeds the shelf is not asked again', async () => {
    page.isPublished = true;
    page.showInStore = true;
    expect((await patch({ name: 'اسم جديد' })).status).toBe(200);
    expect((await patch({ showInStore: false })).status).toBe(200);
    expect(shownPageProductIds).not.toHaveBeenCalled();
  });

  it('NEGATIVE: publishing a hidden page does not switch anything', async () => {
    expect((await patch({ isPublished: true })).status).toBe(200);
    expect(shownPageProductIds).not.toHaveBeenCalled();
  });

  it('the permission is still asked first: no key, no answer about the store', async () => {
    page.isPublished = true;
    requirePermission.mockRejectedValue(Object.assign(new Error('forbidden'), { status: 403 }));
    const res = await patch({ showInStore: true, askBeforeSwitchingStore: true });
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(shownPageProductIds).not.toHaveBeenCalled();
    expect(db.landingPage.update).not.toHaveBeenCalled();
  });
});

describe('a window that did not say it will ask', () => {
  /*
   * THE EDITOR IN USE HAS NO QUESTION TO SHOW. Its publish of a marked page
   * with a product worked before this change and must keep working: the 409
   * is for a window that sends the flag `askBeforeSwitchingStore: true`.
   */
  beforeEach(() => {
    page.productId = PRODUCT;
  });

  it('shows a published page exactly as before: no 409, the shelf is not even asked', async () => {
    page.isPublished = true;
    const res = await patch({ showInStore: true });
    expect(res.status).toBe(200);
    expect((db.landingPage.update.mock.calls[0]![0].data as Record<string, unknown>).showInStore).toBe(true);
    expect(shownPageProductIds).not.toHaveBeenCalled();
  });

  it('publishes a marked page exactly as before', async () => {
    page.showInStore = true;
    expect((await patch({ isPublished: true })).status).toBe(200);
    expect(publishContent).toHaveBeenCalledWith('lp1');
  });

  it('NEGATIVE: saying false is the same as not saying it', async () => {
    page.isPublished = true;
    expect((await patch({ showInStore: true, askBeforeSwitchingStore: false })).status).toBe(200);
    expect(shownPageProductIds).not.toHaveBeenCalled();
  });

  it('NEGATIVE: the flag is not stored on the page', async () => {
    page.isPublished = true;
    await patch({ showInStore: true, askBeforeSwitchingStore: true });
    shownPageProductIds.mockResolvedValue(new Set(['other']));
    await patch({ showInStore: true, askBeforeSwitchingStore: true });
    for (const call of db.landingPage.update.mock.calls) {
      expect('askBeforeSwitchingStore' in (call[0].data as object)).toBe(false);
    }
  });
});

describe('a body that asks for nothing', () => {
  it.each([[{}], [undefined], [{ nothing: 1 }], [{ askBeforeSwitchingStore: true }]])('%j is a 400 and writes nothing', async (body) => {
    expect((await patch(body)).status).toBe(400);
    expect(db.landingPage.update).not.toHaveBeenCalled();
  });

  it('NEGATIVE: renaming alone is still a valid press', async () => {
    expect((await patch({ name: 'اسم جديد' })).status).toBe(200);
  });
});

describe('the domain and its verification', () => {
  beforeEach(() => {
    page.domain = 'old.example.com';
    page.domainVerifiedAt = new Date('2026-09-01');
  });

  it('a DIFFERENT domain loses the mark that the old one was proven', async () => {
    await patch({ domain: 'new.example.com' });
    const data = db.landingPage.update.mock.calls[0]![0].data as Record<string, unknown>;
    expect(data.domain).toBe('new.example.com');
    expect(data.domainVerifiedAt).toBeNull();
  });

  it('clearing it clears the mark (as before)', async () => {
    await patch({ domain: '' });
    const data = db.landingPage.update.mock.calls[0]![0].data as Record<string, unknown>;
    expect(data.domain).toBeNull();
    expect(data.domainVerifiedAt).toBeNull();
  });

  it('NEGATIVE: saving the SAME domain again keeps the mark — the screen sends the whole form', async () => {
    await patch({ domain: 'old.example.com' });
    const data = db.landingPage.update.mock.calls[0]![0].data as Record<string, unknown>;
    expect('domainVerifiedAt' in data).toBe(false);
  });

  it('NEGATIVE: a save that does not mention the domain does not touch the mark', async () => {
    await patch({ name: 'اسم جديد' });
    const data = db.landingPage.update.mock.calls[0]![0].data as Record<string, unknown>;
    expect('domainVerifiedAt' in data).toBe(false);
  });
});

describe('going live', () => {
  it('for the first time, stands down a redirect that would shadow the page — and tells the window the truth', async () => {
    draftState.mockResolvedValue({
      draft: null, hasUnpublished: false, canRevert: true, publishedAt: new Date('2026-10-30'), base: 'e'.repeat(32),
    });
    const json = await (await patch({ isPublished: true })).json();
    expect(publishContent).toHaveBeenCalledWith('lp1');
    expect(standDownRedirectsTo).toHaveBeenCalledWith('p');
    expect(json.hasUnpublished).toBe(false);
    expect(json.canRevert).toBe(true);
    expect(json.base).toBe('e'.repeat(32));
  });

  it('NEGATIVE: a page that was already live does not stand anything down', async () => {
    page.isPublished = true;
    const json = await (await patch({ isPublished: true })).json();
    expect(standDownRedirectsTo).not.toHaveBeenCalled();
    expect(publishContent).not.toHaveBeenCalled();
    expect('base' in json).toBe(false);
  });

  it('NEGATIVE: taking a page down, or renaming it, reads no draft state', async () => {
    page.isPublished = true;
    await patch({ isPublished: false });
    await patch({ name: 'اسم جديد' });
    expect(draftState).not.toHaveBeenCalled();
  });

  it('a new slug at the same moment stands down once, not twice', async () => {
    await patch({ isPublished: true, slug: 'q' });
    expect(standDownRedirectsTo).toHaveBeenCalledTimes(1);
    expect(standDownRedirectsTo).toHaveBeenCalledWith('q');
  });
});
