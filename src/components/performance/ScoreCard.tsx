'use client';

import React, { useCallback, useEffect, useState } from 'react';
import { apiJson } from '@/lib/api-client';
import type { ScoreResult, ScoredBand } from '@/lib/performance-score';
import { RiArrowDownCircleLine, RiLoader4Line, RiMedalLine } from '@remixicon/react';
import { Money } from '@/components/ui/Money';
import { Card } from '@/components/ui/Card';

/**
 * THE CARD, SPELLED OUT.
 *
 * One opaque figure is not allowed here and the layout is what enforces it:
 * there is no place in this component to render a total without the lines
 * that produced it. A person told "your score is 71" can do nothing with
 * it. A person told «نسبة تسليمك ٧٨٪ ← ٢٧ من ٣٥ نقطة» knows which band to
 * work on tomorrow.
 *
 * The bars colour a line and never move the points: what this business
 * calls an acceptable delivery rate is its own judgement, and the weights
 * are the definition of the measurement. Mixing them would mean a score
 * that could not be compared with last month's.
 */

interface CardData {
  person: { id: string; name: string; role: string };
  window: { start: string; end: string; period: 'WEEKLY' | 'MONTHLY' };
  bars: { deliveryRate: number; issuesRate: number };
  score: ScoreResult | null;
  rank: { position: number; of: number } | null;
  owed: { currencyCode: string; amount: number }[] | null;
  currency: string;
}

const PERIOD_AR = { WEEKLY: 'هذا الأسبوع', MONTHLY: 'هذا الشهر' };

/** The raw number as the band's own unit reads. */
function valueText(band: ScoredBand): string {
  if (band.value === null) return '—';
  switch (band.unit) {
    case 'rate':
    case 'share':
      return `${Math.round(band.value * 100)}٪`;
    case 'minutes':
      return `${Math.round(band.value)} دقيقة`;
    case 'count':
      return band.reference ? `${band.value} من ${band.reference}` : String(band.value);
  }
}

/** Under the bar the owner set — a yes-or-no, never points. */
function underBar(band: ScoredBand, bars: CardData['bars']): boolean {
  if (band.value === null) return false;
  if (band.key === 'delivery_rate') return band.value < bars.deliveryRate;
  if (band.key === 'issues_rate') return band.value > bars.issuesRate;
  return false;
}

function BandLine({ band, bars }: { band: ScoredBand; bars: CardData['bars'] }) {
  const missing = band.points === null;
  const low = underBar(band, bars);
  const fill = missing ? 0 : ((band.points ?? 0) / band.weight) * 100;

  return (
    <li className="py-2">
      <div className="flex items-baseline justify-between gap-2">
        <span className="text-note font-medium text-[var(--sys-foreground)]">{band.ar}</span>
        <span className="text-note tabular-nums text-[var(--sys-muted-foreground)]">
          {missing ? (
            'لا يُقاس'
          ) : (
            <>
              {valueText(band)}{' '}
              <span className="text-[var(--sys-muted)]">←</span>{' '}
              <span className="font-semibold text-[var(--sys-heading)]">
                {band.points} من {band.weight}
              </span>
            </>
          )}
        </span>
      </div>
      <div className="mt-1 h-1.5 overflow-hidden rounded-full bg-[var(--sys-surface-strong)]">
        <div
          className={`h-full rounded-full ${low ? 'bg-[var(--sys-destructive)]' : 'bg-[var(--sys-primary)]'}`}
          style={{ width: `${Math.max(0, Math.min(100, fill))}%` }}
        />
      </div>
      {low && (
        <p className="mt-1 flex items-center gap-1 text-note text-[var(--sys-destructive)]">
          <RiArrowDownCircleLine className="h-4 w-4" /> دون العتبة التي حدّدها المتجر
        </p>
      )}
    </li>
  );
}

