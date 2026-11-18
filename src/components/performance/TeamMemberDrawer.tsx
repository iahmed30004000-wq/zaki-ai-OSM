'use client';

import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Modal } from '@/components/ui/Modal';
import { Card } from '@/components/ui/Card';
import { EmptyState } from '@/components/ui/EmptyState';
import { SkeletonRows } from '@/components/ui/Skeleton';
import { apiJson } from '@/lib/api-client';
import { todayKey } from '@/lib/report-range';
import { rowFigures, type TeamRow } from './TeamPerformanceTable';
import { ScoreCard } from './ScoreCard';

/**
 * ONE PERSON, OPENED FROM A ROW — «جدول واحد لأداء الموظفين بدل السبعة» (R14a1, plan 17/11 — 18/11).
 *
 * The board ranks the confirmation desk in ONE table (`TeamPerformanceTable`, `GET /api/orders/confirmation/team`). A row — of that
 * table, or of «سكور الموظفين» — opens this drawer, and the drawer asks `GET /api/orders/confirmation/team/[userId]` with the table's
 * EXACT query: the same function on the server, under the same key, so the drawer can never say a different figure from the row.
 * Its figures are written by the table's own `rowFigures` and explained with the door's own `definitions`.
 *
 * Under them, the figures that live on OTHER doors for this person — today, the score (`/api/performance/card`) — each with its own
 * window said beside it. Nothing here is added, divided or joined from two doors (04 §هـ).
 *
 * A person with no row in the window gets the door's sentence (404), and a refusal gets the door's sentence (403) — never an empty
 * drawer and never a row of zeros.
 */

export interface DrawerPerson {
  id: string;
  name: string;
}

interface Answer {
  employee: TeamRow;
  window: { start: string | null; end: string | null };
}

/** How long the drawer waits — the board's own minute: it is the same report, for one person. */
const DRAWER_WAIT_MS = 60_000;

/** The score's window, said beside it: it does not follow the date box. */
const SCORE_WINDOW = 'السكور على الأسبوع أو الشهر اللي حدده المالك — ما بيتبع المدة المختارة.';

export function TeamMemberDrawer({
  person,
  query,
  definitions,
  onClose,
}: {
  /** Who — null keeps the drawer closed. */
  person: DrawerPerson | null;
  /** The table's query string, character for character (`startDate=…&endDate=…`, or `period=all`). */
  query: string;
  /** The table's `definitions`, by the door's keys. */
  definitions?: Record<string, string> | null;
  onClose: () => void;
}) {
  const [answer, setAnswer] = useState<Answer | null>(null);
  const [failure, setFailure] = useState<{ status: number; said: string } | null>(null);
  /** The newest ask wins: a drawer reopened on another person never shows the first one's late answer. */
  const seq = useRef(0);

  const load = useCallback(() => {
    if (!person) return;
    const mine = ++seq.current;
    setAnswer(null);
    setFailure(null);
    apiJson<Answer>(`/api/orders/confirmation/team/${encodeURIComponent(person.id)}?${query}`, { timeoutMs: DRAWER_WAIT_MS })
      .then((a) => {
        if (mine === seq.current) setAnswer(a);
      })
      .catch((e: unknown) => {
        if (mine !== seq.current) return;
        const status = typeof (e as { status?: unknown })?.status === 'number' ? (e as { status: number }).status : 0;
        const said = e instanceof Error && /[؀-ۿ]/.test(e.message) ? e.message : 'تعذّر الاتصال. تحقق من الشبكة وأعد المحاولة.';
        setFailure({ status, said });
      });
  }, [person, query]);

  useEffect(() => {
    load();
  }, [load]);

  const win = answer?.window;
  const from = win?.start ? todayKey(new Date(win.start)) : null;
  const to = win?.end ? todayKey(new Date(win.end)) : null;
  /** The door clamps a span over ninety days: the caption names the window it answered for, not the one asked. */
  const asked = /startDate=(\d{4}-\d{2}-\d{2})/.exec(query)?.[1] ?? null;
  const clamped = !!(asked && from && from > asked);

  return (
    <Modal isOpen={!!person} onClose={onClose} side="end" maxWidth="md" title={person?.name ?? ''} subtitle="أداء التأكيد — نفس صف الجدول">
      {failure ? (
        <EmptyState
          title={failure.status === 404 ? 'ما في صف بهالمدة' : failure.status === 403 ? 'هالأرقام مش إلك' : 'تعذّر تحميل الأرقام'}
          why={failure.said}
          action={failure.status === 404 || failure.status === 403 ? undefined : { label: 'إعادة المحاولة', onClick: load }}
        />
      ) : !answer ? (
        <div aria-busy>
          <SkeletonRows rows={6} />
        </div>
      ) : (
        <div className="space-y-4">
          <p className="text-note text-[var(--sys-muted-foreground)]">
            {from && to ? `المدة: ${from} إلى ${to}` : 'المدة: كل المدة'}
            {clamped ? ' — المدة أطول من 90 يوم، فالباب قصّها.' : ''}
          </p>
          <ul className="divide-y divide-[var(--sys-border)]">
            {rowFigures(answer.employee).map((f) => (
              <li key={f.key} className="py-2">
                <div className="flex items-baseline justify-between gap-2 text-sm">
                  <span className="text-[var(--sys-foreground)]">{f.label}</span>
                  <span className="font-bold tabular-nums text-[var(--sys-heading)]">{f.value}</span>
                </div>
                {(definitions?.[f.key] ?? f.hint) && (
                  <p className="text-note text-[var(--sys-muted-foreground)]">{definitions?.[f.key] ?? f.hint}</p>
                )}
              </li>
            ))}
          </ul>
        </div>
      )}

      {/* The figures of OTHER doors for the same person, each with its own window — drawn whatever the row's door said. */}
      {person && (
        <Card plain padding="sm" className="mt-4 space-y-2">
          <p className="text-note text-[var(--sys-muted-foreground)]">{SCORE_WINDOW}</p>
          <ScoreCard userId={person.id} />
        </Card>
      )}
    </Modal>
  );
}
