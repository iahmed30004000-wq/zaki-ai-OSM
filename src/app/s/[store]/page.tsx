import { LandingTrackingPixels } from '@/components/tracking/LandingTrackingPixels';
import { getTrackingPixelsForPage } from '@/lib/tracking/tracking-config';
import { notFound, redirect } from 'next/navigation';
import { LandingPageView } from '@/components/landing/LandingPageView';
import { carryQuery } from '@/lib/query-string';
import Link from 'next/link';
import { db } from '@/lib/db';
import { getStorefront, storeShelf, storefrontCatalog } from '@/lib/storefront';
import { parseSections } from '@/lib/landing-sections';
import { paletteFor } from '@/lib/landing-theme';
import { publicizeMedia } from '@/lib/public-media';
import { PageBlocks } from '@/components/landing/blocks/PageBlocks';
import { StorefrontShell } from '@/components/storefront/StorefrontShell';
import { ProductCard } from '@/components/storefront/ProductCard';
import { StoreHero } from '@/components/storefront/StoreHero';
import { CategoryNav } from '@/components/storefront/CategoryNav';
import { BrandWhy } from '@/components/storefront/BrandWhy';
import { FAMILY_HERO_SHEET } from '@/components/storefront/styles';
import { familyOf, layoutOf } from '@/lib/store-theme';
import type { Metadata } from 'next';
import { publicTitle, storeIcons } from '@/lib/public-metadata';
import { sortFacts } from '@/lib/store-looks/sort-facts';

/**
 * A store's front door — no login, no session, no cookies.
 *
 * A Single Product store IS its front page: the landing page the seller
 * picked, rendered right here at the store's address (and its domain) with
 * everything the page has. Rendered, not redirected — a redirect lost the
 * ?c= campaign code, and with it the credit for every sale an ad brought.
 * Until a page is picked it behaves as any store: its one product's page,
 * or its list. A shop with many products lists them — its own, and only
 * its own.
 */
export const dynamic = 'force-dynamic';

