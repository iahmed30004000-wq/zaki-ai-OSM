'use client';

import React, { useEffect, useState } from 'react';
import { Card, CardContent, CardHeader } from '@/components/ui/Card';
import { DateRange } from '@/components/ui/DateRange';
import { EmptyState } from '@/components/ui/EmptyState';
import { Rows } from '@/components/ui/Rows';
import { SkeletonRows } from '@/components/ui/Skeleton';
import { apiFetch, saidBy } from '@/lib/api-client';
import type { AgentRow, AnswerRateReport, AttemptNumbering, NoAnswerBoard, RateRow } from '@/lib/no-answer-watch';
import type { MeasureRow } from '@/lib/no-answer-measure';
import { HeldFlowPanel } from './HeldFlowPanel';
import { WeeklyMeasures } from './WeeklyMeasures';

/**
 * «لا رد والطلبات المحجوزة» — WHAT EACH AGENT IS SITTING ON, AND WHEN CUSTOMERS PICK UP.
 *
 * Read only: nothing on this tab writes anything — its only buttons choose what
 * is read. The board is «now» and is asked for once; the date picker belongs to
 * the answer-rate report under it alone (default: the last fourteen days), and
 * moving it asks for the report only; «حركة الطلبات» above them has its own
 * window and asks for its own part (`HeldFlowPanel`). Every percentage stands
 * beside the counts it was made from, and a base of zero is a dash, never «0%».
 */