export function ScoreCard({ userId }: { userId?: string }) {
  const [data, setData] = useState<CardData | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setData(await apiJson<CardData>(`/api/performance/card${userId ? `?userId=${userId}` : ''}`));
    } catch (e) {
      setError(e instanceof Error ? e.message : 'تعذر التحميل');
    }
  }, [userId]);

  useEffect(() => {
    void load();
  }, [load]);

  if (error) {
    return <p className="rounded-lg border border-[var(--sys-destructive-border)] bg-[var(--sys-destructive-soft)] p-2.5 text-note text-[var(--sys-destructive)]">{error}</p>;
  }
  if (!data) {
    return (
      <p className="flex items-center justify-center gap-2 py-8 text-sm text-[var(--sys-muted-foreground)]">
        <RiLoader4Line className="h-4 w-4 animate-spin" /> جارٍ الحساب…
      </p>
    );
  }

  const score = data.score;

  return (
    <Card padding="md">
      <section dir="rtl">
      <header className="flex flex-wrap items-baseline justify-between gap-2 border-b border-[var(--sys-border)] pb-3">
        <div>
          <h3 className="text-sm font-bold text-[var(--sys-heading)]">{data.person.name}</h3>
          <p className="text-note text-[var(--sys-muted-foreground)]">{PERIOD_AR[data.window.period]}</p>
        </div>
        {score?.total !== null && score !== null && (
          <div className="text-left" dir="ltr">
            <span className="text-2xl font-bold tabular-nums text-[var(--sys-primary)]">{score.total}</span>
            <span className="text-note text-[var(--sys-muted-foreground)]"> / {score.possible}</span>
          </div>
        )}
      </header>

      {/* Nothing at all when the sample is too small. A delivery rate out of
          four orders is noise, and noise shown once is believed for a month. */}
      {score === null || score.reason === 'BELOW_MINIMUM' ? (
        <p className="py-6 text-center text-note leading-relaxed text-[var(--sys-muted-foreground)]">
          {score === null
            ? 'لا يُقاس هذا الدور بهذا السكور.'
            : `العيّنة ${score.sample} طلباً، والحد الأدنى ${score.minSample}. لا سكور بعد — رقمٌ من عيّنة صغيرة يُصدَّق شهراً كاملاً.`}
        </p>
      ) : (
        <>
          {data.rank && (
            <p className="flex items-center gap-1.5 pt-3 text-note text-[var(--sys-muted-foreground)]">
              <RiMedalLine className="h-4 w-4 text-[var(--sys-warning)]" />
              ترتيبك <span className="font-semibold tabular-nums text-[var(--sys-heading)]">{data.rank.position}</span> من{' '}
              <span className="tabular-nums">{data.rank.of}</span> في دورك بهذا المتجر
            </p>
          )}

          <ul className="mt-2 divide-y divide-[var(--sys-surface-strong)]">
            {score.bands.map((b) => (
              <BandLine key={b.key} band={b} bars={data.bars} />
            ))}
          </ul>
        </>
      )}

      {data.owed && data.owed.length > 0 && (
        <footer className="mt-3 border-t border-[var(--sys-border)] pt-2">
          <p className="text-note text-[var(--sys-muted-foreground)]">
            عمولة مستحقة لم تُصرف بعد:{' '}
            {data.owed.map((o) => (
              <span key={o.currencyCode} className="ms-2 font-semibold tabular-nums text-[var(--sys-heading)]" dir="ltr">
                <Money value={o.amount} currency={o.currencyCode} />
              </span>
            ))}
          </p>
        </footer>
      )}

      <p className="mt-2 text-note leading-relaxed text-[var(--sys-muted)]">
        الأوزان ثابتة ولا تُعدَّل، ليبقى الرقم قابلاً للمقارنة بين الشهور. القابل للضبط هو العتبات
        وحدها، وهي تلوّن السطر ولا تحرّك النقاط.
      </p>
      </section>
    </Card>
  );
}
