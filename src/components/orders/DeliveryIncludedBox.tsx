'use client';

import React, { useState } from 'react';
import { apiJson } from '@/lib/api-client';
import { amount, type Currency } from '@/lib/format';
import { useConfirm } from '@/components/ui/Confirm';
import { useToast } from '@/components/ui/Toast';

/**
 * «شامل التوصيل» ON AN ORDER THAT ALREADY EXISTS — the box from the order form, still there until the parcel leaves.
 *
 * The form says it when the order is written (1/11). An order written without it is a plain price, and the courier's fee is added to
 * what the courier collects when the shipment is made; this is how a person says afterwards «this price already carries delivery»
 * (or takes it back). It is drawn only while the order can still be told apart from the parcel (`mayTellDelivery`), and the door
 * (`POST /api/orders/[id]/delivery-included`) asks again.
 *
 * THE FIGURE IS THE SERVER'S. The first call is a `dryRun`: the door answers the two totals and writes nothing, the person is shown
 * both, and only her press writes. No amount is worked out here.
 */

/** Whether the box is offered: she may change the fee, the order is not ended, and nothing of it has reached the courier or the paper. */
export function mayTellDelivery(
  order: { confirmationStatus: string; labelPrintedAt?: string | Date | null; trackingNumber?: string | null },
  mayChangeFee: boolean,
  handedOver: boolean
): boolean {
  return (
    mayChangeFee &&
    !handedOver &&
    !order.labelPrintedAt &&
    !order.trackingNumber &&
    order.confirmationStatus !== 'CANCELLED' &&
    order.confirmationStatus !== 'REJECTED'
  );
}

interface Answer {
  totalBefore: number;
  totalAfter: number;
  unchanged?: boolean;
}

export function DeliveryIncludedBox({
  orderId,
  version,
  included,
  currency,
  onChanged,
}: {
  orderId: string;
  version: number;
  included: boolean;
  currency?: Currency | null;
  onChanged: () => void | Promise<void>;
}) {
  const confirm = useConfirm();
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const url = `/api/orders/${orderId}/delivery-included`;
  const post = (body: Record<string, unknown>) =>
    apiJson<Answer>(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

  async function change(next: boolean) {
    setBusy(true);
    try {
      const asked = await post({ included: next, expectedVersion: version, dryRun: true });
      const same = asked.totalBefore === asked.totalAfter;
      const go = await confirm({
        title: next ? 'السعر يصير شامل التوصيل؟' : 'يرجع التوصيل يتضاف على الزبون؟',
        body: same
          ? `المبلغ ما بيتغيّر هلّق (${amount(asked.totalAfter, currency)}). بيتغيّر وقت إنشاء الشحنة، لأنو الأجرة بتنقرأ من علم الطلب.`
          : `المبلغ المطلوب من الزبون بيصير ${amount(asked.totalAfter, currency)} بدل ${amount(asked.totalBefore, currency)}.`,
        confirmLabel: next ? 'اجعله شامل التوصيل' : 'أضف التوصيل',
        tone: next ? undefined : 'danger',
      });
      if (!go) return;
      await post({ included: next, expectedVersion: version });
      toast.done(next ? 'صار السعر شامل التوصيل.' : 'رجع التوصيل يتضاف على الزبون.');
      await onChanged();
    } catch (e) {
      toast.failed(e instanceof Error ? e.message : 'تعذّر التعديل');
    } finally {
      setBusy(false);
    }
  }

  return (
    <label className="flex min-h-11 md:min-h-0 items-start gap-2 text-xs text-[var(--sys-foreground)]">
      <input
        type="checkbox"
        checked={included}
        disabled={busy}
        onChange={(e) => void change(e.target.checked)}
        className="mt-0.5"
      />
      <span>
        <span className="font-semibold">شامل التوصيل</span>
        <span className="block text-[var(--sys-muted-foreground)]">
          {included
            ? 'الزبون بيدفع سعر الطلب بس، وأجرة التوصيل على المتجر.'
            : 'بينضاف توصيل على الزبون لما تنعمل الشحنة.'}
        </span>
      </span>
    </label>
  );
}
