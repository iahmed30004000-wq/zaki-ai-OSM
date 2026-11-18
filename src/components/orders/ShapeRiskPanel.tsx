'use client';

import React, { useEffect, useState } from 'react';
import { Card } from '@/components/ui/Card';
import { RiArrowLeftLine, RiLoader4Line } from '@remixicon/react';
import { apiJson } from '@/lib/api-client';
import { HealthChip } from '@/components/ui/HealthChip';
import type { Health, HealthTone } from '@/lib/health';
import type { ShapeRisk } from '@/lib/order-shape-risk';
import type { RiskTier } from '@/lib/customer-risk';

/**
 * WHAT THIS SHAPE OF ORDER DOES, WHILE SHE IS STILL ON THE PHONE.
 *
 * The courier's statements say **29.8% of what this shop ships comes back** —
 * 1353 parcels of 4543 between 23/08 and 26/09/2026. Not one screen said so,
 * so the only moment a return is still cheap to prevent passed in silence:
 * once the waybill is printed the parcel is a round trip whatever anybody
 * learns afterwards.
 *
 * It is placed above the confirmation buttons for that reason and no other.
 * A panel like this on the reports page is a fact; here it is a decision.
 *
 * ── IT PRINTS COUNTS BESIDE EVERY RATE ──
 *
 * «يرجع 39%» invites an argument. «يرجع 39% من 1529 شحنة» ends one. Every
 * line carries its sample, and the server refuses to send a line whose
 * sample cannot carry it — so a quiet panel means the record is thin, never
 * that the order is safe.
 *
 * ── AND THE LEVERS ARE THE POINT ──
 *
 * A risk badge she cannot act on is a badge she learns to ignore. Each lever
 * is a change still available on this order, with the measured points it is
 * worth: «3 قطع بدل قطعة واحدة: يرجع 17.8% من 850 شحنة مقابل 33.1%». That
 * sentence is something to say to a customer.
 */

const TONE: Record<Exclude<RiskTier, never>, HealthTone> = {
  HIGH: 'bad',
  WATCH: 'ok',
  SAFE: 'good',
};

/**
 * The words are this panel's own, the colours are the system's.
 *
 * `HEALTH_AR` says «ضعيف» for a bad tone, which is the right word about a
 * delivery rate and the wrong one about a risk: an order is not «ضعيف», it
 * is likely to come back. So the tone map is reused and the label is not.
 */
const LABEL: Record<Exclude<RiskTier, never>, string> = {
  HIGH: 'احتمال إرجاع مرتفع',
  WATCH: 'أعلى من معدّل المتجر',
  SAFE: 'لا شيء ضدّه',
};

interface Payload extends ShapeRisk {
  orderNumber: string;
  paymentUnmeasured: { why: string; measuredElsewhere: string };
}

export function ShapeRiskPanel({ orderId }: { orderId: string }) {
  const [data, setData] = useState<Payload | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    apiJson<Payload>(`/api/orders/${orderId}/shape-risk`)
      .then((d) => !cancelled && setData(d))
      // A reader who may not see reports keeps the order screen exactly as it
      // was: no panel, no error, nothing to dismiss.
      .catch(() => undefined)
      .finally(() => !cancelled && setLoading(false));
    return () => {
      cancelled = true;
    };
  }, [orderId]);

  if (loading) {
    return (
      <p className="flex items-center gap-1.5 text-note text-[var(--sys-muted-foreground)]">
        <RiLoader4Line className="h-4 w-4 animate-spin" />
        يقيس احتمال الإرجاع…
      </p>
    );
  }
  if (!data) return null;

  const health: Health = data.verdict
    ? { tone: TONE[data.verdict], label: LABEL[data.verdict], why: data.why }
    : { tone: 'unknown', label: 'لا يكفي', why: data.why };

  return (
    <Card plain padding="sm" className="space-y-2">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h4 className="text-sm font-black text-[var(--sys-heading)]">
          احتمال الإرجاع لهذا الشكل من الطلبات
        </h4>
        <HealthChip health={health} />
      </div>

      <p className="text-note leading-relaxed text-[var(--sys-muted-foreground)]">{data.why}</p>

      {data.drivers.length > 0 && (
        <ul className="space-y-1">
          {data.drivers.map((d) => (
            <li
              key={d.dimension}
              className={`text-note leading-relaxed ${
                d.points > 0 ? 'text-[var(--sys-destructive)]' : 'text-[var(--sys-success)]'
              }`}
            >
              {d.why}
            </li>
          ))}
        </ul>
      )}

      {/* THE PART SHE CAN ACT ON, phrased as the change and its worth. */}
      {data.levers.length > 0 && (
        <div className="space-y-1 rounded-lg bg-[var(--sys-primary-soft)] p-2">
          <p className="text-note font-semibold text-[var(--sys-primary)]">ما زال بوسعك تغييره الآن:</p>
          {data.levers.map((l) => (
            <p key={`${l.dimension}-${l.to}`} className="flex items-start gap-1.5 text-note leading-relaxed text-[var(--sys-primary)]">
              <RiArrowLeftLine className="icon-mirror mt-0.5 h-4 w-4 shrink-0" />
              <span>
                {l.why} — أقلّ بـ{l.points} نقطة
              </span>
            </p>
          ))}
        </div>
      )}

      {/*
        THE LEVER THE SYSTEM CANNOT PULL. Stated here rather than left out,
        because the largest number in the courier's file is the one this
        product cannot see: شام كاش did not come back once in 195 parcels.
      */}
      <p className="text-note leading-relaxed text-[var(--sys-muted-foreground)]">
        {data.paymentUnmeasured.why} — {data.paymentUnmeasured.measuredElsewhere}
      </p>

      <p className="text-note text-[var(--sys-muted)]">
        محسوب من طلبات متجرك المنتهية: {data.shopShipments} شحنة. لا نموذجَ ذكاءٍ يُستدعى — كلُّ رقم
        معدود، وكلُّ سطرٍ يذكر عيّنته.
      </p>
    </Card>
  );
}
