'use client';

import React, { useEffect, useState } from 'react';
import { RiErrorWarningLine } from '@remixicon/react';
import { apiJson } from '@/lib/api-client';

/**
 * «نفس العميل طلب نفس المنتج قبل دقائق» — ABOVE THE BUTTONS, FOR WHOEVER IS ABOUT TO CALL.
 *
 * It is a question for the person on the phone, not a verdict: a customer who adds a second bottle by phone is an
 * ordinary customer, and a second form sent twice is the same order twice. The window cannot tell those apart; she
 * can, in one sentence. So it refuses nothing, hides no button, and says which order numbers to look at.
 *
 * Silent when there is nothing to say (and when the reader may not open the answer): the order screen stays exactly
 * as it was.
 */
interface Payload {
  suspect: boolean;
  twins: { orderNumber: string }[];
  windowMinutes: number;
}

export function DuplicateSuspectNotice({ orderId }: { orderId: string }) {
  const [data, setData] = useState<Payload | null>(null);

  useEffect(() => {
    let cancelled = false;
    setData(null);
    apiJson<Payload>(`/api/orders/${orderId}/duplicate-suspect`)
      .then((d) => !cancelled && setData(d))
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [orderId]);

  if (!data?.suspect) return null;

  return (
    <div role="alert" className="rounded-lg border border-[var(--sys-warning)] bg-[var(--sys-warning-soft)] p-3">
      <p className="flex items-center gap-1.5 text-xs font-bold text-[var(--sys-warning)]">
        <RiErrorWarningLine className="h-4 w-4" aria-hidden />
        طلب مشابه قبل دقائق
      </p>
      <p className="text-xs leading-relaxed text-[var(--sys-muted-foreground)]">
        نفس العميل طلب نفس المنتج خلال {data.windowMinutes} دقائق: {data.twins.map((t) => `#${t.orderNumber}`).join('، ')}.
        اسأله قبل التأكيد: هل هو طلب ثانٍ فعلاً أم الطلب نفسه أُرسل مرتين؟
      </p>
    </div>
  );
}
