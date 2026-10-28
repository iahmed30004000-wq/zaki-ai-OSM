import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * THE SHELF, THE BASKET AND THE ORDER FORM.
 *
 * One rule runs through all three and is worth more than the rest put
 * together: NOT ONE FIGURE A CUSTOMER READS IS COMPUTED IN THE BROWSER,
 * and not one is computed twice on the server either. The cart's total,
 * the checkout's «المطلوب عند الاستلام» and the amount actually charged
 * are the same call to the same two functions — because the customer meets
 * any disagreement between them while handing money over at their own
 * door, and there is nobody there to explain it.
 */

const { getStorefront, storeShelf, notFound, bestSellers, db } = vi.hoisted(() => ({
  getStorefront: vi.fn(),
  bestSellers: vi.fn(async (..._a: unknown[]) => new Map<string, number>()),
  storeShelf: vi.fn(async (..._a: unknown[]) => [] as unknown[]),
  notFound: vi.fn(() => {
    throw new Error('NOT_FOUND');
  }),
  db: {
    country: { findUnique: vi.fn(async () => ({ currencyCode: 'SYP', minorUnit: 0 })) },
    region: { findMany: vi.fn(async () => [{ name: 'دمشق' }]) },
    store: { findFirst: vi.fn(async () => ({ searchSynonyms: null })) },
  } as {
    country: { findUnique: ReturnType<typeof vi.fn> };
    region: { findMany: ReturnType<typeof vi.fn> };
    store: { findFirst: ReturnType<typeof vi.fn> };
  },
}));

vi.mock('next/navigation', () => ({ notFound: () => notFound(), useRouter: () => ({ push: vi.fn() }) }));
vi.mock('@/lib/db', () => ({ db }));
vi.mock('@/lib/storefront', () => ({
  getStorefront: (...a: unknown[]) => getStorefront(...a),
  storeShelf: (...a: unknown[]) => storeShelf(...a),
}));
vi.mock('@/components/storefront/StorefrontShell', () => ({
  StorefrontShell: ({ children }: { children: React.ReactNode }) => children,
}));
vi.mock('@/components/storefront/CartView', () => ({ CartView: () => null }));
vi.mock('@/components/storefront/CheckoutForm', () => ({ CheckoutForm: () => null }));
vi.mock('@/lib/store-facts', () => ({ bestSellers: (...a: unknown[]) => bestSellers(...a) }));

import CartPage from './[store]/cart/page';
import CheckoutPage from './[store]/checkout/page';
import ShopPage from './[store]/shop/page';
import { DEFAULT_STORE_THEME } from '@/lib/store-theme';
import { repoFile, stripComments } from '@/lib/guard-source';
import { SORT_LABEL_AR } from '@/lib/catalog-query';

/** Every string anywhere in the rendered tree. */
function textOf(node: unknown, out: string[] = []): string[] {
  if (node === null || node === undefined || typeof node === 'boolean') return out;
  if (typeof node === 'string' || typeof node === 'number') { out.push(String(node)); return out; }
  if (Array.isArray(node)) { for (const n of node) textOf(n, out); return out; }
  const el = node as { props?: Record<string, unknown> };
  if (el.props) textOf(el.props.children, out);
  return out;
}

const store = (over: Record<string, unknown> = {}) => ({
  id: 's1',
  slug: 'sehha',
  companyId: 'c1',
  countryId: 'k1',
  type: 'MULTI_PRODUCT',
  landingPageId: null,
  currencyCode: 'SYP',
  countryCode: 'SY',
  name: 'صحة',
  theme: DEFAULT_STORE_THEME,
  ...over,
});

const src = (f: string) => stripComments(repoFile(f));

beforeEach(() => {
  vi.clearAllMocks();
  getStorefront.mockResolvedValue(store());
  storeShelf.mockResolvedValue([]);
  bestSellers.mockResolvedValue(new Map());
});

describe('a shop that sells one thing has no basket', () => {
  /**
   * `cartBarApplies` is the one place that is decided. The page is ABSENT
   * for a SINGLE_PRODUCT shop rather than empty — such a shop sells its one
   * product from its own page, and a cart link there is a detour.
   */
  it('has no cart page', async () => {
    getStorefront.mockResolvedValue(store({ type: 'SINGLE_PRODUCT' }));
    await expect(CartPage({ params: Promise.resolve({ store: 'sehha' }) })).rejects.toThrow('NOT_FOUND');
  });

  it('and no checkout page', async () => {
    getStorefront.mockResolvedValue(store({ type: 'SINGLE_PRODUCT' }));
    await expect(CheckoutPage({ params: Promise.resolve({ store: 'sehha' }) })).rejects.toThrow('NOT_FOUND');
  });

  /** The anchor: a shop that does sell several things has both. */
  it('a many-product shop has both', async () => {
    await expect(CartPage({ params: Promise.resolve({ store: 'sehha' }) })).resolves.toBeTruthy();
    await expect(CheckoutPage({ params: Promise.resolve({ store: 'sehha' }) })).resolves.toBeTruthy();
  });
});

