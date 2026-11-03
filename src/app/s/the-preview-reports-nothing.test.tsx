import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * «المعاينة الحقيقية» REPORTS NOTHING — the independent review of #189, DoD 3.
 *
 * A seller looking at their own shop is not a visitor: no pixel, no
 * PageView / ViewContent, no visit counted. The review found two paths that
 * still did — a product drawn by its landing page, and the thank-you page an
 * order pushes the frame to (a client navigation, so not a frame load). Both
 * now read `store.quiet`, which `getShopView` sets for the preview door's
 * seller whether or not the request is the frame itself.
 */
const h = vi.hoisted(() => ({
  shop: vi.fn(),
  pixels: vi.fn(async () => []),
  landing: vi.fn((_props: unknown) => null),
}));

vi.mock('next/navigation', () => ({
  notFound: () => { throw new Error('NOT_FOUND'); },
  redirect: () => { throw new Error('REDIRECT'); },
}));
vi.mock('@/lib/shop-view', () => ({ getShopView: (s: string) => h.shop(s) }));
vi.mock('@/lib/tracking/tracking-config', () => ({ getTrackingPixelsForPage: (...a: unknown[]) => h.pixels(...(a as [])) }));
vi.mock('@/components/storefront/StorefrontShell', () => ({
  StorefrontShell: ({ children }: { children: React.ReactNode }) => children,
}));
vi.mock('@/components/tracking/LandingTrackingPixels', () => ({ LandingTrackingPixels: () => null }));
vi.mock('@/components/landing/LandingPageView', () => ({ LandingPageView: (p: unknown) => h.landing(p) }));
vi.mock('@/lib/db', () => ({ db: {} }));

import Thanks from './[store]/thanks/page';
import Home from './[store]/page';
import { repoFile, stripComments } from '@/lib/guard-source';

const live = {
  id: 's1', slug: 'sehha', companyId: 'c1', countryId: 'k1', type: 'MULTI_PRODUCT', landingPageId: null,
  currencyCode: 'SYP', countryCode: 'SY', name: 'صحة', theme: { checkout: {} }, homeLive: null, menus: {},
};

beforeEach(() => {
  vi.clearAllMocks();
});

const thanks = () => Thanks({ params: Promise.resolve({ store: 'sehha' }), searchParams: Promise.resolve({ o: 'ORD-2026-1' }) });

describe('the thank-you page', () => {
  it('a customer’s: the shop’s pixels load, as always', async () => {
    h.shop.mockResolvedValue(live);
    await thanks();
    expect(h.pixels).toHaveBeenCalled();
  });

  it('after an order placed in the preview: silent — the shop is read through the preview-aware door', async () => {
    h.shop.mockResolvedValue({ ...live, quiet: true });
    await thanks();
    expect(h.pixels).not.toHaveBeenCalled();
    expect(stripComments(repoFile('src/app/s/[store]/thanks/page.tsx'))).not.toMatch(/getStorefront\(/);
  });
});

describe('a Single Product shop’s front, drawn by its landing page', () => {
  const single = { ...live, type: 'SINGLE_PRODUCT', landingPageId: 'lp1' };
  const home = () => Home({ params: Promise.resolve({ store: 'sehha' }), searchParams: Promise.resolve({}) });

  it('a customer’s visit: the page counts and reports as it always did', async () => {
    h.shop.mockResolvedValue(single);
    const tree = (await home()) as { props: { target: Record<string, unknown> } };
    expect(tree.props.target.quiet).toBeUndefined();
  });

  it('inside the preview: the page is told to report nothing', async () => {
    h.shop.mockResolvedValue({ ...single, quiet: true, preview: true });
    const tree = (await home()) as { props: { target: Record<string, unknown> } };
    expect(tree.props.target.quiet).toBe(true);
  });
});

describe('a product drawn by its landing page', () => {
  it('hands the quiet flag to the page, beside inStore', () => {
    const src = stripComments(repoFile('src/app/s/[store]/p/[sku]/page.tsx'));
    expect(src).toMatch(/<LandingPageView target=\{\{[^}]*inStore: true, quiet: store\.quiet \}\}/);
  });

  it('and every pixel read on the shop’s pages asks `store.quiet` first', () => {
    for (const rel of ['page.tsx', 'p/[sku]/page.tsx', 'checkout/page.tsx', 'thanks/page.tsx']) {
      const src = stripComments(repoFile(`src/app/s/[store]/${rel}`));
      const reads = src.match(/getTrackingPixelsForPage\(/g) ?? [];
      const asked = src.match(/store\.quiet \? \[\] : (await )?getTrackingPixelsForPage\(/g) ?? [];
      expect(asked.length, rel).toBe(reads.length);
      expect(src, rel).not.toMatch(/store\.preview \? \[\]/);
    }
  });
});
