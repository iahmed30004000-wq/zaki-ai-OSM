'use client';

import React from 'react';
import { Modal } from '@/components/ui/Modal';
import { Button } from '@/components/ui/Button';
import { Money } from '@/components/ui/Money';
import { DifferenceActions } from '@/components/screens/finance/DifferenceActions';
import { CourierReason } from '@/components/screens/finance/CourierReason';
import { STATEMENT_CLOSED_SENTENCE } from '@/lib/settlement-gates';
import {
  COMPANY_LINE_AR,
  MATCHING_NOTE_AR,
  NEEDS_REVIEW_KEY_AR,
  OURS_AR,
  THEIRS_AR,
  differenceDoneMessage,
  gapWord,
  type DifferenceOnTheRow,
} from '@/lib/parcel-tracking/difference-words';

/**
 * «فيه فرق» — THE TWO FIGURES, THE COMPANY'S OWN WORD, AND THE ANSWER, WITHOUT LEAVING THE FOLLOW-UP SCREEN.
 *
 *   «عشان بنت المتابعة تبث فيه وتعتمد رقمنا او رقم الشركة» (the owner, 13/11)
 *
 * It opens from the mark on a parcel and shows what the follow-up girl needs to decide — ours against the company's, the
 * gap as the shop reads it, what the matching itself said about the line, and what the company wrote — and then MOUNTS the
 * matching screen's own answer (`DifferenceActions`) for that very match row: the same answers, the same explanation of
 * five characters at least, the same door (`POST /api/finance/statements/:id/matches/:matchId/resolve`, key
 * `settlement.review`) and the same matrix, so a greyed answer carries the sentence the door would give. NOTHING of the
 * decision is written here: this draws, and the door decides.
 *
 * «طلب تبديل» (the owner, 13/11) comes with those answers: the third button of `DifferenceActions`, and — once the line is
 * answered that way — its chip. The row carries the qualifier beside the answer (`resolutionKind`); this hands it on and does
 * not read it, so the dialog and the mark say the same word as the matching screen.
 *
 * ── WHAT IS OFFERED, AND WHEN ──
 *
 *   · an answer is taken only BEFORE the statement's matching is closed. After it the dialog says so in the door's own
 *     sentence — «الكشف مغلق نهائياً — التصحيح بكشف تسوية» — shows the answer read-only if there is one, and offers no
 *     button the door would refuse;
 *   · the answers are drawn only for a person the server says may decide (`mayDecide`); one who may see the figures but not
 *     decide sees them, and the answer read-only, with the sentence that says why there is nothing to press.
 *
 * Success is the parent's: it closes this dialog and reads the list again.
 */
export function DifferenceDialog({
  order,
  mayDecide,
  onClose,
  onDone,
}: {
  order: { id: string; orderNumber: string; merchantRef: string | null; currency: string; difference: DifferenceOnTheRow };
  /** `acts.decide` of the server's answer: what to draw, never what to allow — the door asks the key again. */
  mayDecide: boolean;
  onClose: () => void;
  onDone: (message: string) => void;
}) {
  const d = order.difference;
  const ref = order.merchantRef ?? order.orderNumber;
  const word = gapWord(d.gap);
  const figure = (v: number | null) => (v === null ? '—' : <Money value={v} currency={order.currency} />);
  // The answers are offered while the statement takes one (and only to whoever may give it); an answered line is shown either way.
  const showAnswers = d.answered || (mayDecide && !d.closed);

  return (
    <Modal
      isOpen
      onClose={onClose}
      title={`فيه فرق — ${ref}`}
      subtitle={`كشف ${d.statement}`}
      maxWidth="md"
      footer={
        <Button size="md" variant="secondary" onClick={onClose}>
          رجوع
        </Button>
      }
    >
      <div className="space-y-3 text-sm text-[var(--sys-foreground)]">
        <div className="grid grid-cols-2 gap-2">
          <div className="rounded-lg border border-[var(--sys-border)] bg-[var(--sys-surface)] p-3">
            <p className="text-xs text-[var(--sys-muted-foreground)]">{OURS_AR}</p>
            <p className="mt-1 text-lg font-bold text-[var(--sys-heading)] tabular-nums">{figure(d.ours)}</p>
          </div>
          <div className="rounded-lg border border-[var(--sys-border)] bg-[var(--sys-surface)] p-3">
            <p className="text-xs text-[var(--sys-muted-foreground)]">{THEIRS_AR}</p>
            <p className="mt-1 text-lg font-bold text-[var(--sys-heading)] tabular-nums">{figure(d.theirs)}</p>
          </div>
        </div>

        {word && d.gap !== null && (
          <p className="text-sm font-semibold text-[var(--sys-destructive)]">
            {word}: <Money value={Math.abs(d.gap)} currency={order.currency} />
          </p>
        )}

        {d.note && (
          <p className="text-xs leading-relaxed text-[var(--sys-muted-foreground)]">
            {MATCHING_NOTE_AR}: {d.note}
          </p>
        )}

        {/* What the company wrote is the statement's content: the door sends it to whoever may open a statement, and to nobody else. */}
        {(d.courierWord || d.statementLine) && (
          <div className="space-y-1">
            <p className="text-xs text-[var(--sys-muted-foreground)]">{COMPANY_LINE_AR}</p>
            <div className="rounded-lg border border-[var(--sys-border)] p-3">
              <CourierReason m={{ courierWord: d.courierWord, statementLine: d.statementLine }} />
            </div>
          </div>
        )}

        {d.closed && <p className="text-xs leading-relaxed text-[var(--sys-muted-foreground)]">{STATEMENT_CLOSED_SENTENCE}</p>}
        {!d.closed && !mayDecide && !d.answered && (
          <p className="text-xs leading-relaxed text-[var(--sys-muted-foreground)]">{NEEDS_REVIEW_KEY_AR}</p>
        )}

        {showAnswers && (
          <DifferenceActions
            statementId={d.statementId}
            matchId={d.matchId}
            orderId={order.id}
            orderNumber={order.orderNumber}
            resolution={d.resolution}
            resolutionKind={d.resolutionKind}
            resolutionNote={d.resolutionNote}
            decisions={d.decisions}
            claim={d.claim}
            currency={order.currency}
            locked={d.closed || !mayDecide}
            onResolved={() => onDone(differenceDoneMessage(ref))}
          />
        )}
      </div>
    </Modal>
  );
}
