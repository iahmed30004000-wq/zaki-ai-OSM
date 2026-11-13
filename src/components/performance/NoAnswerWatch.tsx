'use client';

import React, { useEffect, useState } from 'react';
import { Card, CardContent, CardHeader } from '@/components/ui/Card';
import { DateRange } from '@/components/ui/DateRange';
import { EmptyState } from '@/components/ui/EmptyState';
import { Rows } from '@/components/ui/Rows';
import { SkeletonRows } from '@/components/ui/Skeleton';
import { apiFetch, saidBy } from '@/lib/api-client';
import type { AgentRow, AnswerRateReport, NoAnswerBoard, RateRow } from '@/lib/no-answer-watch';
import { HeldFlowPanel } from './HeldFlowPanel';

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

const rateText = (r: RateRow) => (r.rate === null ? '—' : `${r.rate}%`);

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

      {report && (
        <Card>
          <CardHeader
            title="حسب رقم المحاولة"
            subtitle="رقم الاتصال اللي إله نتيجة على الطلب، بترتيب وقته — ضغطة «اتصال» والرسالة ما إلهن رقم. الأول والتاني والتالت والرابع فما فوق، للمدة نفسها"
          />
          <CardContent className="p-0">
            <Rows
              rows={report.byAttempt}
              keyOf={(r: RateRow) => r.key}
              columns={rateColumns('المحاولة', (k) => (k === '4+' ? 'الرابعة فما فوق' : `رقم ${k}`), false)}
            />
          </CardContent>
        </Card>
      )}
    </div>
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
