'use client';

import React from 'react';
import { RiArrowLeftSLine, RiArrowRightSLine } from '@remixicon/react';
import { Button } from './Button';

/**
 * THE PAGE BAR — ONE COPY, FOR EVERY LIST THAT IS READ IN PAGES.
 *
 * «عرض 25 من 312 طلب» on one side, the two arrows and «صفحة 3 من 13» on the
 * other. It was written out by hand in the orders screen, the customers
 * screen and the returns screen — three copies of the same forty lines, which
 * is how a fourth list gets a different bar — and the postponed, winback and
 * tracking lists were about to be the fourth, fifth and sixth.
 *
 * ── WHICH WAY THE ARROWS POINT ──
 *
 * Every directional glyph in this product is drawn in its LTR sense and turned
 * by `icon-mirror`. «التالي» is therefore the RIGHT chevron, flipped — it
 * LOOKS left on an RTL screen, which is where the next page is — and the
 * previous one the other way. `icons.test.ts` insists on the class; the
 * claims beside this file insist on which chevron.
 *
 * ── THE BUTTONS' OWN PROMISE-LOCK IS DELIBERATELY NOT USED ──
 *
 * That lock is for submissions — a second shipment, a second payout. A page
 * turn is a read, and reads arrive late through nothing of the reader's doing;
 * `loading` drives both buttons instead, and an ignored click while a load is
 * in the air is exactly right: the rows on screen are still the truth of the
 * page in hand.
 *
 * `shown` is how many rows THIS page holds and `total` how many the whole list
 * does — a bar that said «عرض 25 من 25» on page 3 of 13 would be describing
 * the page and calling it the list.
 */
export function Pager({
  page,
  totalPages,
  total,
  shown,
  noun,
  label,
  loading = false,
  onPage,
}: {
  page: number;
  totalPages: number;
  total: number;
  shown: number;
  /** What a row is called, singular as it reads after a number: «طلب», «عميل», «مرتجع». */
  noun: string;
  /**
   * Replaces the count on the start side. A list that already says its count
   * elsewhere passes `null` (nothing is drawn there), and one with its own wording
   * («إجمالي N مستخدم») passes it here — the arrows and «صفحة X من Y» are the same either way.
   */
  label?: React.ReactNode;
  loading?: boolean;
  onPage: (page: number) => void;
}) {
  const last = Math.max(totalPages, 1);
  return (
    <div className="flex items-center justify-between text-xs text-[var(--sys-muted-foreground)]">
      <span>
        {label !== undefined ? (
          label
        ) : (
          <>
            عرض <strong>{shown}</strong> من <strong>{total}</strong> {noun}
          </>
        )}
      </span>
      <div className="flex items-center space-x-2 rtl:space-x-reverse">
        <Button
          size="sm"
          variant="outline"
          loading={loading}
          disabled={loading || page <= 1}
          onClick={() => onPage(page - 1)}
          aria-label="الصفحة السابقة"
          title="الصفحة السابقة"
          className="p-1.5"
        >
          <RiArrowLeftSLine className="icon-mirror w-4 h-4" />
        </Button>
        <span className="font-medium">
          صفحة {page} من {last}
        </span>
        <Button
          size="sm"
          variant="outline"
          loading={loading}
          disabled={loading || page >= last}
          onClick={() => onPage(page + 1)}
          aria-label="الصفحة التالية"
          title="الصفحة التالية"
          className="p-1.5"
        >
          <RiArrowRightSLine className="icon-mirror w-4 h-4" />
        </Button>
      </div>
    </div>
  );
}
