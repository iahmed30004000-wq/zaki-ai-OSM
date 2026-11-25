import { notFound, permanentRedirect } from 'next/navigation';
import { slugForPublicId } from '@/lib/product-verify';
import { PRODUCT_CODE_PARAM } from '@/lib/product-verify-design';

export const dynamic = 'force-dynamic';

/**
 * «/verify/p/<publicId>» — the STABLE address of a product's page: the random public id never changes, whatever the
 * owner does to the short link. It answers a permanent redirect to `/v/<current slug>` (with the piece's `?code=` if
 * one came), so a link made from the id keeps opening the page. Unknown or switched-off → 404.
 */
interface Props {
  params: Promise<{ publicId: string }>;
  searchParams: Promise<{ code?: string | string[] }>;
}

export default async function ProductVerifyByIdPage({ params, searchParams }: Props) {
  const { publicId } = await params;
  const slug = await slugForPublicId(publicId);
  if (!slug) notFound();
  const { code } = await searchParams;
  const one = typeof code === 'string' && code.trim() ? code.slice(0, 1000) : null;
  permanentRedirect(`/v/${slug}${one ? `?${PRODUCT_CODE_PARAM}=${encodeURIComponent(one)}` : ''}`);
}
