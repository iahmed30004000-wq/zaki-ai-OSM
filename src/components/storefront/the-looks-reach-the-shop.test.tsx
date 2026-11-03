// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render } from '@testing-library/react';

// Unmount what each test drew: a tree left mounted when the file ends is
// still scheduled work, and it runs after the DOM is gone («window is not defined»).
afterEach(cleanup);
import { StorefrontShell } from './StorefrontShell';
import { EXTRAS_SLICES, shopExtrasSheet, tickerLines } from './extras-sheet';
import { unchangedShops } from './unchanged-shop.fixture';
import { applyLook, lookTokens } from '@/lib/store-looks';
import { DEFAULT_STORE_THEME, type StoreTheme } from '@/lib/store-theme';
import type { Storefront } from '@/lib/storefront';

vi.mock('next/navigation', () => ({ useRouter: () => ({ push: () => {} }), usePathname: () => '/s/golden-shop' }));

const shop = (theme: Partial<StoreTheme>): Storefront => ({ ...unchangedShops()[1], theme: { ...DEFAULT_STORE_THEME, ...theme } });
const draw = (theme: Partial<StoreTheme>) => render(<StorefrontShell store={shop(theme)}>{null}</StorefrontShell>).container;

/** Every selector of a stylesheet, outside @keyframes. */
function selectors(css: string): string[] {
  const out: string[] = [];
  const walk = (s: string) => {
    let i = 0;
    while (i < s.length) {
      const open = s.indexOf('{', i);
      if (open < 0) break;
      const head = s.slice(i, open).trim();
      let depth = 1;
      let k = open + 1;
      while (k < s.length && depth) {
        if (s[k] === '{') depth++;
        else if (s[k] === '}') depth--;
        k++;
      }
      const body = s.slice(open + 1, k - 1);
      if (head.startsWith('@media') || head.startsWith('@supports')) walk(body);
      else if (!head.startsWith('@')) out.push(...head.split(/,(?![^(]*\))/).map((x) => x.trim()));
      i = k;
    }
  };
  walk(css);
  return out;
}

