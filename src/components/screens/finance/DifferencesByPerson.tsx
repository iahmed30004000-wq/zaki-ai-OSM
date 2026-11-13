'use client';

import React, { useEffect, useState } from 'react';
import { RiLoader4Line } from '@remixicon/react';
import { apiJson } from '@/lib/api-client';
import { Money } from '@/components/ui/Money';
import { FoldCard } from '@/components/screens/finance/FoldCard';

/**
 * WHOSE PARCELS ARRIVE SHORT.
 *
 * «أصلاً في إحصائيات على بنت المتابعة: بتقرأ التعليقات الداخلية وبتشوف إذا
 * عملت خصومات.»
 *
 * The person who agreed the discount is the person whose parcels keep
 * arriving a little short of what the order says. Until it is counted,
 * nobody can tell a generous agent from an unlucky one — or from a courier
 * shaving a dinar off a hundred parcels, which is the same number seen from
 * the other end and a completely different conversation.
 *
 * It sits on the matching screen because that is where the differences are
 * answered: the strip is the sum of the answers given below it.
 *
 * Every row carries its sample, and a rate is withheld — not zeroed — for
 * anybody whose orders have barely reached a statement yet.
 */

interface Person {
  personId: string;
  name: string | null;
  role: string | null;
  differences: number;
  accepted: number;
  open: number;
  acceptedValue: number;
  settledOrders: number;
  rate: number | null;
  /** The lines answered «طلب تبديل» — counted apart, and in none of the numbers above. Absent from an older server: none. */
  exchanges?: number;
  why: string;
}

interface Payload {
  people: Person[];
  minSettledOrders: number;
  unattributed: { settledOrders: number; differences: number };
}

export function DifferencesByPerson({
  currency,
  open: kept,
  onOpenChange,
}: {
  currency: string;
  /** Open or shut as the screen kept it across a reload (see `FoldCard`). */
  open?: boolean;
  onOpenChange?: (next: boolean) => void;
}) {
  const [data, setData] = useState<Payload | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    apiJson<Payload>('/api/finance/settlement-differences')
      .then((d) => !cancelled && setData(d))
      // A reader without the settlement permission keeps the screen exactly
      // as it was: no strip, no error to dismiss.
      .catch(() => undefined)
      .finally(() => !cancelled && setLoading(false));
    return () => {
      cancelled = true;
    };
  }, []);

  if (loading) {
    return (
      <p className="flex items-center gap-1.5 text-xs text-[var(--sys-muted-foreground)]">
        <RiLoader4Line className="h-4 w-4 animate-spin" />
        يعدّ الفروق…
      </p>
    );
  }
  if (!data || data.people.length === 0) return null;

  // What is inside, said on the heading while the card is folded (the owner, 12/11): the sum of the people's rows below.
  const differences = data.people.reduce((n, p) => n + p.differences, 0);
  const open = data.people.reduce((n, p) => n + p.open, 0);

  return (
    <FoldCard title="الفروق حسب من أكّد الطلب" holds={`${differences} فرقاً · ${open} بانتظار البتّ`} open={kept} onOpenChange={onOpenChange}>
      <p className="text-xs leading-relaxed text-[var(--sys-muted-foreground)]">
        الفرقُ بين ما يقوله الطلب وما وصل — محسوبٌ على من أكّد الطلب، لأنّ المكالمة هي حيث يُعطى
        الخصم. والنسبةُ من الطلبات التي وصلت كشفاً، لا من كلّ طلباته.
      </p>
      <ul className="space-y-1">
        {data.people.map((p) => (
          <li key={p.personId} className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5 text-xs">
            <span className="font-semibold text-[var(--sys-foreground)]">{p.name ?? p.personId}</span>
            <span className="text-[var(--sys-muted-foreground)]">
              {p.differences} فرقاً · اعتُمد رقم الشركة في {p.accepted} · بانتظار البتّ {p.open}
            </span>
            {p.acceptedValue > 0 && (
              <span className="text-[var(--sys-destructive)]">
                <Money value={p.acceptedValue} currency={currency} />
              </span>
            )}
            {(p.exchanges ?? 0) > 0 && (
              /* Said apart: a replacement sent to a customer is not a discount, so it is in none of the figures above. */
              <span className="text-[var(--sys-muted-foreground)]">طلب تبديل {p.exchanges} — لا يُحسب خصماً</span>
            )}
            {p.rate !== null && (
              <span className="text-[var(--sys-muted-foreground)]">
                ({Math.round(p.rate * 1000) / 10}%)
              </span>
            )}
            <span className="text-[var(--sys-muted)]">{p.why}</span>
          </li>
        ))}
      </ul>
      {data.unattributed.differences > 0 && (
        /* Said out loud: if most differences belong to nobody, the list
           above is a minority and ranking anybody by it would mislead. */
        <p className="text-xs text-[var(--sys-muted)]">
          و{data.unattributed.differences} فرقاً على طلباتٍ لا اسمَ مؤكِّدٍ عليها — غير محسوبةٍ على
          أحد.
        </p>
      )}
    </FoldCard>
  );
}
