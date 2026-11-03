import { cache } from 'react';
import { db } from './db';
import { type LandingTheme } from './landing-theme';
import { DEFAULT_STORE_THEME, parseStoreTheme, type StoreTheme } from './store-theme';
import { parseMenuItems, visibleItems, type MenuItem, type MenuKey } from './store-menus';
import { directionOf } from './store-languages';
import { liveOfferWhere } from './offers';
import { parseCategoryAttributes, parseProductAttributes, type ProductAttributes } from './product-attributes';
import { publicizeMedia } from './public-media';
import type { CatalogItem } from '@/components/landing/blocks/PageBlocks';

/**
 * A STORE, SEEN FROM THE OUTSIDE.
 *
 * The store already existed — it is what an order belongs to, what a user
 * has access to, what a landing page sits inside. It simply had no public
 * face. This gives it one, and deliberately gives it nothing else: no second
 * product catalogue, no second offer system, no second order path. A
 * storefront is a view of what the company already sells.
 *
 * Two shapes from one model, because `Store.type` already said which:
 *
 *   SINGLE_PRODUCT — the home page IS a landing page: the one the seller
 *                    picked as the store's front, with every block, template,
 *                    pixel and upsell it has. No catalogue, no cart. Until a
 *                    page is picked, it is its one product's page.
 *   MULTI_PRODUCT  — home lists what is for sale, each with its own page.
 *
 * Everything is read through THIS store. The catalogue used to be read by
 * company, so one shop listed — and sold — another shop's products, and the
 * order landed on the wrong shop's stock.
 *
 * Only ACTIVE products with a price are listed. A product with no price is
 * not a product a customer can buy, and showing it teaches them the shop is
 * broken.
 */

export interface StorefrontProduct {
  id: string;
  sku: string;
  /**
   * WHAT A LINK TO THIS PRODUCT SHOULD SAY.
   *
   * The readable address when it has one, the SKU when it does not — a
   * product saved before addresses existed still has to be reachable.
   * One field so that every surface links the same way and none of them
   * decides the fallback for itself.
   */
  handle: string;
  name: string;
  /**
   * THE LATIN NAME, FOR THE ONE FAMILY THAT SETS IT HUGE AND FAINT.
   *
   * `Product.nameEn` is a real column and has been since before the
   * storefront existed; it simply never reached a shopper. «علامة» draws
   * it behind the photograph — and draws nothing when it is empty, which
   * is the whole of the owner's rule 0. Carried on the shelf as well as
   * on the product page, because the series card prints it too.
   */
  nameEn: string | null;
  description: string | null;
  image: string | null;
  basePrice: number;
  /** The cheapest per-unit bundle, for a "from" price on a listing. */
  fromPrice: number;
  /**
   * What kind of thing this is, as the shop's own products name it.
   *
   * Here so the search can rank by it and the grid can filter by it without
   * loading the catalogue a second time in a different shape. The category
   * is company-wide and hangs off the product — see the note in
   * `storefrontCatalog` on why there is no store-scoped copy of it.
   */
  category: { id: string; name: string } | null;
  /**
   * This product's answers to its category's questions.
   *
   * Read against that category's schema here, once, so every surface
   * downstream — the grid, the filter sheet, the product page — sees the
   * same answers and nobody parses them a second way.
   */
  attributes: ProductAttributes;
}

export interface Storefront {
  id: string;
  name: string;
  slug: string;
  logo: string | null;
  favicon: string | null;
  tagline: string | null;
  about: string | null;
  supportPhone: string | null;
  domain: string | null;
  type: 'SINGLE_PRODUCT' | 'MULTI_PRODUCT';
  /**
   * The store's whole template — the palette AND the header, footer,
   * product display, checkout and home order. A LandingTheme is a valid
   * StoreTheme, so this stays assignable everywhere a palette was wanted.
   */
  theme: StoreTheme;
  currencyCode: string;
  countryCode: string;
  countryId: string;
  companyId: string;
  /** A Single Product store's front page, when one is picked. */
  landingPageId: string | null;
  /** The shop's menus, already filtered to what a shopper may see. */
  menus: Partial<Record<MenuKey, MenuItem[]>>;
  /**
   * The home page the seller PUBLISHED, as stored JSON, or null.
   *
   * The draft is deliberately not here: it is the seller's own workbench,
   * and a storefront that could read it would put half-finished work in
   * front of a customer.
   */
  homeLive: string | null;
  /** What the shop is written in, and which way it reads. */
  language: string;
  dir: 'rtl' | 'ltr';
  /**
   * True only inside «المعاينة الحقيقية» — the seller's own frame over the
   * draft (see shop-view.ts). Never set by `getStorefront`.
   */
  preview?: true;
  /**
   * True for every page the seller opens through the preview door — inside
   * the frame or reached from it: nothing is reported (no pixel, no visit
   * count). See store-preview.ts. Never set by `getStorefront`.
   */
  quiet?: true;
}

