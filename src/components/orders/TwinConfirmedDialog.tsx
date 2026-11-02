'use client';

import React, { useState } from 'react';
import { RiErrorWarningLine } from '@remixicon/react';
import { Modal } from '@/components/ui/Modal';
import { Button } from '@/components/ui/Button';
import { humanMinutes } from '@/components/ui/Elapsed';
import type { ConfirmedTwinView } from '@/lib/twin-refusal';

/**
 * «الزبون عنده طلب مؤكَّد بنفس المنتج» — THE QUESTION THE CONFIRMATION DOOR ASKS BEFORE A SECOND «نعم».
 *
 * ONE DIALOG, DRAWN BY BOTH PLACES THAT CONFIRM («طلباتي» and the order window), because the three buttons are one decision and a
 * decision written twice is the thing that drifts. It is the answer to a 409 `TWIN_CONFIRMED` (see `confirmed-twin.ts`): the
 * customer already has a confirmed order for the same product that the courier has not taken, and nothing was written.
 *
 * It lists the other orders by number, by colleague and by how long ago — the three things an agent says out loud — and offers
 * exactly three ways out:
 *
 *   «رفضه كمكرر»            the order she is confirming is the same order sent again: the door's own reject, with the reason that
 *                           already exists (`DUPLICATE_ORDER`). The safe one, drawn first and in the destructive colour because it
 *                           ends the order she holds.
 *   «طلب تاني فعلاً — أكّد» the customer really wants a second one: the confirm again, with her word that she knows.
 *   «رجوع»                  neither, yet — close the question and call the customer back.
 *
 * It SENDS NOTHING itself. Each screen sends the body with its own client and says what happened in its own place (the desk's
 * banner, the window's feedback line); the bodies come from `twin-refusal.ts`, written once. So the dialog is the words, the
 * list and the three buttons — nothing that could differ between the two screens.
 *
 * A PHONE: the three buttons stack at the full width, each 44px tall (the shared `Button`), the destructive one on top; from the
 * desk's width they sit in one row. The row is the Modal's footer, so it stays on screen when the list scrolls.
 */
export function TwinConfirmedDialog({
  open,
  orderNumber,
  twins,
  busy,
  onRejectAsDuplicate,
  onConfirmAnyway,
  onBack,
  now,
}: {
  open: boolean;
  /** The order she is confirming. */
  orderNumber: string;
  twins: ConfirmedTwinView[];
  /** A decision is in the air: the three buttons shut. */
  busy?: boolean;
  onRejectAsDuplicate: () => void;
  onConfirmAnyway: () => void;
  onBack: () => void;
  /** The clock the «قبل …» is counted against, for a test; the moment the dialog opened when absent. */
  now?: number;
}) {
  // Taken once, when the dialog is drawn: reading the clock while rendering would make the words depend on when React happened to render.
  const [openedAt] = useState(() => Date.now());
  const at = now ?? openedAt;

  return (
    <Modal
      isOpen={open}
      onClose={onBack}
      title="الزبون عنده طلب مؤكَّد بنفس المنتج"
      subtitle={orderNumber}
      maxWidth="md"
      footer={
        <div className="flex flex-col gap-2 sm:flex-row sm:justify-end">
          <Button type="button" variant="danger" disabled={busy} onClick={onRejectAsDuplicate} className="w-full sm:w-auto">
            رفضه كمكرر
          </Button>
          <Button type="button" variant="outline" disabled={busy} onClick={onConfirmAnyway} className="w-full sm:w-auto">
            طلب تاني فعلاً — أكّد
          </Button>
          <Button type="button" variant="ghost" disabled={busy} onClick={onBack} className="w-full sm:w-auto">
            رجوع
          </Button>
        </div>
      }
    >
      <div className="space-y-3">
        <p className="flex items-start gap-2 text-sm font-medium text-[var(--sys-warning)]">
          <RiErrorWarningLine className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
          <span>هالزبون عنده طلب مؤكَّد بنفس المنتج، ولسا ما انسلّم لشركة الشحن:</span>
        </p>
        {twins.length > 0 && (
          <ul className="space-y-1.5 rounded-lg border border-[var(--sys-warning)]/40 bg-[var(--sys-warning-soft)] p-3 text-sm text-[var(--sys-foreground)]">
            {twins.map((t) => (
              <li key={t.orderNumber}>
                <span className="font-semibold" dir="ltr">{t.orderNumber}</span>
                {' — '}
                {sayWhen(t, at)}
              </li>
            ))}
          </ul>
        )}
        <p className="text-xs leading-relaxed text-[var(--sys-muted-foreground)]">
          إذا هو نفس الطلب أُرسل مرتين: ارفضه كمكرر وما بينشحن مرتين. وإذا هو طلب تاني فعلاً: أكّده وانت متأكد.
        </p>
      </div>
    </Modal>
  );
}

/** «أكّده سارة قبل 12 د» — who, and how long ago; either part is left out when the door did not know it. */
function sayWhen(twin: ConfirmedTwinView, now: number): string {
  const who = twin.confirmedByName ? `أكّده ${twin.confirmedByName}` : 'مؤكَّد';
  const at = twin.confirmedAt ? new Date(twin.confirmedAt).getTime() : NaN;
  if (Number.isNaN(at)) return who;
  const minutes = Math.max(0, Math.floor((now - at) / 60_000));
  return `${who} ${minutes < 1 ? 'قبل لحظات' : `قبل ${humanMinutes(minutes)}`}`;
}
