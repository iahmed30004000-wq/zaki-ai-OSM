'use client';

import React from 'react';
import { Money } from '@/components/ui/Money';
import { SkeletonRows } from '@/components/ui/Skeleton';

/**
 * Who brought the business, and what became of it.
 *
 * The same table for moderators and for channels, because the question is
 * the same and two tables would drift apart. It reads left to right as the
 * funnel actually runs — brought, confirmed, delivered, collected — so the
 * eye lands last on the only number the business keeps.
 *
 * Bringing a hundred orders is not an achievement on its own, which is why
 * "ما يساويه الطلب" sits at the end: it is the column that tells a big
 * noisy source from a good one.
 */

export interface AttributionRow {
  id: string;
  name: string;
  kind: string | null;
  brought: number;
  confirmed: number;
  rejected: number;
  decided: number;
  delivered: number;
  returned: number;
  confirmationRate: number | null;
  deliveryRate: number | null;
  revenue: number;
  revenuePerOrder: number | null;
}

const KIND_AR: Record<string, string> = {
  LANDING_PAGE: 'صفحة هبوط',
  FACEBOOK: 'فيسبوك',
  INSTAGRAM: 'إنستغرام',
  TIKTOK: 'تيك توك',
  WHATSAPP: 'واتساب',
  TELEGRAM: 'تيليغرام',
  PHONE: 'هاتف',
  SHEET: 'ملف',
  WEBSITE: 'موقع',
  OTHER: 'أخرى',
  MODERATOR: 'مودريتر',
  MANAGER: 'مدير مبيعات',
  COMPANY_ADMIN: 'مدير الشركة',
  SUPER_ADMIN: 'المالك',
};

function rateTone(rate: number | null): string {
  if (rate === null) return 'text-[var(--sys-border-strong)]';
  if (rate >= 70) return 'text-[var(--sys-success)]';
  if (rate >= 45) return 'text-[var(--sys-warning)]';
  return 'text-[var(--sys-destructive)]';
}

const HEADS = [
  { label: 'الاسم', align: 'text-start' },
  { label: 'جلب', hint: 'الطلبات المنسوبة إليه خلال المدة' },
  { label: 'أكّد', hint: 'ما وصل إلى التأكيد' },
  { label: 'رفض', hint: 'مرفوض أو ملغى' },
  { label: 'نسبة التأكيد', hint: 'المؤكد ÷ ما وصل إلى قرار' },
  { label: 'وصل', hint: 'ما استلمه الزبون فعلاً' },
  { label: 'مرتجع' },
  { label: 'نسبة التوصيل', hint: 'الموصَّل ÷ المؤكد — طلب لم يُؤكَّد لم يكن للمندوب أن يوصّله' },
  { label: 'المحصَّل', hint: 'نفس تعريف شاشة الأرباح' },
  { label: 'للطلب الواحد', hint: 'المحصَّل ÷ ما جلبه — الفرق بين مصدر كبير ومصدر جيد' },
];

