import { guardRoute } from '@/lib/page-guard';
import { UserDetailScreen } from '@/components/screens/UserDetailScreen';
import { twoFactorRequired } from '@/lib/auth-switches';

export default async function Page() {
  await guardRoute('/admin/users');
  // Read here, on the server, at request time: the sentences about the second code are true only while it is asked.
  return <UserDetailScreen twoFactorRequired={twoFactorRequired()} />;
}
