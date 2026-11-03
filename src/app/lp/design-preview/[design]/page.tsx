import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { DesignPreview } from '@/components/landing/designs/DesignPreview';

/**
 * /lp/design-preview/<design>?product=<id> — «معاينة كاملة» of one design.
 *
 * The library and the wizard link here (`designPreviewHref` in the catalogue)
 * to show a design over the seller's OWN product, drawn by our blocks. Staff
 * only: it reads a company's product, so it asks for the same permission the
 * editor's preview token asks for (`landing_pages.view`) and answers «not
 * found» to anybody else — a visitor, a seller of another company, nobody
 * learns that the address exists.
 *
 * A preview takes no order (the form is the builder's stand-in), loads no
 * pixel, counts no view, and asks search engines to stay out.
 */
export const dynamic = 'force-dynamic';

export const metadata: Metadata = {
  title: 'معاينة التصميم',
  robots: { index: false, follow: false },
};

interface Props {
  params: Promise<{ design: string }>;
  searchParams: Promise<{ product?: string }>;
}

export default async function DesignPreviewPage({ params, searchParams }: Props) {
  const { design } = await params;
  const { product } = await searchParams;
  if (!/^[a-z0-9-]{1,60}$/.test(design)) notFound();
  return <DesignPreview design={design} productId={product && /^[A-Za-z0-9-]{1,64}$/.test(product) ? product : null} />;
}
