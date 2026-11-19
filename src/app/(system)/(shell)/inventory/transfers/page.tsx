import { guardRoute } from '@/lib/page-guard';
import { StockTransfersScreen } from '@/components/screens/StockTransfersScreen';

export default async function Page() {
  await guardRoute('/inventory/transfers');
  return <StockTransfersScreen />;
}
