import { guardRoute } from '@/lib/page-guard';
import { WinbackListScreen } from '@/components/screens/WinbackListScreen';

/** «قايمة الاسترجاع» — her private win-back list (F12, the owner's ruling 25/11). */
export default async function Page() {
  await guardRoute('/confirmation/winback-list');
  return <WinbackListScreen />;
}
