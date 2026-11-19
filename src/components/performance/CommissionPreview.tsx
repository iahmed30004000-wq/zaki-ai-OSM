'use client';

import React, { useEffect, useState } from 'react';
import { Card, CardContent, CardHeader } from '@/components/ui/Card';
import { Rows } from '@/components/ui/Rows';
import { apiJson } from '@/lib/api-client';
import type { PreviewRow } from '@/lib/agent-commission-calc';

/**
 * «تقدير عمولة الشهر» — THE COMMISSION CALCULATOR'S ESTIMATE, under the scorecard (step G2 of Confirmation Center v2).
 *
 * An ESTIMATE, and it says so on its face: it is not what is accrued or paid (the commission screen is). Each amount stands beside the confirmed count it rests on, and the steps that
 * made it («قاعدة الاحتساب») are one tap away. Money is the payroll's: the door answers only to `payroll.view`, so for anyone else — or on any failure, or an odd answer — this draws
 * NOTHING (no empty table, no «0»), and the scorecard above it is untouched.
 */
interface PreviewAnswer {
  window: { start: string; end: string };
  rows: PreviewRow[];
}

const valid = (x: unknown): x is PreviewAnswer => !!x && typeof x === 'object' && Array.isArray((x as PreviewAnswer).rows) && !!(x as PreviewAnswer).window;
const money = (n: number) => n.toLocaleString('en-US');

/** The estimate's own window, said beside it: the month so far, never the board's date box (R14 DoD 2: «كل رقم بنافذة ثابتة بيذكرها جنبو»). */
const ESTIMATE_WINDOW_LINE = 'التقدير على الشهر الحالي من أولو لهلّق — ما بيتبع المدة المختارة فوق.';

export function CommissionPreview() {
  const [answer, setAnswer] = useState<PreviewAnswer | null | 'none'>(null);

  useEffect(() => {
    let live = true;
    apiJson<unknown>('/api/performance/commission-preview')
      .then((a) => live && setAnswer(valid(a) ? a : 'none'))
      .catch(() => live && setAnswer('none'));
    return () => {
      live = false;
    };
  }, []);

  if (answer === null || answer === 'none') return null;

  return (
    <Card>
      <CardHeader
        title="تقدير عمولة الشهر"
        subtitle="تقدير بس، مش المحسوب ولا المصروف (هاد بشاشة العمولة). كل مبلغ جنب عدد التأكيدات اللي انبنى عليه، وقاعدة احتسابو تحت."
      />
      <CardContent className="p-0">
        <p className="px-5 pt-3 text-note text-[var(--sys-muted-foreground)]">{ESTIMATE_WINDOW_LINE}</p>
        <Rows
          rows={answer.rows}
          keyOf={(r: PreviewRow) => r.userId}
          empty="ما في تأكيدات بهالشهر لتقدير عمولتها."
          columns={[
            { key: 'name', label: 'الموظفة', primary: true, render: (r: PreviewRow) => r.name },
            { key: 'confirmed', label: 'المؤكَّد بالشهر', render: (r: PreviewRow) => <span className="tabular-nums">{r.estimate.confirmed}</span> },
            {
              key: 'tier',
              label: 'الشريحة',
              render: (r: PreviewRow) => <span className="tabular-nums">{r.estimate.kind === 'BONUS' ? 'بونص' : r.estimate.kind === 'NONE' ? '—' : r.estimate.tier}</span>,
            },
            {
              key: 'amount',
              label: 'التقدير',
              primary: true,
              render: (r: PreviewRow) => <span className="tabular-nums font-bold">{r.estimate.kind === 'NONE' ? '—' : money(r.estimate.amount)}</span>,
            },
            {
              key: 'rule',
              label: 'قاعدة الاحتساب',
              hideOnPhone: true,
              render: (r: PreviewRow) => (
                <details>
                  <summary className="cursor-pointer text-note text-[var(--sys-primary)]">كيف انحسب</summary>
                  <ul className="mt-1 space-y-1 text-note text-[var(--sys-muted-foreground)]">
                    {r.estimate.steps.map((s, i) => (
                      <li key={i}>{s}</li>
                    ))}
                  </ul>
                </details>
              ),
            },
          ]}
        />
      </CardContent>
    </Card>
  );
}
