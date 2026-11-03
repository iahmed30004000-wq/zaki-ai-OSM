import { guardRoute } from '@/lib/page-guard';
import { LandingLibraryScreen } from '@/components/screens/LandingLibraryScreen';

export default async function Page() {
  // The landing pages' own gate: whoever may open the list may browse the designs.
  await guardRoute('/store/landing-pages');
  return <LandingLibraryScreen />;
}
