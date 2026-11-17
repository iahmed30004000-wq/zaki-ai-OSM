'use client';

import React, { useEffect, useRef } from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import clsx from 'clsx';
import { RiArrowLeftLine, RiArrowRightLine } from '@remixicon/react';
import type { NavGroup } from '@/lib/route-registry';
import { hubAt } from '@/lib/hub';
import { roadPosition } from '@/lib/next-stop';
import { useNotifications } from './NotificationsProvider';

/**
 * THE OTHER SCREENS OF THE SAME ERRAND, ABOVE THE ONE YOU ARE ON.
 *
 * The menu used to spend one line on every screen — fifty-four of them — and
 * the owner's word for it was «كثييير معجوق». A group is now ONE line in the
 * sidebar (see `NavGroup.hub`), and this is where its screens went: a strip
 * of pills above whichever of them is open, so the sibling is one tap away and
 * nobody has to remember which line to open to find it.
 *
 * ── IT IS LINKS, NOT STATE ──
 *
 * Each pill is the screen's own address. Nothing moved: the page guard, the
 * title, the guide, the notification that points at it and the bookmark in
 * somebody's browser all still mean the screen they meant. A pill that were a
 * tab inside one page would have needed redirects for every old address and
 * a second place to enforce who may open what; a link needs neither.
 *
 * ── AND IT NEVER OFFERS WHAT THE PERSON MAY NOT OPEN ──
 *
 * It draws from the groups the shell hands down — the menu this person
 * actually has: stripped of what they may not open, in the order they put it
 * in. A refused screen is not a greyed pill; it is not there, and if its
 * address is typed the server still refuses it.
 *
 * ── THE ROAD LIVES HERE TOO ──
 *
 * On the road groups (الشحن, المال) the pills carry their step — «3. دفعات
 * الشحن» — and the strip ends with «التالي: …». That is what the one-line road
 * strip used to say above these screens; it is gone, because a strip that
 * already shows every stop, numbered, with the one you are on lit, would have
 * printed the same fact twice, one line above the other.
 *
 * A group of cards (the settings) has no strip: twelve pills would be the same
 * clutter one row higher. It carries a single link back to its front door.
 *
 * ── ON A PHONE THE STRIP SCROLLS SIDEWAYS, AND OPENS ON YOUR PILL ──
 *
 * Five pills do not fit across 390px, so the strip scrolls. A strip that
 * always starts at its first pill hides the one you are standing on whenever
 * it is the fourth of five — which is the pill a person looks for first — so
 * the lit one is brought to the middle after every navigation. «التالي» does
 * not squeeze in beside the pills either: when it does not fit it wraps to the
 * line below, and on a desk it stays at the far end of the same row.
 */
export function HubTabs({ groups }: { groups: NavGroup[] }) {
  const pathname = usePathname();
  const { byRoute } = useNotifications();
  const strip = useRef<HTMLUListElement>(null);

  // THE STRIP SCROLLS, NOT THE PAGE (the owner, 17/11: on «الأرباح», the last of eight pills, the first pill sat cut off at the page's edge).
  // `scrollIntoView` moves EVERY scrollable ancestor — `block: 'nearest'` only spares the vertical one, and `inline: 'center'` slid the whole
  // document sideways whenever the page was a hair wider than the screen. So the strip is moved alone, only when it really overflows, by the
  // distance between the two centres read off the screen (the same sum in RTL, where scrollLeft is negative). `scrollBy` is optional because
  // a test browser without layout has none.
  useEffect(() => {
    const ul = strip.current;
    const pill = ul?.querySelector<HTMLElement>('[aria-current="page"]');
    if (!ul || !pill || ul.scrollWidth <= ul.clientWidth) return;
    const a = pill.getBoundingClientRect();
    const b = ul.getBoundingClientRect();
    ul.scrollBy?.({ left: a.left + a.width / 2 - (b.left + b.width / 2) });
  }, [pathname]);

  const at = hubAt(groups, pathname);
  if (!at) return null;
  const { group, here } = at;

  if (group.hub === 'cards') {
    const door = group.routes[0];
    if (!door || here.path === door.path) return null;
    return (
      <nav aria-label={group.label} className="mb-3 text-xs">
        <Link
          href={door.path}
          className="inline-flex min-h-11 items-center gap-1 font-medium text-[var(--sys-primary)] hover:underline md:min-h-0"
        >
          {/* «Back» is the Left glyph, turned by `icon-mirror`, like every
              directional glyph in the product. */}
          <RiArrowLeftLine className="icon-mirror h-4 w-4 shrink-0" aria-hidden />
          {group.label}
        </Link>
      </nav>
    );
  }

  // One screen left to this person is not a set of siblings.
  if (group.routes.length < 2) return null;

  const open = new Set(group.routes.map((r) => r.path));
  const next = roadPosition(pathname, (route) => open.has(route.path))?.next ?? null;

  return (
    <nav aria-label={`أقسام ${group.label}`} className="mb-3 flex flex-wrap items-center justify-between gap-3">
      <ul ref={strip} className="flex min-w-0 gap-1.5 overflow-x-auto pb-1">
        {group.routes.map((route) => {
          const on = route.path === here.path;
          const unread = byRoute[route.path] ?? 0;
          return (
            <li key={route.path} className="shrink-0">
              <Link
                href={route.path}
                aria-current={on ? 'page' : undefined}
                className={clsx(
                  'inline-flex min-h-11 items-center gap-1.5 whitespace-nowrap rounded-full border px-3 py-1.5 text-xs md:min-h-0',
                  on
                    ? 'border-[var(--sys-primary)] bg-[var(--sys-primary-soft)] font-semibold text-[var(--sys-primary)]'
                    : 'border-[var(--sys-border)] text-[var(--sys-muted-foreground)] hover:text-[var(--sys-heading)]'
                )}
              >
                {route.step ? `${route.step}. ` : ''}
                {route.label}
                {/* A count answers «is it worth opening»; a dot only says «something». */}
                {unread > 0 && <span className="tabular-nums text-[var(--sys-primary)]">{unread}</span>}
              </Link>
            </li>
          );
        })}
      </ul>
      {next && (
        <Link
          href={next.path}
          className="inline-flex min-h-11 shrink-0 items-center gap-1 text-xs font-medium text-[var(--sys-primary)] hover:underline md:min-h-0"
        >
          التالي: {next.label}
          <RiArrowRightLine className="icon-mirror h-4 w-4 shrink-0" aria-hidden />
        </Link>
      )}
    </nav>
  );
}
