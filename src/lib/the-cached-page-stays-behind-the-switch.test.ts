import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * «ابني كاش الصفحة، وخلي العدّ بالطريقتين أسبوع قبل ما نبدّل».
 *
 * The cached page exists, and nobody is served from it until the owner turns the switch on (`LP_PAGE_CACHE=1`). Then
 * a visitor's `/lp/<slug>` — and a seller's own domain — are answered from `/lp-cached/<slug>`, with the selling page's
 * headers; the seller's preview never is; an order is never a page view; and the cached route cannot be reached by its
 * own name.
 */

const { hostSite, redirectFor, revalidatePath, findMany } = vi.hoisted(() => ({
  hostSite: vi.fn(),
  redirectFor: vi.fn(),
  revalidatePath: vi.fn(),
  findMany: vi.fn(),
}));
vi.mock('@/lib/store-redirects', () => ({ redirectFor, countRedirectHit: vi.fn() }));
vi.mock('@/lib/landing-domain', async (orig) => ({ ...(await orig<typeof import('@/lib/landing-domain')>()), hostSite }));
vi.mock('next/cache', () => ({ revalidatePath }));
vi.mock('@/lib/db', () => ({ db: { landingPage: { findMany } } }));

import { cachedLandingPath, isCachedLandingPath, landingCacheOn } from './landing-cache-path';
import { refreshLandingPages } from './landing-cache';
import { proxy } from '../proxy';
import { SELLING_PAGE_CSP } from './csp';

const get = (path: string, host = 'app.example.com') => proxy(new Request(`https://${host}${path}`, { headers: { host } }));
const rewroteTo = (res: Response) => {
  const to = res.headers.get('x-middleware-rewrite');
  return to ? new URL(to).pathname : null;
};

beforeEach(() => {
  vi.resetAllMocks();
  hostSite.mockResolvedValue(null);
  redirectFor.mockResolvedValue(null);
});
afterEach(() => vi.unstubAllEnvs());

describe('the switch', () => {
  it('is off unless the environment says exactly 1', () => {
    expect(landingCacheOn({})).toBe(false);
    expect(landingCacheOn({ LP_PAGE_CACHE: 'true' })).toBe(false);
    expect(landingCacheOn({ LP_PAGE_CACHE: '1' })).toBe(true);
  });

  it('on: a visit to the page goes to its cached route — with the campaign code left in the address', () => {
    expect(cachedLandingPath('/lp/kamaa-eye-water', new URLSearchParams('c=RAM'), true)).toBe('/lp-cached/kamaa-eye-water');
  });

  it('NEGATIVE: off, nothing is cached; on, a preview, the raw HTML frame and a malformed slug are not', () => {
    expect(cachedLandingPath('/lp/kamaa', new URLSearchParams(), false)).toBeNull();
    expect(cachedLandingPath('/lp/kamaa', new URLSearchParams('p=token'), true)).toBeNull();
    expect(cachedLandingPath('/lp/kamaa/raw', new URLSearchParams(), true)).toBeNull();
    expect(cachedLandingPath('/lp/Kamaa_1', new URLSearchParams(), true)).toBeNull();
    expect(isCachedLandingPath('/lp-cached/kamaa')).toBe(true);
    expect(isCachedLandingPath('/lp/kamaa')).toBe(false);
  });
});

describe('the proxy, with the switch ON', () => {
  beforeEach(() => vi.stubEnv('LP_PAGE_CACHE', '1'));

  it('answers /lp/<slug> from the cache, wearing the selling page’s headers', async () => {
    const res = await get('/lp/kamaa-eye-water?c=RAM&fbclid=x');
    expect(rewroteTo(res)).toBe('/lp-cached/kamaa-eye-water');
    expect(res.headers.get('content-security-policy')).toBe(SELLING_PAGE_CSP);
  });

  it('answers a seller’s own domain root from the cache too', async () => {
    hostSite.mockResolvedValue({ path: '/lp/kamaa-eye-water', kind: 'page' });
    expect(rewroteTo(await get('/', 'kamaa.example'))).toBe('/lp-cached/kamaa-eye-water');
  });

  it('NEGATIVE: the seller’s preview stays live', async () => {
    expect(rewroteTo(await get('/lp/kamaa-eye-water?p=tok'))).toBeNull();
  });

  it('NEGATIVE: the cached route asked for by its own name does not exist', async () => {
    expect((await get('/lp-cached/kamaa-eye-water')).status).toBe(404);
  });

  it('NEGATIVE: an order posted from the page is never sent to the cache', async () => {
    const res = await proxy(new Request('https://app.example.com/lp/kamaa-eye-water', { method: 'POST', headers: { host: 'app.example.com' } }));
    expect(rewroteTo(res)).toBeNull();
  });
});

