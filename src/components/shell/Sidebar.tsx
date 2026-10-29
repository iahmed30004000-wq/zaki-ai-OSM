'use client';

import React, { useEffect, useMemo, useState } from 'react';
import { isActiveGroup, isActiveRoute } from '@/lib/active-route';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useNotifications } from './NotificationsProvider';
import clsx from 'clsx';
import type { NavGroup, RouteDef } from '@/lib/route-registry';
import { hubHref, hubLabel, isHub } from '@/lib/hub';
import { iconFor } from './icons';
import { RiArrowDownSLine, RiDraggable, RiListSettingsLine, RiSideBarLine, RiTreeLine } from '@remixicon/react';
import { RAIL_EVENT, railed as storedRail, setRailed } from '@/lib/sidebar-rail';
import { ThemeDecor } from './ThemeDecor';

const OPEN_GROUPS_KEY = 'osm.sidebar.open';
const PINNED_KEY = 'osm.sidebar.pinned';

/**
 * The contract groups, RTL. The server already removed every route this
 * user may not open (visibleNav) — nothing here decides access.
 *
 * FIFTEEN LINES, NOT FIFTY-FOUR. A group with a `hub` is ONE line here — its
 * own icon and name, the unread of everything inside it added up, lit when
 * the person is anywhere in it — and its screens are the pills above
 * whichever is open (HubTabs). A `loose` group is its screens as lines with
 * no heading. The owner, 21/10: «الموقع كثييير معجوق».
 *
 * A group with no `hub` still folds, as it always did: fifty screens in one
 * scroll means hunting for the one you want, so the sidebar shows headings
 * and you open the one you are working in. The group holding the current
 * page always opens itself, so you are never looking at a closed list that
 * contains where you are, and what you leave open is remembered on this
 * browser. The real registry has none today; the fold stays for a group that
 * is added without one, and for the tests that hold it.
 */
