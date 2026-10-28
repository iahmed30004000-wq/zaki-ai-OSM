// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';

/**
 * THE REAL PAGE, AND THE STORE'S «الدفع» IN ITS FORM.
 *
 * The form's own suite proves what it does with a checkout it is handed; a grep proved the page hands one over. This
 * renders the page itself — `LandingPageView`, the one renderer behind `/lp/<slug>`, a store's front and a product
 * page inside the shop — from a store row whose LIVE theme orders the fields phone-first, requires the second number,
 * and words the button, and reads the form a visitor would get.
 *
 * The in-shop case is here on purpose: `/s/<store>/p/<handle>` renders this view with `inStore`, and since every
 * public form follows «الدفع», that page does too — it is not the exception an earlier note said it was.
 */

const { db, verifyPreviewToken } = vi.hoisted(() => ({
  db: {
    landingPage: { findFirst: vi.fn(), update: vi.fn(), findMany: vi.fn(async () => []) },
    offer: { findMany: vi.fn(async () => []) },
    landingPageRecommendation: { findMany: vi.fn(async () => []) },
    region: { findMany: vi.fn(async () => [{ name: 'دمشق' }]) },
    $queryRawUnsafe: vi.fn(async () => []),
  },
  verifyPreviewToken: vi.fn(),
}));

vi.mock('@/lib/db', () => ({ db }));
vi.mock('next/headers', () => ({ headers: async () => new Headers({ 'user-agent': 'Googlebot/2.1' }) }));
vi.mock('next/navigation', () => ({ notFound: () => { throw new Error('NOT_FOUND'); } }));
vi.mock('@/lib/landing-pages', () => ({
  verifyPreviewToken: (...a: unknown[]) => verifyPreviewToken(...a),
  clampStoredHtml: (h: string | null) => h ?? '',
}));
vi.mock('@/lib/selling-currency', () => ({ sellingCurrency: async () => 'SYP' }));
vi.mock('@/lib/tracking/tracking-config', () => ({ getTrackingPixelsForPage: async () => [] }));
vi.mock('@/lib/fonts/load-store-fonts', () => ({ loadStoreFonts: async () => ({ css: '' }) }));
vi.mock('@/lib/reservation', () => ({ availableStock: async () => null }));
vi.mock('@/components/tracking/GlobalTrackingProvider', () => ({
  useTracking: () => ({ trackEvent: vi.fn(), registerPixels: vi.fn(), setPageContext: vi.fn() }),
}));

import { LandingPageView } from './LandingPageView';
import { DEFAULT_STORE_THEME, type StoreTheme } from '@/lib/store-theme';

const LP = '11111111-1111-4111-8111-111111111111';
const blocks = [
  { id: 'h', type: 'hero', enabled: true, image: '', headline: 'عرض', subheadline: '', showPrice: true, ctaText: 'اطلب الآن' },
  // The form block as every page saves it: its own words left at the default.
  { id: 'f', type: 'form', enabled: true, title: 'اطلب', subtitle: '' },
];

/** The store row, with its LIVE theme saying this — and a draft that says something else, never to be read. */
const storeWith = (checkout: Partial<NonNullable<StoreTheme['checkout']>>) => ({
  countryId: 'k1', name: 'صحة', slug: 'sehha', logo: null, favicon: null, supportPhone: null, language: 'ar',
  storefrontEnabled: true, status: 'ACTIVE', type: 'MULTI_PRODUCT', landingPageId: null,
  country: { code: 'SY', currencyCode: 'SYP', minorUnit: 0 },
  theme: JSON.stringify({ ...DEFAULT_STORE_THEME, checkout: { ...DEFAULT_STORE_THEME.checkout!, ...checkout } }),
  themeDraft: JSON.stringify({ ...DEFAULT_STORE_THEME, checkout: { ...DEFAULT_STORE_THEME.checkout!, submitText: 'من المسوّدة' } }),
});

const page = (checkout: Partial<NonNullable<StoreTheme['checkout']>>) => ({
  id: LP, name: 'العرض', slug: 'offer', isPublished: true, htmlContent: '', builderMode: 'BLOCKS',
  theme: null, sections: JSON.stringify(blocks),
  product: { id: 'p1', name: 'كريم', basePrice: 1000, reviewMode: 'SELLER' }, company: { id: 'c1' }, storeId: 's1',
  store: storeWith(checkout),
});

