import { guardRoute } from '@/lib/page-guard';
import { AuthenticityScreen } from '@/components/screens/AuthenticityScreen';

export default async function Page() {
  await guardRoute('/settings/authenticity');
  return <AuthenticityScreen />;
}
