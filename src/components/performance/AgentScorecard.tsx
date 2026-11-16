'use client';

import React, { useCallback, useEffect, useState } from 'react';
import { Card, CardContent, CardHeader } from '@/components/ui/Card';
import { Rows } from '@/components/ui/Rows';
import { SkeletonRows } from '@/components/ui/Skeleton';
import { apiJson } from '@/lib/api-client';
import type { Grain, Ratio, ScoreRow } from '@/lib/agent-scorecard';

/**
 * «بطاقة أداء الموظفات» — ONE ROW PER AGENT PER DAY (OR WEEK), under the score board (step G1 of Confirmation Center v2).
 *
 * Read only: the only buttons choose the grain. Every rate stands beside the counts it was made from and a base of zero is a dash, never «0%»; «قاعدة الاحتساب» of each figure
 * is one tap away, so nobody has to guess what was counted. Rows are by day then by name — nothing here orders people by a score, and a list of the worst is not something this
 * tab can draw. A failed or odd answer draws nothing rather than a table of zeros: the score board above is the tab's main content and must not be dragged down by this section.
 */
interface ScorecardAnswer {
  grain: Grain;
  deliveryMaturityDays: number;
  rows: ScoreRow[];
  rules: Record<string, string>;
}

const rateText = (r: Ratio) => (r.rate === null ? '—' : `${r.rate}%`);
const beside = (r: Ratio, unit = 'من') => (r.base === 0 ? '—' : `${r.of} ${unit} ${r.base}`);

function Rate({ r }: { r: Ratio }) {
  return (
    <span className="tabular-nums">
      <span className="font-bold">{rateText(r)}</span>
      {r.base > 0 && <span className="block text-[10px] text-[var(--sys-muted-foreground)]">{beside(r)}</span>}
    </span>
  );
}

const validAnswer = (x: unknown): x is ScorecardAnswer => !!x && typeof x === 'object' && Array.isArray((x as ScorecardAnswer).rows) && typeof (x as ScorecardAnswer).rules === 'object';

export function AgentScorecard() {
  const [grain, setGrain] = useState<Grain>('day');
  const [data, setData] = useState<ScorecardAnswer | null | 'none'>(null);

  const load = useCallback(async (g: Grain) => {
    setData(null);
    try {
      const answer = await apiJson<unknown>(`/api/performance/scorecard?grain=${g}`);
      setData(validAnswer(answer) ? answer : 'none');
    } catch {
      setData('none');
    }
  }, []);

  useEffect(() => {
    void load(grain);
  }, [grain, load]);

  if (data === 'none') return null;
  const rules = data?.rules ?? {};

  const columns = [
    { key: 'day', label: grain === 'week' ? 'أسبوع يبدأ' : 'اليوم', primary: true, render: (r: ScoreRow) => <span className="tabular-nums">{r.bucket}</span> },
    { key: 'name', label: 'الموظفة', primary: true, render: (r: ScoreRow) => r.name },
    { key: 'claims', label: 'سحبت', render: (r: ScoreRow) => <span className="tabular-nums">{r.claims}</span> },
    { key: 'confirmed', label: 'أكّدت', render: (r: ScoreRow) => <span className="tabular-nums">{r.confirmed}</span> },
    { key: 'rate', label: 'نسبة التأكيد', render: (r: ScoreRow) => <Rate r={r.confirmationRate} /> },
    {
      key: 'median',
      label: 'وسيط أول اتصال',
      render: (r: ScoreRow) => (
        <span className="tabular-nums">{r.medianFirstAttemptMinutes === null ? '—' : `${Math.round(r.medianFirstAttemptMinutes * 10) / 10} د`}</span>
      ),
    },
    { key: 'quick', label: 'رجّعت بأقل من دقيقة', render: (r: ScoreRow) => <Rate r={r.quickNoAnswer} /> },
    { key: 'attempts', label: 'محاولات', render: (r: ScoreRow) => <span className="tabular-nums">{r.attempts}</span> },
    { key: 'upsell', label: 'زيادة منتج', hideOnPhone: true, render: (r: ScoreRow) => <Rate r={r.upsell} /> },
    {
      key: 'delivery',
      label: 'نسبة التسليم',
      hideOnPhone: true,
      render: (r: ScoreRow) => (
        <span className="tabular-nums">
          <span className="font-bold">{rateText(r.delivery)}</span>
          {r.delivery.base > 0 && <span className="block text-[10px] text-[var(--sys-muted-foreground)]">{`${r.delivery.delivered} مسلَّم و${r.delivery.returned} مرتجع`}</span>}
        </span>
      ),
    },
    { key: 'winback', label: 'استرجاع', hideOnPhone: true, render: () => <span title={rules.winback}>—</span> },
  ];

  return (
    <Card>
      <CardHeader
        title="بطاقة أداء الموظفات"
        subtitle="آخر 7 أيام. كل نسبة جنبها أرقامها، والنسبة بلا أساس شرطة. مرتّبة باليوم ثم بالاسم، مش بالنتيجة."
        action={
          <div className="flex gap-1" role="group" aria-label="التجميع">
            {(['day', 'week'] as const).map((g) => (
              <button
                key={g}
                type="button"
                onClick={() => setGrain(g)}
                aria-pressed={grain === g}
                className={`rounded-md border px-2.5 py-1 text-xs ${grain === g ? 'border-[var(--sys-primary)] font-bold text-[var(--sys-primary)]' : 'border-[var(--sys-border)] text-[var(--sys-muted-foreground)]'}`}
              >
                {g === 'day' ? 'يومي' : 'أسبوعي'}
              </button>
            ))}
          </div>
        }
      />
      <CardContent className="p-0">
        {data === null ? (
          <div className="p-4" aria-busy>
            <SkeletonRows rows={4} />
          </div>
        ) : (
          <>
            <Rows rows={data.rows} keyOf={(r: ScoreRow) => `${r.bucket}|${r.userId}`} empty="لا نشاط للموظفات بهالمدة." columns={columns} />
            <details className="border-t border-[var(--sys-border)] px-4 py-3 text-xs text-[var(--sys-muted-foreground)]">
              <summary className="cursor-pointer font-bold text-[var(--sys-foreground)]">قاعدة الاحتساب</summary>
              <ul className="mt-2 space-y-1.5">
                {Object.entries(data.rules).map(([key, text]) => (
                  <li key={key}>{text}</li>
                ))}
              </ul>
            </details>
          </>
        )}
      </CardContent>
    </Card>
  );
}
