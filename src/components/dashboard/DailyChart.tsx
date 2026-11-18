'use client';

import React, { useCallback, useRef, useState } from 'react';
import { apiFetch, saidBy } from '@/lib/api-client';
import { useLiveRefresh } from '@/hooks/useLiveRefresh';
import { plainNumber } from '@/lib/format';
import { Card, CardContent, CardHeader } from '@/components/ui/Card';
import { EmptyState } from '@/components/ui/EmptyState';
import { toQuery, type Range } from '@/components/ui/DateRange';

/**
 * «اليوم»'s ONE CHART — THE ORDERS OF EACH DAY OF THE CHOSEN PERIOD (R9, plan 17/11).
 *
 * Three counts a day, as the server sends them from `GET /api/analytics/daily` (the STORE's days): what was made, what was
 * confirmed, what was delivered. Drawn as plain bars — no chart library — with the height set inline, so the page gains no
 * stylesheet rule.
 *
 * It COMPUTES NOTHING the server sent: the legend prints the answer's own `totals`, never a sum of the days. The only arithmetic
 * in this file is `heightOf` — how tall a bar is drawn against the tallest — which is drawing, not a figure anybody reads.
 *
 * A span the door refuses (more days than it reads) is said in the door's own sentence, never shortened silently. A read that hit
 * the door's row ceiling (`truncated`) is said in one line: the counts are then a floor. A period with no orders at all is said in
 * a sentence, not drawn as an empty frame.
 */

interface SeriesDay {
  day: string;
  created: number;
  confirmed: number;
  delivered: number;
}

interface Answer {
  days?: SeriesDay[];
  totals?: { created: number; confirmed: number; delivered: number };
  truncated?: boolean;
  timezone?: string;
}

const SERIES = [
  { key: 'created', ar: 'انعمل', bar: 'bg-[var(--sys-border-strong)]' },
  { key: 'confirmed', ar: 'تأكّد', bar: 'bg-[var(--sys-primary)]' },
  { key: 'delivered', ar: 'توصّل', bar: 'bg-[var(--sys-success)]' },
] as const;

/** How tall a bar is drawn, as a share of the tallest bar of the period. Drawing only — never a figure on the screen. */
export function heightOf(count: number, peak: number): string {
  return peak > 0 ? `${Math.round((count / peak) * 100)}%` : '0%';
}

/** One day said in words, for whoever cannot see the bars. */
function dayLabel(d: SeriesDay): string {
  return `${d.day}: انعمل ${d.created}، تأكّد ${d.confirmed}، توصّل ${d.delivered}`;
}

const TITLE = 'الطلبات كل يوم';

export function DailyChart({ range, onTimeZone }: { range: Range; onTimeZone?: (timeZone: string) => void }) {
  const query = toQuery(range, 'fromTo');
  const [answer, setAnswer] = useState<Answer | null>(null);
  const [refusal, setRefusal] = useState<string | null>(null);
  /** The newest call wins: an answer for a period that is no longer chosen is dropped. */
  const seq = useRef(0);

  const load = useCallback(async () => {
    if (!query) return;
    const mine = ++seq.current;
    try {
      // A report: it waits in the reports' lane like the dashboard's own numbers.
      const res = await apiFetch(`/api/analytics/daily?${query}`, { timeoutMs: 60_000 });
      if (mine !== seq.current) return;
      if (res.ok) {
        const got = (await res.json()) as Answer;
        if (mine !== seq.current) return;
        setRefusal(null);
        setAnswer(got);
        if (got.timezone) onTimeZone?.(got.timezone);
      } else {
        const said = await saidBy(res, 'تعذّر تحميل الرسم. جرّب كمان شوي.');
        if (mine !== seq.current) return;
        setAnswer(null);
        setRefusal(said);
      }
    } catch (e) {
      if (mine !== seq.current) return;
      setAnswer(null);
      setRefusal(e instanceof Error && /[؀-ۿ]/.test(e.message) ? e.message : 'تعذّر الاتصال. تأكّد من الشبكة وجرّب كمان مرة.');
    }
  }, [query, onTimeZone]);

  useLiveRefresh(load, { everyMs: 30_000, key: `daily:${query}` });

  if (refusal) {
    return (
      <Card>
        <CardHeader title={TITLE} />
        <CardContent>
          <EmptyState title="ما قدرنا نرسم هالمدة" why={refusal} />
        </CardContent>
      </Card>
    );
  }

  if (!answer) {
    return (
      <Card>
        <CardHeader title={TITLE} />
        <CardContent>
          <p aria-busy="true" className="text-sm text-[var(--sys-muted-foreground)]">
            جارٍ تحميل الرسم…
          </p>
        </CardContent>
      </Card>
    );
  }

  const days = answer.days ?? [];
  const totals = answer.totals ?? { created: 0, confirmed: 0, delivered: 0 };
  const quiet = days.length === 0 || (totals.created === 0 && totals.confirmed === 0 && totals.delivered === 0);
  const peak = Math.max(0, ...days.flatMap((d) => [d.created, d.confirmed, d.delivered]));

  return (
    <Card>
      <CardHeader title={TITLE} />
      <CardContent className="space-y-3">
        {answer.truncated && (
          <p className="text-sm text-[var(--sys-warning)]">
            بهالمدة طلبات أكثر مما بينقرأ مرة وحدة، فالأرقام هون أقل من الحقيقة. اختر مدة أقصر.
          </p>
        )}

        {quiet ? (
          <EmptyState title="ما في طلبات بهالمدة" why="لما ينعمل طلب أو يتأكّد أو يتوصّل، بيطلع يومه هون." />
        ) : (
          <>
            <ul className="flex flex-wrap gap-x-4 gap-y-1 text-sm">
              {SERIES.map((s) => (
                <li key={s.key} className="inline-flex items-center gap-1.5">
                  <span className={`inline-block h-2 w-2 rounded-full ${s.bar}`} aria-hidden />
                  <span className="text-[var(--sys-muted-foreground)]">{s.ar}</span>
                  <span className="font-bold tabular-nums text-[var(--sys-heading)]">{plainNumber(totals[s.key])}</span>
                </li>
              ))}
            </ul>

            <div className="flex h-36 w-full items-end gap-1" role="img" aria-label={`${TITLE}، من ${range.from} إلى ${range.to}`}>
              {days.map((d) => (
                <div key={d.day} className="flex h-full min-w-0 flex-1 items-end gap-0.5" title={dayLabel(d)} aria-hidden>
                  {SERIES.map((s) => (
                    <span key={s.key} className={`block min-w-0 flex-1 ${s.bar}`} style={{ height: heightOf(d[s.key], peak) }} />
                  ))}
                </div>
              ))}
            </div>

            {days.length > 1 && (
              <div className="flex justify-between text-note text-[var(--sys-muted-foreground)] tabular-nums" aria-hidden>
                <span>{days[0].day}</span>
                <span>{days[days.length - 1].day}</span>
              </div>
            )}

            {/* The same days in words, for a screen reader — a list, not a hand-written table (`one-table.test.ts`). */}
            <ul className="sr-only" aria-label={TITLE}>
              {days.map((d) => (
                <li key={d.day}>{dayLabel(d)}</li>
              ))}
            </ul>
          </>
        )}
      </CardContent>
    </Card>
  );
}
