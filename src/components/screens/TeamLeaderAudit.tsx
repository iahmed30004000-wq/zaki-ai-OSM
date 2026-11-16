'use client';

import React, { useEffect, useState } from 'react';
import { OrderRef } from '@/components/orders/OrderRef';
import { Card, CardContent, CardHeader } from '@/components/ui/Card';
import { Rows } from '@/components/ui/Rows';
import { SkeletonRows } from '@/components/ui/Skeleton';
import { apiJson } from '@/lib/api-client';
import { arStamp } from '@/lib/format';
import { describeAction } from '@/lib/audit-view';
import { EOD_METRICS, EOD_METRIC_AR, localIsoDay, type EodMetric } from '@/lib/eod-metrics';
import type { SampleRow, Variance } from '@/lib/eod-report';

/**
 * «تدقيق قائد الفريق» — THE OWNER'S WINDOW, under the audit log (step H2 of Confirmation Center v2).
 *
 * Her submitted figures against the system's (as frozen when she sent them) with the variance; her own action log of the day; ten rejected orders of the day with the reason and
 * only whether the number is valid. The door answers 403 to everybody but the owner — so for anyone else (the team leader herself included), on a failure or on an odd answer this
 * draws NOTHING, not even its title. No customer name, phone or address is on it. Read only.
 */
interface Answer {
  day: string;
  leaders: { id: string; name: string | null }[];
  leader: { id: string; name: string | null } | null;
  report: {
    submittedAt: string;
    biggestProblem: string;
    tip: string;
    comparison: { userId: string; name: string; metrics: Record<EodMetric, Variance> }[];
  } | null;
  actions: { action: string; entity: string; entityId: string; createdAt: string }[];
  sample: SampleRow[];
}

type Comparison = NonNullable<Answer['report']>['comparison'][number];

const valid = (x: unknown): x is Answer => !!x && typeof x === 'object' && Array.isArray((x as Answer).actions) && Array.isArray((x as Answer).sample) && typeof (x as Answer).day === 'string';
const today = () => localIsoDay(new Date());

function Cell({ v }: { v: Variance }) {
  return (
    <span className="tabular-nums">
      <span className="block">{`قالت ${v.submitted} · النظام ${v.system}`}</span>
      <span className={`block text-xs ${v.percent !== null && Math.abs(v.percent) >= 20 ? 'font-bold text-[var(--sys-destructive)]' : 'text-[var(--sys-muted-foreground)]'}`}>{v.percent === null ? '—' : `${v.percent > 0 ? '+' : ''}${v.percent}%`}</span>
    </span>
  );
}

export function TeamLeaderAudit() {
  const [day, setDay] = useState(today);
  const [leaderId, setLeaderId] = useState('');
  const [data, setData] = useState<Answer | null | 'none'>(null);

  useEffect(() => {
    let live = true;
    setData(null);
    apiJson<unknown>(`/api/audit/team-leader?day=${day}${leaderId ? `&leaderId=${leaderId}` : ''}`)
      .then((a) => live && setData(valid(a) ? a : 'none'))
      .catch(() => live && setData('none'));
    return () => {
      live = false;
    };
  }, [day, leaderId]);

  if (data === 'none') return null;

  return (
    <Card>
      <CardHeader
        title="تدقيق قائد الفريق"
        subtitle="للمالك بس. أرقامها جنب أرقام النظام، وسجل شغلها باليوم، وعيّنة عشر طلبات مرفوضة. الانحراف نسبة من رقم النظام؛ الأحمر 20% أو أكتر."
        action={
          <div className="flex items-center gap-2">
            {data && data.leaders.length > 1 && (
              <select aria-label="قائد الفريق" className="h-11 md:h-8 rounded-md border border-[var(--sys-border-strong)] bg-[var(--sys-card)] px-2 text-xs" value={data.leader?.id ?? ''} onChange={(e) => setLeaderId(e.target.value)}>
                {data.leaders.map((l) => (
                  <option key={l.id} value={l.id}>
                    {l.name ?? '—'}
                  </option>
                ))}
              </select>
            )}
            <input aria-label="اليوم" type="date" className="h-11 md:h-8 rounded-md border border-[var(--sys-border-strong)] bg-[var(--sys-card)] px-2 text-xs" value={day} onChange={(e) => e.target.value && setDay(e.target.value)} />
          </div>
        }
      />
      <CardContent className="space-y-5 p-0">
        {data === null ? (
          <div className="p-4" aria-busy>
            <SkeletonRows rows={5} />
          </div>
        ) : (
          <>
            <section className="space-y-2 px-4 pt-4">
              <h4 className="text-sm font-bold text-[var(--sys-foreground)]">أرقامها مقابل النظام{data.leader?.name ? ` — ${data.leader.name}` : ''}</h4>
              {!data.leader ? (
                <p className="text-xs text-[var(--sys-muted-foreground)]">ما في حدا بدور «قائد الفريق».</p>
              ) : !data.report ? (
                <p className="text-xs text-[var(--sys-muted-foreground)]">ما أرسلت تقرير هاليوم.</p>
              ) : (
                <>
                  <p className="text-xs text-[var(--sys-muted-foreground)]">أرسلتو {arStamp(data.report.submittedAt)}</p>
                  <Rows
                    rows={data.report.comparison}
                    keyOf={(r: Comparison) => r.userId}
                    columns={[
                      { key: 'name', label: 'الموظفة', primary: true, render: (r: Comparison) => r.name },
                      ...EOD_METRICS.map((m) => ({ key: m, label: EOD_METRIC_AR[m], render: (r: Comparison) => <Cell v={r.metrics[m]} /> })),
                    ]}
                  />
                  <p className="text-xs text-[var(--sys-foreground)]">أكبر مشكلة: {data.report.biggestProblem || '—'}</p>
                  <p className="text-xs text-[var(--sys-foreground)]">نصيحة بكرا: {data.report.tip || '—'}</p>
                </>
              )}
            </section>

            <section className="space-y-2 px-4">
              <h4 className="text-sm font-bold text-[var(--sys-foreground)]">سجل شغلها بهاليوم</h4>
              {data.actions.length === 0 ? (
                <p className="text-xs text-[var(--sys-muted-foreground)]">ما في حركات مسجّلة.</p>
              ) : (
                <ul className="space-y-1 text-xs text-[var(--sys-muted-foreground)]">
                  {data.actions.map((a, i) => (
                    <li key={i}>
                      <span className="tabular-nums">{arStamp(a.createdAt)}</span> — {describeAction(a.action, a.entity)}
                    </li>
                  ))}
                </ul>
              )}
            </section>

            <section className="space-y-2 pb-4">
              <h4 className="px-4 text-sm font-bold text-[var(--sys-foreground)]">عيّنة طلبات مرفوضة (نفس العيّنة كل ما انفتح اليوم)</h4>
              <Rows
                rows={data.sample}
                keyOf={(r: SampleRow) => r.orderId}
                empty="ما في طلبات مرفوضة بهاليوم."
                columns={[
                  { key: 'n', label: 'الطلب', primary: true, render: (r: SampleRow) => <OrderRef id={r.orderId} number={r.orderNumber} /> },
                  { key: 'reason', label: 'السبب', render: (r: SampleRow) => r.reasonAr },
                  { key: 'agent', label: 'الموظفة', render: (r: SampleRow) => r.agent },
                  { key: 'phone', label: 'الرقم', render: (r: SampleRow) => (r.phoneValid ? 'صالح' : 'مشكوك') },
                ]}
              />
            </section>
          </>
        )}
      </CardContent>
    </Card>
  );
}
