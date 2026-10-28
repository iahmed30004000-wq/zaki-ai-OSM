import { beforeEach, describe, expect, it, vi } from 'vitest';
import React from 'react';

/**
 * A PRODUCT PAGE INSIDE THE SHOP DRAWS THE SAME FORM — WITH THE SAME «الدفع».
 *
 * `/s/<store>/p/<handle>` has two forms of its own besides the landing page it may render: the plain product page,
 * and «علامة»'s `BrandProductPage`. Both are the landing `OrderForm`, and both were handed no checkout — so a shop
 * that hid «هاتف بديل» or required a note was asking one thing on its landing pages and another on its own product
 * pages. Both now get the store's LIVE «الدفع», resolved on the server, the same answer the door behind them enforces.
 */

const { getStorefront, storefrontProduct, storeShelf, db, notFound, redirect } = vi.hoisted(() => ({
  getStorefront: vi.fn(),
  storefrontProduct: vi.fn(),
  storeShelf: vi.fn(async (..._a: unknown[]) => [] as unknown[]),
  db: {
    landingPage: { findFirst: vi.fn(async () => null) },
    country: { findUnique: vi.fn(async () => ({ minorUnit: 0, currencyCode: 'SYP' })) },
    region: { findMany: vi.fn(async () => [{ name: 'دمشق' }]) },
  },
  notFound: vi.fn(() => { throw new Error('NOT_FOUND'); }),
  redirect: vi.fn((url: string) => { throw Object.assign(new Error('REDIRECT'), { url }); }),
}));

vi.mock('next/navigation', () => ({ notFound: () => notFound(), redirect: (u: string) => redirect(u) }));
vi.mock('@/lib/db', () => ({ db }));
vi.mock('@/lib/storefront', () => ({
  getStorefront: (...a: unknown[]) => getStorefront(...a),
  storefrontProduct: (...a: unknown[]) => storefrontProduct(...a),
  storeShelf: (...a: unknown[]) => storeShelf(...a),
}));
vi.mock('@/lib/offers', () => ({ activeOffersFor: async () => [] }));
vi.mock('@/lib/store-facts', () => ({ boughtTogether: async () => [], bestSellers: async () => new Map() }));
vi.mock('@/lib/delivery-time', () => ({ deliveryWindows: async () => [], windowFor: () => null }));
vi.mock('@/lib/tracking/tracking-config', () => ({ getTrackingPixelsForPage: async () => [] }));
vi.mock('@/components/tracking/LandingTrackingPixels', () => ({ LandingTrackingPixels: () => null }));
vi.mock('@/components/storefront/StorefrontShell', () => ({
  StorefrontShell: ({ children }: { children?: React.ReactNode }) => children ?? null,
}));

import ProductPage from './[store]/p/[sku]/page';
import OrderForm from '@/components/landing/OrderForm';
import { BrandProductPage } from '@/components/storefront/BrandProductPage';
import { DEFAULT_STORE_THEME, type PageCheckout, type StoreTheme } from '@/lib/store-theme';

const themeWith = (checkout: Partial<NonNullable<StoreTheme['checkout']>>, family?: StoreTheme['family']) => ({
  ...DEFAULT_STORE_THEME,
  ...(family ? { family } : {}),
  checkout: { ...DEFAULT_STORE_THEME.checkout!, ...checkout },
});
const store = (theme: StoreTheme) => ({
  id: 's1', slug: 'sehha', companyId: 'c1', countryId: 'k1', type: 'MULTI_PRODUCT', landingPageId: null,
  currencyCode: 'SYP', countryCode: 'SY', name: 'صحة', supportPhone: null, dir: 'rtl', menus: {}, theme,
});

/** The first element of this type anywhere in a tree, rendering function components that are not it on the way. */
function find(node: unknown, type: unknown): { props: Record<string, unknown> } | null {
  if (!node || typeof node !== 'object') return null;
  if (Array.isArray(node)) {
    for (const n of node) {
      const hit = find(n, type);
      if (hit) return hit;
    }
    return null;
  }
  const el = node as { type?: unknown; props?: Record<string, unknown> };
  if (el.type === type) return el as { props: Record<string, unknown> };
  // A server component of the page's own (the brand page): drawn, so what it hands the form is read too.
  if (el.type === BrandProductPage && type === OrderForm) return find(BrandProductPage(el.props as never), type);
  return el.props ? find(el.props.children, type) : null;
}

const open = async () =>
  ProductPage({ params: Promise.resolve({ store: 'sehha', sku: 'SKU1' }), searchParams: Promise.resolve({}) });

beforeEach(() => {
  vi.clearAllMocks();
  storefrontProduct.mockResolvedValue({
    id: 'p1', sku: 'SKU1', handle: 'SKU1', name: 'كريم', nameEn: null, description: null,
    image: null, basePrice: 1000, fromPrice: 1000, gallery: [], category: null, attributes: {},
  });
});

describe.each([
  ['the plain product page', undefined],
  ['«علامة»’s product page', 'brand' as const],
])('%s', (_name, family) => {
  it('hands its order form the store’s «الدفع» — the hidden field gone, the ticks and the words kept', async () => {
    getStorefront.mockResolvedValue(
      store(themeWith({ hidden: ['note'], required: ['altPhone', 'note'], submitText: 'احجز الآن' }, family))
    );
    const form = find(await open(), OrderForm);
    expect(form, 'ما في نموذج طلب').not.toBeNull();
    const checkout = form!.props.checkout as PageCheckout;
    expect(checkout.fields).toEqual(['name', 'phone', 'altPhone', 'region', 'address']);
    expect(checkout.required).toEqual(['name', 'phone', 'altPhone', 'region', 'address']);
    expect(checkout.submitText).toBe('احجز الآن');
    // And the door behind it is still the product's own.
    expect(form!.props.endpoint).toBe('/api/public/stores/sehha/products/SKU1/orders');
  });

  it('NEGATIVE: a store that never opened «الدفع» — every field, the four marked, nothing of its own', async () => {
    getStorefront.mockResolvedValue(store(themeWith({}, family)));
    const checkout = find(await open(), OrderForm)!.props.checkout as PageCheckout;
    expect(checkout.fields).toEqual(['name', 'phone', 'altPhone', 'region', 'address', 'note']);
    expect(checkout.required).toEqual(['name', 'phone', 'region', 'address']);
    expect(checkout.submitText).toBe('');
    expect(checkout.buttonVars).toBeNull();
  });
});
