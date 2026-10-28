import { notFound } from 'next/navigation';
import type { Metadata } from 'next';
import { db } from '@/lib/db';
import { getStorefront } from '@/lib/storefront';
import { StorefrontShell } from '@/components/storefront/StorefrontShell';
import { CheckoutForm } from '@/components/storefront/CheckoutForm';
import { LandingTrackingPixels } from '@/components/tracking/LandingTrackingPixels';
import { getTrackingPixelsForPage } from '@/lib/tracking/tracking-config';
import { publicTitle, storeIcons } from '@/lib/public-metadata';
import { cartBarApplies, checkoutForPage } from '@/lib/store-theme';
import { WHAT_HAPPENS_NEXT_AR } from '@/lib/order-tracking';

/**
 * ONE PAGE, NO ACCOUNT, NO EMAIL, NO PASSWORD.
 *
 * THE FIELDS COME FROM THE SHOP. Which show, in what order, which are
 * required, the button's words and its colour are `checkoutForPage` — the
 * seller's own «الدفع», read from the LIVE theme, the same one answer every
 * public form and every public door take. A list written here would be a
 * second answer to «what does this shop ask for», and the tab would stop
 * meaning anything the day the two drifted.
 *
 * THE CITIES ARE THIS COUNTRY'S. The same `Region` rows the order path
 * validates against, in the same order — so a shopper cannot pick a city
 * the server will refuse, which is a rejection nobody can act on.
 */
export const dynamic = 'force-dynamic';

interface Props {
  params: Promise<{ store: string }>;
}

const SLUG = /^[a-z0-9-]{2,60}$/;

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { store: slug } = await params;
  const store = SLUG.test(slug) ? await getStorefront(slug) : null;
  if (!store) return { title: 'غير متاح' };
  return {
    title: publicTitle('إتمام الطلب', store.name),
    icons: storeIcons(store),
    robots: { index: false, follow: false },
  };
}

export default async function CheckoutPage({ params }: Props) {
  const { store: slug } = await params;
  if (!SLUG.test(slug)) notFound();
  const store = await getStorefront(slug);
  if (!store || !cartBarApplies(store.type)) notFound();

  // The checkout is where the sale is reported, so the store's pixels are here even for a visitor who opened it first.
  const [country, regions, pixels] = await Promise.all([
    db.country.findUnique({ where: { id: store.countryId }, select: { minorUnit: true } }),
    db.region.findMany({
      where: { countryId: store.countryId, isActive: true },
      select: { name: true },
      orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }],
    }),
    getTrackingPixelsForPage(store.companyId, 'PUBLIC', { storeId: store.id, countryId: store.countryId }),
  ]);

  const theme = store.theme;
  const checkout = checkoutForPage(theme);

  return (
    <StorefrontShell store={store} back={{ href: `/s/${store.slug}/cart`, label: 'السلة' }}>
      <LandingTrackingPixels page="PUBLIC" pixels={pixels} viewContent={null} />
      <article className="sf-page">
        <h1>إتمام الطلب</h1>
        <ul>
          {WHAT_HAPPENS_NEXT_AR.map((line) => (
            <li key={line}>{line}</li>
          ))}
        </ul>
        <CheckoutForm
          slug={store.slug}
          minorUnit={country?.minorUnit ?? 2}
          fields={checkout.fields}
          required={checkout.required}
          regions={regions.map((r) => r.name)}
          submitText={checkout.submitText || 'أرسل الطلب'}
          buttonVars={checkout.buttonVars}
        />
      </article>
    </StorefrontShell>
  );
}
