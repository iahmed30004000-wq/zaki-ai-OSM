import { notFound } from 'next/navigation';
import { VerifyBarcodeView } from '@/components/verify/VerifyBarcodeView';

export const dynamic = 'force-dynamic';

/**
 * «/verify/[id]» — the public authenticity checker.
 *
 * `[id]` is the Store id — not a slug: a slug is unique only per company
 * (`@@unique([companyId, slug])`), and this page has no other way to tell
 * two companies' "main" store apart. The store id is globally unique and is
 * what the public API resolves the company by too.
 *
 * Thin on purpose, like `/lp/[slug]`: validate the one route param's shape
 * and hand off to the view. No auth, no layout/shell — the page itself
 * decides which company's codes a scan checks, nothing upstream of it does.
 */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

interface Props {
  params: Promise<{ id: string }>;
}

export async function generateMetadata() {
  return { title: 'تحقق من أصالة المنتج' };
}

export default async function VerifyBarcodePage({ params }: Props) {
  const { id } = await params;
  if (!UUID.test(id)) notFound();
  return <VerifyBarcodeView storeId={id} />;
}