export function AttributionTable({
  rows,
  totals,
  empty,
}: {
  rows: AttributionRow[] | null;
  /** The totals line, computed on the server beside the rows. */
  totals?: AttributionRow | null;
  empty: string;
}) {
  // The table reserves the height it is about to need. A panel that
  // is one line while it waits and ten rows when it arrives moves
  // everything under it, and on a phone a thumb already travelling
  // towards a button presses whatever lands there.
  if (rows === null) return <div className="p-4"><SkeletonRows rows={5} /></div>;
  if (rows.length === 0) return <p className="p-6 text-sm text-[var(--sys-muted)] text-center">{empty}</p>;


  return (
    <div className="overflow-x-auto">
{/*
          A MATRIX, NOT A LIST — AND IT STAYS A TABLE.
          
          Orders, confirmed, delivered and revenue per source, with a
          totals row under them.

          Every other table in the dashboard became `<Rows>`: a table on a
          desk, a card in a hand, from one definition. This one does not,
          and the reason is what it is FOR.

          A card per row destroys the comparison that is the whole point:
          the reader is scanning one column DOWN, across campaigns or
          people, and cards put each row's number in a different place.
          And the totals row has no card form at all — it is the sum of
          the column, and a card of sums beside cards of rows reads as one
          more row.

          So it scrolls sideways on a phone. For a matrix that is the
          honest behaviour: the thing genuinely does not fit, and pretending
          otherwise costs the comparison it exists to make.
        */}
        <table className="w-full text-note">
        <thead className="bg-[var(--sys-surface)] border-b border-[var(--sys-border)] text-[var(--sys-muted-foreground)]">
          <tr>
            {HEADS.map((h) => (
              <th
                key={h.label}
                title={h.hint}
                className={`px-4 py-3 font-semibold whitespace-nowrap ${h.align ?? 'text-center'} ${
                  h.hint ? 'cursor-help' : ''
                }`}
              >
                {h.label}
              </th>
            ))}
          </tr>
        </thead>
        <tbody className="divide-y divide-[var(--sys-border)]">
          {rows.map((r) => (
            <tr key={r.id} className="hover:bg-[var(--sys-surface)] transition-colors">
              <td className="px-4 py-3 whitespace-nowrap">
                <span className="font-semibold text-[var(--sys-heading)]">{r.name}</span>
                {r.kind && (
                  <span className="text-note text-[var(--sys-muted)] block">{KIND_AR[r.kind] ?? r.kind}</span>
                )}
              </td>
              <Num value={r.brought} />
              <Num value={r.confirmed} tone="text-[var(--sys-success)]" />
              <Num value={r.rejected} tone={r.rejected > 0 ? 'text-[var(--sys-destructive)]' : undefined} />
              <Rate value={r.confirmationRate} />
              <Num value={r.delivered} tone="text-[var(--sys-success)]" />
              <Num value={r.returned} tone={r.returned > 0 ? 'text-[var(--sys-warning)]' : undefined} />
              <Rate value={r.deliveryRate} />
              <td className="px-4 py-3 text-center tabular-nums font-bold text-[var(--sys-heading)]" dir="ltr">
                <Money value={r.revenue} />
              </td>
              <td className="px-4 py-3 text-center tabular-nums font-semibold text-[var(--sys-primary)]" dir="ltr">
                {r.revenuePerOrder === null ? '—' : <Money value={r.revenuePerOrder} />}
              </td>
            </tr>
          ))}
        </tbody>
        <tfoot className="border-t-2 border-[var(--sys-border)] bg-[var(--sys-surface)]">
          <tr>
            <td className="px-4 py-3 font-bold text-[var(--sys-heading)]">الإجمالي</td>
            <Num value={totals?.brought ?? 0} bold />
            <Num value={totals?.confirmed ?? 0} bold tone="text-[var(--sys-success)]" />
            <Num value={totals?.rejected ?? 0} bold />
            {/* Both rates come from the server (attributionTotals): the
                screen recomputed their denominators from the row list, and
                a displayed rate is not frontend code's to work out. */}
            <Rate value={totals?.confirmationRate ?? null} bold />
            <Num value={totals?.delivered ?? 0} bold tone="text-[var(--sys-success)]" />
            <Num value={totals?.returned ?? 0} bold />
            <Rate value={totals?.deliveryRate ?? null} bold />
            <td className="px-4 py-3 text-center tabular-nums font-black text-[var(--sys-heading)]" dir="ltr">
              <Money value={totals?.revenue ?? 0} />
            </td>
            <td className="px-4 py-3 text-center tabular-nums font-bold text-[var(--sys-primary)]" dir="ltr">
              {totals?.revenuePerOrder != null ? <Money value={totals.revenuePerOrder} /> : '—'}
            </td>
          </tr>
        </tfoot>
      </table>
    </div>
  );
}

function Num({ value, tone, bold }: { value: number; tone?: string; bold?: boolean }) {
  return (
    <td
      className={`px-4 py-3 text-center tabular-nums ${bold ? 'font-bold' : 'font-semibold'} ${
        tone ?? (value === 0 ? 'text-[var(--sys-border-strong)]' : 'text-[var(--sys-heading)]')
      }`}
    >
      {value}
    </td>
  );
}

function Rate({ value, bold }: { value: number | null; bold?: boolean }) {
  return (
    <td className={`px-4 py-3 text-center tabular-nums ${bold ? 'font-black' : 'font-bold'} ${rateTone(value)}`}>
      {value === null ? '—' : `${value}%`}
    </td>
  );
}
