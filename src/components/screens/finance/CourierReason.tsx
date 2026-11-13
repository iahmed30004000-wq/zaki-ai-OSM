'use client';

import React from 'react';
import { lineEssentials, readCourierRow } from '@/lib/statement-line-reading';

/**
 * «سبب الشركة» — WHAT THE COMPANY SAID ABOUT THE LINE, IN THE FOUR THINGS THE OWNER ASKED FOR.
 *
 * «هاي كلها لغي، بدي بس الأشياء الأساسية: العنوان والمحافظة ورقم الهاتف والحالة» (8/11), said of a cell that dumped every
 * other cell of the row — the sender, the store, two dates as spreadsheet serial numbers, the payment method, the parcel's
 * content. So the cell says: the company's status word (and what we make of it), the phone, the governorate, the address.
 *
 * The figures are not here (they are the columns beside it) and neither is the order number (under the barcode). Nothing is
 * hidden by that: the whole row as the company wrote it stays one press away, behind «النص الأصلي».
 *
 * A line imported before the file's headings were kept (`StatementLine.receiver*`) has no governorate or address to show: it
 * shows its status and the phone read from its row, and the rest is behind «النص الأصلي». Display only.
 *
 * Its own file (13/11) so that the follow-up screen's «فيه فرق» dialog draws the very same cell without dragging the whole
 * matching screen into its page; the matching screen still draws it, from here.
 */

/** The company's own line, as the matching screen carries it (and the follow-up screen's dialog): the cells this reads. */
export interface CourierReasonLine {
  merchantRef: string | null;
  barcode: string | null;
  amount: string | number;
  /** What the company says it collected, and the fee it kept — when its file had those columns. */
  collected?: string | number | null;
  fee?: string | number | null;
  /** The company's own status cell, and the whole row as it wrote it (notes column included). */
  status: string | null;
  rawRow: string | null;
  /** Who the parcel went to, under the headings the file wrote them. Null on a line imported before they were kept. */
  receiverName?: string | null;
  receiverPhone?: string | null;
  receiverAddress?: string | null;
  receiverCity?: string | null;
  receiverArea?: string | null;
}

export interface CourierReasonProps {
  m: {
    /** The status word read through the one phrase table: what it says, and whether the table knows it. */
    courierWord: { phrase: string; outcome: string; known: boolean; label: string } | null;
    statementLine: CourierReasonLine | null;
  };
}

export function CourierReason({ m }: CourierReasonProps) {
  const word = m.courierWord;
  const line = m.statementLine;
  const e = line ? lineEssentials(line) : null;
  // The row exactly as the company wrote it (`readCourierRow` hands it back whole, untouched).
  const raw = m.statementLine?.rawRow ? readCourierRow(m.statementLine).raw : null;
  const hasFacts = !!(e?.phone || e?.governorate || e?.address);
  if (!word && !e?.status && !hasFacts && !raw) return <span className="text-[var(--sys-muted)]">—</span>;
  return (
    <span className="block">
      {word ? (
        <span className="block font-medium">
          «{word.phrase}» <span className="text-xs text-[var(--sys-muted-foreground)]">{word.label}</span>
        </span>
      ) : (
        e?.status && <span className="block text-xs text-[var(--sys-muted-foreground)]">الحالة: {e.status}</span>
      )}
      {hasFacts && (
        <span className="block text-xs text-[var(--sys-muted-foreground)]">
          {e?.phone && (
            <span className="block">
              الهاتف: <b dir="ltr">{e.phone.shown}</b>
            </span>
          )}
          {e?.governorate && (
            <span className="block">
              المحافظة: <span dir="auto">{e.governorate}</span>
            </span>
          )}
          {e?.address && (
            <span className="block" dir="auto">
              العنوان: {e.address}
            </span>
          )}
        </span>
      )}
      {raw && (
        <details>
          <summary className="cursor-pointer text-xs text-[var(--sys-muted)]">النص الأصلي</summary>
          <span className="block text-xs text-[var(--sys-muted)]" dir="auto">
            {raw}
          </span>
        </details>
      )}
    </span>
  );
}