describe('the proxy, with the switch OFF (as shipped)', () => {
  it('NEGATIVE: renders every visit per request, exactly as before', async () => {
    expect(rewroteTo(await get('/lp/kamaa-eye-water'))).toBeNull();
    hostSite.mockResolvedValue({ path: '/lp/kamaa-eye-water', kind: 'page' });
    expect(rewroteTo(await get('/', 'kamaa.example'))).toBe('/lp/kamaa-eye-water');
  });
});

describe('a change the seller makes', () => {
  it('rebuilds the cached page at once — by page, by product, or by the slugs it had', async () => {
    findMany.mockResolvedValueOnce([{ slug: 'kamaa' }]).mockResolvedValueOnce([{ slug: 'kamaa' }, { slug: 'kamaa-2' }]);
    await refreshLandingPages({ pageId: 'lp1' });
    await refreshLandingPages({ productId: 'p1', companyId: 'c1' });
    await refreshLandingPages({ slugs: ['old-name', 'new-name', 'new-name'] });
    expect(findMany.mock.calls[1][0].where).toEqual({ productId: 'p1', companyId: 'c1' });
    expect(revalidatePath.mock.calls.map((c) => c[0])).toEqual([
      '/lp-cached/kamaa', '/lp-cached/kamaa', '/lp-cached/kamaa-2', '/lp-cached/old-name', '/lp-cached/new-name',
    ]);
  });

  it('NEGATIVE: a refresh that fails never fails the seller’s save', async () => {
    findMany.mockRejectedValue(new Error('db down'));
    await expect(refreshLandingPages({ pageId: 'lp1' })).resolves.toBeUndefined();
  });

  /*
   * BY STORE — what a store publishes reaches every page it sells through: the order form asks what «الدفع» says,
   * and the page wears the store's family. Inside the company, so a store id alone can never name another tenant's
   * pages.
   */
  it('rebuilds every page of a store, read inside its company', async () => {
    findMany.mockResolvedValueOnce([{ slug: 'kamaa' }, { slug: 'sidr-honey' }]);
    await refreshLandingPages({ storeId: 's1', companyId: 'c1' });
    expect(findMany.mock.calls[0][0]).toEqual({ where: { storeId: 's1', companyId: 'c1' }, select: { slug: true } });
    expect(revalidatePath.mock.calls.map((c) => c[0])).toEqual(['/lp-cached/kamaa', '/lp-cached/sidr-honey']);
  });

  it('NEGATIVE: by store, a read that fails rebuilds nothing and never fails the publish', async () => {
    findMany.mockRejectedValue(new Error('db down'));
    await expect(refreshLandingPages({ storeId: 's1', companyId: 'c1' })).resolves.toBeUndefined();
    // It was the store's read that failed, not some other one.
    expect(findMany).toHaveBeenCalledWith({ where: { storeId: 's1', companyId: 'c1' }, select: { slug: true } });
    expect(revalidatePath).not.toHaveBeenCalled();
  });
});

describe('every save that changes what a page shows rebuilds it', () => {
  it.each([
    ['src/app/api/landing-pages/[id]/content/route.ts', 2], // publish, revert
    ['src/app/api/landing-pages/[id]/route.ts', 2], // settings (slug, published, product), delete
    ['src/app/api/offers/route.ts', 2],  // create, reorder
    ['src/app/api/offers/[id]/route.ts', 3], // edit, retire, delete
    ['src/app/api/products/[id]/route.ts', 1],
    ['src/app/api/landing-pages/[id]/recommendations/route.ts', 1],
    ['src/app/api/landing-pages/[id]/recommendations/[recId]/route.ts', 2],
    ['src/app/api/store/theme/route.ts', 2], // the store's publish and its step back — never the draft
  ])('%s refreshes the cached page (%i)', async (file, times) => {
    const { repoFile, stripComments } = await import('./guard-source');
    const calls = stripComments(repoFile(file)).match(/await refreshLandingPages\(/g) ?? [];
    expect(calls.length).toBe(times);
  });
});
