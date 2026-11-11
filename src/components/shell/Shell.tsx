'use client';

import React, { useState } from 'react';
import { usePathname } from 'next/navigation';
import type { NavGroup } from '@/lib/route-registry';
import { Sidebar } from './Sidebar';
import { Header, type ShellContextInfo } from './Header';
import { NotificationsProvider } from './NotificationsProvider';
import { NotificationCards } from './NotificationCards';
import { MobileNav } from './MobileNav';
import { OfflineWatch } from './OfflineWatch';
import { InstallAppStrip } from './InstallApp';
import { Watermark } from './Watermark';
import { IdleGuard } from './IdleGuard';
import { CommandPalette, useCommandPalette } from './CommandPalette';
import { BulkProvider } from './BulkBar';
import { HubTabs } from './HubTabs';
import { ScreenGuideProvider } from './ScreenGuide';
import { FirstRunTour } from './FirstRunTour';
import { StoreCurrencyProvider } from '@/context/StoreCurrency';
import { emptyFamilyOf } from '@/lib/theme-decoration';

/** Frame for every contract screen: fixed RTL sidebar + context header. */
export function Shell({
  groups,
  userName,
  userRole,
  viewer,
  context,
  idleSignOut = true,
  children,
}: {
  groups: NavGroup[];
  userName: string;
  userRole: string;
  /** Whose screen this is — for the mark a photograph of it will carry. */
  viewer: { name: string; id: string };
  context: ShellContextInfo;
  /**
   * Whether a screen left untouched signs this device out — `AUTH_IDLE_SIGN_OUT` as the SERVER read it (the layout asks
   * `idleSignOutOn()`; the browser has no environment). Defaults to ON: only the layout says otherwise, and it says it
   * from the switch. See IdleGuard.
   */
  idleSignOut?: boolean;
  children: React.ReactNode;
}) {
  const [mobileOpen, setMobileOpen] = useState(false);
  /** Ctrl/Cmd + K lives here, once, so no screen has to know about it. */
  const palette = useCommandPalette();
  /** The header's own rule, unchanged — see CommandPalette's note. */
  const canSearchRecords = userRole === 'SUPER_ADMIN';
  /**
   * Which family of screen this is, for the picture an empty list wears — and for nothing else.
   * Written on the main element below as `data-empty-family`; only a theme whose empty lists wear a
   * picture per family («ليل») has a rule that reads it, and the picture is still drawn by the one
   * layer EmptyState draws. See `emptyFamilyOf` in theme-decoration.ts.
   */
  const emptyFamily = emptyFamilyOf(usePathname());

  return (
    <BulkProvider>
    {/* Which currency every figure on every screen is in. The header chip
        has been printing it all along; four money screens had nothing to
        print but a hardcoded «$». */}
    <StoreCurrencyProvider code={context.currencyCode}>
    {/* One poller for the bell, the menu's counts and the corner cards —
        three components asking separately would be three timers and three
        answers a second apart. */}
    <NotificationsProvider>
    {/* The guide sheet is drawn here, once; the page titles only hold its button. */}
    <ScreenGuideProvider>
    <div className="min-h-screen bg-[var(--sys-surface)] flex flex-col">

      {/* Registers the worker, and says when the line is down — which
          matters because the worker queues NOTHING. */}
      <OfflineWatch />
      <Sidebar groups={groups} mobileOpen={mobileOpen} onClose={() => setMobileOpen(false)} />
      {/* The margin and the sidebar's width read the SAME variable, so they
          cannot disagree about where the page starts. */}
      <div className="flex-1 flex flex-col min-w-0 transition-all duration-200 md:mr-[var(--shell-nav)]">
        <Header
          onMenuClick={() => setMobileOpen(true)}
          userName={userName}
          userRole={userRole}
          context={context}
          onSearchClick={() => palette.setOpen(true)}
        />
        {/* The phone's offer to install, seen without opening a menu. See InstallApp.tsx. */}
        <InstallAppStrip />
        {/* The bar at the bottom is fixed, so the page needs room under it
            or the last row of every screen sits behind the thumb that is
            trying to read it. */}
        {/* Room for whatever owns the bottom strip: the navigation at its
            fixed height, or a bulk bar at whatever height it wrapped to. */}
        <main
          data-empty-family={emptyFamily}
          className="w-full flex-1 p-4 pb-[calc(var(--bulk-h,4.5rem)+env(safe-area-inset-bottom))] md:p-6 md:pb-6"
        >
          {/* The other screens of this screen's errand, as pills — the menu
              holds ONE line per group, and this is where its screens went.
              On a road (الشحن, المال) the pills carry the step number and the
              «التالي» link too. See HubTabs and next-stop.ts. */}
          <HubTabs groups={groups} />
          {children}
        </main>
      </div>

      <MobileNav groups={groups} />

      {/* The first-run walkthrough: once per person, on their row — see
          FirstRunTour.tsx. Mounted in the shell so it greets the person on
          whatever screen they land on, and never again once dismissed. */}
      <FirstRunTour />

      {/* What arrived while you were looking at something else. On the
          START corner: the assistant anchors to the END one, and two
          floaters in one corner cover each other. */}
      <NotificationCards />

      {/* A personal device, and the two things a web page can honestly do
          about that: put a name in any photograph of the screen, and stop
          being signed in on a phone nobody is holding. Neither prevents a
          screenshot — nothing can. See src/lib/exposure.ts. */}
      {/* One box for records, screens and actions. It is the only global
          search now: the header's box searched orders and nothing else,
          beside a menu of fifty screens that could not be searched at all. */}
      <CommandPalette
        groups={groups}
        canSearchRecords={canSearchRecords}
        canSwitchStore={context.canSwitch}
        open={palette.open}
        onClose={() => palette.setOpen(false)}
      />

      {/*
        EVERYONE EXCEPT THE OWNER.

        The mark exists so a photographed screen full of customers' numbers
        can be traced to the account that was looking at it. The owner is
        who that protects, not who it deters — and it is their company's
        data on the screen. So they are exempt, and nobody else is.

        The exemption is a ROLE, read from the session on the server and
        arriving here as a rendered prop. It is deliberately not a setting,
        not a preference and not a query parameter: a mark anyone can turn
        off is a mark for the honest.
      */}
      {userRole !== 'SUPER_ADMIN' && <Watermark viewer={viewer} />}
      <IdleGuard idleSignOut={idleSignOut} />
    </div>
    </ScreenGuideProvider>
    </NotificationsProvider>
    </StoreCurrencyProvider>
    </BulkProvider>
  );
}
