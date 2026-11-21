import { guardRoute } from '@/lib/page-guard';
import { StockCountsScreen } from '@/components/screens/StockCountsScreen';

export default async function Page() {
  await guardRoute('/inventory/counts');
  return <StockCountsScreen />;
}
