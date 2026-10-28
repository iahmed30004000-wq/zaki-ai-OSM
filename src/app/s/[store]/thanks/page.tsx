import Link from 'next/link';
import { notFound } from 'next/navigation';
import type { Metadata } from 'next';
import { getStorefront } from '@/lib/storefront';
import { StorefrontShell } from '@/components/storefront/StorefrontShell';
import { CartThankYouOffer } from '@/components/storefront/CartThankYouOffer';
import { LandingTrackingPixels } from '@/components/tracking/LandingTrackingPixels';
import { getTrackingPixelsForPage } from '@/lib/tracking/tracking-config';
import { publicTitle, storeIcons } from '@/lib/public-metadata';
import { WHAT_HAPPENS_NEXT_AR } from '@/lib/order-tracking';
import { checkoutForPage } from '@/lib/store-theme';

/**
 * THE ORDER WENT THROUGH.
 *
 * THE REFERENCE IS ECHOED, NEVER LOOKED UP. This page is handed the order
 * number by the checkout it came from and prints it back. It does not ask
 * the database whether that order exists — and it must not: a page that
 * answered differently for a real reference than for a made-up one would
 * be an oracle for «does this order number exist», which is the one thing
 * the tracking route is carefully built not to be. Nothing here is worth
 * anything to somebody who typed a reference into the address bar.
 *
 * AND THE PROMISE IS THE SAME ONE THE TRACKING PAGE MAKES.
 * `WHAT_HAPPENS_NEXT_AR` is written once, because a thank-you page that
 * says one thing and a tracking page that says another is a shop
 * contradicting itself between two screens the same customer opens four
 * minutes apart.
 *
 * The store's pixels load here for the page view — the same pixel
 * component the rest of the public side uses, never a second script. The
 * sale itself was reported by the checkout, which had the server's amount;
 * this page has only a reference it may not look up.
 *
 * AND «العرض بعد الطلب» IS THE CUSTOMER'S OWN, FROM THEIR OWN TAB.
 * `CartThankYouOffer` reads what the checkout kept in this tab's session
 * storage for THIS reference — the offer, its window and the signed token —
 * and draws the same card every other door draws. The page still asks
 * nothing about the reference: a reference typed into the address bar finds
 * no entry in the tab, and the page is exactly the page it was.
 */
export const dynamic = 'force-dynamic';

interface Props {
  params: Promise<{ store: string }>;
  searchParams: Promise<{ o?: string }>;
}

const SLUG = /^[a-z0-9-]{2,60}$/;
/** Shaped like a reference, and printed only when it is. */
const REFERENCE = /^[A-Za-z0-9-]{3,40}$/;

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { store: storeSlug } = await params;
  const store = SLUG.test(storeSlug) ? await getStorefront(storeSlug) : null;
  if (!store) return { title: 'غير متاح' };
  return {
    title: publicTitle('تم استلام طلبك', store.name),
    icons: storeIcons(store),
    // A confirmation belongs to one customer and to no index.
    robots: { index: false, follow: false },
  };
}

export default async function ThanksPage({ params, searchParams }: Props) {
  const { store: storeSlug } = await params;
  if (!SLUG.test(storeSlug)) notFound();
  const store = await getStorefront(storeSlug);
  if (!store) notFound();

  const { o } = await searchParams;
  const reference = o && REFERENCE.test(o) ? o : null;
  const pixels = await getTrackingPixelsForPage(store.companyId, 'PUBLIC', {
    storeId: store.id,
    countryId: store.countryId,
  });
  // «رسالة ما بعد الطلب» from the shop's «الدفع» (its LIVE theme) — the line its landing forms say too. None set:
  // the line this page always had.
  const thanks = checkoutForPage(store.theme).thanksMessage || 'تم استلام طلبك';

  return (
    <StorefrontShell store={store} back={{ href: `/s/${store.slug}`, label: store.name }}>
      <LandingTrackingPixels page="PUBLIC" pixels={pixels} viewContent={null} />
      <article className="sf-page">
        <h1>{thanks}</h1>

        {reference && (
          <p
            className="px-4 py-3 text-base font-bold"
            style={{
              background: 'var(--store-accent-tint)',
              border: '1px solid var(--store-accent-border)',
              borderRadius: 'var(--store-radius)',
            }}
          >
            رقم طلبك: <bdi dir="ltr">{reference}</bdi>
          </p>
        )}

        <ul>
          {WHAT_HAPPENS_NEXT_AR.map((line) => (
            <li key={line}>{line}</li>
          ))}
        </ul>

        <p>
          {/*
            The reference is NOT carried into this link. Tracking needs the
            phone as well, and prefilling half of the pair from a URL would
            put the other half one guess away for anybody who saw the link.
          */}
          <Link href={`/s/${store.slug}/track`}>تتبّع الطلب</Link>
          {' · '}
          <Link href={`/s/${store.slug}`}>العودة إلى المتجر</Link>
        </p>
      </article>
      {reference && <CartThankYouOffer reference={reference} />}
    </StorefrontShell>
  );
}