describe('every figure comes from the server, once', () => {
  const QUOTE = 'src/app/api/public/stores/[store]/quote/route.ts';

  /**
   * The quote is not a second pricing path. It calls the resolver the
   * order calls and the COD function the order calls, with the same
   * inputs.
   */
  it('the quote asks the order’s own code', () => {
    const body = src(QUOTE);
    expect(body).toContain('resolvePublicLines');
    expect(body).toContain('computeCod');
  });

  it('and adds nothing up itself', () => {
    const body = src(QUOTE);
    // Every figure returned is read off `money.…` or off a resolved line.
    expect(body, 'حساب سعر في بوّابة التسعير').not.toMatch(/unitPrice\s*[*+]|[*+]\s*unitPrice/);
    expect(body).toMatch(/subtotal: money\.subtotal/);
    expect(body).toMatch(/cod: money\.cod/);
    expect(body).toMatch(/lineTotal: money\.lineTotals/);
  });

  it.each([
    'src/components/storefront/CartView.tsx',
    'src/components/storefront/CheckoutForm.tsx',
    'src/components/storefront/useCart.ts',
  ])('%s computes no money', (file) => {
    const body = src(file);
    /**
     * Reading a quoted figure and writing it down is allowed; arithmetic
     * on one is not. `moneyText` formats — it never decides.
     *
     * The money IDENTIFIERS by name, not the word «price» anywhere: a
     * looser pattern matched `var(--store-price)` and the word
     * «hard-coded», which is a guard that cries about a CSS variable and
     * teaches whoever reads it to stop believing the failures.
     */
    const MONEY = '(?:unitPrice|lineTotal|subtotal|fromPrice|basePrice|\\bcod\\b)';
    expect(body, 'حساب مال في المتصفّح').not.toMatch(
      new RegExp(`${MONEY}\\s*[*+/-]\\s*[\\w(]|[\\w)]\\s*[*+/-]\\s*${MONEY}`)
    );
  });

  it('and the cart shows the amount the order will charge', () => {
    expect(src('src/components/storefront/CartView.tsx')).toMatch(/cart\.quote\.cod/);
    expect(src('src/components/storefront/CheckoutForm.tsx')).toMatch(/cart\.quote\.cod/);
  });
});

