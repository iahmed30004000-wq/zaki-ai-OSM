'use client';

import React from 'react';
import { RiCloseLine, RiSearchLine } from '@remixicon/react';
import { Button } from '@/components/ui/Button';
import { IconButton } from '@/components/ui/IconButton';

/**
 * THE TAB STRIP'S BUTTON AND THE HEAD OF A WORKING LIST OF «طلباتي» — moved out of `ConfirmationMineScreen.tsx` in R8c (18/11), on the
 * kit, nothing else changed.
 *
 * WHY NOT THE KIT'S `Tabs`. It draws a label and a count; this strip also carries, on a desk, the sentence under each tab that says
 * what it holds, and the amber count of «بانتظار». So the tab stays its own, drawn with the kit's `Button` — and the strip itself
 * (`role="tablist"`, its name «طلباتي», which tabs are drawn, the counts and the sentences) stays in the screen, which decides them.
 *
 * PRESENTATION ONLY: no server, no session, no permission (`the-desk-tabs-and-the-done-list.test.tsx`).
 */

/**
 * ONE OF THE THREE, WITH ITS COUNT AND WHAT IT HOLDS.
 *
 * The count and the note are on the tab and not inside it, because «which
 * of these do I do now» is decided before either list is open.
 *
 * `role="tab"` and `aria-selected` and not three styled buttons: the strip
 * announces itself as one choice of three to a screen reader, and arrow
 * keys move through it. A coloured underline alone would say nothing.
 */
export function TabButton({
  active,
  onClick,
  label,
  count,
  note,
  tone,
  phone,
}: {
  active: boolean;
  onClick: () => void;
  label: string;
  count?: number;
  note?: string;
  tone?: 'warning';
  /** A phone keeps the tab to its label and count, on one line that never wraps. */
  phone?: boolean;
}) {
  /*
   * The kit's `Button` (R8c, 18/11): the open tab is `secondary` (the card fill and an edge), the others `quiet`. Its name is said
   * outright — the label and the count — because a button whose only child is a box would otherwise take its `title` (the note) as
   * its name, and «اتصلي هلّق» would be announced as «اللي لازم ترني عليه هلّق».
   */
  return (
    <Button
      type="button"
      role="tab"
      aria-selected={active}
      aria-label={count !== undefined ? `${label} ${count}` : label}
      variant={active ? 'secondary' : 'quiet'}
      onClick={onClick}
      title={note}
      className={phone ? 'shrink-0 whitespace-nowrap mb-1' : 'mb-1'}
    >
      <span className="flex flex-col items-start">
        <span className="flex items-center gap-1.5 text-sm font-bold">
          {label}
          {count !== undefined && (
          <span
            className={`text-note leading-tight px-1.5 py-0.5 rounded-md border tabular-nums font-normal ${
              tone === 'warning'
                ? 'bg-[var(--sys-warning-soft)] text-[var(--sys-warning)] border-[var(--sys-warning)]/40'
                : 'bg-[var(--sys-surface)] text-[var(--sys-muted-foreground)] border-[var(--sys-border)]'
            }`}
            dir="ltr"
          >
            {count}
          </span>
          )}
        </span>
        {note && !phone && <span className="block text-note leading-tight font-normal text-[var(--sys-muted)]">{note}</span>}
      </span>
    </Button>
  );
}

/**
 * A section's title, its count, and a box to find one row in it.
 *
 * The count says "3 of 12" while a search is running, because a filtered
 * list that says 3 with no context reads as "you only have three".
 */
export function SectionHead({
  title,
  count,
  total,
  value,
  onChange,
  note,
  phone,
}: {
  title: string;
  count: number;
  total: number;
  value: string;
  onChange: (v: string) => void;
  note?: string;
  /** A phone drops the sentence (the open tab already says it) and gives the search box the whole line. */
  phone?: boolean;
}) {
  return (
    <div className="flex flex-wrap items-center gap-2 mb-3">
      <h2 className="text-sm font-bold text-[var(--sys-heading)]">
        {title} ({value.trim() ? `${count} من ${total}` : total})
      </h2>
      {note && !phone && <span className="text-note text-[var(--sys-muted)]">{note}</span>}
      {/* The box and its «امسح البحث» side by side — the kit's `IconButton` beside the field, not laid over the text she typed. */}
      <div className={phone ? 'flex items-center gap-1 w-full' : 'flex items-center gap-1 ms-auto'}>
        <div className={phone ? 'relative w-full min-w-0' : 'relative'}>
          <RiSearchLine className="w-4 h-4 text-[var(--sys-muted)] absolute top-1/2 -translate-y-1/2 end-2.5" />
          <input
            value={value}
            onChange={(e) => onChange(e.target.value)}
            placeholder="رقم الهاتف أو الطلب أو الاسم"
            className={`h-11 md:h-8 ${phone ? 'w-full' : 'w-56'} ps-2.5 pe-8 rounded-lg border border-[var(--sys-border-input)] bg-[var(--sys-card)] text-sm text-[var(--sys-foreground)] focus:outline-none focus:border-[var(--sys-primary)]`}
          />
        </div>
        {value && (
          <IconButton type="button" label="امسح البحث" size="sm" onClick={() => onChange('')}>
            <RiCloseLine className="w-4 h-4" />
          </IconButton>
        )}
      </div>
    </div>
  );
}
