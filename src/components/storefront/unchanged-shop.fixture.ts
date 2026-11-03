import { newSection, type LandingSection } from '@/lib/landing-sections';
import { paletteFor } from '@/lib/landing-theme';
import { parseStoreTheme } from '@/lib/store-theme';
import type { Storefront } from '@/lib/storefront';
import type { BlockContext } from '@/components/landing/blocks/PageBlocks';

/**
 * THE SHOP THE «NOTHING CHANGED» GOLDEN COPY IS DRAWN FROM.
 *
 * `__golden__/unchanged-shop.html` is this shop rendered by `StorefrontShell`
 * around `PageBlocks` on `osm/main` (5e37c1ac) BEFORE the store looks, the
 * home designs, the customizer's new controls and the slider's per-slide
 * fields existed. Deterministic on purpose — fixed ids, fixed words, no clock
 * — so the only thing that can change the markup is a change to what an
 * untouched shop is drawn with.
 *
 * Two shops: one that set colours, fonts, a header, a footer, a layout and a
 * template the way a real seller does, and one that never opened the screen.
 * A .ts file, not .tsx: it is a test's data, and the unused-component guard
 * counts every .tsx under components/ as something that must ship.
 */
const at = <T extends LandingSection['type']>(type: T, id: string, over: Record<string, unknown> = {}) =>
  ({ ...newSection(type), id, ...over }) as LandingSection;

const DRESSED_THEME = JSON.stringify({
  accent: '#0d6ba8',
  mood: 'clean',
  font: 'ibm',
  corners: 'sharp',
  fonts: { heading: 'cairo' },
  colors: { background: '#ffffff', textPrimary: '#16202b', border: '#dde5ec' },
  header: { height: 80, sticky: false, onFrontPage: true },
  footer: { copyright: 'كل الحقوق لمتجر التجربة' },
  layout: { header: 'searchFirst', productCard: 'portrait' },
  template: 'lab',
  family: 'clinic',
});

function store(theme: string | null): Storefront {
  return {
    id: 'st-golden',
    name: 'متجر التجربة',
    slug: 'golden-shop',
    logo: null,
    favicon: null,
    tagline: 'كل ما يلزم البيت',
    about: 'متجر صغير يبيع ما يستعمله بنفسه.',
    supportPhone: '+963 944 000 000',
    domain: null,
    type: 'MULTI_PRODUCT',
    theme: parseStoreTheme(theme),
    currencyCode: 'USD',
    countryCode: 'SY',
    countryId: 'c-sy',
    companyId: 'co-golden',
    landingPageId: null,
    menus: {
      HEADER: [{ label: 'من نحن', href: '/s/golden-shop/pages/about' }],
      FOOTER: [{ label: 'سياسة الإرجاع', href: '/s/golden-shop/pages/returns' }],
    } as Storefront['menus'],
    homeLive: null,
    language: 'ar',
    dir: 'rtl',
  };
}

export const unchangedShops = (): Storefront[] => [store(DRESSED_THEME), store(null)];

export function unchangedHome(): LandingSection[] {
  return [
    at('announcement', 'h-announcement', { text: 'الدفع عند الاستلام' }),
    at('slider', 'h-slider', { title: 'الجديد', images: ['/api/public/media/a.jpg', '/api/public/media/b.jpg'], autoplay: true, seconds: 5 }),
    at('catalog', 'h-catalog', { title: 'تسوّق من المتجر', source: 'both', limit: 0 }),
    // A cut row: which two survive the limit depends on the order too.
    at('catalog', 'h-catalog-cut', { title: 'من المنتجات', source: 'products', limit: 2, showCategories: false }),
    at('trust', 'h-trust'),
    at('reviews', 'h-reviews', { title: 'آراء', items: [] }),
    at('faq', 'h-faq', { title: 'أسئلة', items: [{ q: 'متى يصل الطلب؟', a: 'خلال أيام' }] }),
  ];
}

export function unchangedContext(shop: Storefront): BlockContext {
  return {
    palette: paletteFor(shop.theme),
    productName: shop.name,
    price: 0,
    currency: shop.currencyCode,
    stock: null,
    offers: [],
    form: null,
    store: { name: shop.name, logo: shop.logo, phone: shop.supportPhone },
    catalog: {
      /*
       * IN AN ORDER NO SORT WOULD GIVE, AND CARRYING EVERY SORT'S FACTS.
       *
       * The prices run 20 · 12 · 30 · 15, the oldest product comes first and
       * the best seller third — so «الأقل سعراً», «وصل حديثاً» and «الأكثر
       * مبيعاً» would each draw these in a different order than they were
       * given. A block that chose no order must draw them as given; if the
       * renderer's default order ever changed, this golden copy fails. (The
       * review of #188, item 7: the first fixture was already in price order
       * and carried no facts, so a changed default would have passed.)
       */
      items: [
        { id: 'p1', kind: 'product', name: 'منشفة قطن', image: '/api/public/media/p1.jpg', href: '/s/golden-shop/p/towel', price: 20, categoryId: 'k1', addedAt: 1000, sold: 5 },
        { id: 'lp1', kind: 'page', name: 'عرض المناشف', image: null, href: '/lp/towels', price: 12, categoryId: 'k1' },
        { id: 'p2', kind: 'product', name: 'صابون زيتون', image: null, href: '/s/golden-shop/p/soap', price: 30, categoryId: null, addedAt: 3000, sold: 9 },
        { id: 'p3', kind: 'product', name: 'ليفة طبيعية', image: null, href: '/s/golden-shop/p/loofah', price: 15, categoryId: 'k1', addedAt: 2000 },
      ],
      categories: [{ id: 'k1', name: 'حمّام' }],
      activeCategory: null,
      categoryHref: (id: string | null) => (id ? `/s/golden-shop?cat=${id}` : '/s/golden-shop'),
    },
  };
}

