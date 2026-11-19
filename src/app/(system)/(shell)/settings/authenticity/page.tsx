import { guardRoute } from '@/lib/page-guard';
import { AuthenticityCodesScreen } from '@/components/screens/AuthenticityCodesScreen';

export default async function Page() {
  await guardRoute('/settings/authenticity');
  return <AuthenticityCodesScreen />;
}
