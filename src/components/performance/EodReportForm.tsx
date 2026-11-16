'use client';

import React, { useCallback, useEffect, useState } from 'react';
import { Card, CardContent, CardHeader } from '@/components/ui/Card';
import { SkeletonRows } from '@/components/ui/Skeleton';
import { apiJson } from '@/lib/api-client';
import { useToast } from '@/components/ui/Toast';
import { EOD_METRICS, EOD_METRIC_AR, MAX_TEXT, localIsoDay, type EodMetric } from '@/lib/eod-metrics';
import type { AgentNumbers } from '@/lib/eod-report';

/**
 * «تقرير نهاية اليوم» — THE TEAM LEADER'S FORM, with the system's numbers beside her own (step H2 of Confirmation Center v2).
 *
 * For each agent who did anything that day: the six figures the system counted (read only) and a box for each of hers. At the bottom the biggest problem and the tip for tomorrow.
 * ONE report per day and it is never edited: after it is sent the form is replaced by what she sent, and the screen says so before she sends it. She is never shown a verdict
 * on her figures against the system's — the owner's audit reads that. Today or yesterday only. Agents and counts only: no customer field is on this screen.
 */
interface Answer {
  day: string;
  mayReport: boolean;
  /** The desk's own words for each rejection reason — from the server, so the form holds no second table. */
  reasons: Record<string, string>;
  system: AgentNumbers[];
  submitted: { at: string; payload: { agents: ({ userId: string } & Record<EodMetric, number>)[]; biggestProblem: string; tip: string } } | null;
}

const valid = (x: unknown): x is Answer => !!x && typeof x === 'object' && Array.isArray((x as Answer).system) && typeof (x as Answer).day === 'string';
type Draft = Record<string, Record<EodMetric, string>>;

