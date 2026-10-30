'use client';

import React, { useEffect, useState } from 'react';
import { apiJson } from '@/lib/api-client';
import { RiFocus3Line, RiLoader4Line } from '@remixicon/react';
import { useIsPhone } from '@/hooks/useIsPhone';

/**
 * WHERE THE RUNNING SPAN STANDS.
 *
 * A rule that pays on a day's count is accrued only once the day has closed,
 * so until this there was nothing to look at while it could still be
 * changed: a person worked towards a number they could not see, which is the
 * opposite of what a target is for.
 *
 * Every figure here MOVES. It is the same measure the accrual will use, over
 * the span still being worked, and it becomes money only when the span ends —
 * which the panel says out loud rather than letting it be read as earnings.
 */

interface Row {
  ruleId: string;
  ruleName: string;
  userId: string;
  userName: string;
  metricLabel: string;
  periodLabel: string;
  count: number;
  inBand: { label: string; value: number } | null;
  next: { at: number; value: number; remaining: number } | null;
  isTarget: boolean;
  goal: number | null;
  minOrders: number | null;
}

export function PeriodProgress() {
  const phone = useIsPhone();
  const [rows, setRows] = useState<Row[] | null>(null);
  const [note, setNote] = useState('');

  useEffect(() => {
    apiJson<{ rows: Row[]; note: string }>('/api/finance/commission/progress')
      .then((d) => { setRows(d.rows ?? []); setNote(d.note ?? ''); })
      .catch(() => setRows([]));
  }, []);

  if (rows !== null && rows.length === 0) return null;

  return (
    <div className="bg-[var(--sys-card)] border border-[var(--sys-border)] rounded-lg overflow-hidden">
      <div className="flex items-center gap-1.5 px-4 py-3 border-b border-[var(--sys-border)]">
        <RiFocus3Line className="w-4 h-4 text-[var(--sys-primary)]" />
        <h2 className="text-sm font-medium text-[var(--sys-heading)]">الفترة الجارية</h2>
      </div>

      {!rows ? (
        <div className="flex items-center justify-center gap-2 text-[var(--sys-muted-foreground)] text-sm py-8">
          <RiLoader4Line className="w-4 h-4 animate-spin" /> جارٍ التحميل…
        </div>
      ) : (
        <>
          <ul className="divide-y divide-[var(--sys-border)]">
            {rows.map((r) => {
              const short = r.minOrders != null && r.count < r.minOrders;
              const standing = short ? (
                <span className="text-xs text-[var(--sys-warning)] whitespace-nowrap">
                  دون الحد الأدنى ({r.minOrders}) — لا تُحتسب بعد
                </span>
              ) : r.inBand ? (
                <span className="text-xs text-[var(--sys-success)] whitespace-nowrap">
                  {r.isTarget ? `بلغ الهدف · ${r.inBand.value}` : `شريحة ${r.inBand.label} · ${r.inBand.value}`}
                </span>
              ) : (
                <span className="text-xs text-[var(--sys-muted)] whitespace-nowrap">لم يبلغ أي شريحة بعد</span>
              );
              const figure = (
                <span className="text-sm font-bold text-[var(--sys-heading)] tabular-nums ms-auto" dir="ltr">
                  {r.count}
                  {r.goal !== null && <span className="text-[var(--sys-muted)] font-normal"> / {r.goal}</span>}
                </span>
              );
              const remaining = r.next && (
                <span className="text-xs text-[var(--sys-muted-foreground)] whitespace-nowrap">
                  باقي {r.next.remaining} لـ {r.next.at}
                </span>
              );
              // A phone reads each person as three short lines: who and how many, the rule, then where that stands.
              if (phone) {
                return (
                  <li key={`${r.ruleId}:${r.userId}`} className="px-4 py-2.5 space-y-1">
                    <div className="flex items-center justify-between gap-2">
                      <span className="text-sm font-medium text-[var(--sys-heading)]">{r.userName}</span>
                      {figure}
                    </div>
                    <p className="text-xs text-[var(--sys-muted-foreground)]">
                      {r.ruleName} · {r.metricLabel} · {r.periodLabel}
                    </p>
                    <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                      {standing}
                      {remaining}
                    </div>
                  </li>
                );
              }
              return (
                <li key={`${r.ruleId}:${r.userId}`} className="px-4 py-2.5 flex flex-wrap items-center gap-x-3 gap-y-1">
                  <span className="text-sm font-medium text-[var(--sys-heading)] min-w-[120px]">{r.userName}</span>
                  <span className="text-xs text-[var(--sys-muted-foreground)]">
                    {r.ruleName} · {r.metricLabel} · {r.periodLabel}
                  </span>
                  {figure}
                  {standing}
                  {remaining}
                </li>
              );
            })}
          </ul>
          {note && <p className="px-4 py-2 text-xs text-[var(--sys-muted)] border-t border-[var(--sys-border)]">{note}</p>}
        </>
      )}
    </div>
  );
}
