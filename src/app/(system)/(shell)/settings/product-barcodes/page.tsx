import { guardRoute } from '@/lib/page-guard';
import { ProductBarcodesScreen } from '@/components/screens/ProductBarcodesScreen';

export default async function Page() {
  await guardRoute('/settings/product-barcodes');
  return <ProductBarcodesScreen />;
}
