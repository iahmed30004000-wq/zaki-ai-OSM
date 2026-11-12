'use client';

import { useState } from 'react';

/**
 * A CARD THAT IS ONE LINE UNTIL IT IS ASKED FOR (the owner, 12/11, on the two summary cards of the matching screen:
 * «هدول يكونو مخفيات … أصلاً ما في زر إخفاء»).
 *
 * «شو كتبت الشركة، ووين صار كل نوع» and «الفروق حسب من أكّد الطلب» stood open above the queues for ever, with no way to put them
 * away: the screen opened on a table and a list of names before the first queue. They fold now, CLOSED, the way the queues below
 * them do — a heading, what is inside said in one line, and «عرض» / «إخفاء» on the other side.
 *
 * NOTHING IS REMOVED. The body stays in the page while the card is closed — a native `<details>` only stops DRAWING it — so the
 * browser's find-in-page still reaches it and a test that reads a cell still finds it. The `open` state is the BROWSER's: React
 * follows the `toggle` event (as `AdvancedGroup` does), so the word on the card and the card can never disagree, however it was
 * opened — a press, Enter or Space, or find-in-page unfolding it. Closed by default and NOT remembered between visits: nothing is
 * written anywhere, because a card that restores itself is sometimes open for reasons nobody can see.
 *
 * WITHIN a visit a CALLER may keep it (`open` + `onOpenChange`): the matching screen swaps its whole list for a spinner on every
 * reload, which unmounts the card, and a card that shut itself after every answer would be shut on the owner once per line. Without
 * them the card keeps its own state, closed.
 *
 * No new utility class: the heading row is the queues' own heading row (`Queue` in `MatchingScreen`), so the built CSS is what it was.
 */
export function FoldCard({
  title,
  holds,
  open: kept,
  onOpenChange,
  children,
}: {
  title: string;
  /** What is inside, in one line — shown beside the title while the card is closed AND open, so the count never hides behind a press. */
  holds?: string;
  /** Open or shut as the caller kept it (until it has been touched: absent, so closed). */
  open?: boolean;
  onOpenChange?: (next: boolean) => void;
  children: React.ReactNode;
}) {
  const [own, setOwn] = useState(false);
  const open = kept ?? own;
  return (
    <details
      open={open}
      className="bg-[var(--sys-card)] border border-[var(--sys-border)] rounded-lg overflow-hidden"
      onToggle={(e) => {
        const next = e.currentTarget.open;
        setOwn(next);
        onOpenChange?.(next);
      }}
    >
      <summary aria-expanded={open} className="w-full flex items-center justify-between px-4 py-3 text-right cursor-pointer select-none">
        <span className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
          <span className="text-sm font-medium text-[var(--sys-heading)]">{title}</span>
          {holds && <span className="text-xs text-[var(--sys-muted)]">{holds}</span>}
        </span>
        <span className="text-xs text-[var(--sys-muted)]">{open ? 'إخفاء' : 'عرض'}</span>
      </summary>
      <div className="border-t border-[var(--sys-border)] p-3 space-y-2">{children}</div>
    </details>
  );
}
