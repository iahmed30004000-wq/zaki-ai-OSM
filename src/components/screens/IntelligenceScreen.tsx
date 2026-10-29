'use client';

import React, { useCallback, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import { apiJson } from '@/lib/api-client';
import { AskAi } from '@/components/growth/AskAi';
import { ScreenTitle } from '@/components/shell/ScreenTitle';
import { Tabs } from '@/components/ui/Tabs';
import { RiAlertLine, RiCheckboxCircleLine, RiEyeLine, RiLightbulbLine, RiLoader4Line } from '@remixicon/react';
import { useLiveRefresh } from '@/hooks/useLiveRefresh';
import { useCan } from '@/hooks/useCan';

/**
 * /growth/intelligence — what is bleeding, and what to do about it.
 *
 * Not the chat assistant and not a dashboard. A dashboard shows what
 * happened; this names a problem, shows the number it rests on, and says
 * what to do. Every finding carries its evidence so it can be checked —
 * an insight nobody can verify is a guess with confidence.
 *
 * Silence here is a real answer: no findings means nothing crossed a
 * threshold, not that the analysis failed.
 */

interface Finding {
  key: string;
  family: 'leak' | 'queue' | 'risk' | 'team';
  title: string;
  evidence: string;
  action: string;
  severity: 'ALARM' | 'WATCH' | 'GOOD';
  subject?: { kind: string; id: string; name: string };
  metric?: number;
}

interface Payload {
  findings: Finding[];
  totalOrders: number;
  minSample: number;
  counts: { alarm: number; watch: number };
  byFamily: Record<string, { total: number; alarm: number }>;
}

/**
 * THE FOUR QUESTIONS, AND WHY THEY ARE FOUR TABS.
 *
 * They are read by different people at different moments, and — this is
 * the part that decides the layout — they FAIL differently. A rate needs
 * history and is honestly silent without it. A queue is a count and is
 * true on the first day. Mixing them in one list means a new store sees
 * an empty screen and concludes the analysis is broken, when in fact it
 * has nine orders nobody pulled.
 */
const TABS: { key: Finding['family']; label: string; blurb: string; needsHistory: boolean }[] = [
  { key: 'queue', label: 'طوابير', blurb: 'عملٌ توقّف عن الحركة — عددٌ لا نسبة، فهو صحيحٌ من أوّل يوم.', needsHistory: false },
  { key: 'risk', label: 'خطر', blurb: 'ما سينكسر قريباً: مخزونٌ لا يكفي طلباتٍ وُعد بها، ومالٌ لم يدخل الدفاتر.', needsHistory: false },
  { key: 'leak', label: 'استنزاف', blurb: 'مالٌ يخرج بلا داعٍ. نِسَبٌ، فتحتاج تاريخاً قبل أن تعني شيئاً.', needsHistory: true },
  { key: 'team', label: 'أداء', blurb: 'كلُّ مؤكِّدٍ مقابل متوسّط هذا المتجر نفسه، لا مقابل رقمٍ متخيَّل.', needsHistory: true },
];

const TONE: Record<string, { border: string; chip: string; label: string }> = {
  ALARM: { border: 'border-[var(--sys-destructive-border)]', chip: 'bg-[var(--sys-destructive-soft)] text-[var(--sys-destructive)] border-[var(--sys-destructive-border)]', label: 'يحتاج تدخّلاً' },
  WATCH: { border: 'border-[var(--sys-warning)]/40', chip: 'bg-[var(--sys-warning-soft)] text-[var(--sys-warning)] border-[var(--sys-warning)]/40', label: 'راقبه' },
  GOOD: { border: 'border-[var(--sys-success)]/40', chip: 'bg-[var(--sys-success-soft)] text-[var(--sys-success)] border-[var(--sys-success)]/40', label: 'جيد' },
};

export function IntelligenceScreen() {
  // «اسأل الذكاء» answers at `/api/growth/intelligence/ask`, which asks `ai.use`: without it the box was drawn to be refused.
  const mayAsk = useCan('ai.use');
  const [data, setData] = useState<Payload | null>(null);
  const [error, setError] = useState<string | null>(null);
  /**
   * Queues first by default — it is the tab with something to do TODAY.
   *
   * But `?tab=` wins, because the dashboard strip links straight to the
   * family whose number the person just read. Landing them on a different
   * tab from the one they tapped is the small betrayal that teaches people
   * the number is decorative.
   */
  const params = useSearchParams();
  const asked = params.get('tab');
  const [tab, setTab] = useState<Finding['family']>(
    TABS.some((t) => t.key === asked) ? (asked as Finding['family']) : 'queue'
  );

  const shown = (data?.findings ?? []).filter((f) => f.family === tab);
  const needsHistory = TABS.find((t) => t.key === tab)?.needsHistory ?? false;

  const load = useCallback(async () => {
    setError(null);
    try {
      setData(await apiJson<Payload>('/api/growth/intelligence'));
    } catch (e) {
      setError(e instanceof Error ? e.message : 'تعذر التحليل');
    }
  }, []);

  useLiveRefresh(load);

  return (
    <div className="max-w-4xl space-y-3">
      <ScreenTitle />

      {/* The AI sits under the rule-based findings, never instead of them:
          those carry their evidence and can be checked, and the numbers it
          is handed are the same numbers. */}
      <p className="text-xs text-[var(--sys-muted-foreground)] bg-[var(--sys-surface)] border border-[var(--sys-border)] rounded-lg p-3">
        تحليل مبني على طلباتك الفعلية — كل رقم هنا محسوب من طلبات موجودة، لا تقديرات. وما لا تكفي
        البيانات للإجابة عليه يُقال فيه «لا تكفي البيانات» بدل رقم يبدو معقولاً.
      </p>

      {error && <p className="text-sm text-[var(--sys-destructive)] bg-[var(--sys-destructive-soft)] border border-[var(--sys-destructive-border)] rounded-lg p-3">{error}</p>}

      {!data ? (
        <div className="flex items-center justify-center gap-2 text-[var(--sys-muted-foreground)] text-sm py-16">
          <RiLoader4Line className="w-4 h-4 animate-spin" /> جارٍ التحليل…
        </div>
      ) : (
        <>
          {/* A count of what needs a person, before any of the detail. */}
          <div className="flex flex-wrap gap-2 text-xs">
            {data.counts.alarm > 0 && (
              <span className={`px-2.5 py-1 rounded-full border ${TONE.ALARM.chip}`}>
                {data.counts.alarm} يحتاج تدخّلاً
              </span>
            )}
            {data.counts.watch > 0 && (
              <span className={`px-2.5 py-1 rounded-full border ${TONE.WATCH.chip}`}>
                {data.counts.watch} للمراقبة
              </span>
            )}
            <span className="px-2.5 py-1 rounded-full border border-[var(--sys-border)] text-[var(--sys-muted-foreground)]">
              من {data.totalOrders} طلباً
            </span>
          </div>

          <Tabs
            value={tab}
            onChange={(k) => setTab(k as Finding['family'])}
            tabs={TABS.map((t) => ({
              key: t.key,
              label: t.label,
              count: data.byFamily?.[t.key]?.total || undefined,
            }))}
          />

          {/* What this tab is for, in one line. A tab whose name is one
              word needs it; «خطر» alone does not say what was measured. */}
          <p className="text-xs text-[var(--sys-muted-foreground)]">
            {TABS.find((t) => t.key === tab)?.blurb}
          </p>

          <div className="space-y-2">
            {shown.length === 0 ? (
              needsHistory && data.totalOrders < data.minSample ? (
                /* A rate tab, with nothing to rate. Say the number and the
                   threshold rather than «no results», which reads as a
                   failure of the analysis. */
                <p className="rounded-lg border border-[var(--sys-border)] bg-[var(--sys-card)] p-6 text-center text-sm text-[var(--sys-muted-foreground)]">
                  <RiLightbulbLine className="mx-auto mb-2 h-5 w-5 text-[var(--sys-muted)]" />
                  هذا التبويب نِسَبٌ، و{data.totalOrders} طلباً لا تكفي — يحتاج {data.minSample} على الأقل
                  حتى لا تكون النسبة ضجيجاً.
                </p>
              ) : (
                <p className="rounded-lg border border-[var(--sys-success)]/30 bg-[var(--sys-success-soft)] p-6 text-center text-sm text-[var(--sys-success)]">
                  <RiCheckboxCircleLine className="mx-auto mb-2 h-5 w-5" />
                  لا شيء هنا يتجاوز الحدّ. هذا صمتٌ مقصود، لا تحليلٌ فشل.
                </p>
              )
            ) : null}
            {shown.map((f) => {
              const tone = TONE[f.severity];
              return (
                <div key={f.key} className={`bg-[var(--sys-card)] border rounded-lg p-4 ${tone.border}`}>
                  <div className="flex items-start gap-2">
                    {f.severity === 'ALARM' ? (
                      <RiAlertLine className="w-4 h-4 text-[var(--sys-destructive)] shrink-0 mt-0.5" />
                    ) : (
                      <RiEyeLine className="w-4 h-4 text-[var(--sys-warning)] shrink-0 mt-0.5" />
                    )}
                    <div className="flex-1 min-w-0">
                      <div className="flex flex-wrap items-center gap-2">
                        <h3 className="text-sm font-medium text-[var(--sys-heading)]">{f.title}</h3>
                        <span className={`text-xs px-2 py-0.5 rounded-full border ${tone.chip}`}>{tone.label}</span>
                      </div>

                      {/* The number it rests on, so the claim can be checked. */}
                      <p className="text-xs text-[var(--sys-muted-foreground)] mt-1">{f.evidence}</p>

                      <p className="text-sm text-[var(--sys-foreground)] mt-2 bg-[var(--sys-surface)] border border-[var(--sys-border)] rounded-lg p-2.5">
                        {f.action}
                      </p>
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        </>
      )}
      {mayAsk && <AskAi />}
    </div>
  );
}
