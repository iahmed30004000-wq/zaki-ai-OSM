'use client';

import React, { useState } from 'react';
import { RiCheckLine, RiLoader4Line, RiShieldCheckLine } from '@remixicon/react';
import { apiJson } from '@/lib/api-client';
import { OrderNotesPeek } from '@/components/orders/OrderNotesPeek';
import { PARKED, PARKED_AR, RESOLUTION_AR, RESOLUTION_MEANING, RESOLUTIONS, type Resolution } from '@/lib/settlement-difference';
import { EXPLANATION_SENTENCE, explanationOf } from '@/lib/decision-words';
import { STATEMENT_CLOSED_SENTENCE } from '@/lib/settlement-gates';

/**
 * WHAT TO DO ABOUT A DIFFERENCE, WHERE THE DIFFERENCE IS.
 *
 * «عند المطابقة في فرق… حط زر أشاهد التعليقات الداخلية، وزر ترحيل على
 * اعتماد. ممكن عادي صار خصم، بس يعتمد رقم الشركة. وإذا غير معتمد أنا رح
 * أتواصل مع الشركة وخط اعتماد رقمنا. بس بضل الطلب معلّم.»
 *
 * The screen used to show the two figures and stop. The reader could see
 * that the courier's number and ours disagreed and could do nothing with
 * it — so the same parcel was argued over again at the next statement, and
 * the commonest cause was never recorded anywhere.
 *
 * ── THE NOTES BUTTON IS NOT A CONVENIENCE ──
 *
 * It is where the answer usually already is. An agent agreed a discount on
 * the phone to save the sale and wrote it in the order's internal notes;
 * finance never reads those, because a note is prose and a statement is a
 * number. One press puts the prose beside the number.
 */

/** What the server's matrix says about each saying, for THIS order as it is now: allowed, or the sentence why not. */
type Verdicts = Record<string, { allowed: boolean; why: string | null }>;

interface Props {
  statementId: string;
  matchId: string;
  orderId: string | null;
  orderNumber: string | null;
  resolution: string | null;
  resolutionNote: string | null;
  onResolved: () => void;
  /** The matrix for this row (settlement-decisions). Absent: every saying is offered and the door decides. */
  decisions?: Verdicts | null;
  /** What the company still owes, when our figure was the one that stood. */
  claim?: number | null;
  currency?: string;
  /** The statement is closed for good (approved): no answer is taken any more — the correction is a settlement statement. */
  locked?: boolean;
  /** A line no order carries: no figure to choose, only «قيد المراجعة» with its reason (the one answer it may have). */
  parkOnly?: boolean;
}

/*
 * INTERNAL ONLY. A note written to the customer is not evidence about a
 * discount somebody agreed, and putting the two in one list would let a
 * reader take one for the other.
 */
const INTERNAL_ONLY = ['internal'] as const;

