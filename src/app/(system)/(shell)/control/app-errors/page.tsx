import { guardRoute } from '@/lib/page-guard';
import { AppErrorsScreen } from '@/components/screens/AppErrorsScreen';

export default async function Page() {
  await guardRoute('/control/app-errors');
  return <AppErrorsScreen />;
}