/**
 * A shop's menus, as a shopper sees them: hidden items removed, order kept.
 *
 * Cached per request like the storefront itself — the shell draws the
 * header and the footer from the same read.
 */
export const getStoreMenus = cache(async function getStoreMenus(
  storeId: string
): Promise<Partial<Record<MenuKey, MenuItem[]>>> {
  const rows = await db.storeMenu.findMany({ where: { storeId }, select: { key: true, items: true } });
  const out: Partial<Record<MenuKey, MenuItem[]>> = {};
  for (const row of rows) out[row.key as MenuKey] = visibleItems(parseMenuItems(row.items));
  return out;
});

/**
 * The stored theme, or the house one when it is missing or corrupt.
 *
 * One parser, in src/lib/store-theme.ts: it falls back part by part, so a
 * header height this code refuses does not cost the shop its colour. This
 * used to spread the raw JSON over the defaults with no validation at all,
 * which meant a corrupt field reached the page as-is.
 */
export function storeTheme(raw: string | null | undefined): StoreTheme {
  return parseStoreTheme(raw);
}

/** Re-exported so callers reaching for a default do not import two modules. */
export { DEFAULT_STORE_THEME };
export type { LandingTheme };

/**
 * The storefront at this slug, or null.
 *
 * A paused store and a store whose owner never turned the storefront on both
 * read as absent: a shop that is not open should not be browsable.
 */
// Cached per request: the page and its metadata both read the store.
export const getStorefront = cache(async function getStorefront(slug: string): Promise<Storefront | null> {
  const store = await db.store.findFirst({
    where: { slug, storefrontEnabled: true, status: 'ACTIVE' },
    // Slugs are unique across companies from now on; for any pair that
    // predates that, the older store keeps its address — deterministically.
    orderBy: { createdAt: 'asc' },
    select: {
      id: true, name: true, slug: true, logo: true, favicon: true, tagline: true, about: true,
      supportPhone: true, domain: true, type: true, theme: true, homeLive: true, language: true,
      companyId: true, countryId: true, landingPageId: true,
      country: { select: { code: true, currencyCode: true } },
    },
  });
  if (!store) return null;

  return {
    id: store.id,
    name: store.name,
    slug: store.slug,
    logo: store.logo,
    favicon: store.favicon,
    tagline: store.tagline,
    about: store.about,
    supportPhone: store.supportPhone,
    domain: store.domain,
    type: store.type === 'SINGLE_PRODUCT' ? 'SINGLE_PRODUCT' : 'MULTI_PRODUCT',
    theme: storeTheme(store.theme),
    currencyCode: store.country.currencyCode,
    countryCode: store.country.code,
    countryId: store.countryId,
    companyId: store.companyId,
    landingPageId: store.type === 'SINGLE_PRODUCT' ? store.landingPageId : null,
    menus: await getStoreMenus(store.id),
    homeLive: store.homeLive,
    language: store.language,
    dir: directionOf(store.language),
  };
});

/**
 * What this store has for sale.
 *
 * The "from" price is the cheapest per unit across the product's bundles,
 * because that is the number a shopper compares — and it is computed from
 * the same offers the order path charges from, so a listing can never
 * advertise a price the checkout will not honour.
 */
