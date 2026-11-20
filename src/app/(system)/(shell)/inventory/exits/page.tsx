import { guardRoute } from '@/lib/page-guard';
import { StockExitsScreen } from '@/components/screens/StockExitsScreen';

export default async function Page() {
  await guardRoute('/inventory/exits');
  return <StockExitsScreen />;
}
