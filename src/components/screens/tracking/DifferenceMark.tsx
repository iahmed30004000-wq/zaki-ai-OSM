'use client';

import React from 'react';
import { Money } from '@/components/ui/Money';
import type { HealthTone } from '@/lib/health';
import { gapWord, markHead, markTitle, markTone, type DifferenceOnTheRow } from '@/lib/parcel-tracking/difference-words';

/**
 * «فيه فرق» — THE MARK BESIDE A PARCEL WHOSE MATCHING CAME BACK WITH A DIFFERENCE.
 *
 *   «واذا المطابقة رجعت في فرق حط جنبو علامة انو في فرق عشان بنت المتابعة تشيك» (the owner, 13/11)
 *
 * It sits with the row's other chips (the reason it is in front of you, what the company says) and carries what the
 * follow-up girl needs at a glance: that there is a difference, and how much — as the shop reads it: «نقص» when the
 * company paid less than we expected, «زيادة» when it paid more. Once somebody has answered it, it wears the answer's own
 * word in place of the red one (the order stays marked: «بس بضل الطلب معلّم») with the figure beside it.
 *
 * A real button, 44px on a phone: it opens the dialog that shows the two figures and takes the answer. The figures and the
 * words are the server's (`difference`) and the library's; this draws.
 */

/** The same four tones every verdict is painted with (`HealthChip`) — the mark invents no colour of its own. */
const TONE: Record<HealthTone, string> = {
  good: 'bg-[var(--sys-success-soft)] text-[var(--sys-success)] border-[var(--sys-success)]/30',
  ok: 'bg-[var(--sys-warning-soft)] text-[var(--sys-warning)] border-[var(--sys-warning)]/30',
  bad: 'bg-[var(--sys-destructive-soft)] text-[var(--sys-destructive)] border-[var(--sys-destructive-border)]',
  unknown: 'bg-[var(--sys-surface)] text-[var(--sys-muted-foreground)] border-[var(--sys-border)]',
};

export function DifferenceMark({
  difference,
  currency,
  mayDecide,
  onOpen,
}: {
  difference: DifferenceOnTheRow;
  currency: string;
  /** The server said this person may answer (`acts.decide`): only the tooltip differs — the dialog decides what is offered. */
  mayDecide: boolean;
  onOpen: () => void;
}) {
  const word = gapWord(difference.gap);
  return (
    <button
      type="button"
      onClick={onOpen}
      title={markTitle(difference, mayDecide)}
      className={`mt-1 flex w-fit min-h-11 md:min-h-0 items-center gap-1.5 rounded-md border px-2 py-0.5 text-xs font-medium ${TONE[markTone(difference)]}`}
    >
      <span>{markHead(difference)}</span>
      {word && difference.gap !== null && (
        <>
          {/* Spaces between the parts are not drawn in a flex box, and are what makes the button's spoken name read as words. */}
          {' '}
          <span aria-hidden="true">·</span>
          {' '}
          <span>{word}</span>
          {' '}
          <Money value={Math.abs(difference.gap)} currency={currency} />
        </>
      )}
    </button>
  );
}
