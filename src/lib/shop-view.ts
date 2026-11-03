import { cache } from 'react';
import { db } from './db';
import { getStorefront, storeTheme, type Storefront } from './storefront';
import { previewSessionStoreId, previewStoreIdFor } from './store-preview';
import type { StoreTheme } from './store-theme';

/**
 * THE SHOP AS ITS PAGES DRAW IT — the live one, or, inside the seller's own
 * preview frame, its DRAFT.
 *
 * `getStorefront` stays what it is: the LIVE store, and the theme the order
 * doors read their rules from (`every-public-door-asks-what-the-shop-asks`).
 * Nothing here is reachable from a door — only the shop's pages call this.
 *
 * For every request that is not «المعاينة الحقيقية» (store-preview.ts) this
 * returns `getStorefront`'s answer, the same object. Inside the frame it
 * swaps in two things: the draft theme — with the LIVE «الدفع», because the
 * door enforces the live one until publish and a preview must not show a
 * form that would be refused — and the draft home page.
 *
 * A store that is not open yet has no live shop to build on, so it cannot
 * be previewed this way (BACKLOG RV1035).
 */
export const getShopView = cache(async function getShopView(slug: string): Promise<Storefront | null> {
  const live = await getStorefront(slug);
  if (!live) return null;
  // The seller who opened the preview door: nothing on this page is reported.
  const sessionId = await previewSessionStoreId(slug);
  if (!sessionId || sessionId !== live.id) return live;
  // And only inside the frame itself is the DRAFT drawn.
  const previewId = await previewStoreIdFor(slug);
  if (!previewId || previewId !== live.id) return { ...live, quiet: true };

  const row = await db.store.findFirst({
    where: { id: live.id, companyId: live.companyId },
    select: { theme: true, themeDraft: true, homeDraft: true, homeLive: true },
  });
  if (!row) return live;
  return {
    ...live,
    theme: previewTheme(row.theme, row.themeDraft),
    homeLive: row.homeDraft ?? row.homeLive,
    preview: true,
    quiet: true,
  };
});

/** The draft's look, with the live shop's «الدفع». */
export function previewTheme(live: string | null, draft: string | null | undefined): StoreTheme {
  return { ...storeTheme(draft ?? live), checkout: storeTheme(live).checkout };
}