const PHONE_FIRST = {
  fieldOrder: ['phone', 'name', 'region', 'address', 'altPhone', 'note'] as NonNullable<StoreTheme['checkout']>['fieldOrder'],
  required: ['altPhone'] as NonNullable<StoreTheme['checkout']>['required'],
  submitText: 'احجز علبتك الآن',
};

/** The page as a visitor's browser receives it, as a document to read. */
async function visit(target: Parameters<typeof LandingPageView>[0]['target']) {
  const host = document.createElement('div');
  host.innerHTML = renderToStaticMarkup(await LandingPageView({ target }));
  return host;
}
/** The form's fields, top to bottom, by the name each is sent under (the city is a button). */
const fieldsOf = (host: HTMLElement) =>
  [...host.querySelectorAll('#zaki-order-form form [name], #zaki-order-form #zf-city')]
    .map((el) => (el.id === 'zf-city' ? 'city' : el.getAttribute('name')))
    .filter((n) => n && n !== 'website' && n !== 'zf-offer-radio');
const submitOf = (host: HTMLElement) => host.querySelector('#zaki-order-form button[type="submit"]')?.textContent ?? '';

beforeEach(() => {
  vi.clearAllMocks();
  verifyPreviewToken.mockResolvedValue(null);
});

describe('/lp/<slug> — the page’s form is the store’s «الدفع»', () => {
  it('in the store’s order, with the second number, its «*», and the store’s words on the button', async () => {
    db.landingPage.findFirst.mockResolvedValue(page(PHONE_FIRST));
    const host = await visit({ slug: 'offer' });
    expect(fieldsOf(host)).toEqual(['phone', 'full_name', 'city', 'address', 'alt_phone']);
    const alt = host.querySelector('#zf-alt_phone') as HTMLInputElement;
    expect(alt.getAttribute('type')).toBe('tel');
    expect(host.querySelector('label[for="zf-alt_phone"]')!.textContent!.trim().endsWith('*')).toBe(true);
    expect(submitOf(host)).toMatch(/^احجز علبتك الآن/);
    // «اطلب الآن» lands in the phone field, the first one.
    expect(host.querySelector('[data-zf-first]')?.id).toBe('zf-phone');
  });

  it('NEGATIVE: never the store’s draft — the words on the button are the published ones', async () => {
    db.landingPage.findFirst.mockResolvedValue(page(PHONE_FIRST));
    expect(submitOf(await visit({ slug: 'offer' }))).not.toContain('من المسوّدة');
  });

  it('a field the store hid is not on the page at all', async () => {
    db.landingPage.findFirst.mockResolvedValue(page({ ...PHONE_FIRST, hidden: ['altPhone', 'note'] }));
    const host = await visit({ slug: 'offer' });
    expect(fieldsOf(host)).toEqual(['phone', 'full_name', 'city', 'address']);
    expect(host.querySelector('#zf-alt_phone')).toBeNull();
    expect(host.textContent).not.toContain('إضافة ملاحظة');
  });

  it('NEGATIVE: a store that never opened «الدفع» — the house order, the second number optional, the page’s own words', async () => {
    db.landingPage.findFirst.mockResolvedValue(page({}));
    const host = await visit({ slug: 'offer' });
    expect(fieldsOf(host)).toEqual(['full_name', 'phone', 'alt_phone', 'city', 'address']);
    expect(host.querySelector('label[for="zf-alt_phone"]')!.textContent).toContain('(اختياري)');
    expect(submitOf(host)).toMatch(/^تأكيد الطلب/);
    expect(host.querySelector('[data-zf-first]')?.id).toBe('zf-full_name');
  });
});

describe('/s/<store>/p/<handle> — the product page inside the shop follows «الدفع» too', () => {
  it('the same form, from the same store, when the view is drawn inside the shop’s shell', async () => {
    db.landingPage.findFirst.mockResolvedValue(page(PHONE_FIRST));
    const host = await visit({ frontPageId: LP, storeId: 's1', inStore: true });
    expect(fieldsOf(host)).toEqual(['phone', 'full_name', 'city', 'address', 'alt_phone']);
    expect(host.querySelector('#zf-alt_phone')).not.toBeNull();
    expect(submitOf(host)).toMatch(/^احجز علبتك الآن/);
    // And inside the shop the page draws no shell of its own — one header, as before.
    expect(host.querySelectorAll('header').length).toBeLessThanOrEqual(1);
  });
});