export async function storefrontProducts(
  companyId: string,
  storeId: string,
  limit = 60,
  /**
   * NARROWED TO THESE PRODUCTS, AND NONE OF THEM CUT BY THE LIMIT.
   *
   * Passed only by `storeShelf`, for a store that has made the switch.
   * The narrowing is in the WHERE and not a `.filter()` on the result for
   * one reason: taking 60 rows newest-first and filtering afterwards
   * silently drops a shown product that happens to be the 61st, and a
   * shop whose window loses its oldest goods as it grows is a bug nobody
   * reports because nothing looks broken.
   *
   * `take` therefore ignores `limit` here. The count is bounded by how
   * many pages the seller has published and shown, which is their own
   * doing and small.
   */
  onlyIds?: string[]
): Promise<StorefrontProduct[]> {
  const now = new Date();
  const products = await db.product.findMany({
    where: {
      companyId,
      storeId,
      status: 'ACTIVE',
      basePrice: { gt: 0 },
      ...(onlyIds ? { id: { in: onlyIds } } : {}),
    },
    orderBy: { createdAt: 'desc' },
    take: onlyIds ? onlyIds.length : limit,
    select: {
      id: true, sku: true, name: true, nameEn: true, description: true, image: true, basePrice: true, attributes: true,
      slug: true, previousSlugs: true,
      category: { select: { id: true, name: true, attributeSchema: true } },
      offers: {
        // The same predicate the product page and the order path use. This
        // read spelled `status: 'ACTIVE'` itself, so a bundle that had
        // finished went on setting the per-unit price in the grid.
        where: liveOfferWhere(now),
        select: { quantity: true, freeQuantity: true, sellingPrice: true },
      },
      images: {
        where: { isPrimary: true },
        take: 1,
        select: { url: true },
      },
    },
  });

  // Shown to shoppers, who have no session: public image links.
  return publicizeMedia(products).map((p) => {
    const perUnit = p.offers
      .map((o) => {
        const units = o.quantity + o.freeQuantity;
        return units > 0 ? o.sellingPrice / units : o.sellingPrice;
      })
      .filter((n) => n > 0);

    return {
      id: p.id,
      sku: p.sku,
      name: p.name,
      nameEn: p.nameEn,
      description: p.description,
      image: p.images[0]?.url ?? p.image,
      basePrice: p.basePrice,
      fromPrice: perUnit.length ? Math.min(...perUnit) : p.basePrice,
      handle: p.slug || p.sku,
      category: p.category && { id: p.category.id, name: p.category.name },
      attributes: parseProductAttributes(p.attributes, parseCategoryAttributes(p.category?.attributeSchema ?? null)),
    };
  });
}

/**
 * THE PRODUCTS THIS STORE HAS PUT A SHOWN PAGE BEHIND.
 *
 * One read, one place, so «ما الذي في واجهة هذا المتجر؟» has a single
 * answer. Published AND shown are two different things: publishing is
 * what makes a page exist for the public, `showInStore` is whether it
 * belongs in the shop window, and a campaign page is deliberately the
 * first without the second.
 */
export async function shownPageProductIds(companyId: string, storeId: string): Promise<Set<string>> {
  const shown = await db.landingPage.findMany({
    where: { companyId, storeId, showInStore: true, isPublished: true },
    select: { productId: true },
  });
  return new Set(shown.map((p) => p.productId).filter((id): id is string => !!id));
}

/**
 * THE SHELF — ONE RULE, ONE FUNCTION, EVERY SURFACE.
 *
 * What this store offers a shopper, wherever the question is asked: the
 * home grid, `/shop`, the search and cards doors, the sitemap, the
 * catalogue block, «يُشترى معه عادةً».
 *
 * ── THE RULE ──
 *
 * A store that has at least one published shown page selling a product
 * has made the switch: its shelf is the products those pages sell, and
 * nothing else. A store that has none keeps exactly the shelf it always
 * had — every active product, as before.
 *
 * ── WHY IT IS ONE FUNCTION ──
 *
 * Stage 1 put this rule inside `storefrontCatalog` alone, so it reached
 * only the `catalog` block of a **published** home page. Every other
 * listing went on reading all active products: the default home grid,
 * `/shop`, the public search and cards APIs, the sitemap. A store without
 * a published home — the owner's own — showed precisely what it had shown
 * before, which is how a shipped rule can be true and invisible at the
 * same time. `storefront-shelf.test.ts` sweeps the source and fails if any
 * surface grows a shelf read of its own again.
 *
 * ── WHY «WITH A PRODUCT» ──
 *
 * A shown page with no product sells nothing, so it cannot put anything
 * on a shelf. Counting it as the switch would empty the store — the one
 * thing the owner's answer ① forbids: «الكتالوج ما بصير يفضى».
 */
