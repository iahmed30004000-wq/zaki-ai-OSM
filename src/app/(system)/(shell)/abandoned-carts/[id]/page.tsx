import { notFound } from 'next/navigation';
import { guardRoute } from '@/lib/page-guard';
import { AbandonedCartDetailScreen } from '@/components/screens/AbandonedCartDetailScreen';

/** A cart's id is a uuid. Anything else was typed into the address bar. */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** «السلة» — one abandoned cart, behind the list's own door (`orders.view`); the API answers 404 for one not hers. */
export default async function Page({ params }: { params: Promise<{ id: string }> }) {
  await guardRoute('/abandoned-carts');
  const { id } = await params;
  if (!UUID.test(id)) notFound();
  return <AbandonedCartDetailScreen id={id} />;
}
