import { guardRoute } from '@/lib/page-guard';
import { StaffRulesScreen } from '@/components/screens/StaffRulesScreen';

export default async function Page() {
  await guardRoute('/admin/staff-rules');
  return <StaffRulesScreen />;
}
