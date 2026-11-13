'use client';

import React, { useState } from 'react';
import { RiCheckLine, RiLoader4Line, RiShieldCheckLine } from '@remixicon/react';
import { apiJson } from '@/lib/api-client';
import { OrderNotesPeek } from '@/components/orders/OrderNotesPeek';
import {
  EXCHANGE_AR,
  EXCHANGE_KIND,
  EXCHANGE_MEANING,
  PARKED,
  PARKED_AR,
  RESOLUTION_AR,
  RESOLUTION_MEANING,
  RESOLUTIONS,
  isExchange,
  type Resolution,
} from '@/lib/settlement-difference';
import { EXPLANATION_SENTENCE, explanationOf } from '@/lib/decision-words';
import { STATEMENT_CLOSED_SENTENCE } from '@/lib/settlement-gates';
import { useIsPhone } from '@/hooks/useIsPhone';

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
 *
 * ── «طلب تبديل» IS THE THIRD BUTTON, AND IT IS THE FIRST ONE WITH A REASON ──
 *
 * «احيانا بيكون طلب تبديل او زبون وصلو الطلب ناقص فنبعثلو حبة» (the owner, 13/11). A replacement, or a piece sent to a customer whose
 * order came short, has no price to collect — the «difference» is the whole price of an order nobody was to pay for. The button
 * answers «اعتُمد رقم الشركة» and says WHY (`exchange: true`), so the line is not counted as a discount somebody gave and nobody is
 * asked to carry its shortfall. It is allowed exactly where their figure is — it reads that button's verdict, and greys with that
 * button's sentence — and it is offered here, one order at a time, and not in the bulk answer. «غيّر البتّ» moves a line to or from it.
 */

/** What the server's matrix says about each saying, for THIS order as it is now: allowed, or the sentence why not. */
type Verdicts = Record<string, { allowed: boolean; why: string | null }>;

interface Props {
  statementId: string;
  matchId: string;
  orderId: string | null;
  orderNumber: string | null;
  resolution: string | null;
  /** `EXCHANGE` beside «اعتُمد رقم الشركة» is «طلب تبديل». Absent (an older server) or null: not an exchange. */
  resolutionKind?: string | null;
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
  resolutionKind,
  resolutionNote,
  onResolved,
  decisions,
  claim,
  currency,
  locked,
  parkOnly,
}: Props) {
  const [busy, setBusy] = useState<Resolution | typeof PARKED | typeof EXCHANGE_KIND | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState('');
  // The two money decisions say which is which WITHOUT a hover on a phone (there is none): each at rest wears the
  // colour the desk shows only under the pointer, and what each one means is printed under the pair.
  const phone = useIsPhone();
  // An answered row may be answered again until the approval acts on it — the way out of «an order changed».
  const [again, setAgain] = useState(false);
  // While a person changes the answer, the row is read as unanswered; once it is saved the new answer shows.
  const resolution = again ? null : saved;

  const resolve = async (choice: Resolution | typeof PARKED, exchange = false) => {
    // The explanation is the person's, five characters at least: the same rule the door holds.
    const explanation = explanationOf(note);
    if (!explanation) {
      setError(EXPLANATION_SENTENCE);
      return;
    }
    setBusy(exchange ? EXCHANGE_KIND : choice);
    setError(null);
    try {
      await apiJson(`/api/finance/statements/${statementId}/matches/${matchId}/resolve`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        // «طلب تبديل» is «اعتُمد رقم الشركة» with a reason: the field is sent ONLY for it, so every other answer is the body it always was.
        body: JSON.stringify(
          exchange ? { resolution: choice, exchange: true, note: explanation } : { resolution: choice, note: explanation }
        ),
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
          {isExchange({ resolution, resolutionKind })
            ? EXCHANGE_AR
            : known
              ? RESOLUTION_AR[resolution as Resolution]
              : resolution === PARKED
                ? PARKED_AR
                : resolution}
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
              ? phone
                ? 'border-[var(--sys-success)] text-[var(--sys-success)]'
                : 'border-[var(--sys-border)] text-[var(--sys-muted-foreground)] hover:border-[var(--sys-success)] hover:text-[var(--sys-success)]'
              : phone
                ? 'border-[var(--sys-warning)] text-[var(--sys-warning)]'
                : 'border-[var(--sys-border)] text-[var(--sys-muted-foreground)] hover:border-[var(--sys-warning)] hover:text-[var(--sys-warning)]'
          }`}
        >
          {busy === r ? <RiLoader4Line className="h-4 w-4 animate-spin" /> : <RiShieldCheckLine className="h-4 w-4" />}
          {RESOLUTION_AR[r]}
        </button>
      ))}
      {/* «طلب تبديل»: their figure with a reason. It is greyed by THEIR figure's verdict — the same cell, so the same sentence below. */}
      {!parkOnly && (
        <button
          type="button"
          disabled={busy !== null || !verdict('ACCEPTED_COURIER').allowed}
          title={EXCHANGE_MEANING}
          onClick={() => void resolve('ACCEPTED_COURIER', true)}
          className="min-h-11 md:min-h-0 inline-flex items-center gap-1 rounded-md border px-2 py-1 text-xs font-medium transition-colors disabled:opacity-50 border-[var(--sys-border)] text-[var(--sys-muted-foreground)] hover:border-[var(--sys-success)] hover:text-[var(--sys-success)]"
        >
          {busy === EXCHANGE_KIND ? <RiLoader4Line className="h-4 w-4 animate-spin" /> : null}
          {EXCHANGE_AR}
        </button>
      )}
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
      {phone && !parkOnly && (
        <span className="block w-full space-y-1 text-xs text-[var(--sys-muted-foreground)]">
          {RESOLUTIONS.map((r) => (
            <span key={r} className="block">
              <b className="font-semibold">{RESOLUTION_AR[r]}:</b> {RESOLUTION_MEANING[r]}
            </span>
          ))}
          <span className="block">
            <b className="font-semibold">{EXCHANGE_AR}:</b> {EXCHANGE_MEANING}
          </span>
        </span>
      )}
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
