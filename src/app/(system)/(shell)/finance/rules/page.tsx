import { guardRoute } from '@/lib/page-guard';
import { FinanceRulesScreen } from '@/components/screens/FinanceRulesScreen';

export default async function Page() {
  await guardRoute('/finance/rules');
  return <FinanceRulesScreen />;
}
