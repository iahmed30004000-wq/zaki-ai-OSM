import Link from 'next/link';
import { notFound } from 'next/navigation';
import type { Metadata } from 'next';
import { storeShelf } from '@/lib/storefront';
import { getShopView } from '@/lib/shop-view';
import { StorefrontShell } from '@/components/storefront/StorefrontShell';
import { publicTitle, storeIcons } from '@/lib/public-metadata';
import { parseSynonyms, searchProducts } from '@/lib/store-search';
import { bestSellers } from '@/lib/store-facts';
import { facetsFor, parseCategoryAttributes } from '@/lib/product-attributes';
import { FilterSheet } from '@/components/storefront/FilterSheet';
import { ProductCard } from '@/components/storefront/ProductCard';
import { CategoryNav } from '@/components/storefront/CategoryNav';
import { layoutOf } from '@/lib/store-theme';
import { SORTS, SORT_LABEL_AR, catalogPage, type Sort } from '@/lib/catalog-query';
import { moneyText } from '@/lib/money';
import { db } from '@/lib/db';

/**
 * THE SHELF — BROWSING, A CATEGORY, AND A SEARCH, ON ONE PAGE.
 *
 * Three of the brief's pages, and they are one screen with different
 * inputs: «الفئة أو المجموعة» is this page with `?cat=`, «نتائج البحث» is
 * this page with `?q=`. Building them separately would be three grids, and
 * the third one written would be the one that forgets the sort, or the
 * «عرض المزيد», or that a price filter compares the price on the card.
 *
 * IT IS RENDERED ON THE SERVER AND «عرض المزيد» IS A LINK. No script has
 * to run for a shopper to see the shelf or to reach the second page of it
 * — which is the cheapest possible thing on a mid-range Android, and it
 * leaves the footer reachable, where the shop's phone number lives.
 *
 * THE SEARCH IS `searchProducts`, and the sort and the paging are
 * `catalogPage`. Neither is re-implemented here: this file reads the query
 * string and draws what they answer.
 */
export const dynamic = 'force-dynamic';

interface Props {
  params: Promise<{ store: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}

const SLUG = /^[a-z0-9-]{2,60}$/;

const one = (v: string | string[] | undefined): string =>
  (Array.isArray(v) ? v[0] : v)?.slice(0, 80) ?? '';

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { store: slug } = await params;
  const store = SLUG.test(slug) ? await getShopView(slug) : null;
  if (!store) return { title: 'غير متاح' };
  return { title: publicTitle('المتجر', store.name), icons: storeIcons(store) };
}

