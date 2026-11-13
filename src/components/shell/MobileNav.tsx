'use client';

import React, { useEffect, useState } from 'react';
import { isActiveGroup, isActiveRoute } from '@/lib/active-route';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import type { NavGroup } from '@/lib/route-registry';
import { mobileNav } from '@/lib/mobile-nav';
import { hubHref, hubLabel, isHub } from '@/lib/hub';
import { iconFor } from './icons';
import { RiCloseLine, RiLogoutBoxLine, RiMoreLine } from '@remixicon/react';
import { useBulkActive } from './BulkBar';
import { signOut } from '@/lib/sign-out';
import { InstallAppLine } from './InstallApp';

/**
 * THE BOTTOM OF A PHONE.
 *
 * The sidebar on a phone was a drawer behind a hamburger: every screen, at
 * any hour, two taps and a scroll away — including the one screen somebody
 * uses four hundred times a day.
 *
 * So the four they actually work in sit across the bottom, where a thumb
 * already is, and "المزيد" opens the rest. Which four depends on the
 * person: an agent gets her queue, a packer gets preparation. Nobody's
 * phone opens on somebody else's job.
 *
 * «المزيد» draws the same fifteen lines the sidebar does, not fifty screens:
 * a group that is a hub is ONE line here too, and its screens are the pills
 * above whichever of them is open (HubTabs, which is not `md:`-only — a strip
 * that scrolls sideways is a phone's own shape).
 *
 * Two details that are not decoration:
 *
 *   Every target is at least 44px. A tap that misses on a phone held in one
 *   hand, in a warehouse, is a tap somebody makes twice.
 *
 *   The bar sits above the home indicator (`safe-area-inset-bottom`). A tab
 *   underneath it is a tab that closes the app instead of opening a screen.
 */

const TAP = 'min-h-[44px] min-w-[44px]';

