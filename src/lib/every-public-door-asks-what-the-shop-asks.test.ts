import { beforeEach, describe, expect, it, vi } from 'vitest';
import { readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

/**
 * THE THREE PUBLIC DOORS, AND THE SHOP'S «الدفع».
 *
 * `createPublicOrder` refuses a blank field the shop requires — but only for the rules a door hands it, so a door that
 * forgot to hand them over would take every order «إلزامي» was meant to stop, and nothing would look wrong. This file
 * stands at each of the three doors — a landing page, the store's basket, a product page inside the store — and
 * holds that each hands over what the store's LIVE theme requires, and never what its draft says.
 *
 * The engine itself is a spy here; what it does with the rules is `public-order-asks-what-the-shop-asks.test.ts`.
 */

const { db, getStorefront, createPublicOrder } = vi.hoisted(() => ({
  db: {
    landingPage: { findFirst: vi.fn() },
    product: { findFirst: vi.fn(), findMany: vi.fn() },
    country: { findUnique: vi.fn() },
  },
  getStorefront: vi.fn(),
  createPublicOrder: vi.fn(),
}));

vi.mock('@/lib/db', () => ({ db }));
vi.mock('@/lib/storefront', () => ({ getStorefront: (...a: unknown[]) => getStorefront(...a) }));
vi.mock('@/lib/public-order', () => ({ createPublicOrder: (...a: unknown[]) => createPublicOrder(...a) }));
vi.mock('@/lib/campaigns-server', () => ({ resolveCampaign: async () => null }));
vi.mock('@/lib/rate-limit', () => ({ rateLimit: () => ({ allowed: true }), getClientIp: () => '1.1.1.1' }));

import { POST as landingDoor } from '@/app/api/public/landing-pages/[slug]/orders/route';
import { POST as basketDoor } from '@/app/api/public/stores/[store]/orders/route';
import { POST as productDoor } from '@/app/api/public/stores/[store]/products/[sku]/orders/route';
import { DEFAULT_STORE_THEME, parseStoreTheme, type StoreTheme } from './store-theme';
import { repoFile, stripComments } from './guard-source';

const COUNTRY = { code: 'JO', currencyCode: 'JOD', orderPrefix: 'ORD', minorUnit: 3 };
const FOUR = ['name', 'phone', 'region', 'address'];

/** A stored theme whose «الدفع» says this. */
const stored = (over: Partial<NonNullable<StoreTheme['checkout']>>) =>
  JSON.stringify({ ...DEFAULT_STORE_THEME, checkout: { ...DEFAULT_STORE_THEME.checkout!, ...over } });

const post = (body: unknown) =>
  new Request('http://localhost/x', { method: 'POST', body: JSON.stringify(body) });
const ORDER = { full_name: 'زبون', phone: '0790000000', address: 'شارع الاختبار', city: 'عمّان' };

/** What each door handed the engine. */
const handed = () => createPublicOrder.mock.calls.at(-1)![0] as { checkout?: { required: string[] } | null };

/**
 * Each door, standing in front of a store whose LIVE theme is `live` and whose unpublished draft is `draft`.
 * The draft is put where a careless read would find it — on the row the door loads — so a door that read it would
 * be caught.
 */
const DOORS: Record<string, (live: string | null, draft: string | null) => Promise<Response>> = {
  'the landing page’s door': async (live, draft) => {
    db.landingPage.findFirst.mockResolvedValue({
      id: 'lp1', name: 'العرض', slug: 'offer', productId: 'p1',
      company: { id: 'c1' },
      product: { id: 'p1', basePrice: 10, name: 'كريم', image: null },
      store: { id: 's1', countryId: 'jo', country: COUNTRY, theme: live, themeDraft: draft },
    });
    return landingDoor(post(ORDER), { params: Promise.resolve({ slug: 'offer' }) });
  },
  'the basket’s door': async (live, draft) => {
    getStorefront.mockResolvedValue({
      id: 's1', slug: 'sehha', name: 'صحة', companyId: 'c1', countryId: 'jo', type: 'MULTI_PRODUCT',
      landingPageId: null, theme: parseStoreTheme(live), themeDraft: draft,
    });
    db.product.findMany.mockResolvedValue([{ id: 'p1', name: 'كريم', image: null, basePrice: 10 }]);
    return basketDoor(post({ ...ORDER, items: [{ productId: 'p1', quantity: 1 }] }), {
      params: Promise.resolve({ store: 'sehha' }),
    });
  },
  'the product page’s door': async (live, draft) => {
    getStorefront.mockResolvedValue({
      id: 's1', slug: 'sehha', name: 'صحة', companyId: 'c1', countryId: 'jo', type: 'MULTI_PRODUCT',
      landingPageId: null, theme: parseStoreTheme(live), themeDraft: draft,
    });
    db.product.findFirst.mockResolvedValue({ id: 'p1', name: 'كريم', image: null, basePrice: 10 });
    return productDoor(post(ORDER), { params: Promise.resolve({ store: 'sehha', sku: 'SKU1' }) });
  },
};

beforeEach(() => {
  vi.clearAllMocks();
  db.country.findUnique.mockResolvedValue(COUNTRY);
  createPublicOrder.mockResolvedValue({ ok: true, body: { success: true } });
});

describe.each(Object.entries(DOORS))('%s', (_name, door) => {
  it('hands the engine what the store’s LIVE «الدفع» requires', async () => {
    const res = await door(stored({ required: ['altPhone', 'note'] }), null);
    expect(res.status).toBe(200);
    expect(createPublicOrder).toHaveBeenCalledTimes(1);
    expect(handed().checkout?.required).toEqual(['name', 'phone', 'altPhone', 'region', 'address', 'note']);
  });

  it('NEGATIVE: a store that ticked nothing hands over only the four a parcel needs', async () => {
    await door(stored({}), null);
    expect(handed().checkout?.required).toEqual(FOUR);
    // And a store with no theme at all reads as the house theme — the same four.
    await door(null, null);
    expect(handed().checkout?.required).toEqual(FOUR);
  });

  it('NEGATIVE: the DRAFT never answers — unpublished ticks ask the visitor nothing', async () => {
    await door(stored({}), stored({ required: ['altPhone', 'note'] }));
    expect(handed().checkout?.required).toEqual(FOUR);
  });

  it('and a field the store hid is never handed over as required, whatever its tick', async () => {
    await door(stored({ required: ['altPhone', 'note'], hidden: ['altPhone'] }), null);
    expect(handed().checkout?.required).toEqual(['name', 'phone', 'region', 'address', 'note']);
  });
});

describe('the doors read the LIVE theme where they read the store', () => {
  it('the landing door asks for the store’s `theme`, and not its draft', () => {
    const src = stripComments(repoFile('src/app/api/public/landing-pages/[slug]/orders/route.ts'));
    const store = src.slice(src.indexOf('store: {'), src.indexOf('store: {') + 400);
    expect(store).toMatch(/theme: true/);
    expect(src, 'باب صفحة الهبوط بيقرا المسوّدة').not.toMatch(/themeDraft/);
    expect(src).toMatch(/checkout: checkoutRules\(parseStoreTheme\(lp\.store\.theme\)\)/);
  });

  it('the two store doors take the theme `getStorefront` read — which is the live column, never the draft', () => {
    for (const rel of [
      'src/app/api/public/stores/[store]/orders/route.ts',
      'src/app/api/public/stores/[store]/products/[sku]/orders/route.ts',
    ]) {
      const src = stripComments(repoFile(rel));
      expect(src, rel).toMatch(/checkout: checkoutRules\(store\.theme\)/);
      expect(src, rel).not.toMatch(/themeDraft/);
    }
    const storefront = stripComments(repoFile('src/lib/storefront.ts'));
    const fn = storefront.slice(storefront.indexOf('export const getStorefront'));
    expect(fn.slice(0, fn.indexOf('});'))).toMatch(/theme: true/);
    expect(fn).toMatch(/theme: storeTheme\(store\.theme\)/);
    expect(storefront, 'getStorefront بيقرا المسوّدة').not.toMatch(/themeDraft/);
  });

  it('and every route that calls the engine is one of these three — a fourth must be added here on purpose', () => {
    const THREE = [
      'src/app/api/public/landing-pages/[slug]/orders/route.ts',
      'src/app/api/public/stores/[store]/orders/route.ts',
      'src/app/api/public/stores/[store]/products/[sku]/orders/route.ts',
    ];
    const callers: string[] = [];
    const walk = (dir: string) => {
      for (const name of readdirSync(join(process.cwd(), dir))) {
        const rel = `${dir}/${name}`;
        if (statSync(join(process.cwd(), rel)).isDirectory()) walk(rel);
        else if (/\.tsx?$/.test(name) && !name.includes('.test.')) {
          if (/createPublicOrder\(/.test(stripComments(repoFile(rel)))) callers.push(rel);
        }
      }
    };
    walk('src/app');
    expect(callers.sort()).toEqual([...THREE].sort());
    for (const rel of THREE) expect(stripComments(repoFile(rel)), rel).toMatch(/await createPublicOrder\(surface, raw\)/);
  });
});