export function DifferenceActions({
  statementId,
  matchId,
  orderId,
  orderNumber,
  resolution: saved,
  resolutionNote,
  onResolved,
  decisions,
  claim,
  currency,
  locked,
  parkOnly,
}: Props) {
  const [busy, setBusy] = useState<Resolution | typeof PARKED | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState('');
  // An answered row may be answered again until the approval acts on it — the way out of «an order changed».
  const [again, setAgain] = useState(false);
  // While a person changes the answer, the row is read as unanswered; once it is saved the new answer shows.
  const resolution = again ? null : saved;

  const resolve = async (choice: Resolution | typeof PARKED) => {
    // The explanation is the person's, five characters at least: the same rule the door holds.
    const explanation = explanationOf(note);
    if (!explanation) {
      setError(EXPLANATION_SENTENCE);
      return;
    }
    setBusy(choice);
    setError(null);
    try {
      await apiJson(`/api/finance/statements/${statementId}/matches/${matchId}/resolve`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ resolution: choice, note: explanation }),
      });
      setAgain(false);
      onResolved();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'تعذّر الحفظ');
    } finally {
      setBusy(null);
    }
  };

  /**
   * ALREADY ANSWERED — and the order is still marked.
   *
   * The chip does not replace the row or move it out of the difference
   * queue: «بس بضل الطلب معلّم». Recording what was decided is not the same
   * as deciding it never happened, and the count per person is the reason
   * it was written down at all.
   */
  if (resolution) {
    const known = (RESOLUTIONS as readonly string[]).includes(resolution);
    return (
      <span className="inline-flex flex-wrap items-center gap-1.5">
        <span className="inline-flex items-center gap-1 rounded-full border border-[var(--sys-success)]/40 bg-[var(--sys-success-soft)] px-2.5 py-1 text-xs font-semibold text-[var(--sys-success)]">
          <RiCheckLine className="h-4 w-4" />
          {known ? RESOLUTION_AR[resolution as Resolution] : resolution === PARKED ? PARKED_AR : resolution}
        </span>
        {resolution === 'OURS_STANDS' && claim ? (
          <span className="text-xs font-medium text-[var(--sys-warning)]">
            مطالبة على الشركة {claim} {currency ?? ''}
          </span>
        ) : null}
        {resolutionNote && <span className="text-xs text-[var(--sys-muted-foreground)]">{resolutionNote}</span>}
        {!locked && (
          <button
            type="button"
            onClick={() => setAgain(true)}
            className="min-h-11 md:min-h-0 inline-flex items-center gap-1 rounded-md border px-2 py-1 text-xs font-medium transition-colors border-[var(--sys-border)] text-[var(--sys-muted-foreground)] hover:border-[var(--sys-warning)] hover:text-[var(--sys-warning)]"
          >
            غيّر البتّ
          </button>
        )}
        {orderId && (
          <OrderNotesPeek
            orderId={orderId}
            orderNumber={orderNumber}
            kinds={INTERNAL_ONLY}
            emptyText="لا تعليق داخليّ على هذا الطلب — فلا خصمَ مكتوبٌ يفسّر الفرق."
          />
        )}
      </span>
    );
  }

  // A closed statement takes no answer: the row says why, in the sentence every door of it gives.
  if (locked) {
    return <span className="text-xs text-[var(--sys-muted-foreground)]">{STATEMENT_CLOSED_SENTENCE}</span>;
  }

  // What the server's matrix says, once, per saying: the sentence that explains a greyed-out button is the one
  // the door would answer with.
  const verdict = (k: string) => decisions?.[k] ?? { allowed: true, why: null };
  const refusal = [...RESOLUTIONS, PARKED].map((k) => verdict(k)).find((v) => !v.allowed)?.why ?? null;

  return (
    <span className="inline-flex flex-wrap items-center gap-1.5">
      <input
        type="text"
        value={note}
        onChange={(e) => setNote(e.target.value)}
        placeholder={EXPLANATION_SENTENCE}
        aria-label="تفسير القرار"
        className="h-11 md:h-10 px-3 rounded-lg border border-[var(--sys-border-input)] text-sm bg-[var(--sys-card)] min-w-[220px]"
      />
      {!parkOnly && RESOLUTIONS.map((r) => (
        <button
          key={r}
          type="button"
          disabled={busy !== null || !verdict(r).allowed}
          title={RESOLUTION_MEANING[r]}
          onClick={() => void resolve(r)}
          className={`min-h-11 md:min-h-0 inline-flex items-center gap-1 rounded-md border px-2 py-1 text-xs font-medium transition-colors disabled:opacity-50 ${
            r === 'ACCEPTED_COURIER'
              ? 'border-[var(--sys-border)] text-[var(--sys-muted-foreground)] hover:border-[var(--sys-success)] hover:text-[var(--sys-success)]'
              : 'border-[var(--sys-border)] text-[var(--sys-muted-foreground)] hover:border-[var(--sys-warning)] hover:text-[var(--sys-warning)]'
          }`}
        >
          {busy === r ? <RiLoader4Line className="h-4 w-4 animate-spin" /> : <RiShieldCheckLine className="h-4 w-4" />}
          {RESOLUTION_AR[r]}
        </button>
      ))}
      {/* Where neither figure can be settled yet, this is the answer that is always there. */}
      <button
        type="button"
        disabled={busy !== null}
        title="قيد المراجعة — لا يُسوّى شيء ولا يُطالَب بشيء؛ تسجيل أنك رأيت السطر وأجّلته"
        onClick={() => void resolve(PARKED)}
        className="min-h-11 md:min-h-0 inline-flex items-center gap-1 rounded-md border px-2 py-1 text-xs font-medium transition-colors disabled:opacity-50 border-[var(--sys-border)] text-[var(--sys-muted-foreground)] hover:border-[var(--sys-warning)] hover:text-[var(--sys-warning)]"
      >
        {busy === PARKED ? <RiLoader4Line className="h-4 w-4 animate-spin" /> : null}
        {PARKED_AR}
      </button>
      {refusal && !parkOnly && <span className="text-xs text-[var(--sys-muted-foreground)]">{refusal}</span>}
      {orderId && (
        <OrderNotesPeek
          orderId={orderId}
          orderNumber={orderNumber}
          kinds={INTERNAL_ONLY}
          emptyText="لا تعليق داخليّ على هذا الطلب — فلا خصمَ مكتوبٌ يفسّر الفرق."
        />
      )}
      {error && <span className="text-xs text-[var(--sys-destructive)]">{error}</span>}
    </span>
  );
}
