'use client';

import React, { useCallback, useState } from 'react';
import { Card, CardContent, CardHeader } from '@/components/ui/Card';
import { apiJson } from '@/lib/api-client';
import { useLiveRefresh } from '@/hooks/useLiveRefresh';
import type { HealthAlert, QueueHealth } from '@/lib/queue-health-words';

/**
 * «صحة الطابور» — the supervisor's board above the pool (step D2 of Confirmation Center v2): what waits behind a «لا يرد», what is due now, the oldest wait, what entered and what closed
 * today, and the alerts those raise. Counts and ages only — no customer field. When the owner's switch is off, or on any failure or odd answer, this draws NOTHING.
 */
interface Answer {
  enabled: boolean;
  health?: QueueHealth;
  alerts?: HealthAlert[];
  rule?: string;
  weekly?: string;
}

const valid = (x: unknown): x is Answer => !!x && typeof x === 'object' && typeof (x as Answer).enabled === 'boolean';

function age(hours: number | null): string {
  if (hours === null) return '—';
  return hours >= 48 ? `${Math.floor(hours / 24)} يوم` : `${Math.floor(hours)} ساعة`;
}

export function QueueHealthBoard() {
  const [data, setData] = useState<Answer | null>(null);

  const load = useCallback(async () => {
    try {
      const a = await apiJson<unknown>('/api/confirmation/health');
      setData(valid(a) && a.enabled && a.health ? a : null);
    } catch {
      setData(null);
    }
  }, []);

  // a board left open must not go stale: it loads on mount and again when she comes back to the screen
  useLiveRefresh(load, { everyMs: 120_000 });

  if (!data?.health) return null;
  const h = data.health;
  const cells: Array<[string, string]> = [
    ['بالانتظار', String(h.backlog)],
    ['حان موعده الآن', String(h.dueNow)],
    ['أقدم موعد فات', age(h.oldestDueHours)],
    ['دخل اليوم', String(h.enteredToday)],
    ['انسكّر اليوم', String(h.closedToday)],
  ];

  return (
    <Card>
      <CardHeader title="صحة الطابور" subtitle="الهدف: اللي بينسكّر اليوم يساوي أو يزيد عن اللي بيدخل." />
      <CardContent>
        {data.alerts && data.alerts.length > 0 && (
          <ul className="mb-3 space-y-1" role="alert">
            {data.alerts.map((a) => (
              <li key={a.kind} className="rounded-md border border-[var(--sys-border-strong)] px-3 py-2 text-xs text-[var(--sys-destructive)]">
                <strong>{a.title}:</strong> {a.message}
              </li>
            ))}
          </ul>
        )}
        <dl className="grid grid-cols-2 gap-3 md:grid-cols-5">
          {cells.map(([label, value]) => (
            <div key={label} className="rounded-md border border-[var(--sys-border)] px-3 py-2">
              <dt className="text-xs text-[var(--sys-muted-foreground)]">{label}</dt>
              <dd className="text-lg font-semibold tabular-nums text-[var(--sys-heading)]">{value}</dd>
            </div>
          ))}
        </dl>
        {data.weekly && (
          <p className="mt-3 rounded-md border border-[var(--sys-border)] px-3 py-2 text-xs text-[var(--sys-foreground)]">
            <strong>معايرة الأسبوع:</strong> {data.weekly}
          </p>
        )}
        {data.rule && <p className="mt-3 text-xs text-[var(--sys-muted-foreground)]">{data.rule}</p>}
      </CardContent>
    </Card>
  );
}
