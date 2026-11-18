'use client';

import React from 'react';
import { RiPhoneLine, RiShieldCheckLine, RiUserSettingsLine } from '@remixicon/react';
import { SkeletonRows } from '@/components/ui/Skeleton';
import { Button } from '@/components/ui/Button';

/**
 * The confirmation desk, by person, for the span of days chosen above.
 *
 * Rows are grouped by job because the roles are not doing the same work: a
 * supervisor who takes six hard orders and closes five is not behind an
 * agent who took forty easy ones, and ranking them in one list invites
 * exactly that comparison.
 *
 * Every duration is working minutes, so an order held overnight or over a
 * weekend does not read as a slow call, and every typical figure is a
 * median, so one order left open does not rewrite somebody's week. A dash
 * means there was nothing to measure — never a zero, which reads as bad.
 */

export interface TeamRow {
  id: string;
  name: string;
  role: string | null;
  claimed: number;
  confirmed: number;
  rejected: number;
  noAnswer: number;
  decided: number;
  openNow: number;
  confirmationRate: number | null;
  medianConfirmMinutes: number | null;
  medianGapMinutes: number | null;
  medianFirstActionMinutes: number | null;
  attempts: number;
  attemptsPerDecision: number | null;
  daysPresent: number;
  daysLate: number;
  totalLateMinutes: number;
  avgPresentMinutes: number | null;
  daysWithoutWork: number;
  daysLateEstimated: number;
}

/** The jobs on this desk, in the order a manager reads them. */
const GROUPS: { roles: string[]; label: string; icon: React.ReactNode }[] = [
  {
    roles: ['CONFIRMATION_AGENT'],
    label: 'موظفو التأكيد',
    icon: <RiPhoneLine className="w-4 h-4 text-[var(--sys-primary)]" />,
  },
  {
    roles: ['CONFIRMATION_SUPERVISOR'],
    label: 'مشرفو التأكيد',
    icon: <RiShieldCheckLine className="w-4 h-4 text-[var(--sys-primary)]" />,
  },
];

const OTHERS = {
  label: 'أدوار أخرى لامست طلبات التأكيد',
  icon: <RiUserSettingsLine className="w-4 h-4 text-[var(--sys-muted)]" />,
};

/** Minutes as something sayable: ٤٥ د، ٢ س ١٠ د، ١ ي ٣ س. */
function duration(minutes: number | null): string {
  if (minutes === null) return '—';
  // Working minutes are whole, so a call answered on the first ring lands
  // on zero. "0 د" reads as a broken column; say what actually happened.
  if (minutes === 0) return 'أقل من دقيقة';
  if (minutes < 60) return `${minutes} د`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  // A working day is eight hours, so "ي" here means a day of work.
  if (hours < 8) return rest ? `${hours} س ${rest} د` : `${hours} س`;
  const days = Math.floor(hours / 8);
  const restHours = hours % 8;
  return restHours ? `${days} ي ${restHours} س` : `${days} ي`;
}

/**
 * Presence and lateness are wall-clock, not working minutes, so they never
 * collapse into "days". Eight hours at the desk is "8 س" — calling it
 * "1 ي" would read as a whole day off.
 */
function clock(minutes: number | null): string {
  if (minutes === null) return '—';
  if (minutes === 0) return 'أقل من دقيقة';
  if (minutes < 60) return `${minutes} د`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest ? `${hours} س ${rest} د` : `${hours} س`;
}

function rateTone(rate: number | null): string {
  if (rate === null) return 'text-[var(--sys-muted)]';
  if (rate >= 70) return 'text-[var(--sys-success)]';
  if (rate >= 45) return 'text-[var(--sys-warning)]';
  return 'text-[var(--sys-destructive)]';
}

const HEADS = [
  { key: 'name', label: 'الموظف', align: 'text-start' },
  { key: 'claimed', label: 'سحب', hint: 'طلبات سحبها من المجمّع خلال المدة' },
  { key: 'confirmed', label: 'أكّد' },
  { key: 'rejected', label: 'رفض', hint: 'مرفوض أو ملغى' },
  { key: 'noAnswer', label: 'لا يرد' },
  { key: 'rate', label: 'نسبة التأكيد', hint: 'المؤكد ÷ ما وصل إلى قرار' },
  { key: 'firstAction', label: 'أول اتصال', hint: 'وسيط دقائق العمل من سحب الطلب حتى أول إجراء عليه' },
  { key: 'confirmTime', label: 'زمن التأكيد', hint: 'وسيط دقائق العمل من السحب حتى التأكيد' },
  { key: 'gap', label: 'بين طلب وطلب', hint: 'وسيط دقائق العمل بين سحب وآخر' },
  { key: 'attempts', label: 'محاولات/قرار', hint: 'اتصالات ورسائل لكل طلب وصل إلى قرار' },
  { key: 'openNow', label: 'مفتوح الآن', hint: 'ما يحمله الآن، بصرف النظر عن المدة' },
  { key: 'daysPresent', label: 'أيام حضور', hint: 'أيام ظهر فيها أثر حضور — دخول أو بصمة أو شغل' },
  { key: 'daysLate', label: 'أيام تأخير', hint: 'أيام وصل فيها بعد بداية الدوام — العطلة لا تُحسب' },
  { key: 'present', label: 'متوسط التواجد', hint: 'متوسط ساعات التواجد في اليوم الواحد' },
];

