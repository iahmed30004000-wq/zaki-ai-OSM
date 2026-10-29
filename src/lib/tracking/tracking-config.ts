/**
 * GLOBAL TRACKING — server-side pixel configuration (DB → client engine).
 *
 * Scope is resolved HERE, on the server. The client never decides which
 * pixels it "owns" — it only receives an already-filtered, re-validated
 * list for the page being rendered. IDs are re-validated on the way out
 * (fail closed: an invalid row is silently excluded).
 *
 * Tenant isolation: every query is companyId-scoped, and the companyId
 * always comes from the page being rendered — the landing page's row or the
 * storefront's store — never from whoever happens to be signed in.
 */

import { db } from '@/lib/db';
import {
  filterPixelsForPage,
  pixelReaches,
  PageOrigin,
  TrackingPageContext,
  TrackingPixelView,
  TrackingPlatform,
  TrackingScope,
} from './tracking-types';
import { validateTrackingPixelId } from './tracking-validation';
import { orderEventOf } from '@/lib/conversions/types';

/**
 * EVERY COLUMN OF A PIXEL THAT MAY LEAVE THE SERVER.
 *
 * Written once, used by every route that returns one. The pixel row now
 * carries an encrypted Conversions API token, and the way that token gets
 * leaked is not a mistake in the sending — it is a route that returns the
 * whole row because it always did, on the day somebody adds a column.
 *
 * `capiToken` is absent rather than stripped afterwards: a field that is
 * never selected cannot be accidentally serialised. `capiTokenHint` is the
 * last four characters and is safe — it is there so a seller can tell which
 * token is in there.
 */
export const PIXEL_PUBLIC_SELECT = {
  id: true, platform: true, name: true, pixelId: true, enabled: true,
  scope: true, createdAt: true, capiTokenHint: true, capiTestCode: true, capiDatasetId: true,
  // Where it fires. Not a secret, and a settings screen that cannot show it
  // is a screen on which «كل المتاجر» and «هذا المتجر» look identical.
  storeId: true, countryId: true,
  orderEvent: true, sendViewContent: true, sendInitiateCheckout: true,
} as const;

function toView(row: {
  id: string;
  platform: string;
  name: string;
  pixelId: string;
  scope: string;
  enabled: boolean;
  storeId: string | null;
  countryId: string | null;
  orderEvent?: string;
  sendViewContent?: boolean;
  sendInitiateCheckout?: boolean;
}, purchaseOnServer = false): TrackingPixelView | null {
  const platform = row.platform as TrackingPlatform;
  const scope = row.scope as TrackingScope;
  const pixelId = validateTrackingPixelId(platform, row.pixelId);
  if (!pixelId) return null; // fail closed — never serve an invalid ID
  return {
    id: row.id,
    platform,
    name: row.name,
    pixelId,
    scope,
    enabled: row.enabled === true,
    storeId: row.storeId,
    countryId: row.countryId,
    ...(purchaseOnServer ? { purchaseOnServer: true } : {}),
    // Only what differs from the default travels to the browser — a page with every pixel on its defaults ships
    // exactly the bytes it did before these switches existed.
    ...(row.orderEvent === 'Lead' ? { orderEvent: 'Lead' as const } : {}),
    ...(row.sendViewContent === false ? { sendViewContent: false } : {}),
    ...(row.sendInitiateCheckout === false ? { sendInitiateCheckout: false } : {}),
  };
}

/**
 * The pixels whose Purchase is sent by the SERVER when an order is confirmed.
 *
 * The owner's rule: «الشراء بيتحقق لما يتم تأكيد الطلب». The server side already exists — a conversion on
 * `order.confirmed` is queued and sent through the Conversions API — so the only missing half is the browser
 * standing down. The conditions are the ones `queueConversions` uses to decide a delivery will happen at all
 * (conversion on, pixel on, token held): a pixel that cannot receive the server event keeps its browser
 * Purchase, so signal is never lost to a switch that sends nothing.
 *
 * Fails to an empty set: if this cannot be read the browser keeps sending Purchase, which is the old
 * behaviour — never silence.
 */
export async function pixelsWithServerPurchase(companyId: string): Promise<Set<string>> {
  try {
    const rows = await db.customConversion.findMany({
      where: {
        companyId,
        enabled: true,
        trigger: 'order.confirmed',
        // The two names a pixel reports an order as; which one is THIS pixel's is decided below, per row.
        eventName: { in: ['Purchase', 'Lead'] },
        pixel: { enabled: true, capiToken: { not: null } },
      },
      select: { pixelId: true, eventName: true, pixel: { select: { orderEvent: true } } },
    });
    /*
     * COVERED = the server's event IS the pixel's order event. A pixel that reports orders as leads sends `Lead` from
     * the browser, so a server «Lead» at confirmation covers it and a server «Purchase» does not (the browser still
     * has its Lead to send, and it is a different event); the reverse holds for a pixel on the default. Matching the
     * NAME to the pixel's own goal is what stops the browser and the server counting one order twice.
     */
    return new Set(
      rows.filter((r) => r.eventName === orderEventOf(r.pixel ?? {})).map((r) => r.pixelId)
    );
  } catch {
    return new Set();
  }
}

const SCOPE_COLUMNS = {
  id: true, platform: true, name: true, pixelId: true, scope: true,
  enabled: true, storeId: true, countryId: true,
  orderEvent: true, sendViewContent: true, sendInitiateCheckout: true,
} as const;

export async function getCompanyTrackingPixels(companyId: string): Promise<TrackingPixelView[]> {
  try {
    const rows = await db.trackingPixel.findMany({
      where: { companyId, enabled: true },
      orderBy: { createdAt: 'asc' },
      select: SCOPE_COLUMNS,
    });
    const onServer = await pixelsWithServerPurchase(companyId);
    return rows.map((r) => toView(r, onServer.has(r.id))).filter((p): p is TrackingPixelView => p !== null);
  } catch {
    return []; // tracking must never break a page render
  }
}

/**
 * Pixels for one page: the right KIND of page, and the right SHOP.
 *
 * ── WHY THE ORIGIN IS REQUIRED AND NOT OPTIONAL ──
 *
 * It was `(companyId, page)` and every call site had the store to hand and
 * did not pass it, because there was nothing to pass it to. An optional
 * origin would compile at all four call sites and silently mean «every
 * pixel» at any one that forgot — which is the exact defect this is for.
 * Required, the compiler asks the question.
 *
 * ── AND THE FILTERING IS IN ONE PLACE, NOT TWO ──
 *
 * The narrowing could be done in SQL (`storeId IN (null, :store)`), and
 * that query would be faster and would be a SECOND copy of the rule — one
 * in Prisma's `where`, one in `pixelReaches`, and nothing to notice when
 * they disagree. A company has tens of pixels, not thousands. The rule
 * stays a pure function and the query stays «this company's enabled rows».
 */
export async function getTrackingPixelsForPage(
  companyId: string,
  page: TrackingPageContext,
  origin: PageOrigin
): Promise<TrackingPixelView[]> {
  const all = await getCompanyTrackingPixels(companyId);
  return filterPixelsForPage(
    all.filter((p) => pixelReaches(p, origin)),
    page
  );
}
