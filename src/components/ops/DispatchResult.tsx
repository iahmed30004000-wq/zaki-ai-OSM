'use client';

import React, { useId, useState } from 'react';
import type { DispatchSummary } from '@/lib/courier-dispatch';
import { groupDispatchReasons, type DispatchReasonGroup } from '@/lib/dispatch-reason';

/**
 * WHAT CAME BACK FROM SENDING A BATCH TO THE COURIER — ONE BOX FOR BOTH SCREENS.
 *
 * The batches screen and the banner after «إنشاء شحنة» both send a batch and both showed one line per refused order.
 * Thirty-five orders refused for one reason filled the page. Here the failures are grouped by reason, the larger
 * group first, and the order numbers of a group sit behind a real button — closed until somebody asks for them.
 * The summary line stays as it was.
 */
export function DispatchResult({
  summary,
  savedNote,
  onClearSend,
}: {
  summary: DispatchSummary;
  savedNote: string;
  /**
   * The way out of a send that never answered. Offered only where the screen
   * can carry it out; the orders it is offered for are the ones whose send is
   * «قيد الإرسال» or may have created a parcel.
   */
  onClearSend?: (order: { orderId: string; orderNumber: string }) => void;
}) {
  const groups = groupDispatchReasons(summary.outcomes);
  const stuck = onClearSend
    ? summary.outcomes.filter((o) => !o.ok && (o.skipped === 'SEND_IN_FLIGHT' || o.outcomeUnknown))
    : [];
  return (
    <div className="rounded-lg border border-[var(--sys-border)] bg-[var(--sys-surface)] p-2.5 space-y-1">
      <p className="text-xs font-bold text-[var(--sys-heading)]">
        رُحّل {summary.sent}
        {summary.skipped > 0 && ` · تُخطّي ${summary.skipped}`}
        {summary.failed > 0 && ` · فشل ${summary.failed}`}
      </p>
      {groups.map((g) => (
        <ReasonGroup key={`${g.outcomeUnknown ? 'U' : 'K'}|${g.reason}`} group={g} />
      ))}
      {stuck.length > 0 && onClearSend && (
        <div className="space-y-1">
          <p className="text-xs text-[var(--sys-muted-foreground)]">سألت الشركة وما عندها طرد لهالطلبات؟</p>
          {stuck.map((o) => (
            <button
              key={o.orderId}
              type="button"
              onClick={() => onClearSend({ orderId: o.orderId, orderNumber: o.orderNumber })}
              className="min-h-11 md:min-h-0 inline-flex items-center text-xs font-medium text-[var(--sys-primary)] underline"
            >
              تحقّقتُ مع الشركة — لا طرد عندهم ({o.orderNumber})
            </button>
          ))}
        </div>
      )}
      {summary.outcomes.some((o) => o.ok) && <p className="text-xs text-[var(--sys-success)]">{savedNote}</p>}
    </div>
  );
}

function ReasonGroup({ group }: { group: DispatchReasonGroup }) {
  const [open, setOpen] = useState(false);
  const listId = useId();
  return (
    <div className="space-y-1">
      {/*
        «Maybe it was sent» is not the same news as «it failed», and the difference is a second parcel at the
        customer's door. It is coloured as the warning it is, not left in the grey list where the eye reads it as one
        more failure to retry.
      */}
      <p className={group.outcomeUnknown ? 'text-xs font-bold text-[var(--sys-warning)]' : 'text-xs text-[var(--sys-muted-foreground)]'}>
        {group.count} طلب — {group.reason}
      </p>
      <button
        type="button"
        aria-expanded={open}
        aria-controls={open ? listId : undefined}
        onClick={() => setOpen(!open)}
        className="min-h-11 md:min-h-0 inline-flex items-center text-xs font-medium text-[var(--sys-primary)] underline"
      >
        {open ? 'خبّي الطلبات' : `اعرض الطلبات (${group.count})`}
      </button>
      {open && (
        <p id={listId} className="flex flex-wrap gap-1.5 text-xs text-[var(--sys-muted-foreground)]">
          {group.orderNumbers.map((n) => (
            <span key={n} className="font-mono" dir="ltr">{n}</span>
          ))}
        </p>
      )}
    </div>
  );
}
