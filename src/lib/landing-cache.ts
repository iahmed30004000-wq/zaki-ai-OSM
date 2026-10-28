import { revalidatePath } from 'next/cache';
import { db } from './db';
import { CACHED_LANDING_PREFIX } from './landing-cache-path';

/**
 * THE CACHED PAGE IS REFRESHED THE MOMENT WHAT IT SHOWS CHANGES.
 *
 * «إذا ما بيخرب … دقة الأرقام». A cached page refreshes itself within a minute anyway (`revalidate = 60` on
 * `/lp-cached/[slug]`); this is the «at once» for the changes a seller expects to see at once: publishing the page,
 * unpublishing or deleting it, an offer or a price, the product it sells, what it recommends after the order. The
 * order itself never depends on any of it — its price and offers are read from the database when it is placed.
 *
 * Harmless with the switch off: it refreshes a route nobody is being served from. Never throws — a refresh that fails
 * leaves the minute-long refresh to do the job, and must not fail the seller's save.
 *
 * BY STORE, for what a store decides on every page it sells through: its published look — the order form's fields,
 * its confirm button and its after-order line come from the store's «الدفع», and the page's family from its
 * template. Inside the company, like the product's, so a store id can never reach another tenant's pages.
 */
export async function refreshLandingPages(
  where:
    | { pageId: string }
    | { productId: string; companyId: string }
    | { storeId: string; companyId: string }
    | { slugs: string[] }
): Promise<void> {
  try {
    const slugs =
      'slugs' in where
        ? where.slugs
        : (
            await db.landingPage.findMany({
              where:
                'pageId' in where
                  ? { id: where.pageId }
                  : 'storeId' in where
                    ? { storeId: where.storeId, companyId: where.companyId }
                    : { productId: where.productId, companyId: where.companyId },
              select: { slug: true },
            })
          ).map((p) => p.slug);
    for (const slug of new Set(slugs.filter(Boolean))) revalidatePath(`${CACHED_LANDING_PREFIX}/${slug}`);
  } catch {
    /* the minute-long refresh still stands */
  }
}
