import React from 'react';
import { Shell } from '@/components/shell/Shell';
import { ConfirmProvider } from '@/components/ui/Confirm';
import { ToastProvider } from '@/components/ui/Toast';
import { AiDock } from '@/components/ai/AiDock';
import { can } from '@/lib/authorization';
import { requireShellContext } from '@/lib/page-guard';
import { menuNav, visibleNav } from '@/lib/route-registry';
import { applyArrangement } from '@/lib/nav-arrangement';
import { readArrangement } from '@/lib/nav-arrangement-store';
import { listAccessibleCountries, listAccessibleStores } from '@/lib/geo-context';
import { idleSignOutOn } from '@/lib/auth-switches';

/**
 * Every contract screen lives under this layout. It resolves the session and
 * the country + store selection server-side; without a valid selection the
 * user is sent to /entry, never to a half-scoped screen.
 */
export default async function ShellLayout({ children }: { children: React.ReactNode }) {
  const { user, companyId, store } = await requireShellContext();

  /*
   * THE ARRANGEMENT IS READ HERE, ON THE SERVER, FOR THE FIRST FRAME.
   *
   * A menu that reorders itself a moment after the page appears is a menu
   * that moved under somebody's thumb. This layout already resolves the
   * session, so the stored arrangement is read in the same pass and the
   * sidebar is handed the result — it never knows there was a preference.
   *
   * And it is applied to `visibleNav`'s output, never before it: what a
   * role may SEE is still decided by the server, per route. Arranging
   * reorders and hides; it cannot add.
   */
  const nav = await readArrangement(companyId, user.id, user.role).catch(() => null);

  const countries = await listAccessibleCountries(user, companyId);
  const stores = countries.length > 0 ? await listAccessibleStores(user, companyId, store.country.id) : [];
  const canSwitch = countries.length > 1 || (stores?.length ?? 0) > 1;

  return (
    <Shell
      groups={applyArrangement(menuNav(user, can), nav?.resolved ?? null)}
      userName={user.name}
      userRole={user.role}
      // During «عاين كـ» the mark names who is really looking — the owner — never the person being previewed.
      viewer={user.preview ? { name: user.preview.ownerName, id: user.preview.ownerId } : { name: user.name, id: user.id }}
      // Read here, on the server, at request time: the browser has no environment, and a `NEXT_PUBLIC_` variable is baked
      // in at build, out of reach of a changed variable in Coolify. Off by default — the owner's ruling 11/11.
      idleSignOut={idleSignOutOn()}
      context={{
        storeName: store.name,
        storePaused: store.status !== 'ACTIVE',
        countryName: store.country.name,
        currencyCode: store.country.currencyCode,
        canSwitch,
      }}
    >
      {/* One dialog for the whole app: every screen that needs to ask
          before doing something asks in here, not in a browser box. */}
      <ConfirmProvider>
        {/* One place a screen says what just happened — beside the one
            place it asks before doing something. A message that appears at
            the top of a long form, after a button at the bottom, is a
            message nobody sees. */}
        <ToastProvider>
        {children}
        {/*
          The assistant lives HERE and not on a page.

          In the layout it survives moving between screens, so a question
          asked on the orders list is still answered when you are on the
          profit screen — and asking one no longer costs you the screen you
          were working on, which is why most people did not ask.

          Rendered only for a user who may use it. What it can SEE is
          decided on the server regardless: /api/ai/chat resolves the
          company, the store and the permissions itself.
        */}
        {can(user, 'ai.use') && <AiDock />}
        </ToastProvider>
      </ConfirmProvider>
    </Shell>
  );
}