/**
 * ONE PERSON'S ROW, AS THE TABLE WRITES IT — for the drawer under a row (R14a1, 18/11).
 *
 * The drawer reads `team/[userId]`, the same function as this table, and prints the figures with THESE words and THESE formatters, so a
 * row and its drawer can never spell one number two ways. The key is the door's own `definitions` key where it has one.
 */
export function rowFigures(r: TeamRow): { key: string; label: string; value: string; hint?: string }[] {
  const hintOf = (key: string) => HEADS.find((h) => h.key === key)?.hint;
  return [
    { key: 'claimed', label: 'سحب', value: String(r.claimed), hint: hintOf('claimed') },
    { key: 'confirmed', label: 'أكّد', value: String(r.confirmed) },
    { key: 'rejected', label: 'رفض', value: String(r.rejected), hint: hintOf('rejected') },
    { key: 'noAnswer', label: 'لا يرد', value: String(r.noAnswer) },
    { key: 'confirmationRate', label: 'نسبة التأكيد', value: r.confirmationRate === null ? '—' : `${r.confirmationRate}%`, hint: hintOf('rate') },
    { key: 'medianFirstActionMinutes', label: 'أول اتصال', value: duration(r.medianFirstActionMinutes), hint: hintOf('firstAction') },
    { key: 'medianConfirmMinutes', label: 'زمن التأكيد', value: duration(r.medianConfirmMinutes), hint: hintOf('confirmTime') },
    { key: 'medianGapMinutes', label: 'بين طلب وطلب', value: duration(r.medianGapMinutes), hint: hintOf('gap') },
    { key: 'attemptsPerDecision', label: 'محاولات/قرار', value: r.attemptsPerDecision === null ? '—' : String(r.attemptsPerDecision), hint: hintOf('attempts') },
    { key: 'openNow', label: 'مفتوح الآن', value: String(r.openNow), hint: hintOf('openNow') },
    {
      key: 'daysPresent',
      label: 'أيام حضور',
      value: `${r.daysPresent}${r.daysWithoutWork > 0 ? ` (${r.daysWithoutWork} بلا شغل)` : ''}`,
      hint: hintOf('daysPresent'),
    },
    {
      key: 'daysLate',
      label: 'أيام تأخير',
      value: `${r.daysLate}${r.daysLate > 0 ? ` (${clock(r.totalLateMinutes)})` : ''}${r.daysLateEstimated > 0 ? ' ≈' : ''}`,
      hint: hintOf('daysLate'),
    },
    { key: 'avgPresentMinutes', label: 'متوسط التواجد', value: clock(r.avgPresentMinutes), hint: hintOf('present') },
  ];
}

