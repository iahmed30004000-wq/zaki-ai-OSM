'use client';

import React, { useState } from 'react';
import { Button } from '@/components/ui/Button';
import { Select } from '@/components/ui/Input';
import { apiJson } from '@/lib/api-client';

/**
 * «افحص موظفة» — PICK A NAME, READ WHAT THE DESK WOULD TELL HER NOW (request Q1b, 19/11).
 *
 * Asks `GET /api/confirmation/rules/check?userId=` and draws its answer: what she holds against her limit, how many of those
 * nobody rang yet, her pulls in the last hour against the pace, and what «اسحب الطلب التالي» would answer her — the pull's own
 * code and Arabic sentence, written by the server. The check writes nothing and pulls nothing; the screen says so.
 */

export interface DeskCheckAnswer {
  person: { id: string; name: string };
  hold: {
    inHand: number;
    heldForHer: number;
    load: number;
    limit: number;
    limitFrom: 'CAP' | 'HAND';
    withoutAttempt: number;
    withoutAttemptLimit: number;
  };
  pace: { pulled: number; perHour: number; windowMinutes: number };
  pull: { open: boolean; code: string | null; sentence: string };
}

export const CHECK_WRITES_NOTHING =
  'الفحص ما بيكتب شي وما بيسحب شي. السحب الحقيقي بيرجّع أول الطلبات المتروكة بلا اتصال للطابور، فممكن رقمها يطلع أقل لحظة ما تسحب.';

export function holdSentence(h: DeskCheckAnswer['hold']): string {
  const held = h.heldForHer > 0 ? ` و${h.heldForHer} محجوزين إلها` : '';
  const whose = h.limitFrom === 'HAND' ? 'حد اليد' : 'السقف';
  return `بإيدها ${h.inHand}${held} — المجموع ${h.load} من ${h.limit} (${whose})`;
}

export function untriedSentence(h: DeskCheckAnswer['hold']): string {
  return `بلا محاولة اتصال: ${h.withoutAttempt} — الحد ${h.withoutAttemptLimit}`;
}

export function paceSentence(p: DeskCheckAnswer['pace']): string {
  return `سحبت ${p.pulled} خلال آخر ${p.windowMinutes} دقيقة — الحد ${p.perHour}`;
}

export function DeskPersonCheck({ people }: { people: { id: string; name: string }[] }) {
  const [userId, setUserId] = useState('');
  const [answer, setAnswer] = useState<DeskCheckAnswer | null>(null);
  const [refused, setRefused] = useState<string | null>(null);

  const check = async () => {
    if (!userId) return;
    setRefused(null);
    setAnswer(null);
    try {
      setAnswer(await apiJson<DeskCheckAnswer>(`/api/confirmation/rules/check?userId=${encodeURIComponent(userId)}`));
    } catch (e) {
      setRefused(e instanceof Error ? e.message : 'تعذّر الفحص');
    }
  };

  return (
    <section className="space-y-3 border-t border-[var(--sys-border)] pt-4" aria-label="افحص موظفة" data-desk-check>
      <h4 className="text-sm font-semibold text-[var(--sys-heading)]">افحص موظفة</h4>
      <div className="flex flex-col gap-2 sm:flex-row sm:items-end">
        <Select
          label="الموظفة"
          value={userId}
          onChange={(e) => {
            setUserId(e.target.value);
            setAnswer(null);
            setRefused(null);
          }}
          options={[{ value: '', label: 'اختار اسم' }, ...people.map((p) => ({ value: p.id, label: p.name }))]}
        />
        <Button onClick={check} disabled={!userId}>
          افحص
        </Button>
      </div>
      {refused && (
        <p role="alert" className="text-sm text-[var(--sys-destructive)]" data-check-refused>
          {refused}
        </p>
      )}
      {answer && (
        <div className="space-y-1.5" data-check-answer>
          <ul className="space-y-1 text-sm text-[var(--sys-foreground)]">
            <li>{holdSentence(answer.hold)}</li>
            <li>{untriedSentence(answer.hold)}</li>
            <li>{paceSentence(answer.pace)}</li>
          </ul>
          <p
            className={`text-sm font-medium ${answer.pull.open ? 'text-[var(--sys-foreground)]' : 'text-[var(--sys-warning)]'}`}
            data-pull-code={answer.pull.code ?? 'OPEN'}
          >
            {`لو ضغطت «اسحب» هلّق: ${answer.pull.sentence}`}
          </p>
          <p className="text-note leading-relaxed text-[var(--sys-muted-foreground)]">{CHECK_WRITES_NOTHING}</p>
        </div>
      )}
    </section>
  );
}