export async function storeShelf(
  companyId: string,
  storeId: string,
  limit = 60
): Promise<StorefrontProduct[]> {
  const shown = await shownPageProductIds(companyId, storeId);
  if (shown.size === 0) return storefrontProducts(companyId, storeId, limit);
  return storefrontProducts(companyId, storeId, limit, [...shown]);
}

/**
 * One product of this store, by its SKU.
 *
 * The SKU is the URL because it already exists, is already unique per
 * company and is already URL-safe — a second "slug" column would be one
 * more name for the same thing, and one more place for them to disagree.
 */
/**
 * ONE PRODUCT, BY WHATEVER ADDRESS THE LINK CARRIED.
 *
 * Three of them answer, in this order:
 *   · the readable address it has now,
 *   · one it used to have — because a link that has gone round a family
 *     group keeps being tapped for weeks after a rename, and 404 is the
 *     shop's own advertising going dark,
 *   · the SKU, which is every link that existed before addresses did.
 *
 * The caller compares the `handle` it gets back with the one it was
 * given: when they differ, that link is an old one and the page sends
 * the shopper to the current address permanently. One product, one
 * address, and nothing lost on the way.
 */
export const storefrontProduct = cache(async function storefrontProduct(
  companyId: string,
  storeId: string,
  handle: string
): Promise<(StorefrontProduct & { gallery: string[] }) | null> {
  const now = new Date();
  const p = await db.product.findFirst({
    where: {
      companyId,
      storeId,
      status: 'ACTIVE',
      basePrice: { gt: 0 },
      OR: [
        { slug: handle },
        { sku: handle.toUpperCase() },
        // An address it used to have. The column is a JSON array, so the
        // match is on the quoted string — which is why `isSlug` guards
        // what may ever be written into it.
        { previousSlugs: { contains: `"${handle}"` } },
      ],
    },
    select: {
      id: true, sku: true, name: true, nameEn: true, description: true, image: true, basePrice: true, attributes: true,
      slug: true, previousSlugs: true,
      category: { select: { id: true, name: true, attributeSchema: true } },
      offers: {
        // The same predicate the product page and the order path use. This
        // read spelled `status: 'ACTIVE'` itself, so a bundle that had
        // finished went on setting the per-unit price in the grid.
        where: liveOfferWhere(now),
        select: { quantity: true, freeQuantity: true, sellingPrice: true },
      },
      images: {
        orderBy: [{ isPrimary: 'desc' }, { sortOrder: 'asc' }],
        select: { url: true },
      },
    },
  });
  if (!p) return null;

  const perUnit = p.offers
    .map((o) => {
      const units = o.quantity + o.freeQuantity;
      return units > 0 ? o.sellingPrice / units : o.sellingPrice;
    })
    .filter((n) => n > 0);

  const gallery = publicizeMedia(p.images.map((i) => i.url));

  return {
    id: p.id,
    sku: p.sku,
    name: p.name,
    nameEn: p.nameEn,
    description: p.description,
    image: gallery[0] ?? publicizeMedia(p.image),
    basePrice: p.basePrice,
    fromPrice: perUnit.length ? Math.min(...perUnit) : p.basePrice,
    handle: p.slug || p.sku,
    category: p.category && { id: p.category.id, name: p.category.name },
    attributes: parseProductAttributes(p.attributes, parseCategoryAttributes(p.category?.attributeSchema ?? null)),
    gallery,
  };
});

/**
 * WHAT A `catalog` BLOCK LAYS OUT: this store's pages and products.
 *
 * Read at render time, never stored in the block. A list of ids ticked in
 * the builder would be a second place deciding what is in the shop, and it
 * would be wrong the first time a page was unpublished or a product paused.
 *
 * BOTH KINDS ALWAYS, whatever the block's `source` says. The filtering is
 * the renderer's, so the builder's preview answers the «pages · products ·
 * both» toggle without a round trip — and one query serves a page with two
 * catalogue blocks set differently.
 *
 * A PAGE IS SHOWN ONLY IF IT SAYS SO. `showInStore` is off by default and
 * the page's own screen turns it on: a campaign page is meant to be
 * reachable by its link and nowhere else, and listing every page a store
 * owns would put the half-finished ones in the shop window. Unpublished
 * pages never appear whatever the flag says — the flag is intent, and
 * publishing is the act.
 */