export function TeamPerformanceTable({
  rows,
  totals,
  onOpen,
}: {
  rows: TeamRow[] | null;
  totals?: TeamRow | null;
  /** A row's name opens that person's drawer (R14a1). Left out, the name is plain text, as before. */
  onOpen?: (row: TeamRow) => void;
}) {
  if (rows === null) {
    return <div className="p-4"><SkeletonRows rows={5} /></div>;
  }
  if (rows.length === 0) {
    return (
      <p className="p-6 text-sm text-[var(--sys-muted)] text-center">
        لا عمل تأكيد مسجَّل في هذه المدة. جرّب مدة أوسع.
      </p>
    );
  }

  const claimedRoles = new Set(GROUPS.flatMap((g) => g.roles));
  const sections = [
    ...GROUPS.map((g) => ({ ...g, rows: rows.filter((r) => r.role && g.roles.includes(r.role)) })),
    { ...OTHERS, rows: rows.filter((r) => !r.role || !claimedRoles.has(r.role)) },
  ].filter((s) => s.rows.length > 0);

  return (
    <div className="overflow-x-auto">
{/*
          A MATRIX, NOT A LIST — AND IT STAYS A TABLE.
          
          Each person against the same eight measures, with a totals row
          under them.

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
                key={h.key}
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

        {sections.map((section) => (
          <tbody key={section.label} className="divide-y divide-[var(--sys-border)]">
            <tr className="bg-[var(--sys-primary-soft)]/60">
              <td colSpan={HEADS.length} className="px-4 py-1.5">
                <span className="inline-flex items-center gap-1.5 text-note font-bold text-[var(--sys-muted-foreground)]">
                  {section.icon}
                  {section.label}
                </span>
              </td>
            </tr>
            {section.rows.map((r) => (
              <tr key={r.id} className="hover:bg-[var(--sys-surface)] transition-colors">
                <td className="px-4 py-3 font-semibold text-[var(--sys-heading)] whitespace-nowrap">
                  {onOpen ? (
                    <Button variant="quiet" size="sm" type="button" onClick={() => onOpen(r)}>
                      {r.name}
                    </Button>
                  ) : (
                    r.name
                  )}
                </td>
                <Num value={r.claimed} />
                <Num value={r.confirmed} tone="text-[var(--sys-success)]" />
                <Num value={r.rejected} tone={r.rejected > 0 ? 'text-[var(--sys-destructive)]' : undefined} />
                <Num value={r.noAnswer} />
                <td className={`px-4 py-3 text-center tabular-nums font-bold ${rateTone(r.confirmationRate)}`}>
                  {r.confirmationRate === null ? '—' : `${r.confirmationRate}%`}
                </td>
                <Text value={duration(r.medianFirstActionMinutes)} />
                <Text value={duration(r.medianConfirmMinutes)} />
                <Text value={duration(r.medianGapMinutes)} />
                <Text value={r.attemptsPerDecision === null ? '—' : String(r.attemptsPerDecision)} />
                <Num value={r.openNow} tone={r.openNow > 10 ? 'text-[var(--sys-warning)]' : undefined} />
                <td
                  className="px-4 py-3 text-center tabular-nums font-semibold text-[var(--sys-heading)]"
                  title={r.daysWithoutWork > 0 ? `${r.daysWithoutWork} يوم حضور بلا أي إجراء مسجَّل` : undefined}
                >
                  {r.daysPresent === 0 ? <span className="text-[var(--sys-border-strong)]">0</span> : r.daysPresent}
                  {r.daysWithoutWork > 0 && (
                    <span className="text-note text-[var(--sys-warning)] font-normal"> ({r.daysWithoutWork} بلا شغل)</span>
                  )}
                </td>
                <td
                  className={`px-4 py-3 text-center tabular-nums font-semibold ${
                    r.daysLate > 0 ? 'text-[var(--sys-destructive)]' : 'text-[var(--sys-border-strong)]'
                  }`}
                  title={
                    r.daysLate > 0
                      ? `مجموع التأخير ${clock(r.totalLateMinutes)}` +
                        (r.daysLateEstimated > 0
                          ? ` · ${r.daysLateEstimated} منها وقت الوصول فيه مُقدَّر من أول إجراء (لم يُسجَّل «استلمت»)`
                          : '')
                      : undefined
                  }
                >
                  {r.daysLate}
                  {r.daysLate > 0 && (
                    <span className="text-note font-normal"> ({clock(r.totalLateMinutes)})</span>
                  )}
                  {r.daysLateEstimated > 0 && (
                    <span className="text-note text-[var(--sys-muted)] font-normal"> ≈</span>
                  )}
                </td>
                <Text value={clock(r.avgPresentMinutes)} />
              </tr>
            ))}
          </tbody>
        ))}

        {totals && (
          <tfoot className="border-t-2 border-[var(--sys-border)] bg-[var(--sys-surface)]">
            <tr>
              <td className="px-4 py-3 font-bold text-[var(--sys-heading)]">الإجمالي</td>
              <Num value={totals.claimed} bold />
              <Num value={totals.confirmed} bold tone="text-[var(--sys-success)]" />
              <Num value={totals.rejected} bold />
              <td />
              <td className={`px-4 py-3 text-center tabular-nums font-black ${rateTone(totals.confirmationRate)}`}>
                {totals.confirmationRate === null ? '—' : `${totals.confirmationRate}%`}
              </td>
              <td />
              <Text value={duration(totals.medianConfirmMinutes)} bold />
              <td />
              <td />
              <td />
              <td />
              <td />
              <td />
            </tr>
          </tfoot>
        )}
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

function Text({ value, bold }: { value: string; bold?: boolean }) {
  return (
    <td
      className={`px-4 py-3 text-center tabular-nums whitespace-nowrap ${
        bold ? 'font-bold text-[var(--sys-heading)]' : value === '—' ? 'text-[var(--sys-border-strong)]' : 'text-[var(--sys-foreground)]'
      }`}
    >
      {value}
    </td>
  );
}