export function Sidebar({
  groups,
  mobileOpen,
  onClose,
}: {
  groups: NavGroup[];
  mobileOpen?: boolean;
  onClose?: () => void;
}) {
  const pathname = usePathname();
  // Unread, by the screen each notification points at — one poller, in
  // NotificationsProvider; this only reads it.
  const { byRoute } = useNotifications();

  /**
   * Every path this menu draws. The «which item is lit» question cannot be
   * answered per item — `/store` matches on `/store/landing-pages` too —
   * so the answer needs the whole set. See src/lib/active-route.ts.
   */
  const drawnPaths = useMemo(() => groups.flatMap((g) => g.routes.map((r) => r.path)), [groups]);

  /** The group the current page lives in — always open, never collapsible shut. */
  const activeGroup = useMemo(
    () =>
      groups.find((g) => isActiveGroup(pathname, g.routes.map((r) => r.path), drawnPaths))?.key ??
      null,
    [groups, pathname, drawnPaths]
  );

  const [open, setOpen] = useState<Set<string>>(new Set());
  /** Everything showing at once, and staying that way. */
  const [pinned, setPinned] = useState(false);
  /**
   * Folded to a rail of icons. The WIDTH is CSS (see sidebar-rail.ts) so it
   * is right on the first frame; this copy exists only for the things a
   * frame of delay cannot be seen in — a tooltip, a name for a screen
   * reader, which way the chevron points.
   */
  const [rail, setRail] = useState(false);

  // What was left open last time, per browser. A missing or unreadable value
  // is not a failure: the active group opens either way.
  useEffect(() => {
    let stored: string[] = [];
    try {
      stored = JSON.parse(localStorage.getItem(OPEN_GROUPS_KEY) ?? '[]');
    } catch {
      stored = [];
    }
    setOpen(new Set(Array.isArray(stored) ? stored : []));
    try {
      setPinned(localStorage.getItem(PINNED_KEY) === '1');
    } catch {
      setPinned(false);
    }
    setRail(storedRail());
  }, []);

  // The palette folds the same menu. Without this the names on the icons
  // come from a copy only the button here ever updated.
  useEffect(() => {
    const heard = () => setRail(storedRail());
    window.addEventListener(RAIL_EVENT, heard);
    return () => window.removeEventListener(RAIL_EVENT, heard);
  }, []);

  function toggleRail() {
    setRailed(!rail);
  }

  function togglePinned() {
    setPinned((was) => {
      const next = !was;
      try {
        localStorage.setItem(PINNED_KEY, next ? '1' : '0');
      } catch {
        // Navigation still works without the browser remembering.
      }
      // Folding has to actually fold. Every group opened by hand stayed
      // open underneath the pin, so pressing «اطوِ القوائم» left the list
      // exactly as it was and read as a dead button. The active group is
      // kept: collapsing must never hide where you are standing.
      if (!next) {
        setOpen(new Set());
        try {
          localStorage.setItem(OPEN_GROUPS_KEY, '[]');
        } catch {
          /* remembering is a convenience, not a requirement */
        }
      }
      return next;
    });
  }

  /**
   * ONE GROUP OPEN AT A TIME.
   *
   * Ten groups that each stay open where they were left is a sidebar that
   * ends up fully unfolded after a morning's work — which is the state the
   * folding exists to avoid, reached one honest click at a time. Opening
   * التشغيل to reach التجهيز and then المال to reach المطابقة left both
   * standing, and the list you have to read to find the next thing grows
   * every time you use it.
   *
   * So opening one folds the rest. Pressing the open one still closes it:
   * an accordion that cannot be fully shut is a control with a state it
   * refuses to enter.
   */
  function toggle(key: string) {
    setOpen((prev) => {
      const next = prev.has(key) ? new Set<string>() : new Set([key]);
      try {
        localStorage.setItem(OPEN_GROUPS_KEY, JSON.stringify([...next]));
      } catch {
        // A browser that refuses storage still gets working navigation.
      }
      return next;
    });
  }

  /**
   * AND ARRIVING SOMEWHERE FOLDS WHAT YOU CAME FROM.
   *
   * `activeGroup` already opens the group holding the current page, so after
   * navigating from التجهيز to المطابقة both were open — the new one because
   * it holds the page, the old one because a hand had opened it and nothing
   * ever closed it. Following a link IS leaving the other group.
   *
   * Not while pinned: pinning is the explicit «show me everything», and
   * folding underneath it would make that button a lie.
   */
  useEffect(() => {
    if (pinned || !activeGroup) return;
    setOpen((prev) => (prev.size === 1 && prev.has(activeGroup) ? prev : new Set([activeGroup])));
  }, [activeGroup, pinned]);

  /** One screen's line — shared by a folding group and a loose one. */
  const routeLine = (route: RouteDef) => {
    const isActive = isActiveRoute(pathname, route.path, drawnPaths);
    // Line at rest, filled on the one you are on. Four items of
    // the same shape, one of them slightly brighter, is a
    // difference people miss; a filled glyph is not.
    const Icon = iconFor(route.icon, isActive);
    return (
      <Link
        key={route.path}
        href={route.path}
        onClick={onClose}
        // Folded, the label is not drawn, so the name has to
        // come from somewhere: `title` for the eye, `aria-label`
        // for anything reading the screen aloud. Both only when
        // folded — a tooltip repeating a label you can already
        // read is noise.
        title={rail ? route.label : undefined}
        aria-label={rail ? route.label : undefined}
        className={clsx(
          'rail-center flex items-center justify-between mx-3 px-2 py-2.5 rounded-lg text-sm font-medium transition-colors group',
          isActive
            ? 'bg-[var(--sys-primary)] text-[var(--sys-primary-foreground)]'
            : 'text-[var(--sys-sidebar-foreground)] hover:text-[var(--sys-heading)] hover:bg-[var(--sys-primary-soft)]'
        )}
      >
        <span className="rail-center flex items-center gap-3">
          {/* No box behind the glyph. It measured 1.07:1 against
              the surface it sat on — not a container, a smudge —
              and the difference it was trying to make is already
              made twice over: the icon fills when you are on the
              row, and the row itself is a filled bar. */}
          <span className="w-8 h-8 flex items-center justify-center shrink-0">
            <Icon className="w-[18px] h-[18px]" />
          </span>
          {/*
            THE STOP'S NUMBER, WHEN THE GROUP IS A ROAD.

            «3. دفعات الشحن»: a plain prefix in the label's own
            colour, so it needs no new class and cannot fall
            below the contrast the label already has — on the
            lit row it would have been the one text on the
            accent that was NOT `primary-foreground`. See
            `RouteDef.step` for why it belongs to the screen and
            not to its place in the list. Folded to a rail the
            label is not drawn, and the number goes with it.
          */}
          <span className="rail-hide">
            {route.step ? `${route.step}. ` : ''}
            {route.label}
          </span>
        </span>

        {/*
          HOW MANY UNREAD ARE ABOUT THIS SCREEN.

          Every notification already carries the route it is
          about, so this is that column grouped — not a second
          counter to invent and keep in step with the bell. It
          shows on the rail too, where the label does not: a
          number is the only thing a folded menu can say.
        */}
        {byRoute[route.path] ? (
          <span
            /* One badge, not two. A tinted chip carrying the
               accent as its text reads on the row you stand on
               and on the rows you do not — and the pair is
               already guarded for contrast. Painting a wash of
               `primary-foreground` for the active row would
               have been a second style to keep legible. */
            className="min-w-5 rounded-full bg-[var(--sys-primary-soft)] px-1.5 py-0.5 text-center text-xs font-bold tabular-nums text-[var(--sys-primary)]"
            aria-label={`${byRoute[route.path]} إشعار غير مقروء`}
          >
            {byRoute[route.path]}
          </span>
        ) : null}
      </Link>
    );
  };

  /**
   * A HUB IS ONE LINE.
   *
   * The group's own icon and name, the unread of every screen in it added up,
   * and lit when the person is anywhere inside it — the same single answer
   * (`isActiveGroup`) the folding groups open by, so one line is lit for any
   * page, never two and never none. It leads to the first screen this person
   * may open; the rest are the pills above that screen (see HubTabs).
   *
   * Folded to a rail the label is not drawn, so the name comes from `title`
   * and `aria-label`, and the unread number — the only thing a folded menu
   * can say — still shows.
   */
  const hubLine = (group: NavGroup) => {
    const isActive = isActiveGroup(pathname, group.routes.map((r) => r.path), drawnPaths);
    const Icon = iconFor(group.icon ?? group.routes[0]?.icon ?? '', isActive);
    const label = hubLabel(group);
    const unread = group.routes.reduce((sum, r) => sum + (byRoute[r.path] ?? 0), 0);
    return (
      <Link
        key={group.key}
        href={hubHref(group)}
        onClick={onClose}
        title={rail ? label : undefined}
        aria-label={rail ? label : undefined}
        className={clsx(
          'rail-center flex items-center justify-between mx-3 px-2 py-2.5 rounded-lg text-sm font-medium transition-colors group',
          isActive
            ? 'bg-[var(--sys-primary)] text-[var(--sys-primary-foreground)]'
            : 'text-[var(--sys-sidebar-foreground)] hover:text-[var(--sys-heading)] hover:bg-[var(--sys-primary-soft)]'
        )}
      >
        <span className="rail-center flex items-center gap-3">
          <span className="w-8 h-8 flex items-center justify-center shrink-0">
            <Icon className="w-[18px] h-[18px]" />
          </span>
          <span className="rail-hide">{label}</span>
        </span>
        {unread ? (
          <span
            className="min-w-5 rounded-full bg-[var(--sys-primary-soft)] px-1.5 py-0.5 text-center text-xs font-bold tabular-nums text-[var(--sys-primary)]"
            aria-label={`${unread} إشعار غير مقروء`}
          >
            {unread}
          </span>
        ) : null}
      </Link>
    );
  };

  return (
    <>
      {mobileOpen && <div className="fixed inset-0 z-40 bg-[var(--sys-background)]/60 md:hidden" onClick={onClose} />}

      {/*
        THE SIDEWAYS SCROLL NOBODY COULD FIND.

        This used to stay mounted when closed and slide out past the right
        edge, which is how it slid back in. But a `fixed` box 280px beyond
        the edge still counts towards how wide the document is, and no
        `overflow` on any ancestor can clip it — a fixed element's
        containing block is the viewport itself. So EVERY screen on EVERY
        phone scrolled 280px sideways into an empty grey field. It reads as
        a broken screen rather than as a menu, and it survived both the rule
        against sideways scrolling and the test for it, because both look
        for over-wide columns in a screen's source and this is in no
        screen's source at all.

        Closed it is now `display: none`, which takes up no width anywhere.
        Open it slides in — the entrance is the half anybody sees.
      */}
      <aside
        // The first-run tour anchors its first step here. See FirstRunTour.tsx.
        data-tour='sidebar'
        className={clsx(
          'fixed top-0 bottom-0 right-0 z-40 flex-col w-[280px] bg-[var(--sys-sidebar)] text-[var(--sys-sidebar-foreground)] md:w-[var(--shell-nav)] md:flex',
          mobileOpen ? 'flex animate-in slide-in-from-right duration-200' : 'hidden'
        )}
      >
        {/* A minimum, like the header beside it (Header.tsx): the wordmark is shorter than 72px, so this
            draws exactly as before, and the stylesheet carries one height rule for both instead of two. */}
        {/* And it is as tall as the header is: when the header wraps to a second row the two borders
            used to part company. The header writes its height; 72 stays until it has. */}
        <div
          className="rail-center relative flex items-center gap-2 min-h-[72px] px-5 border-b border-[var(--sys-border)] shrink-0"
          style={{ minHeight: 'var(--sys-header-h, 72px)' }}
        >
          {/* The theme's own mood, in one of the three places it is allowed:
              above the menu, where the wordmark is — and not one pixel of it
              behind a figure. It draws nothing unless the person's level is
              «light» or «full». See src/lib/theme-decoration.ts. */}
          <ThemeDecor place="sidebar" />
          <Link href="/" className="relative flex min-w-0 items-center gap-3" onClick={onClose}>
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src="/brand/mark.png" alt="" aria-hidden className="h-11 w-11 shrink-0 object-contain" />
            <div className="rail-hide min-w-0">
              {/*
                THE WORDMARK SITS ON THE SIDEBAR, NOT ON THE ACCENT.
                It was `--sys-primary-foreground` — the colour of text that
                sits ON the cyan, which in the default theme is #04182B. On
                the sidebar's #0a1a2e that is 1.03:1: the product's own name
                was invisible in the place it is most often read, and it took
                measuring the contrast in a browser to see it, because a
                near-invisible word looks like empty padding.
              */}
              <span className="font-bold text-[var(--sys-sidebar-foreground)] tracking-wide text-base leading-tight block" dir="ltr">
                Zaki <span className="text-[var(--sys-primary)]">AI</span> OMS
              </span>
              <span className="block text-xs text-[var(--sys-muted-foreground)] font-semibold uppercase tracking-wide" lang="en" dir="ltr">
                Intelligent Systems
              </span>
            </div>
          </Link>

          {/* Folding is a desktop affair: below 768px this is a drawer laid
              over the screen, and a narrower drawer buys nothing. */}
          <button
            onClick={toggleRail}
            aria-label={rail ? 'وسّع القائمة' : 'اطوِ القائمة إلى شريط'}
            title={rail ? 'وسّع القائمة' : 'اطوِ القائمة إلى شريط'}
            aria-pressed={rail}
            className="rail-hide hidden md:flex mr-auto h-11 md:h-9 w-9 shrink-0 items-center justify-center rounded-lg text-[var(--sys-sidebar-foreground)] hover:bg-[var(--sys-primary-soft)] hover:text-[var(--sys-heading)]"
          >
            <RiSideBarLine className="icon-mirror w-5 h-5" />
          </button>
        </div>

        {/* Folded, the control that unfolds it must still be reachable — and
            it cannot be the row above, which is now just the mark. */}
        {rail && (
          <button
            onClick={toggleRail}
            aria-label="وسّع القائمة"
            title="وسّع القائمة"
            className="hidden md:flex mx-auto mt-2 h-11 md:h-9 w-9 shrink-0 items-center justify-center rounded-lg text-[var(--sys-sidebar-foreground)] hover:bg-[var(--sys-primary-soft)] hover:text-[var(--sys-heading)]"
          >
            <RiSideBarLine className="icon-mirror w-5 h-5" />
          </button>
        )}

        <nav className="flex-1 overflow-y-auto sidebar-scroll py-3 space-y-0.5">
          {groups.map((group) => {
            // A hub is one line, a loose group is its lines with no heading
            // — neither folds, so neither has an open/shut state to keep.
            if (isHub(group)) return hubLine(group);
            if (group.hub === 'loose') {
              return (
                <div key={group.key} className="pb-1">
                  {group.routes.map(routeLine)}
                </div>
              );
            }
            // Folded, a collapsed group is a heading that is not drawn at
            // all — so the rail would show nothing. Everything is open.
            const isOpen = rail || pinned || open.has(group.key) || activeGroup === group.key;
            const count = group.routes.length;

            return (
            <div key={group.key} className="pb-1">
              {pinned ? (
                <p className="rail-hide px-5 pt-3 pb-2 text-xs font-semibold tracking-[0.12em] text-[var(--sys-sidebar-foreground)]">
                  {group.label}
                </p>
              ) : (
                <button
                  onClick={() => toggle(group.key)}
                  aria-expanded={isOpen}
                  className="rail-hide w-full flex items-center justify-between gap-2 px-5 pt-3 pb-2 text-xs font-semibold tracking-[0.12em] text-[var(--sys-sidebar-foreground)] hover:text-[var(--sys-heading)] transition-colors"
                >
                  <span className="flex items-center gap-2">
                    {group.label}
                    {!isOpen && <span className="text-[var(--sys-muted)] tabular-nums">{count}</span>}
                  </span>
                  <RiArrowDownSLine
                    className={clsx('w-4 h-4 transition-transform', isOpen ? '' : '-rotate-90')}
                  />
                </button>
              )}
              {isOpen && group.routes.map(routeLine)}
            </div>
            );
          })}
        </nav>

        {/*
          «رتّب القائمة», WHERE THE MENU IS.

          Arranging the menu lives on the profile page — it is a personal
          preference and needs no permission of its own — and a control that
          reorders the menu is found, by most people, by looking at the menu.
          It was reachable only by knowing that «الملف الشخصي» hid it, which
          is how a feature the owner asked for ends up unused.

          Same classes as the row beneath it, so the footer reads as one list
          of two things to do with the menu. Hidden on the rail with the rest
          of the labels: a folded menu has no room for a sentence.
        */}
        <Link
          href="/admin/profile#menu-order"
          onClick={onClose}
          className="rail-hide shrink-0 flex items-center gap-2 px-5 py-3 border-t border-[var(--sys-border)] text-xs text-[var(--sys-sidebar-foreground)] hover:text-[var(--sys-heading)] transition-colors"
        >
          <RiDraggable className="w-4 h-4" />
          رتّب القائمة
        </Link>

        {/* Show everything at once, or fold it back. Fifty screens in one
            scroll is a hunt; ten headings is a menu. Whichever you prefer is
            remembered on this browser. */}
        {/* Only when something folds: with every group a line, «show
            everything» would be a button that does nothing. */}
        {groups.some((g) => !g.hub) && (
          <button
            onClick={togglePinned}
            className="rail-hide shrink-0 flex items-center gap-2 px-5 py-3 border-t border-[var(--sys-border)] text-xs text-[var(--sys-sidebar-foreground)] hover:text-[var(--sys-heading)] transition-colors"
          >
            {pinned ? <RiListSettingsLine className="w-4 h-4" /> : <RiTreeLine className="w-4 h-4" />}
            {pinned ? 'اطوِ القوائم' : 'اعرض كل القوائم'}
          </button>
        )}
      </aside>
    </>
  );
}