export async function storefrontCatalog(
  companyId: string,
  storeId: string,
  storeSlug: string
): Promise<{ items: CatalogItem[]; categories: { id: string; name: string }[] }> {
  /**
   * ONE CARD PER PRODUCT — ONLY ONCE A SHOWN PAGE EXISTS.
   *
   * A product is in the catalogue if and only if it has at least one
   * published page with `showInStore`. Until the seller's one-press («اعرض
   * كل الصفحات المنشورة») — and while no shown page exists at all — the
   * catalogue below is byte-for-byte what it always was: pages and
   * products side by side. The press flips every published page to shown
   * in a single update, so the switch and the press are one moment, and
   * the store is never empty in between.
   */
  const shownProductIds = await shownPageProductIds(companyId, storeId);

  if (shownProductIds.size > 0) {
    // `storeShelf` reads the same rule again and narrows in the query, so a
    // shown product is never the one cut by the limit. This used to take 60
    // products and filter afterwards.
    const products = await storeShelf(companyId, storeId);
    const seen = new Map<string, string>();
    for (const p of products) if (p.category) seen.set(p.category.id, p.category.name);
    const items: CatalogItem[] = products.map((p) => ({
      id: p.id,
      kind: 'product' as const,
      name: p.name,
      image: p.image,
      // The product's page renders inside the store shell at this address.
      href: `/s/${storeSlug}/p/${p.handle}`,
      price: p.fromPrice,
      categoryId: p.category?.id ?? null,
    }));
    return {
      items: publicizeMedia(items),
      categories: [...seen].map(([id, name]) => ({ id, name })).sort((a, b) => a.name.localeCompare(b.name, 'ar')),
    };
  }

  const [pages, products] = await Promise.all([
    db.landingPage.findMany({
      where: { companyId, storeId, showInStore: true, isPublished: true },
      orderBy: { createdAt: 'desc' },
      take: 60,
      select: {
        id: true, name: true, slug: true,
        product: { select: { image: true, basePrice: true, categoryId: true } },
      },
    }),
    // The direct read and not `storeShelf`: this branch is only reached
    // when the rule has already been asked and answered «no shown page», so
    // going through the shelf would ask the same question a second time for
    // an answer that cannot have changed.
    storefrontProducts(companyId, storeId),
  ]);

  const productRows = await db.product.findMany({
    where: { companyId, storeId, status: 'ACTIVE', categoryId: { not: null } },
    select: { id: true, categoryId: true, category: { select: { id: true, name: true } } },
  });
  const catOf = new Map(productRows.map((p) => [p.id, p.categoryId]));

  /**
   * THE CATEGORIES ARE THIS STORE'S, DERIVED.
   *
   * Not a per-store category table. `Category` is already company-wide and
   * already hangs off the product; a second, store-scoped one would be two
   * tables answering «what kind of thing is this» and they would disagree.
   * A store shows the categories ITS OWN products carry — which is exactly
   * «كل متجر وتصنيفاته» without a fork.
   */
  const seen = new Map<string, string>();
  for (const p of productRows) if (p.category) seen.set(p.category.id, p.category.name);

  const items: CatalogItem[] = [
    // Pages first: the one the seller built on purpose.
    ...pages.map((p) => ({
      id: p.id,
      kind: 'page' as const,
      name: p.name,
      // A page has no picture of its own; the product it sells does.
      image: p.product?.image ?? null,
      // The public landing page route. A store page links to the page the
      // seller built, not to a product card standing in for it.
      href: `/lp/${p.slug}`,
      price: p.product?.basePrice ?? null,
      categoryId: p.product?.categoryId ?? null,
    })),
    ...products.map((p) => ({
      id: p.id,
      kind: 'product' as const,
      name: p.name,
      image: p.image,
      href: `/s/${storeSlug}/p/${p.sku}`,
      price: p.fromPrice,
      categoryId: catOf.get(p.id) ?? null,
    })),
  ];

  return {
    items: publicizeMedia(items),
    categories: [...seen].map(([id, name]) => ({ id, name })).sort((a, b) => a.name.localeCompare(b.name, 'ar')),
  };
}
