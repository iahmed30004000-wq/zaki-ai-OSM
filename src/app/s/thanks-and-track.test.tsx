import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * THE TWO PAGES AT THE END OF AN ORDER.
 *
 * The thank-you page and the tracking page are the only two screens a
 * customer sees after they have paid nothing and given us their address.
 * Both are built so that opening one, or being sent a link to one, reveals
 * nothing about anybody.
 */

const { getStorefront, notFound } = vi.hoisted(() => ({
  getStorefront: vi.fn(),
  notFound: vi.fn(() => {
    throw new Error('NOT_FOUND');
  }),
}));

vi.mock('next/navigation', () => ({ notFound: () => notFound() }));
vi.mock('@/lib/storefront', () => ({ getStorefront: (...a: unknown[]) => getStorefront(...a) }));
vi.mock('@/components/storefront/StorefrontShell', () => ({
  StorefrontShell: ({ children }: { children: React.ReactNode }) => children,
}));
vi.mock('@/components/storefront/TrackForm', () => ({ TrackForm: () => null }));
vi.mock('@/components/tracking/LandingTrackingPixels', () => ({ LandingTrackingPixels: () => null }));
vi.mock('@/lib/tracking/tracking-config', () => ({ getTrackingPixelsForPage: async () => [] }));
vi.mock('@/lib/db', () => ({ db: {} }));

import Thanks, { generateMetadata as thanksMeta } from './[store]/thanks/page';
import Track, { generateMetadata as trackMeta } from './[store]/track/page';
import { WHAT_HAPPENS_NEXT_AR } from '@/lib/order-tracking';
import { repoFile, stripComments } from '@/lib/guard-source';
import { DEFAULT_STORE_THEME } from '@/lib/store-theme';

const store = {
  id: 's1',
  slug: 'sehha',
  companyId: 'c1',
  countryId: 'k1',
  type: 'MULTI_PRODUCT',
  landingPageId: null,
  currencyCode: 'SYP',
  countryCode: 'SY',
  name: 'صحة',
};

/** Every string and every href anywhere in the rendered tree. */
function textOf(node: unknown, out: string[] = []): string[] {
  if (node === null || node === undefined || typeof node === 'boolean') return out;
  if (typeof node === 'string' || typeof node === 'number') {
    out.push(String(node));
    return out;
  }
  if (Array.isArray(node)) {
    for (const n of node) textOf(n, out);
    return out;
  }
  const el = node as { props?: Record<string, unknown> };
  if (el.props) {
    if (typeof el.props.href === 'string') out.push(el.props.href);
    textOf(el.props.children, out);
  }
  return out;
}

const thanks = (search: Record<string, string> = {}) =>
  Thanks({ params: Promise.resolve({ store: 'sehha' }), searchParams: Promise.resolve(search) });
const track = () => Track({ params: Promise.resolve({ store: 'sehha' }) });

beforeEach(() => {
  vi.clearAllMocks();
  getStorefront.mockResolvedValue(store);
});