interface Props {
  params: Promise<{ store: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}

export async function generateMetadata({ params }: Pick<Props, 'params'>): Promise<Metadata> {
  const { store: slug } = await params;
  const store = /^[a-z0-9-]{2,60}$/.test(slug) ? await getStorefront(slug) : null;
  if (!store) return {};
  return { title: publicTitle(store.name, store.tagline), icons: storeIcons(store) };
}

export default async function StorefrontHome({ params, searchParams }: Props) {
  const { store: slug } = await params;
  if (!/^[a-z0-9-]{2,60}$/.test(slug)) notFound();

  const store = await getStorefront(slug);
  if (!store) notFound();

  // ── A home page the seller built and PUBLISHED wins ──
  //
  // Read before the single-product branch below, because a seller who has
  // published a shop home has said what they want their address to open:
  // the shop, with its pages inside it. Until they publish one, nothing
  // changes — the front page still renders here exactly as it did.
  const home = parseSections(store.homeLive).filter((s) => s.enabled);

  if (store.type === 'SINGLE_PRODUCT' && home.length === 0) {
    if (store.landingPageId) {
      const { c } = await searchParams;
      return (
        <LandingPageView
          target={{ frontPageId: store.landingPageId, storeId: store.id, campaign: typeof c === 'string' ? c : undefined }}
        />
      );
    }
    // No front page picked yet: with one product, that product's page (the
    // campaign code carried along); otherwise the store's own products, as
    // any store shows them, until a front page is picked. A store that was
    // open before front pages existed must not go dark on the day they did.
    // THE SHELF and not every active product: in a store that has made
    // the switch, «how many things does this shop offer» has to mean the
    // same here as on the grid below, or a shop with one shown page among
    // twenty products would refuse to open on it.
    const only = await storeShelf(store.companyId, store.id, 2);
    if (only.length === 1) redirect(`/s/${store.slug}/p/${only[0].sku}${carryQuery(await searchParams)}`);
  }

  const pixelsForHome = await getTrackingPixelsForPage(store.companyId, 'PUBLIC', {
    storeId: store.id,
    countryId: store.countryId,
  });

  // ── A home page the seller built ──
  // Only what was PUBLISHED: the draft is the seller's own workbench, and a
  // half-finished page must never be what a customer opens. Drawn by the
  // SAME renderer the builder previews with, so what they approved is what
  // ships. A shop that has published nothing keeps the product list it
  // always had.
  if (home.length > 0) {
    /**
     * THE CATALOGUE'S CONTENTS, READ ONLY IF SOMETHING ASKS FOR THEM.
     *
     * A home page of a hero and a footer must not pay for two queries it
     * never renders, so this is fetched when a `catalog` block is actually
     * on the page.
     */
    const wantsCatalog = home.some((b) => b.type === 'catalog');
    const shelf = wantsCatalog
      ? await storefrontCatalog(store.companyId, store.id, store.slug)
      : null;
    // A row of a home design that is sorted asks two more facts of its
    // products — when each was added, and what this shop delivered — and
    // only such a row: a home whose blocks never chose an order reads
    // nothing more than it always did.
    const catalogue = shelf ? await sortFacts(shelf, home, { companyId: store.companyId, storeId: store.id }) : null;

    // The shopper's chosen category, from the query string. A link and a
    // server render rather than client state: this page is a server
    // component, and a shopper with no JavaScript still gets to browse.
    const { cat } = await searchParams;
    const activeCategory =
      typeof cat === 'string' && catalogue?.categories.some((c) => c.id === cat) ? cat : null;

    return (
      <StorefrontShell store={store}>
        <LandingTrackingPixels page="PUBLIC" pixels={pixelsForHome} viewContent={null} />
        {/*
          The block stylesheet was inlined HERE as well, inside a
          `StorefrontShell` that already inlines it — so any shop that had
          actually built a home page served 25 KB of identical CSS twice,
          on the one page that matters most for how fast the shop feels.
          The shell is the owner; this was the copy.
        */}
        <PageBlocks
          // Stored images are linked privately by the builder; a shopper has
          // no session, so they are made public for this render.
          sections={publicizeMedia(home, { via: store.id })}
          ctx={{
            palette: paletteFor(store.theme),
            productName: store.name,
            price: 0,
            currency: store.currencyCode,
            stock: null,
            offers: [],
            // A home page sells nothing directly: the order form belongs to a
            // product's page and to a landing page, where there is something
            // to order. A form block here renders as nothing rather than as a
            // form that cannot say what it is buying.
            form: null,
            store: { name: store.name, logo: store.logo, phone: store.supportPhone },
            catalog: catalogue
              ? {
                  ...catalogue,
                  activeCategory,
                  // Back to the same address with one parameter changed:
                  // nothing else about where the shopper is gets lost.
                  categoryHref: (id: string | null) =>
                    id ? `/s/${store.slug}?cat=${encodeURIComponent(id)}` : `/s/${store.slug}`,
                }
              : null,
          }}
        />
      </StorefrontShell>
    );
  }

  const products = await storeShelf(store.companyId, store.id);

  /**
   * The country's own minor unit, for the one formatter.
   *
   * This page used to write prices with a `toLocaleString` of its own —
   * a fifth way to spell an amount, two decimals wherever the country
   * says otherwise. `ProductCard` goes through `moneyText` like every
   * other surface.
   */
  // The categories this shop's own products carry — derived, like the
  // catalogue block's, never a per-store table.
  const categories = [
    ...new Map(products.flatMap((p) => (p.category ? [[p.category.id, p.category] as const] : []))).values(),
  ];

  const minorUnit =
    (await db.country.findUnique({ where: { id: store.countryId }, select: { minorUnit: true } }))
      ?.minorUnit ?? 2;

  return (
    <StorefrontShell store={store}>
      <LandingTrackingPixels page="PUBLIC" pixels={pixelsForHome} viewContent={null} />
      {/*
        THE FIRST SCREEN SHOWS SOMETHING TO BUY.
        It was `<h1>{store.tagline || store.name}</h1>` — the shop's name,
        alone, under a header already carrying the name and the tagline.
        «اسم المتجر مكرر ثلاث مرات بأول شاشة؛ البطل ضايع على الاسم» and
        «أول شاشة ما فيها منتج ولا عرض ولا فئة» are the brief's own words
        for that screen.

        The tagline stays when there IS one — it says what the shop sells,
        which the name usually does not. The bare name never does: the
        header has it, the tab title has it, and a third telling sells
        nothing.
      */}
      {/*
        THE FIRST SCREEN THE TEMPLATE ACTUALLY PICKED.

        This was `{store.tagline && <section className="sf-hero">…}` — one
        fixed shape, and nothing at all for a shop that had left the
        tagline empty. Meanwhile «القوالب» drew five different first
        screens in its preview and let the seller choose between them, and
        `layoutOf(theme, 'hero')` was called nowhere in the storefront. The
        seller picked, saved, opened their shop, and got a sixth thing.

        `StoreHero` is the one component the gallery now draws too, so the
        promise and the delivery cannot drift apart again.
      */}
      {/*
        THE FIRST SCREEN'S OWN RULES, ON THE ONLY PAGE THAT DRAWS ONE.

        A family's hero is between one and two kilobytes of stylesheet,
        and no other page in the shop matches a line of it. Measured: the
        shop ships 43.9 KB of base against a 50 KB budget, so a product
        page carrying the home's hero was two kilobytes it could not
        afford for rules it never used. The shell still carries the
        family's shop-wide half — the card, the rhythm, the ornament.
      */}
      <style dangerouslySetInnerHTML={{ __html: FAMILY_HERO_SHEET[familyOf(store.theme)] }} />
      <StoreHero
        variant={layoutOf(store.theme, 'hero')}
        tagline={store.tagline}
        about={store.about}
        slug={store.slug}
        currency={store.currencyCode}
        minorUnit={minorUnit}
        products={products}
        categories={categories}
      />

      <CategoryNav
        categories={categories}
        activeId={null}
        hrefFor={(id) => (id ? `/s/${store.slug}/shop?cat=${encodeURIComponent(id)}` : `/s/${store.slug}/shop`)}
        variant={layoutOf(store.theme, 'categoryNav')}
      />

      {/*
        «ليش تطلب عنّا» — «علامة»'s own row, and only on the page nobody
        arranged.

        The owner's ruling of 15/10: «a theme/template changes the LOOK.
        It never changes the ARRANGEMENT of anything a person arranged.»
        A shop that has PUBLISHED a home page returns far above this line,
        drawing the seller's own blocks in the order the seller put them —
        so nothing here can reorder, insert into or push anything out of
        it. This is the default front page, which nobody has arranged, and
        the row is part of what the family looks like there.
      */}
      {familyOf(store.theme) === 'brand' && (
        <BrandWhy discreetPacking={store.theme.discreetPacking === true} />
      )}

      {products.length === 0 ? (
        <p className="sf-empty">لا منتجات معروضة حالياً.</p>
      ) : (
        <div className="sf-grid-wrap">
          <div className="sf-grid">
            {products.map((p) => (
              <ProductCard
                key={p.id}
                slug={store.slug}
                product={p}
                currency={store.currencyCode}
                minorUnit={minorUnit}
                variant={layoutOf(store.theme, 'productCard')}
              />
            ))}
          </div>
        </div>
      )}
    </StorefrontShell>
  );
}