export function EodReportForm() {
  const toast = useToast();
  const [which, setWhich] = useState<'today' | 'yesterday'>('today');
  const [data, setData] = useState<Answer | null | 'none'>(null);
  const [draft, setDraft] = useState<Draft>({});
  const [problem, setProblem] = useState('');
  const [tip, setTip] = useState('');
  const [busy, setBusy] = useState(false);

  const load = useCallback(async (w: 'today' | 'yesterday') => {
    setData(null);
    try {
      const day = w === 'today' ? '' : `?day=${localIsoDay(new Date(Date.now() - 86_400_000))}`;
      const a = await apiJson<unknown>(`/api/confirmation/eod-report${day}`);
      if (!valid(a)) return setData('none');
      setData(a);
      setDraft(Object.fromEntries(a.system.map((s) => [s.userId, Object.fromEntries(EOD_METRICS.map((m) => [m, ''])) as Record<EodMetric, string>])));
    } catch {
      setData('none');
    }
  }, []);

  useEffect(() => {
    void load(which);
  }, [which, load]);

  if (data === 'none') return null;

  const send = async () => {
    if (!data) return;
    const agents = data.system.map((s) => ({ userId: s.userId, ...Object.fromEntries(EOD_METRICS.map((m) => [m, draft[s.userId]?.[m] === '' ? NaN : Number(draft[s.userId]?.[m])])) }));
    setBusy(true);
    try {
      await apiJson('/api/confirmation/eod-report', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ day: data.day, agents, biggestProblem: problem, tip }) });
      await load(which);
    } catch (e) {
      toast.failed(e instanceof Error ? e.message : 'تعذر الإرسال');
    } finally {
      setBusy(false);
    }
  };

  const box = 'h-8 w-20 rounded-md border border-[var(--sys-border-strong)] bg-[var(--sys-card)] px-2 text-xs tabular-nums';

  return (
    <Card>
      <CardHeader
        title="تقرير نهاية اليوم"
        subtitle="أرقام النظام جنب أرقامك لكل موظفة. التقرير مرة وحدة باليوم وما بيتعدّل بعد الإرسال، وبيتحفظ مع أرقام النظام وقت الإرسال. لليوم أو لأمس بس."
        action={
          <div className="flex gap-1" role="group" aria-label="اليوم">
            {(['today', 'yesterday'] as const).map((w) => (
              <button key={w} type="button" aria-pressed={which === w} onClick={() => setWhich(w)} className={`rounded-md border px-2.5 py-1 text-xs ${which === w ? 'border-[var(--sys-primary)] font-bold text-[var(--sys-primary)]' : 'border-[var(--sys-border)] text-[var(--sys-muted-foreground)]'}`}>
                {w === 'today' ? 'اليوم' : 'أمس'}
              </button>
            ))}
          </div>
        }
      />
      <CardContent className="space-y-4">
        {data === null ? (
          <div aria-busy>
            <SkeletonRows rows={4} />
          </div>
        ) : data.system.length === 0 ? (
          <p className="text-xs text-[var(--sys-muted-foreground)]">ما في نشاط للموظفات بهاليوم.</p>
        ) : (
          <>
            {data.submitted && (
              <p className="rounded-md border border-[var(--sys-border-strong)] bg-[var(--sys-surface)] p-2.5 text-xs text-[var(--sys-foreground)]">
                أرسلتي تقرير {data.day} وما بيتعدّل. اللي أرسلتيه تحت.
              </p>
            )}
            {data.system.map((s) => {
              const sent = data.submitted?.payload.agents.find((a) => a.userId === s.userId);
              return (
                <section key={s.userId} className="space-y-2 rounded-lg border border-[var(--sys-border-strong)] p-3">
                  <h4 className="text-sm font-bold text-[var(--sys-foreground)]">{s.name}</h4>
                  <div className="grid grid-cols-2 gap-2 md:grid-cols-3">
                    {EOD_METRICS.map((m) => (
                      <label key={m} className="space-y-1 text-xs text-[var(--sys-muted-foreground)]">
                        <span className="block">{EOD_METRIC_AR[m]}</span>
                        <span className="block tabular-nums">النظام: {s[m]}</span>
                        {data.submitted ? (
                          <span className="block font-bold tabular-nums text-[var(--sys-foreground)]">أرقامك: {sent ? sent[m] : '—'}</span>
                        ) : (
                          <input aria-label={`${s.name} — ${EOD_METRIC_AR[m]}`} type="number" min={0} className={box} value={draft[s.userId]?.[m] ?? ''} disabled={busy || !data.mayReport} onChange={(e) => setDraft({ ...draft, [s.userId]: { ...draft[s.userId], [m]: e.target.value } })} />
                        )}
                      </label>
                    ))}
                  </div>
                  {Object.keys(s.rejectedByReason).length > 0 && (
                    <p className="text-xs text-[var(--sys-muted-foreground)]">
                      الرفض حسب السبب (النظام): {Object.entries(s.rejectedByReason).map(([reason, n]) => `${data.reasons[reason] ?? reason} ${n}`).join(' · ')}
                    </p>
                  )}
                  {s.winback > 0 && <p className="text-xs text-[var(--sys-muted-foreground)]">الاسترجاع (النظام): {s.winback} عرض، {s.winbackConverted} صار طلب مؤكَّد.</p>}
                </section>
              );
            })}
            {data.submitted ? (
              <div className="space-y-1 text-xs text-[var(--sys-foreground)]">
                <p>أكبر مشكلة: {data.submitted.payload.biggestProblem || '—'}</p>
                <p>نصيحة بكرا: {data.submitted.payload.tip || '—'}</p>
              </div>
            ) : (
              <>
                <label className="block space-y-1 text-xs text-[var(--sys-muted-foreground)]">
                  أكبر مشكلة اليوم
                  <textarea className="w-full rounded-md border border-[var(--sys-border-strong)] bg-[var(--sys-card)] p-2 text-xs" rows={2} maxLength={MAX_TEXT} value={problem} disabled={busy || !data.mayReport} onChange={(e) => setProblem(e.target.value)} />
                </label>
                <label className="block space-y-1 text-xs text-[var(--sys-muted-foreground)]">
                  نصيحة لبكرا
                  <textarea className="w-full rounded-md border border-[var(--sys-border-strong)] bg-[var(--sys-card)] p-2 text-xs" rows={2} maxLength={MAX_TEXT} value={tip} disabled={busy || !data.mayReport} onChange={(e) => setTip(e.target.value)} />
                </label>
                <button type="button" className="rounded-md bg-[var(--sys-primary)] px-3 py-1.5 text-xs font-bold text-[var(--sys-primary-foreground)] disabled:opacity-50" disabled={busy || !data.mayReport} onClick={() => void send()}>
                  إرسال التقرير (مرة وحدة)
                </button>
              </>
            )}
          </>
        )}
      </CardContent>
    </Card>
  );
}
