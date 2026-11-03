import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * WHICH RENDERS OF A LANDING PAGE ARE VISITS.
 *
 * A real visitor, counted in the lifetime total and in the day's row with
 * their device and campaign. Not the seller's preview, and not the crawler
 * that draws a link's card in a chat.
 */

const { db, ua, recordLandingView, resolveCampaign, verifyPreviewToken, pixels } = vi.hoisted(() => ({
  pixels: vi.fn(async (..._a: unknown[]) => []),
  db: {
    landingPage: { findFirst: vi.fn(), update: vi.fn() },
    offer: { findMany: vi.fn(async () => []) },
    landingPageRecommendation: { findMany: vi.fn(async () => []) },
    region: { findMany: vi.fn(async () => []) },
    // A preview reads the page's unpublished draft when it has one
    // (landing-draft.ts); these fixtures have none, so the statement answers
    // with no rows and the preview shows the live columns.
    $queryRawUnsafe: vi.fn(async () => []),
  },
  ua: { value: 'Mozilla/5.0 (iPhone) Mobile Safari' as string | null },
  recordLandingView: vi.fn(),
  resolveCampaign: vi.fn(),
  verifyPreviewToken: vi.fn(),
}));

vi.mock('@/lib/db', () => ({ db }));
vi.mock('next/headers', () => ({ headers: async () => new Headers(ua.value ? { 'user-agent': ua.value } : {}) }));
vi.mock('next/navigation', () => ({ notFound: () => { throw new Error('NOT_FOUND'); } }));
vi.mock('@/lib/landing-views', async (orig) => ({
  ...(await orig<typeof import('@/lib/landing-views')>()),
  recordLandingView: (...a: unknown[]) => recordLandingView(...a),
}));
vi.mock('@/lib/campaigns-server', () => ({ resolveCampaign: (...a: unknown[]) => resolveCampaign(...a) }));
vi.mock('@/lib/landing-pages', () => ({
  verifyPreviewToken: (...a: unknown[]) => verifyPreviewToken(...a),
  clampStoredHtml: (h: string | null) => h ?? '',
}));
vi.mock('@/lib/selling-currency', () => ({ sellingCurrency: async () => 'SYP' }));
vi.mock('@/lib/tracking/tracking-config', () => ({ getTrackingPixelsForPage: (...a: unknown[]) => pixels(...a) }));
vi.mock('@/lib/fonts/load-store-fonts', () => ({ loadStoreFonts: async () => ({ css: '' }) }));
vi.mock('@/lib/reservation', () => ({ availableStock: async () => null }));
// No request scope in a test: afterResponse runs the work at once.
vi.mock('next/server', () => ({ after: () => { throw new Error('outside a request'); } }));

import { LandingPageView } from './LandingPageView';
import { BrowserVisit } from './BrowserVisit';

const page = {
  id: 'lp1', name: 'العرض', slug: 'offer', isPublished: true, htmlContent: '<p>hi</p>', builderMode: 'HTML',
  theme: null, sections: null, product: null, company: { id: 'c1' }, storeId: 's1', store: null,
};

const settle = () => new Promise((r) => setTimeout(r, 0));

beforeEach(() => {
  vi.clearAllMocks();
  ua.value = 'Mozilla/5.0 (iPhone) Mobile Safari';
  db.landingPage.findFirst.mockResolvedValue(page);
  db.landingPage.update.mockResolvedValue({});
  resolveCampaign.mockResolvedValue('cmp1');
  recordLandingView.mockResolvedValue(undefined);
});


/**
 * «المعاينة الحقيقية» — THE INDEPENDENT REVIEW OF #189, DoD 3.
 *
 * A product (or a Single Product shop's front) drawn by its landing page
 * inside the preview: `quiet` — no pixel asked for, no visit counted by the
 * server, no browser count script. A customer's visit to the same page is
 * counted and reported exactly as before.
 */
function findAll(node: unknown, type: unknown, out: { props: Record<string, unknown> }[] = []) {
  if (!node || typeof node !== 'object') return out;
  if (Array.isArray(node)) { for (const n of node) findAll(n, type, out); return out; }
  const el = node as { type?: unknown; props?: Record<string, unknown> };
  if (el.type === type && el.props) out.push(el as { props: Record<string, unknown> });
  if (el.props) findAll(el.props.children, type, out);
  return out;
}

describe('a landing page drawn through the preview door', () => {
  it('a customer’s visit: pixels asked for, the visit counted, the browser count drawn', async () => {
    const tree = await LandingPageView({ target: { frontPageId: 'lp1', storeId: 's1', inStore: true } });
    await settle();
    expect(pixels).toHaveBeenCalled();
    expect(db.landingPage.update).toHaveBeenCalled();
    expect(recordLandingView).toHaveBeenCalled();
    expect(findAll(tree, BrowserVisit)).toHaveLength(1);
  });

  it.each([
    ['a product inside the shop', { frontPageId: 'lp1', storeId: 's1', inStore: true, quiet: true }],
    ['a Single Product shop’s front', { frontPageId: 'lp1', storeId: 's1', quiet: true }],
  ])('%s, quiet: no pixel, no count, no browser count', async (_w, target) => {
    const tree = await LandingPageView({ target });
    await settle();
    expect(pixels).not.toHaveBeenCalled();
    expect(db.landingPage.update).not.toHaveBeenCalled();
    expect(recordLandingView).not.toHaveBeenCalled();
    expect(findAll(tree, BrowserVisit)).toHaveLength(0);
  });
});