export function MobileNav({ groups, slots }: { groups: NavGroup[]; slots?: string[] }) {
  const pathname = usePathname();
  const [sheet, setSheet] = useState(false);
  // `slots` is the person's own four, when they chose them: a preference over `groups`, never a way to add a screen.
  const { primary, rest } = mobileNav(groups, pathname, slots);
  /**
   * While something is selected, this strip belongs to the bar that acts on
   * it. Navigating away mid-selection is not what anybody is reaching for,
   * and the bar was otherwise four screens up the page.
   */
  const yielding = useBulkActive();

  // Any navigation closes the sheet. Leaving it open over the screen it
  // just opened is the commonest way a sheet becomes a thing people avoid.
  useEffect(() => setSheet(false), [pathname]);

  // The sheet is a layer over the page: the page behind it must not scroll,
  // or a thumb swiping the list moves the screen underneath instead.
  useEffect(() => {
    if (!sheet) return;
    const previous = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.body.style.overflow = previous;
    };
  }, [sheet]);

  /*
   * The same single answer the sidebar uses. Per-item `startsWith` lights
   * more than one item whenever one path is a prefix of another, and the
   * drawer had exactly that: on «صفحات الهبوط» it lit «المتجر» too.
   */
  const drawnPaths = primary.map((r) => r.path);
  const active = (path: string) => isActiveRoute(pathname, path, drawnPaths);
  /** Every path this person's menu holds — what «which line is lit» needs to know to answer once. */
  const menuPaths = groups.flatMap((g) => g.routes.map((r) => r.path));
  /** What a line of the sheet looks like lit and unlit — the rest of its classes sit on the line itself, beside `TAP`. */
  const sheetTone = (on: boolean) =>
    on ? 'bg-[var(--sys-primary-soft)] text-[var(--sys-primary)]' : 'text-[var(--sys-foreground)]';

  if (primary.length === 0 || yielding) return null;

  return (
    <>
      {sheet && (
        <div className="fixed inset-0 z-40 md:hidden" role="dialog" aria-label="كل الشاشات">
          <div className="absolute inset-0 bg-[var(--sys-background)]/60" onClick={() => setSheet(false)} aria-hidden="true" />
          <div
            className="absolute inset-x-0 bottom-0 max-h-[75vh] overflow-y-auto rounded-t-lg border-t border-[var(--sys-border)] bg-[var(--sys-card)] pb-[env(safe-area-inset-bottom)]"
            dir="rtl"
          >
            <div className="sticky top-0 flex items-center justify-between border-b border-[var(--sys-border)] bg-[var(--sys-card)] px-4 py-3">
              <span className="text-sm font-semibold text-[var(--sys-heading)]">كل الشاشات</span>
              <button
                type="button"
                onClick={() => setSheet(false)}
                aria-label="إغلاق"
                className={`${TAP} -me-2 flex items-center justify-center rounded-lg text-[var(--sys-muted)]`}
              >
                <RiCloseLine className="h-5 w-5" />
              </button>
            </div>

            <div className="p-2">
              {rest.map((group) => {
                /*
                 * A HUB IS ONE LINE HERE TOO.
                 *
                 * The sheet was the same fifty screens under ten headings the
                 * sidebar used to be — «كثييير معجوق», on the smallest
                 * screen. It leads to the first screen this person may open
                 * in the group, from the WHOLE group (the bar may already
                 * hold that screen, and the line is still the way into the
                 * group); the rest are the pills above it.
                 */
                if (isHub(group)) {
                  const whole = groups.find((g) => g.key === group.key) ?? group;
                  const on = isActiveGroup(pathname, whole.routes.map((r) => r.path), menuPaths);
                  const GroupIcon = iconFor(whole.icon ?? whole.routes[0]?.icon ?? '');
                  return (
                    <ul key={group.key}>
                      <li>
                        <Link href={hubHref(whole)} className={`${TAP} flex items-center gap-3 rounded-lg px-2 text-sm ${sheetTone(on)}`}>
                          <GroupIcon className="h-4 w-4 shrink-0" />
                          {hubLabel(whole)}
                        </Link>
                      </li>
                    </ul>
                  );
                }

                const lines = (
                  <ul>
                    {group.routes.map((route) => {
                      const Icon = iconFor(route.icon);
                      return (
                        <li key={route.path}>
                          <Link
                            href={route.path}
                            className={`${TAP} flex items-center gap-3 rounded-lg px-2 text-sm ${sheetTone(active(route.path))}`}
                          >
                            <Icon className="h-4 w-4 shrink-0" />
                            {route.step ? `${route.step}. ` : ''}
                            {route.label}
                          </Link>
                        </li>
                      );
                    })}
                  </ul>
                );

                // A loose group is its screens with no heading, as in the sidebar.
                if (group.hub === 'loose') return <div key={group.key}>{lines}</div>;

                return (
                  <section key={group.key} className="mb-2">
                    <h3 className="px-2 py-1 text-xs font-semibold text-[var(--sys-muted-foreground)]">
                      {group.label}
                    </h3>
                    {lines}
                  </section>
                );
              })}
            </div>

            {/*
              THE WAY OUT, WHICH A PHONE DID NOT HAVE.

              The header's logout is `hidden md:block` — deliberately, and
              the comment there gives the reason: «seven controls in a 375px
              bar is how a bell gets missed and a logout gets hit». But
              nothing took its place. The bottom bar is routes, this sheet
              was routes, and the command palette opens on Ctrl+K, which a
              phone does not have.

              So a person working from a phone COULD NOT SIGN OUT. On a
              shared warehouse handset that is not an inconvenience: the
              next person to pick it up is still the last person logged in.

              It sits at the BOTTOM, after the screens, separated by a rule
              and coloured as the destructive thing it is — the opposite of
              the header's problem, which was a logout within a thumb's
              width of a notification bell.
            */}
            <div className="border-t border-[var(--sys-border)] p-2">
              {/* Installing, while this phone can: the strip above the page rests, this line stays. */}
              <InstallAppLine className={`${TAP} flex w-full items-center gap-3 rounded-lg px-2 text-sm font-semibold text-[var(--sys-primary)]`} />
              <button
                type="button"
                onClick={() => signOut('manual')}
                className={`${TAP} flex w-full items-center gap-3 rounded-lg px-2 text-sm font-semibold text-[var(--sys-destructive)]`}
              >
                <RiLogoutBoxLine className="icon-mirror h-4 w-4 shrink-0" aria-hidden />
                تسجيل الخروج
              </button>
            </div>
          </div>
        </div>
      )}

      <nav
        /* Its height is published as `--sys-mobile-nav-h` so anything
           floating above it reads the same number — see system.css. */
        className="fixed inset-x-0 bottom-0 z-30 min-h-[var(--sys-mobile-nav-h)] border-t border-[var(--sys-border)] bg-[var(--sys-card)] pb-[env(safe-area-inset-bottom)] md:hidden"
        aria-label="التنقل"
      >
        <ul className="flex">
          {primary.map((route) => {
            const on = active(route.path);
            const Icon = iconFor(route.icon, on);
            return (
              /**
               * `min-w-0` IS WHAT MAKES `truncate` BELOW DO ANYTHING.
               *
               * A flex item's `min-width` is `auto`, which means "never
               * shrink below your content" — and `truncate` does not change
               * that content's intrinsic width, it only clips the paint. So
               * «الطلبات الجديدة» claimed 98px, five tabs claimed 530, and
               * the whole page scrolled sideways by 170px on a 360px phone:
               * the bar is `fixed inset-x-0`, but a fixed box still grows to
               * its own min-content.
               */
              <li key={route.path} className="min-w-0 flex-1">
                <Link
                  href={route.path}
                  aria-current={on ? 'page' : undefined}
                  className={`${TAP} flex flex-col items-center justify-center gap-0.5 px-1 py-1.5 ${
                    on ? 'text-[var(--sys-primary)]' : 'text-[var(--sys-muted-foreground)]'
                  }`}
                >
                  <Icon className="h-5 w-5" />
                  {/* Truncated, never wrapped: a label that wraps makes the
                      bar taller and moves every other tab under the thumb. */}
                  <span className="w-full truncate text-center text-xs leading-tight">{route.label}</span>
                </Link>
              </li>
            );
          })}

          <li className="min-w-0 flex-1">
            <button
              type="button"
              onClick={() => setSheet(true)}
              aria-expanded={sheet}
              className={`${TAP} flex w-full flex-col items-center justify-center gap-0.5 px-1 py-1.5 text-[var(--sys-muted-foreground)]`}
            >
              <RiMoreLine className="h-5 w-5" />
              <span className="text-xs leading-tight">المزيد</span>
            </button>
          </li>
        </ul>
      </nav>
    </>
  );
}
