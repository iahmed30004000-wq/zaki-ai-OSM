import { notFound } from 'next/navigation';
import { getShopView } from '@/lib/shop-view';

/**
 * THE SHOP'S DIRECTION, HELD ONE LEVEL ABOVE THE PAGE.
 *
 * Every storefront page already renders `StorefrontShell`, which sets
 * `dir={store.dir}` on its own root — so why this.
 *
 * Because `not-found.tsx` does not render the shell. When a page calls
 * `notFound()`, Next draws the 404 in place of the page but INSIDE the
 * layouts above it, and the nearest layout was `/s/layout.tsx`, which is a
 * tracking provider and nothing else. So the 404 had no way to know the
 * shop's language and answered with a hard-coded `dir="rtl"` — a shop
 * selling in English mirrored on all eight of its other pages and
 * un-mirrored on the one a shopper meets when something went wrong.
 *
 * `getStorefront` is `cache()`d per request, so the page below reads the
 * same row this did and no second query is made.
 *
 * `display: contents` on purpose: this element must carry `dir` and `lang`
 * and must not add a box. Every storefront page was laid out as a direct
 * child of the tracking provider, and a wrapper with a box of its own
 * would be a layout change smuggled in by a direction fix.
 */
export default async function StoreDirectionLayout({
  children,
  params,
}: {
  children: React.ReactNode;
  params: Promise<{ store: string }>;
}) {
  const { store: slug } = await params;
  const store = await getShopView(slug).catch(() => null);

  /**
   * A SHOP THAT DOES NOT EXIST IS REFUSED HERE, NOT IN THE PAGE.
   *
   * It was refused in each page, and that was correct until the shelf was
   * given a `loading.tsx`. A loading file opens a Suspense boundary, and a
   * streamed response has already sent its headers by the time the page
   * inside resolves — so `notFound()` thrown in there cannot set the
   * status. Measured: `/s/nosuchstore/shop` answered **200** with the
   * not-found page in the body. A soft 404 tells a search engine that
   * every mistyped shop address is a real page, on a system whose shops
   * live on being found.
   *
   * A layout runs BEFORE that boundary, so the status is still ours here.
   * The shelf keeps its skeleton and an unknown shop keeps its 404.
   *
   * The page that cannot be saved this way is the product page: its `sku`
   * is not a segment this layout can read, so an unknown product could
   * only be refused inside the boundary. That route has no `loading.tsx`
   * for exactly this reason — see the note there.
   */
  if (!store) notFound();

  return (
    <div dir={store.dir} lang={store.language} style={{ display: 'contents' }}>
      {children}
    </div>
  );
}
