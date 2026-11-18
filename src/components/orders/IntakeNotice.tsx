'use client';

import React, { useEffect, useState } from 'react';
import { RiErrorWarningLine } from '@remixicon/react';
import { apiJson } from '@/lib/api-client';

/**
 * «فلتر الاستقبال» — ABOVE THE BUTTONS, FOR WHOEVER IS ABOUT TO CALL (step C1 of Confirmation Center v2).
 *
 * Two questions for the person on the phone, not verdicts: the same customer asked for the same product within a day (he may really want two, or the form went
 * twice), and the number's shape is not a number of the store's country (a typo, or a number from abroad). So it refuses nothing, hides no button, and says what to
 * ask. Silent when there is nothing to say, and when the reader may not open the answer: the order screen stays exactly as it was.
 */
interface Payload {
  duplicateOf: string | null;
  suspectNumber: boolean;
  windowHours: number;
}

export function IntakeNotice({ orderId }: { orderId: string }) {
  const [data, setData] = useState<Payload | null>(null);

  useEffect(() => {
    let cancelled = false;
    setData(null);
    apiJson<Payload>(`/api/orders/${orderId}/intake-flags`)
      .then((d) => !cancelled && setData(d))
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [orderId]);

  if (!data || (!data.duplicateOf && !data.suspectNumber)) return null;

  return (
    <div role="alert" className="rounded-lg border border-[var(--sys-warning)] bg-[var(--sys-warning-soft)] p-3">
      {data.duplicateOf && (
        <>
          <p className="flex items-center gap-1.5 text-note font-bold text-[var(--sys-warning)]">
            <RiErrorWarningLine className="h-4 w-4" aria-hidden />
            طلب مكرر محتمل
          </p>
          <p className="text-note leading-relaxed text-[var(--sys-muted-foreground)]">
            نفس الزبون طلب نفس المنتج خلال {data.windowHours} ساعة: #{data.duplicateOf}. اسأله: هل هو طلب ثانٍ فعلاً أم الطلب نفسه؟
          </p>
        </>
      )}
      {data.suspectNumber && (
        <>
          <p className="flex items-center gap-1.5 text-note font-bold text-[var(--sys-warning)]">
            <RiErrorWarningLine className="h-4 w-4" aria-hidden />
            رقم مشكوك
          </p>
          <p className="text-note leading-relaxed text-[var(--sys-muted-foreground)]">
            الرقم ما بيطابق شكل أرقام بلد المتجر. تأكد منه مع الزبون قبل ما تتصل.
          </p>
        </>
      )}
    </div>
  );
}
