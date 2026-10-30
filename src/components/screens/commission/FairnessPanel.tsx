'use client';

import React, { useState } from 'react';
import { HealthChip } from '@/components/ui/HealthChip';
import { RiScales3Line } from '@remixicon/react';
import { useIsPhone } from '@/hooks/useIsPhone';
import {
  MIN_COMPARABLE_DAYS,
  MIN_COUNTED_ORDERS,
  type CalendarReadiness,
  type FairAgent,
} from '@/lib/commission-fairness';

/**
 * «البنات جابوا طلبات أكثر» — AND WHETHER THAT IS TRUE.
 *
 * The owner's note says ranking agents by how many orders they brought is
 * unfair, and gives the reason: «بدك تاخد بعين الاعتبار التمويل أي فترة من
 * الشهر، لأنو مثلاً تحويل عالي، طلبات أعلى بداية الشهر والراتب». Salaries
 * land, conversion rises, and whoever worked those shifts tops the table.
 *
 * This panel shows both numbers side by side — the raw count the old table
 * ranked on, and the count each agent managed against an even share of the
 * SAME DAYS their colleagues worked. When the two orders disagree, the panel
 * says which pair swapped, because that is the evidence for re-banding a rule
 * rather than another opinion about it.
 *
 * NOTHING IS DECIDED HERE. `commission-fairness.ts` holds the rule and the
 * route applies it; this renders what it was handed. A threshold written in a
 * component is a threshold the payslip does not know about.
 *
 * AND WHEN THE RECORD CANNOT CARRY IT, THE PANEL SAYS SO INSTEAD OF SHOWING
 * A NUMBER. On this database every agent is ungraded — 6 working days with
 * exactly one day on which two agents both worked — so the honest screen is
 * the raw counts plus a plain statement of what is missing. A screen that
 * filled that gap with a ratio would be the same unfairness wearing a fairer
 * name.
 */

export interface FairnessData {
  confirmed: (FairAgent & { userName: string })[];
  sourced: (FairAgent & { userName: string })[];
  calendar: CalendarReadiness;
  swaps: {
    confirmed: { compared: number; swaps: { aheadOnVolume: string; aheadOnFairness: string }[] };
    sourced: { compared: number; swaps: { aheadOnVolume: string; aheadOnFairness: string }[] };
  };
}

/** One agent's row. The raw count is never hidden, the index often is. */
function AgentRow({ a }: { a: FairAgent & { userName: string } }) {
  const [open, setOpen] = useState(false);

  return (
    <li className="px-4 py-2.5">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <span className="text-sm font-medium text-[var(--sys-heading)]">{a.userName}</span>

        {/* The number the old leaderboard ranked on, kept visible on purpose:
            without it the screen throws away the figure people already trust
            and offers nothing they recognise in its place. */}
        <span className="text-xs text-[var(--sys-muted-foreground)] whitespace-nowrap">
          <span className="tabular-nums" dir="ltr">
            {a.rawCount}
          </span>{' '}
          طلباً في{' '}
          <span className="tabular-nums" dir="ltr">
            {a.daysWorked}
          </span>{' '}
          يوماً
        </span>

        <span className="ms-auto flex items-center gap-2">
          {a.index !== null && (
            <span className="text-sm font-bold tabular-nums text-[var(--sys-heading)]" dir="ltr">
              {a.index}×
            </span>
          )}
          <HealthChip health={{ tone: a.tone, label: a.label, why: a.why }} />
        </span>
      </div>

      {/* The reason, printed rather than hidden in a tooltip. «تحت نصيبه»
          tells a reader nothing they can act on or argue with; «7 طلباً في 6
          أيام مشتركة، ونصيب الأيام نفسها 12» does both. */}
      <p className="mt-1 text-xs leading-relaxed text-[var(--sys-muted-foreground)]">{a.why}</p>

      {a.bands.length > 0 && (
        <>
          <button
            type="button"
            onClick={() => setOpen(!open)}
            aria-expanded={open}
            className="min-h-11 md:min-h-0 inline-flex items-center mt-1 text-xs font-medium text-[var(--sys-primary)] hover:underline"
          >
            {open ? 'أخفِ البنود' : `من أين الدرجة (${a.score} من 100)؟`}
          </button>
          {open && (
            <ul className="mt-1.5 space-y-1.5 rounded-lg bg-[var(--sys-surface)] p-2.5">
              {a.bands.map((b) => (
                <li key={b.key} className="text-xs leading-relaxed">
                  <span className="font-semibold text-[var(--sys-heading)]">{b.ar}</span>{' '}
                  <span className="tabular-nums text-[var(--sys-foreground)]" dir="ltr">
                    {Math.round(b.earned)}/{b.weight}
                  </span>
                  <span className="block text-[var(--sys-muted-foreground)]">{b.why}</span>
                </li>
              ))}
            </ul>
          )}
        </>
      )}
    </li>
  );
}

