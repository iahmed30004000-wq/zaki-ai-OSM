'use client';

import React, { useEffect, useState } from 'react';
import { Card, CardContent, CardHeader } from '@/components/ui/Card';
import { DateRange } from '@/components/ui/DateRange';
import { EmptyState } from '@/components/ui/EmptyState';
import { Rows } from '@/components/ui/Rows';
import { SkeletonRows } from '@/components/ui/Skeleton';
import { apiFetch, saidBy } from '@/lib/api-client';
import type { AgentRow, AnswerRateReport, NoAnswerBoard, RateRow } from '@/lib/no-answer-watch';

/**
 * «لا رد والطلبات المحجوزة» — WHAT EACH AGENT IS SITTING ON, AND WHEN CUSTOMERS PICK UP.
 *
 * Read only: nothing on this tab presses anything. The board is «now»; the
 * date picker belongs to the answer-rate report under it alone (default: the
 * last fourteen days). Every percentage stands beside the counts it was made
 * from, and a base of zero is a dash, never «0%».
 */

interface Answer {
  board: NoAnswerBoard;
  report: AnswerRateReport;
  rules: { stuckBusinessDays: number; freshNewHours: number };
}

function lastFourteenDays() {
  const to = new Date();
  const from = new Date();
  from.setDate(from.getDate() - 13);
  const iso = (d: Date) =>
    `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  return { from: iso(from), to: iso(to) };
}

const rateText = (r: RateRow) => (r.rate === null ? '—' : `${r.rate}%`);

function rateColumns(first: string, keyLabel: (key: string) => string) {
  return [
    { key: 'k', label: first, primary: true, render: (r: RateRow) => keyLabel(r.key) },
    { key: 'rate', label: 'نسبة الرد', primary: true, render: (r: RateRow) => <span className="tabular-nums font-bold">{rateText(r)}</span> },
    { key: 'reached', label: 'ردّ', render: (r: RateRow) => <span className="tabular-nums">{r.reached}</span> },
    { key: 'not', label: 'لم يرد', render: (r: RateRow) => <span className="tabular-nums">{r.notReached}</span> },
    { key: 'base', label: 'الأساس', render: (r: RateRow) => <span className="tabular-nums">{r.base}</span> },
    { key: 'nc', label: 'زر أو رسالة — خارج النسبة', hideOnPhone: true, render: (r: RateRow) => <span className="tabular-nums">{r.notACall}</span> },
  ];
}

export function NoAnswerWatch() {
  const [range, setRange] = useState(lastFourteenDays);
  const [data, setData] = useState<Answer | null>(null);
  const [refusal, setRefusal] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    setData(null);
    setRefusal(null);
    const q = range.from && range.to ? `?startDate=${range.from}&endDate=${range.to}` : '';
    apiFetch(`/api/orders/confirmation/no-answer${q}`)
      .then(async (res) => {
        if (!live) return;
        if (res.ok) setData((await res.json()) as Answer);
        else setRefusal(await saidBy(res, 'تعذّر تحميل أرقام «لا رد». أعد المحاولة بعد قليل.'));
      })
      .catch(() => live && setRefusal('تعذّر الاتصال. تحقق من الشبكة وأعد المحاولة.'));
    return () => {
      live = false;
    };
  }, [range]);

  if (refusal) {
    return (
      <Card>
        <CardContent>
          <EmptyState title="لا أرقام لعرضها" why={refusal} />
        </CardContent>
      </Card>
    );
  }
  if (!data) {
    return (
      <div aria-busy>
        <SkeletonRows rows={6} />
      </div>
    );
  }

  const { board, report, rules } = data;
  const t = board.totals;
  const team: [string, number][] = [
    ['بيد الموظفات الآن', t.held],
    ['منها لا رد فقط', t.onlyNoAnswer],
    [`طلبات جديدة بلا سحب — أحدث من ${rules.freshNewHours} ساعة`, board.team.freshUnclaimed],
    ['مفتوحة بلا صاحب وفيها لا رد', board.team.unclaimedWithNoAnswer],
  ];

  return (
    <div className="space-y-6">
      <div className="grid grid-cols-2 xl:grid-cols-4 gap-3">
        {team.map(([label, value]) => (
          <div key={label} className="bg-[var(--sys-card)] border border-[var(--sys-border)] p-4 rounded-lg">
            <span className="text-xs font-bold text-[var(--sys-muted-foreground)]">{label}</span>
            <p className="text-lg font-black tabular-nums text-[var(--sys-heading)] mt-1.5">{value}</p>
          </div>
        ))}
      </div>

      <Card>
        <CardHeader
          title="ما بيد كل موظفة الآن"
          subtitle={`«عالق» = آخر محاولة عليه أقدم من ${rules.stuckBusinessDays} يوم عمل — العطلة وخارج الدوام لا يُحتسبان`}
        />
        <CardContent className="p-0">
          {board.truncated && (
            <p className="px-5 pt-3 text-xs text-[var(--sys-warning)]">القائمة أطول من حد القراءة — الأرقام حد أدنى.</p>
          )}
          <Rows
            rows={board.agents}
            keyOf={(r: AgentRow) => r.id}
            empty="لا طلبات بيد أحد الآن، ولا تأكيد اليوم."
            columns={[
              { key: 'name', label: 'الموظفة', primary: true, render: (r: AgentRow) => <span className="font-semibold text-[var(--sys-heading)]">{r.name}</span> },
              { key: 'held', label: 'بيدها الآن', primary: true, render: (r: AgentRow) => <span className="tabular-nums font-bold">{r.held}</span> },
              { key: 'only', label: 'لا رد فقط — ولا مرة ردّ', render: (r: AgentRow) => <span className="tabular-nums">{r.onlyNoAnswer}</span> },
              { key: 'due', label: 'وعود حان وقتها', render: (r: AgentRow) => <span className="tabular-nums">{r.promisesDue}</span> },
              { key: 'stuck', label: 'عالق', render: (r: AgentRow) => <span className="tabular-nums">{r.stuck}</span> },
              { key: 'today', label: 'أكّدت اليوم', render: (r: AgentRow) => <span className="tabular-nums text-[var(--sys-success)]">{r.confirmedToday}</span> },
            ]}
          />
        </CardContent>
      </Card>

      <Card>
        <CardHeader
          title="متى يرد الزبون"
          subtitle={`نسبة الرد = ردّ ÷ (ردّ + لم يرد) — ${report.total.reached} من ${report.total.base}${report.total.rate === null ? '' : ` (${report.total.rate}%)`}`}
          action={
            <div className="w-56">
              <DateRange value={range} onChange={setRange} label="آخر 14 يوم" />
            </div>
          }
        />
        <CardContent className="p-0">
          {report.truncated && (
            <p className="px-5 pt-3 text-xs text-[var(--sys-warning)]">المدة أطول من حد القراءة — الأرقام لجزء منها. اختر مدة أقصر.</p>
          )}
          <Rows
            rows={report.byHour}
            keyOf={(r: RateRow) => r.key}
            empty="لا محاولات اتصال في هذه المدة."
            columns={rateColumns('الساعة', (k) => `${k.padStart(2, '0')}:00`)}
          />
        </CardContent>
      </Card>

      <Card>
        <CardHeader title="حسب رقم المحاولة" subtitle="المحاولة الأولى على الطلب، والثانية، والثالثة، والرابعة فما فوق — للمدة نفسها" />
        <CardContent className="p-0">
          <Rows
            rows={report.byAttempt}
            keyOf={(r: RateRow) => r.key}
            columns={rateColumns('المحاولة', (k) => (k === '4+' ? 'الرابعة فما فوق' : `رقم ${k}`))}
          />
        </CardContent>
      </Card>
    </div>
  );
}