export default async function ShopPage({ params, searchParams }: Props) {
  const { store: slug } = await params;
  if (!SLUG.test(slug)) notFound();
  const store = await getShopView(slug);
  if (!store) notFound();

  const sp = await searchParams;
  const q = one(sp.q).trim();
  const cat = one(sp.cat);
  const sortAsked = one(sp.sort);
  const sort: Sort | undefined = (SORTS as readonly string[]).includes(sortAsked)
    ? (sortAsked as Sort)
    : undefined;
  const page = Math.max(1, Math.trunc(Number(one(sp.page))) || 1);

  /**
   * The narrowings, as `attr_<key>=a,b`.
   *
   * In the address rather than in a form's state so that a narrowed shelf
   * is a page: bookmarkable, sendable, and behind the back button. That is
   * also what lets the whole grid render on the server.
   */
  const chosen: Record<string, string[]> = {};
  for (const [k, v] of Object.entries(sp)) {
    if (!k.startsWith('attr_')) continue;
    const picked = one(v)
      .split(',')
      .map((x) => x.trim())
      .filter(Boolean);
    if (picked.length) chosen[k.slice(5)] = picked;
  }

  const [all, country, vocabulary, sales] = await Promise.all([
    storeShelf(store.companyId, store.id),
    db.country.findUnique({ where: { id: store.countryId }, select: { currencyCode: true, minorUnit: true } }),
    db.store
      .findFirst({ where: { id: store.id }, select: { searchSynonyms: true } })
      .then((r) => parseSynonyms(r?.searchSynonyms)),
    bestSellers(db, { companyId: store.companyId, storeId: store.id }),
  ]);

  // A search narrows the shelf before anything else touches it, so the
  // category chips and the sort act on what was found.
  const found = q ? searchProducts(all, q, { synonyms: vocabulary, limit: all.length }).map((h) => h.product) : all;

  /**
   * «الأكثر مبيعاً» IS OFFERED ONLY WHEN IT IS TRUE.
   *
   * `bestSellers` returns an empty map for a shop that has not delivered
   * five of anything, and `catalogPage` reads that as «cannot prove it»
   * and writes «مختارات» over the grid. The control itself is hidden in
   * that case rather than shown and quietly downgraded: a button that
   * cannot do what it says is worse than no button, and the shopper has
   * no way to tell which they got.
   */
  const canRank = sales.size > 0;
  const shelf = catalogPage(
    found,
    { categoryId: cat || null, sort, page, perPage: 24, attributes: chosen },
    sales
  );

  /**
   * NARROWINGS ARE OFFERED ONLY INSIDE A CATEGORY.
   *
   * The questions belong to the category, so a shelf showing three of them
   * at once has no single set to ask. Merging them would offer «المقاس»
   * over a row of eye drops — a filter that empties the grid, which is the
   * dead end `facetsFor` exists to avoid.
   *
   * Computed from the products in this category BEFORE the attribute
   * narrowing, so ticking one option does not delete the others from the
   * sheet the shopper is standing in.
   */
  const inCategory = cat ? found.filter((p) => p.category?.id === cat) : [];
  const schema = cat
    ? await db.category.findFirst({
        // Through the company, and only a category this shelf is showing:
        // a category id in a query string is a foreign key anybody can type.
        where: { id: cat, companyId: store.companyId },
        select: { attributeSchema: true },
      })
    : null;
  const facets = facetsFor(
    parseCategoryAttributes(schema?.attributeSchema ?? null),
    inCategory.map((p) => ({ attributes: p.attributes }))
  );

  const categories = [...new Map(all.flatMap((p) => (p.category ? [[p.category.id, p.category]] : []))).values()];
  const money = (v: number) => moneyText(v, country?.currencyCode ?? null, country?.minorUnit ?? 2);
  const href = (over: Record<string, string>) => {
    const next = new URLSearchParams();
    if (q) next.set('q', q);
    if (cat) next.set('cat', cat);
    if (sortAsked) next.set('sort', sortAsked);
    // The narrowings ride along, so changing the sort does not silently
    // drop them — which would look to the shopper like the shelf forgot.
    for (const [k, picked] of Object.entries(chosen)) next.set(`attr_${k}`, picked.join(','));
    for (const [k, v] of Object.entries(over)) {
      if (v) next.set(k, v);
      else next.delete(k);
    }
    const s = next.toString();
    return `/s/${store.slug}/shop${s ? `?${s}` : ''}`;
  };

  /** This option on, or off if it was already on. Always back to page one. */
  const toggle = (key: string, value: string) => {
    const picked = chosen[key] ?? [];
    const next = picked.includes(value) ? picked.filter((v) => v !== value) : [...picked, value];
    return href({ [`attr_${key}`]: next.join(','), page: '' });
  };

  /**
   * A DIFFERENT SHELF, SO NO NARROWINGS.
   *
   * The questions belong to the category. Carrying «المقاس» from the
   * shelf a shopper just left would narrow the new one by a question it
   * was never asked — and the grid would come back short for a reason
   * nothing on the page explains. «الكل» is the same move with no
   * category at all.
   */
  const categoryHref = (id: string) => {
    const next = new URLSearchParams();
    if (q) next.set('q', q);
    if (id) next.set('cat', id);
    if (sortAsked) next.set('sort', sortAsked);
    const s = next.toString();
    return `/s/${store.slug}/shop${s ? `?${s}` : ''}`;
  };

  /** Everything except the narrowings — the category and search survive. */
  const clearFilters = () => {
    const keep = new URLSearchParams();
    if (q) keep.set('q', q);
    if (cat) keep.set('cat', cat);
    if (sortAsked) keep.set('sort', sortAsked);
    const s = keep.toString();
    return `/s/${store.slug}/shop${s ? `?${s}` : ''}`;
  };

  /**
   * THE SHEET IS HANDED ADDRESSES, NOT A FUNCTION THAT MAKES THEM.
   *
   * A server component cannot pass a function to a client one — the
   * first version did and the page did not render at all. Working them
   * out here is better than what it replaced: every address is built
   * beside the rest of the query-string logic, and the sheet knows
   * nothing about how a narrowing is spelled.
   */
  const sheetFacets = facets.map((f) => ({
    key: f.key,
    label: f.label,
    kind: f.kind,
    unit: f.unit,
    range: f.range,
    options: f.options.map((o) => ({
      value: o.value,
      count: o.count,
      href: toggle(f.key, o.value),
      on: (chosen[f.key] ?? []).includes(o.value),
    })),
  }));
  const narrowings = Object.values(chosen).reduce((n, v) => n + v.length, 0);

  return (
    <StorefrontShell store={store} back={{ href: `/s/${store.slug}`, label: store.name }}>
      <article className="sf-page">
        <h1>{q ? `نتائج البحث عن «${q}»` : 'المتجر'}</h1>

        <CategoryNav
          categories={categories}
          activeId={cat || null}
          hrefFor={categoryHref}
          variant={layoutOf(store.theme, 'categoryNav')}
        />

        <nav aria-label="التصفية والترتيب" className="flex flex-wrap gap-2">
          <FilterSheet facets={sheetFacets} clearHref={clearFilters()} active={narrowings} />
          {([...(canRank ? (['bestSelling'] as const) : []), 'newest', 'priceAsc', 'priceDesc'] as const).map((s) => (
            <Link key={s} href={href({ sort: s, page: '' })} className="sf-chip" aria-current={shelf.sort === s || undefined}>
              {SORT_LABEL_AR[s]}
            </Link>
          ))}
        </nav>

        {shelf.total === 0 ? (
          <p>
            {q ? 'لم نجد منتجاً بهذا الاسم.' : 'لا توجد منتجات معروضة الآن.'}{' '}
            <Link href={`/s/${store.slug}/shop`}>اعرض كل المنتجات</Link>
          </p>
        ) : (
          <>
            <p className="sf-count">{shelf.total} منتج</p>
            {/*
              THE CATEGORY PAGE'S DENSITY — the slot that was declared,
              validated, offered to the seller and chosen by all ten
              skins, and read by no renderer at all, so every shop's
              category page looked the same. This is the renderer.
            */}
            <div className="sf-grid" data-catpage={layoutOf(store.theme, 'categoryPage')}>
              {shelf.items.map((p) => (
                <ProductCard
                  key={p.id}
                  slug={store.slug}
                  product={p}
                  currency={country?.currencyCode ?? null}
                  minorUnit={country?.minorUnit ?? 2}
                  variant={layoutOf(store.theme, 'productCard')}
                />
              ))}
            </div>

            {shelf.hasMore && (
              // A link, not an infinite scroll: lighter on a weak phone, and
              // the footer stays reachable.
              <p>
                <Link href={href({ page: String(page + 1) })} className="sf-more">
                  عرض المزيد
                </Link>
              </p>
            )}
          </>
        )}
      </article>
    </StorefrontShell>
  );
}