describe('the thank-you page', () => {
  it('prints back the reference it was handed', async () => {
    const text = textOf(await thanks({ o: 'ORD-77' })).join(' ');
    expect(text).toContain('ORD-77');
    expect(text).toContain('تم استلام طلبك');
  });

  /**
   * THE REFERENCE IS ECHOED, NEVER LOOKED UP.
   *
   * A page that answered differently for a real reference than for a made
   * up one would be an oracle for «does this order number exist» — which is
   * the one thing the tracking route is carefully built not to be.
   */
  it('asks the database nothing about it', () => {
    const src = stripComments(repoFile('src/app/s/[store]/thanks/page.tsx'));
    expect(src, 'صفحة الشكر تسأل عن الطلب').not.toMatch(/db\.order|findFirst|findUnique/);
  });

  it('prints nothing that is not shaped like a reference', async () => {
    const text = textOf(await thanks({ o: '<script>alert(1)</script>' })).join(' ');
    expect(text).not.toContain('script');
    expect(text).toContain('تم استلام طلبك');
  });

  it('and stands on its own with no reference at all', async () => {
    const text = textOf(await thanks()).join(' ');
    expect(text).toContain('تم استلام طلبك');
    expect(text).not.toContain('رقم طلبك');
  });

  /**
   * Tracking needs the phone as well. Prefilling half the pair from a URL
   * would put the other half one guess away for anybody who saw the link.
   */
  it('links to tracking without carrying the reference into it', async () => {
    const parts = textOf(await thanks({ o: 'ORD-77' }));
    const link = parts.find((p) => p.includes('/track'));
    expect(link).toBe('/s/sehha/track');
    expect(link).not.toContain('ORD-77');
  });

  /**
   * «رسالة ما بعد الطلب» — the shop's «الدفع», from its LIVE theme. The basket's thank-you page says it too, where it
   * used to say only its own line; a shop that wrote none keeps that line.
   */
  it('says the shop’s «رسالة ما بعد الطلب» when it wrote one, in place of its own line', async () => {
    getStorefront.mockResolvedValue({
      ...store,
      theme: {
        ...DEFAULT_STORE_THEME,
        checkout: { ...DEFAULT_STORE_THEME.checkout!, afterOrderMessage: '  وصلنا طلبك — بنتصل فيك اليوم.  ' },
      },
    });
    const text = textOf(await thanks({ o: 'ORD-77' })).join(' ');
    expect(text).toContain('وصلنا طلبك — بنتصل فيك اليوم.');
    expect(text).not.toContain('تم استلام طلبك');
    // Everything else the page promises is still there.
    expect(text).toContain('ORD-77');
    for (const line of WHAT_HAPPENS_NEXT_AR) expect(text).toContain(line);
  });

  it('NEGATIVE: a shop that wrote none — or only spaces — keeps the line the page always had', async () => {
    for (const afterOrderMessage of ['', '   ']) {
      getStorefront.mockResolvedValue({
        ...store,
        theme: { ...DEFAULT_STORE_THEME, checkout: { ...DEFAULT_STORE_THEME.checkout!, afterOrderMessage } },
      });
      expect(textOf(await thanks()).join(' ')).toContain('تم استلام طلبك');
    }
  });

  /** One promise, written once, on both screens. */
  it('makes the promise the tracking page makes', async () => {
    const text = textOf(await thanks()).join(' ');
    for (const line of WHAT_HAPPENS_NEXT_AR) expect(text).toContain(line);
  });

  it('is not for a shop that is not open', async () => {
    getStorefront.mockResolvedValue(null);
    await expect(thanks()).rejects.toThrow('NOT_FOUND');
  });

  it('keeps a customer’s confirmation out of any index', async () => {
    const meta = await thanksMeta({
      params: Promise.resolve({ store: 'sehha' }),
      searchParams: Promise.resolve({}),
    });
    expect(meta.robots).toMatchObject({ index: false });
  });
});

describe('the tracking page', () => {
  it('draws the form and asks nothing of anybody', async () => {
    const text = textOf(await track()).join(' ');
    expect(text).toContain('تتبّع الطلب');
    const src = stripComments(repoFile('src/app/s/[store]/track/page.tsx'));
    // Nothing is read here: the one question it can answer needs two
    // halves, and both are typed by whoever is standing in front of it.
    expect(src).not.toMatch(/db\.|findFirst|findMany/);
  });

  it('is not for a shop that is not open', async () => {
    getStorefront.mockResolvedValue(null);
    await expect(track()).rejects.toThrow('NOT_FOUND');
  });

  it('stays out of any index', async () => {
    const meta = await trackMeta({ params: Promise.resolve({ store: 'sehha' }) });
    expect(meta.robots).toMatchObject({ index: false });
  });

  /**
   * The form POSTs. A phone number in a query string ends up in the
   * browser's history, the access log and the next page's referrer — the
   * shape of the request is the privacy decision, and it is made on both
   * sides of the wire.
   */
  it('sends the phone in a body, never in a URL', () => {
    const src = stripComments(repoFile('src/components/storefront/TrackForm.tsx'));
    expect(src).toMatch(/method: 'POST'/);
    expect(src).toMatch(/JSON\.stringify\(\{ phone, orderNumber \}\)/);
    expect(src, 'الهاتف في رابط').not.toMatch(/\?phone=|searchParams\.set/);
  });

  /**
   * And it repeats the server's sentence. Every failure answers
   * identically on purpose; a friendlier message composed in the browser
   * for one of those cases hands back exactly the difference the route
   * went to trouble to remove.
   */
  it('writes no refusal of its own', () => {
    const src = stripComments(repoFile('src/components/storefront/TrackForm.tsx'));
    expect(src).toMatch(/body\?\.error/);
    expect(src, 'رسالة رفض مؤلَّفة في المتصفّح').not.toMatch(/رقم الطلب غير صحيح|لا يوجد طلب/);
  });
});
