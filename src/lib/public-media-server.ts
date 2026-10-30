import { db } from './db';
import { publicMediaStrict } from './auth-switches';

/**
 * WHOSE IMAGES ARE PUBLIC, AND WHEN.
 *
 * An image sits in the folder of the row it was uploaded for — a landing
 * page or a product (see public-media.ts). It is public:
 *
 *  - shown by a landing page (a link naming the page): while that page is
 *    PUBLISHED, or is the page a valid preview token names, AND the image is
 *    the page's own, or of its company and something the page references —
 *    an image in its blocks, theme, HTML or CSS (a duplicated page links
 *    into the original's folder), or the photo of the product it sells or
 *    offers as an add-on (placed by the server, not written in the page).
 *    The product's own status does not matter here: the page is public, and
 *    it is showing it.
 *  - on its own (a storefront's catalogue): an ACTIVE product whose store's
 *    storefront is open. Nothing else — a page's images are always asked
 *    for through the page.
 *
 * Anything else — a draft, an image no public page shows, a closed shop, a
 * store's folder of logos past and present — stays private, with no
 * difference between "no such file" and "not public". The answer is the
 * owner's company, from its own row: the URL never names one.
 */

export interface MediaRequest {
  owner: string;
  file: string;
  /** The landing page the image is shown on, when a page shows it. */
  via: string | null;
  /** The page a valid preview token names. */
  previewPageId: string | null;
}

const TTL_MS = 60_000;
const MAX_ENTRIES = 5_000;
const cache = new Map<string, { company: string | null; at: number }>();

/** The owner's company when the image is public, else null. Remembered for a minute. */
export async function publicMediaCompany(req: MediaRequest): Promise<string | null> {
  // A preview answers for one person; it is never remembered for others.
  const key = req.previewPageId ? null : `${req.via ?? ''}|${req.owner}|${req.file}`;
  const hit = key ? cache.get(key) : undefined;
  if (hit && Date.now() - hit.at < TTL_MS) return hit.company;

  const company = req.via ? await shownByPage(req) : await publicOnItsOwn(req);

  if (key) {
    if (cache.size >= MAX_ENTRIES) cache.delete(cache.keys().next().value as string);
    cache.set(key, { company, at: Date.now() });
  }
  return company;
}

async function shownByPage({ owner, file, via, previewPageId }: MediaRequest): Promise<string | null> {
  const page = await db.landingPage.findFirst({
    where: { id: via! },
    select: {
      id: true, companyId: true, isPublished: true, productId: true,
      sections: true, theme: true, htmlContent: true, cssContent: true, pageSettings: true,
      recommendations: { where: { isActive: true }, select: { productId: true } },
    },
  });
  if (!page || !(page.isPublished || previewPageId === page.id)) return null;
  if (owner === page.id) return page.companyId;

  const references =
    [page.sections, page.theme, page.htmlContent, page.cssContent, page.pageSettings].some((t) => typeof t === 'string' && t.includes(file)) ||
    page.productId === owner ||
    page.recommendations.some((r) => r.productId === owner);
  if (!references) return null;

  // The folder must be a page's or a product's of the SAME company: the
  // storage key is built from the owner's row, never from the page's.
  const [ownerPage, ownerProduct] = await Promise.all([
    db.landingPage.findFirst({ where: { id: owner, companyId: page.companyId }, select: { companyId: true } }),
    db.product.findFirst({ where: { id: owner, companyId: page.companyId }, select: { companyId: true } }),
  ]);
  return ownerPage?.companyId ?? ownerProduct?.companyId ?? null;
}

async function publicOnItsOwn({ owner, file }: MediaRequest): Promise<string | null> {
  const strict = publicMediaStrict();
  const product = await db.product.findFirst({
    where: { id: owner, status: 'ACTIVE' },
    select: {
      companyId: true,
      store: { select: { storefrontEnabled: true, status: true } },
      // Read only under the strict rule (A8), so the default query is the one that has always run.
      ...(strict
        ? { image: true, description: true, descriptionEn: true, images: { select: { url: true } } }
        : {}),
    },
  });
  if (!(product?.store?.storefrontEnabled && product.store.status === 'ACTIVE')) return null;

  /*
   * A8 — A FILE IS PUBLIC ON ITS OWN ONLY IF THE PRODUCT STILL SHOWS IT.
   *
   * The folder of an active product holds every file ever uploaded for it: the pictures it was given and replaced, and
   * anything else put there. Serving the whole folder made all of those readable by anyone who could guess or had kept a
   * link. Under the strict rule a file is public on its own only when it is the product's main picture, one of its
   * gallery pictures, or appears in its description (a picture written into the text is shown with it). A page's images
   * are never asked for here; they come through the page. Off by default (`PUBLIC_MEDIA_STRICT`) until the owner has
   * looked at a storefront with it on.
   */
  if (strict) {
    const shown = product as unknown as {
      image?: string | null;
      description?: string | null;
      descriptionEn?: string | null;
      images?: Array<{ url: string }>;
    };
    const refs = [shown.image, shown.description, shown.descriptionEn, ...(shown.images ?? []).map((i) => i.url)];
    if (!refs.some((t) => typeof t === 'string' && t.includes(file))) return null;
  }
  return product.companyId;
}

/** For tests: forget every remembered answer. */
export function forgetPublicMedia(): void {
  cache.clear();
}
