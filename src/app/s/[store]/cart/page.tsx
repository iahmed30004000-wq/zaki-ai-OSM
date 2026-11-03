import { notFound } from 'next/navigation';
import type { Metadata } from 'next';
import { db } from '@/lib/db';
import { getShopView } from '@/lib/shop-view';
import { StorefrontShell } from '@/components/storefront/StorefrontShell';
import { CartView } from '@/components/storefront/CartView';
import { publicTitle, storeIcons } from '@/lib/public-metadata';
import { cartBarApplies } from '@/lib/store-theme';

/**
 * THE BASKET.
 *
 * A SINGLE_PRODUCT shop has no cart — `cartBarApplies` is the one place
 * that is decided, and the page is ABSENT there rather than empty, because
 * such a shop sells its one product from its own page.
 *
 * Nothing about the basket is read here: it lives on the device, and the
 * client asks `/quote` what it costs. So this page is the same for every
 * visitor and reveals nothing about any of them.
 */
export const dynamic = 'force-dynamic';

interface Props {
  params: Promise<{ store: string }>;
}

const SLUG = /^[a-z0-9-]{2,60}$/;

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { store: slug } = await params;
  const store = SLUG.test(slug) ? await getShopView(slug) : null;
  if (!store) return { title: 'غير متاح' };
  return {
    title: publicTitle('السلة', store.name),
    icons: storeIcons(store),
    robots: { index: false, follow: false },
  };
}

export default async function CartPage({ params }: Props) {
  const { store: slug } = await params;
  if (!SLUG.test(slug)) notFound();
  const store = await getShopView(slug);
  if (!store || !cartBarApplies(store.type)) notFound();

  const country = await db.country.findUnique({
    where: { id: store.countryId },
    select: { minorUnit: true },
  });

  return (
    <StorefrontShell store={store} back={{ href: `/s/${store.slug}`, label: store.name }}>
      <article className="sf-page">
        <h1>السلة</h1>
        <CartView slug={store.slug} minorUnit={country?.minorUnit ?? 2} />
      </article>
    </StorefrontShell>
  );
}
