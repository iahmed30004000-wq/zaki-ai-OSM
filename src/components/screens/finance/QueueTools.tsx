'use client';

import React from 'react';
import { RiPushpinLine, RiSearchLine } from '@remixicon/react';
import { Button } from '@/components/ui/Button';
import { Checkbox } from '@/components/ui/Checkbox';

/**
 * «بدي أثبّت هاد عشان أفهم — زر تثبيت وفلاتر وسيرش بوكس» (the owner, 8/11) — THE THREE THINGS ABOVE A LONG QUEUE.
 *
 * A statement of 116 lines is five queues, and the biggest of them is a list nobody can read once the headings have scrolled
 * off. So above each queue: a box that narrows it by whatever a person has in hand (a barcode, an order number, a phone, a
 * name, a governorate, an address), a filter by what the company wrote (or by the order's outcome word, for the queue of OUR
 * orders), «بلا بتّ فقط» for the queues that hold the approval back, and the pin that keeps the headings in view.
 *
 * It only hides rows from view. The queue's counter, the approval gate and every answer still count ALL the rows: a filter is
 * a way of looking, never a way of deciding.
 */

export interface QueueKind {
  key: string;
  label: string;
  count: number;
}

export interface QueueView {
  query: string;
  /** A `QueueKind.key`, or '' for all. */
  kind: string;
  onlyOpen: boolean;
}

export const NO_VIEW: QueueView = { query: '', kind: '', onlyOpen: false };

export function QueueTools({
  view,
  onView,
  kinds,
  kindLabel,
  openCount,
  shown,
  total,
  pin,
}: {
  view: QueueView;
  onView: (next: QueueView) => void;
  kinds: QueueKind[];
  /** What the filter filters by, said on its label: «ما كتبته الشركة» or «كلمة نتيجته». */
  kindLabel: string;
  /** How many lines of this queue are still a question; the toggle is drawn only when there are some. */
  openCount: number;
  shown: number;
  total: number;
  /** The pin, when a table with headings is on the page (a phone has cards and none). */
  pin?: { pinned: boolean; onChange: (next: boolean) => void };
}) {
  const narrowed = view.query.trim() !== '' || view.kind !== '' || view.onlyOpen;
  return (
    <div className="flex flex-wrap items-end gap-2 border-b border-[var(--sys-border)] px-4 py-2">
      <label className="min-w-[200px] flex-1">
        <span className="mb-1 block text-note font-medium text-[var(--sys-foreground)]">ابحث بهالقسم</span>
        <span className="relative block">
          <RiSearchLine className="pointer-events-none absolute start-2 top-1/2 h-4 w-4 -translate-y-1/2 text-[var(--sys-muted)]" />
          <input
            type="search"
            dir="auto"
            value={view.query}
            onChange={(e) => onView({ ...view, query: e.target.value })}
            placeholder="باركود، رقم طلب، هاتف، اسم، محافظة، عنوان…"
            className="h-11 md:h-10 w-full rounded-lg border border-[var(--sys-border-input)] bg-[var(--sys-card)] ps-8 pe-2 text-sm"
          />
        </span>
      </label>

      {kinds.length > 1 && (
        <label>
          <span className="mb-1 block text-note font-medium text-[var(--sys-foreground)]">{kindLabel}</span>
          <select
            value={view.kind}
            onChange={(e) => onView({ ...view, kind: e.target.value })}
            className="h-11 md:h-10 rounded-lg border border-[var(--sys-border-input)] bg-[var(--sys-card)] px-2 text-sm"
          >
            <option value="">الكل ({total})</option>
            {kinds.map((k) => (
              <option key={k.key} value={k.key}>
                {k.label} ({k.count})
              </option>
            ))}
          </select>
        </label>
      )}

      {openCount > 0 && (
        <Checkbox
          checked={view.onlyOpen}
          onChange={(checked) => onView({ ...view, onlyOpen: checked })}
          label={<>بلا بتّ فقط ({openCount})</>}
        />
      )}

      {/* A press that holds a state: `aria-pressed` says it, and the look follows it — framed while the headings are pinned, quiet when not. */}
      {pin && (
        <Button
          type="button"
          variant={pin.pinned ? 'secondary' : 'quiet'}
          aria-pressed={pin.pinned}
          onClick={() => pin.onChange(!pin.pinned)}
          title={pin.pinned ? 'عناوين الجدول ثابتة وانت بتمرّر — اضغط لتفكّها' : 'ثبّت عناوين الجدول لتضل ظاهرة وانت بتمرّر'}
        >
          <RiPushpinLine className="h-4 w-4" />
          {pin.pinned ? 'العناوين مثبّتة' : 'ثبّت العناوين'}
        </Button>
      )}

      <span className="ms-auto text-note text-[var(--sys-muted-foreground)]" aria-live="polite">
        {narrowed ? `يعرض ${shown} من ${total}` : `${total} سطر`}
      </span>
      {narrowed && (
        <Button type="button" variant="secondary" onClick={() => onView(NO_VIEW)}>
          امسح البحث والفلتر
        </Button>
      )}
    </div>
  );
}