describe('the checkout asks what the shop asks', () => {
  /**
   * A field list written in the form would be a second answer to «what
   * does this shop ask for», and the seller's checkout tab would stop
   * meaning anything the day the two drifted.
   */
  it('takes its fields from the shop’s own settings', () => {
    const page = src('src/app/s/[store]/checkout/page.tsx');
    // The one resolver every public form and every public door take — `checkoutOrder` and `requiredCheckoutFields`
    // behind it, and what the shop hid taken off.
    expect(page).toContain('checkoutForPage(theme)');
    expect(page).toContain('fields={checkout.fields}');
    expect(page).toContain('required={checkout.required}');
  });

  /** The form the page draws, as the page hands it over (the form itself is stubbed in this file). */
  const formProps = async () => {
    const tree = await CheckoutPage({ params: Promise.resolve({ store: 'sehha' }) });
    const find = (node: unknown): Record<string, unknown> | null => {
      if (!node || typeof node !== 'object') return null;
      if (Array.isArray(node)) {
        for (const n of node) {
          const hit = find(n);
          if (hit) return hit;
        }
        return null;
      }
      const el = node as { type?: unknown; props?: Record<string, unknown> };
      if (el.props && 'fields' in el.props && 'required' in el.props) return el.props;
      return el.props ? find(el.props.children) : null;
    };
    return find(tree)!;
  };
  const withCheckout = (checkout: Record<string, unknown>) =>
    getStorefront.mockResolvedValue(
      store({ theme: { ...DEFAULT_STORE_THEME, checkout: { ...DEFAULT_STORE_THEME.checkout!, ...checkout } } })
    );

  it('a field the shop hid is not handed to the form at all — and asks nothing while hidden', async () => {
    withCheckout({ hidden: ['altPhone', 'note'], required: ['altPhone'] });
    const props = await formProps();
    expect(props.fields).toEqual(['name', 'phone', 'region', 'address']);
    expect(props.required).toEqual(['name', 'phone', 'region', 'address']);
  });

  it('NEGATIVE: nothing hidden — every field, in the shop’s order, and its ticks', async () => {
    withCheckout({ fieldOrder: ['phone', 'name', 'note', 'region', 'address', 'altPhone'], required: ['note'] });
    const props = await formProps();
    expect(props.fields).toEqual(['phone', 'name', 'note', 'region', 'address', 'altPhone']);
    expect(props.required).toEqual(['name', 'phone', 'region', 'address', 'note']);
  });

  it('and the button wears the shop’s «لون زر التأكيد» and words — or its own, when none are set', async () => {
    withCheckout({ buttonColor: '#ffd400', submitText: 'احجز الآن' });
    const props = await formProps();
    expect((props.buttonVars as Record<string, string>)['--store-accent']).toBe('#ffd400');
    expect(props.submitText).toBe('احجز الآن');
    withCheckout({});
    const plain = await formProps();
    expect(plain.buttonVars).toBeNull();
    expect(plain.submitText).toBe('أرسل الطلب');
  });

  it('and the form invents none of its own', () => {
    const form = src('src/components/storefront/CheckoutForm.tsx');
    expect(form).toMatch(/fields\.map/);
    expect(form, 'قائمة حقول مكتوبة في النموذج').not.toMatch(/CHECKOUT_FIELDS|\['name',\s*'phone'/);
  });

  it('offers the cities the order path will accept', async () => {
    await CheckoutPage({ params: Promise.resolve({ store: 'sehha' }) });
    const where = db.region.findMany.mock.calls[0][0].where;
    expect(where).toMatchObject({ countryId: 'k1', isActive: true });
  });

  /**
   * The basket became an order. Leaving it on the device would let a
   * refresh place the same order twice.
   */
  it('empties the basket once the order is placed, and not before', () => {
    const form = src('src/components/storefront/CheckoutForm.tsx');
    const at = form.indexOf('cart.clear()');
    expect(at).toBeGreaterThan(0);
    expect(form.slice(0, at)).toMatch(/res\.ok && body\?\.orderNumber/);
  });

  it('carries the reference to the thank-you page and nothing else', () => {
    expect(src('src/components/storefront/CheckoutForm.tsx')).toMatch(
      /thanks\?o=\$\{encodeURIComponent\(String\(body\.orderNumber\)\)\}/
    );
  });
});

describe('the shelf', () => {
  it('is browsing, a category and a search on one page', async () => {
    const page = src('src/app/s/[store]/shop/page.tsx');
    expect(page).toContain('searchProducts');
    expect(page).toContain('catalogPage');
    // No grid of its own: it reads the query string and draws the answer.
    expect(page, 'ترتيب مكتوب في الصفحة').not.toMatch(/\.sort\(\(a, b\)/);
  });

  /**
   * «الأكثر مبيعاً» is a claim about delivered orders and nothing counts
   * them for a shelf yet. `catalogPage` would answer «مختارات» honestly if
   * it were asked — but offering a control that cannot do what it says is
   * worse than not offering it.
   */
  it('offers no sort it cannot honour', async () => {
    const shelf = async () =>
      textOf(
        await ShopPage({
          params: Promise.resolve({ store: 'sehha' }),
          searchParams: Promise.resolve({}),
        })
      ).join(' ');

    // A shop that has not delivered five of anything cannot make the claim,
    // so the control is absent — not shown and quietly downgraded, which a
    // shopper has no way to tell apart.
    expect(await shelf()).not.toContain(SORT_LABEL_AR.bestSelling);

    // And the moment the orders exist, it is there.
    bestSellers.mockResolvedValue(new Map([['p1', 9]]));
    expect(await shelf()).toContain(SORT_LABEL_AR.bestSelling);
  });

  it('renders on the server, and «عرض المزيد» is a link', () => {
    const page = src('src/app/s/[store]/shop/page.tsx');
    expect(page, 'الرفّ صار مكوّن متصفّح').not.toMatch(/^'use client'/m);
    expect(page).toMatch(/<Link[^>]*className="sf-more"|className="sf-more"/);
  });

  /**
   * The card was written by hand in four places and three of them had
   * lost something. It is one component now, and the rule lives with it.
   */
  it('draws a designed empty state instead of a broken image', () => {
    expect(src('src/components/storefront/ProductCard.tsx')).toContain('sf-card-none');
    expect(src('src/app/s/[store]/shop/page.tsx'), 'بطاقة مكتوبة بيدها').not.toContain('sf-card-none');
    expect(src('src/components/storefront/CartView.tsx')).toMatch(/priced\?\.image \?/);
  });

  it('and every class it uses is one the stylesheet has', () => {
    const page = src('src/app/s/[store]/shop/page.tsx');
    const css = repoFile('src/components/storefront/styles.ts');
    const used = [...page.matchAll(/className="(sf-[a-z-]+)"/g)].map((m) => m[1]);
    expect(used.length).toBeGreaterThan(3);
    for (const cls of new Set(used)) expect(css, cls).toContain(`.${cls}`);
  });

  it('shows nothing to a shop that is not open', async () => {
    getStorefront.mockResolvedValue(null);
    await expect(
      ShopPage({ params: Promise.resolve({ store: 'sehha' }), searchParams: Promise.resolve({}) })
    ).rejects.toThrow('NOT_FOUND');
  });
});
