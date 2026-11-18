import { guardRoute, requireShellContext } from '@/lib/page-guard';
import { PageShell } from '@/components/ui/PageShell';
import { routeLabel } from '@/lib/route-registry';
import { TrackingPixelsSection } from '@/components/settings/TrackingPixelsSection';
import { AdAccountsCard } from '@/components/settings/AdAccountsCard';
import { CustomConversionsCard } from '@/components/settings/CustomConversionsCard';

export default async function Page() {
  await guardRoute('/settings/tracking');
  // Pixels are the company's; ad accounts are the selected store's. The
  // card says which store, because the header's store picker scoping it
  // silently is how a seller connects an account to the wrong shop.
  const { store } = await requireShellContext();
  return (
    /*
      A TITLE, because the ⓘ hangs on one. This page drew none — the first card began at the top of the screen — so the only screen of
      the settings with no name on it was also the only one that could not offer its guide. 18/11 (R15e): the frame draws it now
      (`PageShell`, the same `PageHeader` inside, the same name and sentence), at the full width the page always had.
    */
    <PageShell
      title={routeLabel('/settings/tracking')}
      description="البكسلات التي تحمّلها صفحاتك، وما يُرسله الخادم بعد الطلب، وحسابات الإعلانات — في مكان واحد."
    >
      <TrackingPixelsSection />
      {/*
        Directly under the pixels, because it is the same thought carried
        one step further: the pixel says what happened on the page, this
        says what happened afterwards — at the door, days later, where no
        browser could ever have watched.
      */}
      <CustomConversionsCard />
      {/*
        Beside the pixels, not on a screen of its own.

        A pixel reports what happened on the page and an ad account reports
        what the advert cost — two halves of the same question, and a seller
        setting up their advertising is thinking about both in the same five
        minutes. Splitting them across two screens means finding the second
        one later, which mostly means not finding it.
      */}
      <AdAccountsCard storeName={store.name} />
    </PageShell>
  );
}