interface BoardAnswer {
  board: NoAnswerBoard;
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

/** One sentence under the attempts table: how the range was numbered against the plan's floor (request C3). */
function numberingWords(n: AttemptNumbering): string {
  if (n.mode === 'SPLIT') return `من يوم ${n.fromDay} الرقم هو المحاولة اللي انحسبت بجدول المحاولات (الضغطة اللي ما انحسبت ما بتزيدو)، وقبلو بترتيب الاتصالات.`;
  if (n.mode === 'PLAN') return 'الرقم هو المحاولة اللي انحسبت بجدول المحاولات — الضغطة اللي ما انحسبت ما بتزيدو.';
  return 'الرقم بترتيب الاتصالات — جدول المحاولات ما كان شغّال بهالمدة.';
}

const rateText =(r: RateRow) => (r.rate === null ? '—' : `${r.rate}%`);

function rateColumns(first: string, keyLabel: (key: string) => string, withNotACall: boolean) {
  return [
    { key: 'k', label: first, primary: true, render: (r: RateRow) => keyLabel(r.key) },
    { key: 'rate', label: 'نسبة الرد', primary: true, render: (r: RateRow) => <span className="tabular-nums font-bold">{rateText(r)}</span> },
    { key: 'reached', label: 'ردّ', render: (r: RateRow) => <span className="tabular-nums">{r.reached}</span> },
    { key: 'not', label: 'لم يرد', render: (r: RateRow) => <span className="tabular-nums">{r.notReached}</span> },
    { key: 'base', label: 'الأساس', render: (r: RateRow) => <span className="tabular-nums">{r.base}</span> },
    // A button or a message has no call number, so this column is the hour table's only.
    ...(withNotACall
      ? [{ key: 'nc', label: 'زر أو رسالة — خارج النسبة', hideOnPhone: true, render: (r: RateRow) => <span className="tabular-nums">{r.notACall}</span> }]
      : []),
  ];
}

const FAILED = 'تعذّر تحميل أرقام «لا رد». أعد المحاولة بعد قليل.';
const OFFLINE = 'تعذّر الاتصال. تحقق من الشبكة وأعد المحاولة.';

/** One part of the door; a refusal or a failure comes back as its sentence. */
async function ask<T>(query: string): Promise<{ ok: true; data: T } | { ok: false; said: string }> {
  try {
    const res = await apiFetch(`/api/orders/confirmation/no-answer?${query}`);
    if (res.ok) return { ok: true, data: (await res.json()) as T };
    return { ok: false, said: await saidBy(res, FAILED) };
  } catch {
    return { ok: false, said: OFFLINE };
  }
}

export function NoAnswerWatch() {
  const [range, setRange] = useState(lastFourteenDays);
  const [board, setBoard] = useState<BoardAnswer | null>(null);
  const [report, setReport] = useState<AnswerRateReport | null>(null);
  const [refusal, setRefusal] = useState<string | null>(null);

  // The board: once. It is «now», and the dates below have nothing to say about it.
  useEffect(() => {
    let live = true;
    void ask<BoardAnswer>('part=board').then((r) => {
      if (!live) return;
      if (r.ok) setBoard(r.data);
      else setRefusal(r.said);
    });
    return () => {
      live = false;
    };
  }, []);

  // The report: on every change of the dates, and only the report.
  useEffect(() => {
    let live = true;
    setReport(null);
    const dates = range.from && range.to ? `&startDate=${range.from}&endDate=${range.to}` : '';
    void ask<{ report: AnswerRateReport }>(`part=report${dates}`).then((r) => {
      if (!live) return;
      if (r.ok) setReport(r.data.report);
      else setRefusal(r.said);
    });
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

  return (
    <div className="space-y-6">
      {/* «القياس كل أسبوع» (request C3): its own part, above everything; the parts under it never wait for it. */}
      <WeeklyMeasures />

      {/* «حركة الطلبات»: asks for its own part and its own window, so the board below never waits for it and never fails with it. */}
      <HeldFlowPanel />

      {!board ? (
        <div aria-busy>
          <SkeletonRows rows={6} />
        </div>
      ) : (
        <BoardPart board={board.board} rules={board.rules} />
      )}

      <Card>
        <CardHeader
          title="متى يرد الزبون"
          subtitle={
            report
              ? `نسبة الرد = ردّ ÷ (ردّ + لم يرد) — ${report.total.reached} من ${report.total.base}${report.total.rate === null ? '' : ` (${report.total.rate}%)`}`
              : undefined
          }
          action={
            <div className="w-56">
              <DateRange value={range} onChange={setRange} label="آخر 14 يوم" />
            </div>
          }
        />
        <CardContent className="p-0">
          {!report ? (
            <div className="p-4" aria-busy>
              <SkeletonRows rows={5} />
            </div>
          ) : (
            <>
              {report.truncated && (
                <p className="px-5 pt-3 text-xs text-[var(--sys-warning)]">المدة أطول من حد القراءة — الأرقام لجزء منها. اختر مدة أقصر.</p>
              )}
              <Rows
                rows={report.byHour}
                keyOf={(r: RateRow) => r.key}
                empty="لا محاولات اتصال في هذه المدة."
                columns={rateColumns('الساعة', (k) => `${k.padStart(2, '0')}:00`, true)}
              />
            </>
          )}
        </CardContent>
      </Card>

      {/* قياس «ما ردّ» (step G1): its own part, over the same dates; a failure or an odd answer draws nothing and never touches the parts above. */}
      <MeasurePart range={range} />

      {report && (
        <Card>
          <CardHeader
            title="حسب رقم المحاولة"
            subtitle="رقم الاتصال اللي إله نتيجة على الطلب — ضغطة «اتصال» والرسالة ما إلهن رقم. من المحاولة 1 للمحاولة 5، وأكثر من 5، للمدة نفسها"
          />
          <CardContent className="p-0">
            <Rows
              rows={report.byAttempt}
              keyOf={(r: RateRow) => r.key}
              columns={rateColumns('المحاولة', (k) => (k === '6+' ? 'أكثر من 5' : `المحاولة ${k}`), false)}
            />
            {report.numbering && <p className="px-5 py-3 text-note text-[var(--sys-muted-foreground)]">{numberingWords(report.numbering)}</p>}
          </CardContent>
        </Card>
      )}
    </div>
  );
}

interface MeasureAnswer {
  measure: { rows: MeasureRow[]; rule: string; thresholds: number[] };
}

const validMeasure = (x: unknown): x is MeasureAnswer => {
  const m = (x as MeasureAnswer | null)?.measure;
  return !!m && Array.isArray(m.rows) && typeof m.rule === 'string' && Array.isArray(m.thresholds);
};

/** The percentage of the lines that rang for less than `seconds`, beside its counts; a zero base is a dash. */
const underText = (r: MeasureRow, seconds: number) => {
  const u = r.under.find((x) => x.seconds === seconds);
  return !u || u.rate === null ? '—' : `${u.rate}% (${u.count} من ${r.withPress})`;
};

function MeasurePart({ range }: { range: { from: string; to: string } }) {
  const [answer, setAnswer] = useState<MeasureAnswer | null | 'none'>(null);

  useEffect(() => {
    let live = true;
    setAnswer(null);
    const dates = range.from && range.to ? `&startDate=${range.from}&endDate=${range.to}` : '';
    void ask<unknown>(`part=measure${dates}`).then((r) => {
      if (live) setAnswer(r.ok && validMeasure(r.data) ? r.data : 'none');
    });
    return () => {
      live = false;
    };
  }, [range]);

  if (answer === 'none') return null;
  const thresholds = answer?.measure.thresholds ?? [];

  return (
    <Card>
      <CardHeader
        title="قياس «ما ردّ» لكل موظفة"
        subtitle="كل «لا يرد» بنربطو بضغطة «اتصل» إلها قبلو، ونقيس كم ثانية رنّت. النسبة جنب أرقامها، وبدون ضغطة اتصال بتنعدّ لحالها."
      />
      <CardContent className="p-0">
        {answer === null ? (
          <div className="p-4" aria-busy>
            <SkeletonRows rows={4} />
          </div>
        ) : (
          <>
            <Rows
              rows={answer.measure.rows}
              keyOf={(r: MeasureRow) => `${r.day}|${r.userId}`}
              empty="لا ضغطات اتصال بهالمدة."
              columns={[
                { key: 'day', label: 'اليوم', primary: true, render: (r: MeasureRow) => <span className="tabular-nums">{r.day}</span> },
                { key: 'name', label: 'الموظفة', primary: true, render: (r: MeasureRow) => r.name },
                { key: 'opened', label: 'ضغطات اتصل', render: (r: MeasureRow) => <span className="tabular-nums">{r.opened}</span> },
                { key: 'na', label: 'لا يرد', render: (r: MeasureRow) => <span className="tabular-nums">{r.noAnswer}</span> },
                { key: 'wo', label: 'بلا ضغطة اتصال', hideOnPhone: true, render: (r: MeasureRow) => <span className="tabular-nums">{r.withoutPress}</span> },
                ...thresholds.map((seconds) => ({
                  key: `u${seconds}`,
                  label: seconds === 60 ? 'أقل من دقيقة' : seconds === 120 ? 'أقل من دقيقتين' : `أقل من ${seconds} ثانية`,
                  render: (r: MeasureRow) => <span className="tabular-nums">{underText(r, seconds)}</span>,
                })),
              ]}
            />
            <details className="border-t border-[var(--sys-border)] px-4 py-3 text-xs text-[var(--sys-muted-foreground)]">
              <summary className="cursor-pointer font-bold text-[var(--sys-foreground)]">قاعدة الاحتساب</summary>
              <p className="mt-2">{answer.measure.rule}</p>
            </details>
          </>
        )}
      </CardContent>
    </Card>
  );
}

function BoardPart({ board, rules }: BoardAnswer) {
  const t = board.totals;
  const team: [string, number][] = [
    ['بيد الموظفات الآن', t.held],
    ['منها لا رد فقط', t.onlyNoAnswer],
    [`طلبات جديدة بلا سحب — أحدث من ${rules.freshNewHours} ساعة`, board.team.freshUnclaimed],
    ['مفتوحة بلا صاحب وفيها لا رد', board.team.unclaimedWithNoAnswer],
  ];
  return (
    <>
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
    </>
  );
}
