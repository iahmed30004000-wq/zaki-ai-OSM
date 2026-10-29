'use client';

import React from 'react';
import Link from 'next/link';
import { signOut } from '@/lib/sign-out';
import { NotificationBell } from '@/components/shell/NotificationBell';
import { MyWork } from './MyWork';
import { InstallAppButton } from './InstallApp';
import { ShiftChip } from '@/components/attendance/ShiftChip';
import { ROLE_LABELS } from '@/types/auth';
import { RiLogoutBoxLine, RiMenuLine, RiRepeatLine, RiSearchLine, RiStore2Line } from '@remixicon/react';

export interface ShellContextInfo {
  storeName: string;
  storePaused: boolean;
  countryName: string;
  currencyCode: string;
  canSwitch: boolean;
}

export function Header({
  onMenuClick,
  userName,
  userRole,
  context,
  onSearchClick,
}: {
  onMenuClick: () => void;
  userName: string;
  userRole: string;
  context: ShellContextInfo;
  /** Opens the one box. The shortcut that also opens it lives in Shell. */
  onSearchClick: () => void;
}) {
  const logout = () => signOut('manual');

  /**
   * THE BAR SAYS HOW TALL IT IS, SO NOTHING HAS TO GUESS.
   *
   * It grows when its group wraps (see below), which made every «the screen
   * minus 72» wrong by the extra row: the WhatsApp inbox ran past the bottom
   * of the window, and the side menu's head line stopped meeting this bar's
   * border. The height is written once, on the document, where both read it;
   * each keeps its old 72 as the fallback until this has measured.
   */
  const bar = React.useRef<HTMLElement>(null);
  React.useEffect(() => {
    const el = bar.current;
    if (!el) return;
    const root = document.documentElement;
    const publish = () => root.style.setProperty('--sys-header-h', `${el.offsetHeight}px`);
    publish();
    if (typeof ResizeObserver === 'undefined') return;
    const watch = new ResizeObserver(publish);
    watch.observe(el);
    return () => {
      watch.disconnect();
      root.style.removeProperty('--sys-header-h');
    };
  }, []);

  /*
   * AT LEAST 72px TALL, NEVER EXACTLY 72px.
   *
   * The group at the end of this bar wraps on purpose (see the note above it), but the bar
   * itself had a fixed height. A wrapped group then did not make the bar taller: centred in
   * 72px, it hung out of both edges. At 800px wide with an install button, a shift chip and
   * four counters it measured 6 rows, from 33px above the window down to 104px, and the part
   * below the bar sat over the page. It covered the screen's first row: on «الطلبات» that is
   * «متقدم» and «إدخال طلب سريع», so pressing them did nothing at all. The top rows sat above
   * the window and could not be seen.
   *
   * A minimum keeps the single-row bar exactly as it was, and lets a wrapped one push the page
   * down instead of covering it. `py-2` keeps the wrapped rows off the bar's own border.
   */
  return (
    <header ref={bar} className="sticky top-0 z-30 min-h-[72px] py-2 bg-[var(--sys-card)] border-b border-[var(--sys-border)] flex items-center gap-3 px-4 md:px-6">
      <button
        onClick={onMenuClick}
        className="md:hidden flex h-11 w-11 shrink-0 items-center justify-center rounded-lg hover:bg-[var(--sys-surface)]"
        aria-label="القائمة"
        title="القائمة"
      >
        <RiMenuLine className="w-5 h-5 text-[var(--sys-foreground)]" />
      </button>

      {/* Country + store context, always visible: every request carries it */}
      {/* `min-w-0 shrink` is what lets this give way on a phone. Without
          it the chip holds its full width, the header cannot fit, and the
          whole document grows 95px wider than the screen — so every page
          scrolls sideways into grey. The name already truncates; it just
          had no room in which to. */}
      {/*
        THE CHIP IS THE SWITCH.

        It used to be a box that showed the store, with a small swap icon
        beside it that was `hidden md:block`. On a phone the box was the
        only thing there — bordered, with a store icon and a name — and it
        did nothing when tapped: «خانة تبديل المتاجر لا يمكن أن تضغط
        عليها». A thing that looks like a control and is not one is worse
        than no control.
        This adds NO seventh control to a 375px bar: it makes the one
        already sitting there work, and the separate icon goes — two
        targets for one command was the duplication underneath the bug.
      */}
      {(() => {
        // The first-run tour anchors its second step here. See FirstRunTour.tsx.
        const tour = { 'data-tour': 'context' } as const;
        const body = (
          <>
            <RiStore2Line className="w-4 h-4 text-[var(--sys-primary)] shrink-0" />
            <div className="leading-tight min-w-0 text-start">
              <p className="text-xs font-semibold text-[var(--sys-heading)] truncate max-w-[160px]">{context.storeName}</p>
              <p className="text-xs text-[var(--sys-muted-foreground)] truncate">
                {context.countryName} · {context.currencyCode}
                {context.storePaused && <span className="text-[var(--sys-destructive)]"> · موقوف</span>}
              </p>
            </div>
            {context.canSwitch && (
              <RiRepeatLine className="w-4 h-4 shrink-0 text-[var(--sys-muted)]" aria-hidden />
            )}
          </>
        );
        const shell = 'flex min-w-0 shrink items-center gap-2 px-3 py-2 rounded-lg bg-[var(--sys-surface)] border border-[var(--sys-border)]';
        return context.canSwitch ? (
          <Link
            href="/entry?change=1"
            title="تبديل البلد أو المتجر"
            aria-label={`المتجر الحالي ${context.storeName} — بدّل البلد أو المتجر`}
            className={`${shell} min-h-11 md:min-h-0 hover:border-[var(--sys-primary)] hover:text-[var(--sys-primary)]`}
            {...tour}
          >
            {body}
          </Link>
        ) : (
          <div className={shell} {...tour}>
            {body}
          </div>
        );
      })()}

      {/* ONE TRIGGER, NOT A SECOND SEARCH.
          What stood here was an input that searched orders and nothing
          else, that only the owner could see, and that sat beside a menu of
          fifty screens nobody could search at all. It is now the door to
          the palette — which finds records, screens AND actions, and which
          Ctrl/Cmd + K opens without reaching for the mouse.

          Everyone gets the door. What is behind it is still decided per
          person: record lookup remains the owner's, exactly as before. */}
      <button
        type="button"
        onClick={onSearchClick}
        // The first-run tour anchors its third step here. See FirstRunTour.tsx.
        data-tour="search"
        className="hidden md:flex flex-1 max-w-md items-center gap-2 h-11 md:h-10 px-3 rounded-lg border border-[var(--sys-border)] bg-[var(--sys-surface)] text-sm text-[var(--sys-muted-foreground)] hover:border-[var(--sys-primary)]"
      >
        <RiSearchLine className="w-4 h-4 shrink-0 text-[var(--sys-muted)]" aria-hidden />
        <span className="flex-1 text-start truncate">ابحث، انتقل، أو نفّذ</span>
        <kbd className="shrink-0 rounded-sm border border-[var(--sys-border)] bg-[var(--sys-card)] px-1.5 py-0.5 text-xs font-sans text-[var(--sys-muted-foreground)]">
          Ctrl K
        </kbd>
      </button>

      {/* A phone has no Ctrl, so it gets the same door as an icon. */}
      <button
        type="button"
        onClick={onSearchClick}
        aria-label="ابحث، انتقل، أو نفّذ"
        className="md:hidden mr-auto flex h-11 w-11 shrink-0 items-center justify-center rounded-lg text-[var(--sys-muted-foreground)] hover:bg-[var(--sys-surface)]"
        title="ابحث، انتقل، أو نفّذ"
      >
        <RiSearchLine className="w-5 h-5" />
      </button>

      {/*
        WRAPS INSTEAD OF PUSHING THE PAGE SIDEWAYS.
        Measured at 768 — the width where the sidebar appears and takes 280
        of it: this group is about 340px of shift chip, counter, bell and
        avatar, and `shrink-0` meant it would rather overflow the document by
        122px than give up a pixel. On a tablet a header that wraps to two
        rows is ordinary; a page that scrolls sideways is not.
        It is ordinary only because the bar grows with it — see the height
        note at the top of this component.
      */}
      <div className="flex min-w-0 flex-wrap items-center gap-3 md:mr-auto lg:flex-nowrap">
        {/* «ثبّت التطبيق» — only while this browser can install and has not. See InstallApp.tsx. */}
        <InstallAppButton />

        {/* Am I on shift, and how long since my last order. It lives here
            rather than above a queue: same place on every screen, beside
            the name, and never in the path of somebody clicking fast. The
            server decides who sees it — the owner does not clock in. */}
        <ShiftChip />

        {/*
          WHAT IS WAITING FOR THIS PERSON — counts only, never a list.

          This replaced a single confirmation counter, which was the right
          idea applied to one role: a shipping clerk with forty parcels
          ready to go and a warehouse with an uncounted pallet of returns
          both saw a header identical to an accountant's. The server still
          decides which numbers each person gets, by permission, and the
          phone gets only the most urgent — seven controls in a 375px bar
          is how a bell gets missed and a logout gets hit.
        */}
        <MyWork />

        {/* Work is announced here: this person's own notifications for the
            selected store. The server decides who is told what. */}
        <NotificationBell />

        <div className="text-left leading-tight hidden sm:block">
          <p className="text-xs font-semibold text-[var(--sys-heading)]">{userName}</p>
          <p className="text-xs text-[var(--sys-muted-foreground)]">
            {ROLE_LABELS[userRole as keyof typeof ROLE_LABELS]?.ar ?? userRole}
          </p>
        </div>
        <button aria-label="تسجيل الخروج"
          onClick={logout}
          className="min-h-11 min-w-11 md:min-h-0 md:min-w-0 hidden md:block p-2 rounded-lg text-[var(--sys-muted-foreground)] hover:text-[var(--sys-destructive)] hover:bg-[var(--sys-destructive-soft)]"
          title="تسجيل الخروج"
        >
          <RiLogoutBoxLine className="icon-mirror w-5 h-5" />
        </button>
      </div>
    </header>
  );
}
