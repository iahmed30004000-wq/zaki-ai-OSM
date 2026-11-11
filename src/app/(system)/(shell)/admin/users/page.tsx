import { guardRoute } from '@/lib/page-guard';
import { UsersScreen } from '@/components/screens/UsersScreen';
import { twoFactorRequired } from '@/lib/auth-switches';

export default async function Page() {
  await guardRoute('/admin/users');
  // Read here, on the server, at request time: the words in the 2FA column are true only while the second code is asked.
  return <UsersScreen twoFactorRequired={twoFactorRequired()} />;
}
