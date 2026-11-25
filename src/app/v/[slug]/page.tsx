import { notFound, permanentRedirect } from 'next/navigation';
import { ProductVerifyView } from '@/components/verify/ProductVerifyView';
import { lookupBySlug } from '@/lib/product-verify';
import { PRODUCT_CODE_PARAM } from '@/lib/product-verify-design';

export const dynamic = 'force-dynamic';

/**
 * «/v/<slug>» — ONE PRODUCT'S OWN AUTHENTICITY PAGE, AT ITS SHORT ADDRESS (25/11, owner).
 *
 * The product's barcode is this link; a piece's QR is the same link with `?code=…`, and the page checks that code by
 * itself. Three answers, decided by `lookupBySlug`:
 *   - the current slug of an active page → the page;
 *   - a slug the page USED to have → a permanent (308) redirect to the current one, the query carried along — a
 *     barcode printed before the owner shortened the link keeps working, for ever;
 *   - anything else (unknown, or the page switched off) → 404, the same for both.
 * No session, no shell: the page decides which company's codes a scan checks; nothing upstream of it does.
 */
interface Props {
  params: Promise<{ slug: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}

export async function generateMetadata({ params }: Props) {
  const { slug } = await params;
  const found = await lookupBySlug(slug);
  return {
    title: found.kind === 'page' ? `${found.design.name} — تحقق من الأصالة` : 'تحقق من أصالة المنتج',
    robots: { index: false },
  };
}

export default async function ProductVerifyPage({ params, searchParams }: Props) {
  const { slug } = await params;
  const query = await searchParams;
  const found = await lookupBySlug(slug);

  if (found.kind === 'moved') {
    const qs = new URLSearchParams();
    for (const [k, v] of Object.entries(query)) {
      for (const one of Array.isArray(v) ? v : v === undefined ? [] : [v]) qs.append(k, one);
    }
    const tail = qs.toString();
    permanentRedirect(`/v/${found.slug}${tail ? `?${tail}` : ''}`);
  }
  if (found.kind !== 'page') notFound();

  const raw = query[PRODUCT_CODE_PARAM];
  const initialCode = typeof raw === 'string' && raw.trim() ? raw.slice(0, 1000) : undefined;
  // The overscroll beyond the page wears the page's own background — a validated `#rrggbb`, nothing else reaches here.
  const bg = found.design.backgroundColor;
  return (
    <>
      <style>{`html,body{background:${bg}}`}</style>
      <ProductVerifyView design={found.design} publicId={found.page.publicId} initialCode={initialCode} />
    </>
  );
}
