import { guardRoute } from '@/lib/page-guard';
import { AbandonedCartsScreen } from '@/components/screens/AbandonedCartsScreen';

export default async function Page() {
  await guardRoute('/abandoned-carts');
  return <AbandonedCartsScreen />;
}