const SCOPED = /\[data-(look|radius|motion|logo|badge)\]|\[data-(look|radius|motion|logo|badge)=|\[data-(look|radius|motion|logo|badge)\],|\.sf-ticker/;

describe('a look reaches the shop that chose it, and only that shop', () => {
  it('an untouched shop writes no sheet of these at all', () => {
    expect(shopExtrasSheet(DEFAULT_STORE_THEME)).toBe('');
    const root = draw({}).firstElementChild!;
    for (const a of ['data-look', 'data-radius', 'data-motion', 'data-logo']) expect(root.hasAttribute(a), a).toBe(false);
    expect(root.querySelector('.sf-ticker')).toBeNull();
  });

  it('every rule hangs off an attribute the shell sets only when asked, or the band itself', () => {
    for (const [name, css] of Object.entries(EXTRAS_SLICES)) {
      const loose = selectors(css).filter((s) => !SCOPED.test(s));
      expect(loose, name).toEqual([]);
    }
    // the check catches a rule that escapes
    expect(selectors('.sf-root[data-look] .a{x:1}.b{y:2}').filter((s) => !SCOPED.test(s))).toEqual(['.b']);
  });

  it('a device that asks for less motion gets none, in both moving slices', () => {
    expect(EXTRAS_SLICES.motion).toContain('prefers-reduced-motion');
    expect(EXTRAS_SLICES.ticker).toContain('prefers-reduced-motion');
  });

  // 4.5 and not 4: the badge slice (the review of #188, «لون التمييز» coloured nothing) is the fifth.
  it('and all of it together stays small — under 4.5 KB, beside a 50 KB shop sheet', () => {
    const all = Object.values(EXTRAS_SLICES).join('');
    console.log(`[shop] شرائح الثيمات: ${(Buffer.byteLength(all) / 1024).toFixed(2)} ك.ب`);
    expect(Buffer.byteLength(all) / 1024).toBeLessThan(4.5);
  });

  it('a tried look names itself on the root and writes its radii', () => {
    const root = draw(applyLook(DEFAULT_STORE_THEME, lookTokens('nova')!)).firstElementChild as HTMLElement;
    expect(root.getAttribute('data-look')).toBe('nova');
    expect(root.style.getPropertyValue('--look-btn-r')).toBe('999px');
    expect(root.querySelector('style:not(:empty)')).not.toBeNull();
    expect(root.innerHTML).toContain(EXTRAS_SLICES.shape);
    expect(root.innerHTML).not.toContain(EXTRAS_SLICES.motion);
  });

  it('motion and logo size are attributes with their slices', () => {
    const root = draw({ motion: 'full', header: { height: 72, sticky: true, onFrontPage: true, logoHeight: 60 } })
      .firstElementChild as HTMLElement;
    expect(root.getAttribute('data-motion')).toBe('full');
    expect(root.hasAttribute('data-logo')).toBe(true);
    expect(root.style.getPropertyValue('--store-logo-h')).toBe('60px');
    expect(root.innerHTML).toContain(EXTRAS_SLICES.motion);
    expect(root.innerHTML).toContain(EXTRAS_SLICES.logo);
  });
});

describe('«شريط الإعلانات»', () => {
  const ticker = { enabled: true, mode: 'scroll' as const, phone: true, items: ['خصم على الطلب الثاني', ' '] };

  it('draws the seller’s lines twice for the loop, the copy hidden from screen readers, with the phone', () => {
    const root = draw({ ticker }).firstElementChild!;
    const lists = root.querySelectorAll('.sf-ticker-list');
    expect(lists).toHaveLength(2);
    expect(lists[1].getAttribute('aria-hidden')).toBe('true');
    expect(lists[0].textContent).toContain('خصم على الطلب الثاني');
    expect(lists[0].querySelector('a[href^="tel:"]')).not.toBeNull();
    // an empty line is drawn as nothing
    expect(lists[0].querySelectorAll('li')).toHaveLength(2);
  });

  it('with no line typed it says the two facts every shop here keeps — and only promised packaging when promised', () => {
    expect(tickerLines({ ...DEFAULT_STORE_THEME, ticker: { ...ticker, items: [] } })).toEqual(['الدفع عند الاستلام', 'توصيل لكل المحافظات']);
    expect(tickerLines({ ...DEFAULT_STORE_THEME, discreetPacking: true, ticker: { ...ticker, items: [] } })).toContain('تغليف خفي');
  });

  it('is off when turned off, and never on the thin frame', () => {
    expect(draw({ ticker: { ...ticker, enabled: false } }).querySelector('.sf-ticker')).toBeNull();
    const thin = render(<StorefrontShell store={shop({ ticker })} thin>{null}</StorefrontShell>).container;
    expect(thin.querySelector('.sf-ticker')).toBeNull();
  });
});

describe('«المعاينة الحقيقية» on the page itself', () => {
  it('says it is the draft and keeps out of every index — only in the preview', () => {
    const inside = render(<StorefrontShell store={{ ...shop({}), preview: true }}>{null}</StorefrontShell>).container;
    expect(inside.textContent).toContain('معاينة المسوّدة');
    expect(document.querySelector('meta[name="robots"]')?.getAttribute('content') ?? inside.innerHTML).toContain('noindex');
    const outside = render(<StorefrontShell store={shop({})}>{null}</StorefrontShell>).container;
    expect(outside.textContent).not.toContain('معاينة المسوّدة');
  });
});

describe('«شارة العرض» · «لون التمييز» colour the offer badges', () => {
  it.each([
    ['the highlight', { highlight: '#ffb020' }, '#ffb020'],
    ['«شارة العرض»', { colors: { offerBadge: '#0b5f96' } }, '#0b5f96'],
    ['«شارة العرض» over the highlight', { highlight: '#ffb020', colors: { offerBadge: '#0b5f96' } }, '#0b5f96'],
  ] as const)('%s: the badge rule is on the page, with the colour and measured ink', (_w, theme, colour) => {
    const root = draw(theme as Partial<StoreTheme>).firstElementChild as HTMLElement;
    expect(root.hasAttribute('data-badge')).toBe(true);
    expect(root.style.getPropertyValue('--store-offer-badge')).toBe(colour);
    expect(root.style.getPropertyValue('--store-offer-badge-ink')).toMatch(/^#[0-9a-f]{6}$/);
    expect(root.innerHTML).toContain(EXTRAS_SLICES.badge);
    expect(EXTRAS_SLICES.badge).toMatch(/lp-offer-tag/);
    expect(EXTRAS_SLICES.badge).toMatch(/lp-catalog-tag/);
  });

  it('a shop that set neither: no attribute, no rule, no ink', () => {
    const root = draw({}).firstElementChild as HTMLElement;
    expect(root.hasAttribute('data-badge')).toBe(false);
    expect(root.style.getPropertyValue('--store-offer-badge-ink')).toBe('');
    expect(root.innerHTML).not.toContain(EXTRAS_SLICES.badge);
  });
});