function Block({
  title,
  note,
  agents,
  swaps,
  nameOf,
}: {
  title: string;
  note: string;
  agents: (FairAgent & { userName: string })[];
  swaps: { compared: number; swaps: { aheadOnVolume: string; aheadOnFairness: string }[] };
  nameOf: (id: string) => string;
}) {
  if (agents.length === 0) return null;

  return (
    <div className="border-t border-[var(--sys-border)]">
      <div className="px-4 pt-3">
        <h3 className="text-sm font-medium text-[var(--sys-heading)]">{title}</h3>
        <p className="mt-0.5 text-xs text-[var(--sys-muted-foreground)]">{note}</p>
      </div>

      <ul className="divide-y divide-[var(--sys-border)]">
        {agents.map((a) => (
          <AgentRow key={a.userId} a={a} />
        ))}
      </ul>

      {/* THE ONE LINE WORTH ACTING ON. If the two rankings agree, volume was
          not lying and the owner can band on it with a clear conscience. If
          they disagree, the pair that swapped is named. */}
      {swaps.compared >= 2 && (
        <p className="px-4 py-2 text-xs leading-relaxed border-t border-[var(--sys-border)] text-[var(--sys-muted-foreground)]">
          {swaps.swaps.length === 0 ? (
            <>
              ترتيب العدد الخام وترتيب نصيب اليوم متّفقان على {swaps.compared} موظفين — التقويم لم يقلب شيئاً
              هذا الشهر.
            </>
          ) : (
            <>
              الترتيبان يختلفان:{' '}
              {swaps.swaps
                .map((s) => `${nameOf(s.aheadOnVolume)} أعلى بالعدد، و${nameOf(s.aheadOnFairness)} أعلى بنصيب اليوم`)
                .join(' · ')}
              . العدد الخام هنا يكافئ أيام العمل لا صاحبها.
            </>
          )}
        </p>
      )}
    </div>
  );
}

const explanation =
  'الترتيب بعدد الطلبات يكافئ التقويم: الرواتب تنزل أوّل الشهر، التحويل يرتفع، ومَن عمل تلك الأيام يتصدّر. فبدلاً من تقدير «كم كان يجب أن يكون هذا اليوم»، يُقارَن كلُّ موظفٍ بمَن عمل الأيامَ نفسها فقط — فإذا رفعت الرواتب أرقامَ الجميع في يوم، رفعتها للطرفين، والنسبة بينهما لا تتغيّر. نصيب اليوم هو إجمالُ ذلك اليوم مقسوماً على عدد مَن عمله.';

export function FairnessPanel({ data }: { data: FairnessData | null }) {
  const phone = useIsPhone();
  if (!data) return null;
  if (data.confirmed.length === 0 && data.sourced.length === 0) return null;

  const nameOf = (id: string) =>
    [...data.confirmed, ...data.sourced].find((a) => a.userId === id)?.userName ?? '—';

  return (
    <div className="bg-[var(--sys-card)] border border-[var(--sys-border)] rounded-lg overflow-hidden">
      <div className="flex items-center gap-1.5 px-4 py-3 border-b border-[var(--sys-border)]">
        <RiScales3Line className="w-4 h-4 text-[var(--sys-primary)]" />
        <h2 className="text-sm font-medium text-[var(--sys-heading)]">عدالة العدد — مقابل نصيب اليوم</h2>
      </div>

      {/* On a phone the long explanation is folded behind one line that says what it is, so the
          headline and the numbers are what the first screen shows; on a desk it is printed whole. */}
      {phone ? (
        <details className="border-b border-[var(--sys-border)]">
          <summary className="flex min-h-11 cursor-pointer items-center px-4 text-xs font-medium text-[var(--sys-primary)]">
            لماذا هذه المقارنة؟
          </summary>
          <p className="px-4 pb-2.5 text-xs leading-relaxed text-[var(--sys-muted-foreground)]">{explanation}</p>
        </details>
      ) : (
        <p className="px-4 py-2.5 text-xs leading-relaxed text-[var(--sys-muted-foreground)] border-b border-[var(--sys-border)]">
          {explanation}
        </p>
      )}

      {/* THE PRECONDITION HE ASKED FOR, ANSWERED. Rather than silently
          skipping «أي فترة من الشهر» or inventing a payday coefficient, the
          screen states whether the record can carry one yet. */}
      <p className="px-4 py-2 text-xs leading-relaxed text-[var(--sys-muted-foreground)] bg-[var(--sys-surface)] border-b border-[var(--sys-border)]">
        {data.calendar.why}
      </p>

      <Block
        title="وكلاء التأكيد"
        note="الطلبات التي أكّدوها، مؤرَّخةً بيوم التأكيد. الطلب الملغيُّ خارج الحساب — قبل التأكيد أو بعده."
        agents={data.confirmed}
        swaps={data.swaps.confirmed}
        nameOf={nameOf}
      />

      <Block
        title="المسوّقون"
        note="الطلبات التي جاءوا بها، مؤرَّخةً بيوم وصولها. الطلب الملغيُّ خارج الحساب — قبل التأكيد أو بعده."
        agents={data.sourced}
        swaps={data.swaps.sourced}
        nameOf={nameOf}
      />

      <p className="px-4 py-2 text-xs leading-relaxed text-[var(--sys-muted)] border-t border-[var(--sys-border)]">
        لا تُعطى نسبةٌ لمن عمل أقلّ من {MIN_COMPARABLE_DAYS} أيامٍ مشتركةٍ مع زميل، أو أقلّ من{' '}
        {MIN_COUNTED_ORDERS} طلباتٍ فيها — والأيام التي عمِلها وحده لا تُحتسب، لأنّ نصيب اليوم فيها هو
        رقمُه نفسه فتكون النسبةُ واحداً بالحساب لا بالأداء.
      </p>
    </div>
  );
}
