'use client';

import React, { useEffect, useState } from 'react';
import { Card, CardContent, CardHeader } from '@/components/ui/Card';
import { Segmented } from '@/components/ui/Segmented';
import { SkeletonRows } from '@/components/ui/Skeleton';
import { StatTile } from '@/components/ui/StatTile';
import { apiFetch, saidBy } from '@/lib/api-client';
import type { WeekKey, WeeklyMeasures as Weekly, WeeklyTile, WeeklyTone } from '@/lib/weekly-measures';

/**
 * «القياس كل أسبوع» — SIX FIGURES AGAINST SIX TARGETS, AND THE TWO CHECKS (request C3), at the top of «لا رد والطلبات المحجوزة».
 *
 * Read only: its one control chooses the week. It asks `part=weekly` ON ITS OWN, and only once the tab is open (it lives in the tab).
 * Every string is the server's (`weekly-measures.ts`): this draws the tiles and the sentences and decides nothing. A failure is its
 * own small line; an answer without `weekly` (an older server) draws nothing, and the parts under it never wait for it.
 */

interface Answer {
  weekly: Weekly;
  window: { week: WeekKey; fromDay: string; toDay: string; words: string };
}

const FAILED = 'تعذّر تحميل القياس الأسبوعي. أعد المحاولة بعد قليل.';
const OFFLINE = 'تعذّر الاتصال. تحقق من الشبكة وأعد المحاولة.';

const valid = (x: unknown): x is Answer => {
  const a = x as Answer | null;
  return !!a?.weekly && Array.isArray(a.weekly.tiles) && Array.isArray(a.weekly.checks) && !!a.window;
};

async function ask(week: WeekKey): Promise<Answer | 'none' | { said: string }> {
  try {
    const res = await apiFetch(`/api/orders/confirmation/no-answer?part=weekly&week=${week}`);
    if (!res.ok) return { said: await saidBy(res, FAILED) };
    const body: unknown = await res.json();
    return valid(body) ? body : 'none';
  } catch {
    return { said: OFFLINE };
  }
}

const TONE_CLASS: Record<WeeklyTone, string> = { OK: 'text-[var(--sys-success)]', WATCH: 'text-[var(--sys-warning)]' };

function Tile({ tile }: { tile: WeeklyTile }) {
  return (
    <StatTile
      label={tile.label}
      value={tile.value}
      caption={
        <>
          <span className="block tabular-nums">{tile.counts}</span>
          {tile.apart && <span className="block tabular-nums">{tile.apart}</span>}
          <span className="block">
            {tile.target}
            {tile.tone && <span className={`font-bold ${TONE_CLASS[tile.tone]}`}> — {tile.toneWords}</span>}
          </span>
          <span className="block mt-1">{tile.definition}</span>
        </>
      }
    />
  );
}

const WEEKS = [
  { value: 'this', label: 'هالأسبوع' },
  { value: 'last', label: 'الأسبوع اللي قبلو' },
];

export function WeeklyMeasures() {
  const [week, setWeek] = useState<WeekKey>('this');
  const [answer, setAnswer] = useState<Answer | 'none' | { said: string } | null>(null);

  useEffect(() => {
    let live = true;
    setAnswer(null);
    void ask(week).then((r) => {
      if (live) setAnswer(r);
    });
    return () => {
      live = false;
    };
  }, [week]);

  if (answer === 'none') return null;
  const ready = answer && 'weekly' in answer ? answer : null;

  return (
    <Card>
      <CardHeader
        title="القياس كل أسبوع"
        subtitle={ready?.window.words}
        action={
          <Segmented size="sm" aria-label="أي أسبوع" options={WEEKS} value={week} onChange={(v) => setWeek(v === 'last' ? 'last' : 'this')} />
        }
      />
      <CardContent>
        {answer === null ? (
          <div aria-busy>
            <SkeletonRows rows={3} />
          </div>
        ) : !ready ? (
          <p className="text-note text-[var(--sys-warning)]">{'said' in answer ? answer.said : FAILED}</p>
        ) : (
          <div className="space-y-3">
            {ready.weekly.truncated && <p className="text-note text-[var(--sys-warning)]">القراءة وصلت حدّها — الأرقام حد أدنى.</p>}
            <div className="grid grid-cols-2 xl:grid-cols-3 gap-3">
              {ready.weekly.tiles.map((t) => (
                <Tile key={t.key} tile={t} />
              ))}
            </div>
            <div className="space-y-1 text-note text-[var(--sys-muted-foreground)]">
              {ready.weekly.checks.map((c) => (
                <p key={c.key}>{c.sentence}</p>
              ))}
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
