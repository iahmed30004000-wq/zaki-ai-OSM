import { guardRoute } from '@/lib/page-guard';
import { LandingChatsScreen } from '@/components/screens/LandingChatsScreen';

export default async function Page() {
  await guardRoute('/growth/landing-chats');
  return <LandingChatsScreen />;
}
