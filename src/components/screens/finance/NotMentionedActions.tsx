'use client';

import React, { useState } from 'react';
import { RiCheckLine, RiExternalLinkLine, RiLoader4Line, RiShieldCheckLine } from '@remixicon/react';
import { apiJson } from '@/lib/api-client';
import {
  NOT_MENTIONED_ACTIONS,
  NOT_MENTIONED_AR,
  NOT_MENTIONED_MEANING,
  actionOfActivity,
  type NotMentionedAction,
} from '@/lib/not-mentioned';

/**
 * WHAT TO DO ABOUT A PARCEL WE DELIVERED THAT NO STATEMENT NAMES.
 *
 * Three answers, each recorded on the ORDER (see `lib/not-mentioned`): look again at a later statement, ask
 * the company for it, or say it was never delivered. None of them moves money or changes a status. The
 * third is offered only where a door exists to correct the status — a delivered order and a person who
 * holds «orders.unlock» — and it leads there: the order page, where the correction is made.
 *
 * What was last recorded stays on the row as a chip, so the next person to open the statement sees that
 * the parcel was already looked at and does not ask the same question twice.
 */

interface Props {
  statementId: string;
  matchId: string;
  orderId: string;
  orderNumber: string;
  /** Is there a door that can correct this order's status, for this person? */
  canCorrectStatus: boolean;
  /** The last answer recorded on the order, as stored. */
  followUp: { action: string; at: string } | null;
  onDone: () => void;
}

export function NotMentionedActions({ statementId, matchId, orderId, orderNumber, canCorrectStatus, followUp, onDone }: Props) {
  const [busy, setBusy] = useState<NotMentionedAction | null>(null);
  const [error, setError] = useState<string | null>(null);
  const last = actionOfActivity(followUp?.action);

  const send = async (action: NotMentionedAction) => {
    setBusy(action);
    setError(null);
    try {
      await apiJson(`/api/finance/statements/${statementId}/matches/${matchId}/order-action`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action }),
      });
      onDone();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'تعذّر الحفظ');
    } finally {
      setBusy(null);
    }
  };

  return (
    <span className="inline-flex flex-wrap items-center gap-1.5">
      {last && (
        <span className="inline-flex items-center gap-1 rounded-full border border-[var(--sys-success)]/40 bg-[var(--sys-success-soft)] px-2.5 py-1 text-xs font-semibold text-[var(--sys-success)]">
          <RiCheckLine className="h-4 w-4" />
          {NOT_MENTIONED_AR[last]}
        </span>
      )}
      {NOT_MENTIONED_ACTIONS.filter((a) => a !== 'NOT_DELIVERED' || canCorrectStatus).map((a) => (
        <button
          key={a}
          type="button"
          disabled={busy !== null}
          title={NOT_MENTIONED_MEANING[a]}
          onClick={() => void send(a)}
          className="min-h-11 md:min-h-0 inline-flex items-center gap-1 rounded-md border px-2 py-1 text-xs font-medium transition-colors disabled:opacity-50 border-[var(--sys-border)] text-[var(--sys-muted-foreground)] hover:border-[var(--sys-warning)] hover:text-[var(--sys-warning)]"
        >
          {busy === a ? <RiLoader4Line className="h-4 w-4 animate-spin" /> : <RiShieldCheckLine className="h-4 w-4" />}
          {NOT_MENTIONED_AR[a]}
        </button>
      ))}
      {last === 'NOT_DELIVERED' && canCorrectStatus && (
        <a
          href={`/orders/${orderId}`}
          className="inline-flex items-center gap-1 text-xs text-[var(--sys-primary)] hover:underline"
          title={`افتح الطلب ${orderNumber} لتصحيح حالته`}
        >
          <RiExternalLinkLine className="icon-mirror h-4 w-4" />
          افتح الطلب
        </a>
      )}
      {error && <span className="text-xs text-[var(--sys-destructive)]">{error}</span>}
    </span>
  );
}
